// What an update and a rollback do, step by step. Every step that touches the outside world comes in
// through ReleaseSteps, so the decisions here are tested without Sites, git or Codex.
import {
  type Release,
  type SiteVersion,
  type ToolCaller,
  deployVersion,
  getDeployment,
  listVersions,
  readReleases,
  waitForDeployment,
} from "../sites/sites.ts";

export type Stage = "prepare" | "build" | "publish" | "verify" | "smoke" | "rollback";

export class ReleaseError extends Error {
  readonly stage: Stage;
  /** True when production may have changed and could not be put back. */
  readonly critical: boolean;
  constructor(stage: Stage, message: string, critical = false) {
    super(message);
    this.stage = stage;
    this.critical = critical;
  }
}

export interface ReleaseResult {
  outcome: "published" | "redeployed" | "already-live" | "rolled-back";
  versionNumber: number | null;
  commit: string | null;
  url: string | null;
  message: string;
}

export interface ReleaseSteps {
  sites: ToolCaller;
  projectId: string;
  log(line: string): void;
  step(name: string): void;
  /** Syncs the private checkout with Sites, stages this plugin's Site source and commits it. */
  prepare(): Promise<string>;
  /** Installs, tests, builds and packages; returns the archive path. */
  build(): Promise<string>;
  push(): Promise<void>;
  /** Writes the preferences and the key to this Mac to the Site; they apply with the next deployment. */
  configure(): Promise<void>;
  publish(commitSha: string, archive: string): Promise<void>;
  /** `attempts` overrides how long to wait for ChatGPT to show the new tool list. */
  smoke(metadata: boolean, attempts?: number): Promise<{ failures: string[]; warnings: string[] }>;
  wait?: { intervalMs?: number; timeoutMs?: number };
}

const short = (sha: string | undefined | null) => (sha ? sha.slice(0, 7) : "?");

/** A live release whose tools ChatGPT has not picked up yet is not broken; say so instead. */
const staleNote = (warnings: string[]) =>
  warnings.length ? ` ChatGPT still shows the previous tool list (${warnings.length} difference(s)); the new tools appear in a new chat once it refreshes.` : "";

function asStageError(stage: Stage, error: unknown): ReleaseError {
  return error instanceof ReleaseError ? error : new ReleaseError(stage, (error as Error).message);
}

async function deployAndConfirm(s: ReleaseSteps, version: SiteVersion, stage: Stage): Promise<Release> {
  const started = await deployVersion(s.sites, s.projectId, version.id);
  const deployment = await waitForDeployment(s.sites, s.projectId, started.id, { ...s.wait, log: s.log });
  if (deployment.status !== "succeeded") {
    throw new ReleaseError(stage, `Deploying version ${version.version_number} failed: ${deployment.failure_message ?? "no reason given"}`);
  }
  return { version, deployment };
}

/** After a publish the newest saved version must be new, built from this commit, and live. */
async function confirmNewRelease(s: ReleaseSteps, commitSha: string, before: SiteVersion | undefined): Promise<Release> {
  const [newest] = await listVersions(s.sites, s.projectId, 1);
  if (!newest || (before && newest.version_number <= before.version_number)) throw new ReleaseError("verify", "Sites saved no new version.");
  if (newest.source.commit_sha !== commitSha) {
    throw new ReleaseError("verify", `The newest version ${newest.version_number} is built from ${short(newest.source.commit_sha)}, not ${short(commitSha)}.`);
  }
  if (!newest.deployment_id) throw new ReleaseError("verify", `Version ${newest.version_number} was saved but not deployed.`);
  const deployment = await waitForDeployment(s.sites, s.projectId, newest.deployment_id, { ...s.wait, log: s.log });
  if (deployment.status !== "succeeded") {
    throw new ReleaseError("verify", `Version ${newest.version_number} did not deploy: ${deployment.failure_message ?? "no reason given"}`);
  }
  if (deployment.version_id !== newest.id || deployment.type !== "publish") {
    throw new ReleaseError("verify", `The deployment of version ${newest.version_number} belongs to another version.`);
  }
  return { version: newest, deployment };
}

/** A failure after production may have changed: wait out a deployment still in flight, then put the
 *  version that was live before back, unless it still is. */
async function recover(s: ReleaseSteps, liveBefore: Release | null, before: SiteVersion | undefined, failure: ReleaseError): Promise<ReleaseError> {
  try {
    const versions = await listVersions(s.sites, s.projectId);
    for (const v of versions) {
      if (!before || v.version_number <= before.version_number || !v.deployment_id) continue;
      const deployment = await getDeployment(s.sites, s.projectId, v.deployment_id);
      if (deployment.status !== "succeeded" && deployment.status !== "failed") {
        await waitForDeployment(s.sites, s.projectId, v.deployment_id, { ...s.wait, log: s.log });
      }
    }
    const { live } = await readReleases(s.sites, s.projectId, await listVersions(s.sites, s.projectId));
    if (!liveBefore) return failure;
    if (live && live.version.id === liveBefore.version.id) {
      return new ReleaseError(failure.stage, `${failure.message}\nProduction is unchanged: version ${liveBefore.version.version_number} is still live.`);
    }
    s.step(`Rolling back to version ${liveBefore.version.version_number}`);
    await deployAndConfirm(s, liveBefore.version, "rollback");
    const { failures } = await s.smoke(false);
    const note = failures.length ? ` Its check reported: ${failures.join("; ")}` : "";
    return new ReleaseError(failure.stage, `${failure.message}\nRolled back to version ${liveBefore.version.version_number}.${note}`);
  } catch (error) {
    return new ReleaseError("rollback", `${failure.message}\nThe automatic rollback failed too: ${(error as Error).message}`, true);
  }
}

export async function runUpdate(s: ReleaseSteps): Promise<ReleaseResult> {
  s.step("Reading the Site");
  const versions = await listVersions(s.sites, s.projectId);
  const before = versions[0];
  const { live } = await readReleases(s.sites, s.projectId, versions);

  s.step("Preparing the release");
  const commitSha = await s.prepare().catch((error) => { throw asStageError("prepare", error); });
  const saved = versions.find((v) => v.source.commit_sha === commitSha);
  if (saved && live?.version.id === saved.id) {
    return { outcome: "already-live", versionNumber: saved.version_number, commit: commitSha, url: live.deployment.url, message: `Version ${saved.version_number} is already live.` };
  }

  let archive = "";
  if (!saved) {
    s.step("Building and testing");
    archive = await s.build().catch((error) => { throw asStageError("build", error); });
  }

  // From here on production may change; any failure ends in recover().
  let release: Release;
  let warnings: string[] = [];
  try {
    s.step("Saving settings to the Site");
    await s.configure();
    if (saved) {
      s.step(`Deploying saved version ${saved.version_number}`);
      release = await deployAndConfirm(s, saved, "publish");
    } else {
      s.step("Pushing the source");
      await s.push().catch((error) => { throw asStageError("publish", error); });
      s.step("Publishing");
      await s.publish(commitSha, archive).catch((error) => { throw asStageError("publish", error); });
      s.step("Verifying");
      release = await confirmNewRelease(s, commitSha, before);
    }
    s.step("Checking the live plugin");
    let smoke = await s.smoke(true, 2);
    if (!smoke.failures.length && smoke.warnings.length) {
      // ChatGPT still shows the old tool list. Observed in the Site's Worker log on 2026-10-17, not a
      // documented ChatGPT contract: after a plain redeploy ChatGPT re-reads server/discover and the
      // widget, but never tools/list; after saving the settings and then redeploying (what the
      // configure job does) it re-reads tools/list within seconds, from the new Worker. So the
      // settings are saved again first.
      s.step("Asking ChatGPT to pick up the new tools");
      await s.configure();
      release = await deployAndConfirm(s, release.version, "publish");
      smoke = await s.smoke(true);
    }
    if (smoke.failures.length) throw new ReleaseError("smoke", `The live plugin failed its check:\n- ${smoke.failures.join("\n- ")}`);
    warnings = smoke.warnings;
  } catch (error) {
    throw await recover(s, live, before, asStageError("publish", error));
  }
  return {
    outcome: saved ? "redeployed" : "published",
    versionNumber: release.version.version_number,
    commit: commitSha,
    url: release.deployment.url,
    message: `Version ${release.version.version_number} is live.${staleNote(warnings)}`,
  };
}

/** Writes the preferences and the key to this Mac, then redeploys the live version so they apply. */
export async function runConfigure(s: ReleaseSteps): Promise<ReleaseResult> {
  s.step("Reading the Site");
  const versions = await listVersions(s.sites, s.projectId);
  const { live } = await readReleases(s.sites, s.projectId, versions);
  s.step("Saving settings to the Site");
  await s.configure().catch((error) => { throw asStageError("prepare", error); });
  if (!live) {
    return { outcome: "already-live", versionNumber: null, commit: null, url: null, message: "Settings saved; they apply with the first publish." };
  }
  let release: Release;
  let warnings: string[] = [];
  try {
    s.step(`Redeploying version ${live.version.version_number}`);
    release = await deployAndConfirm(s, live.version, "publish");
    s.step("Checking the live plugin");
    const smoke = await s.smoke(true);
    if (smoke.failures.length) throw new ReleaseError("smoke", `The live plugin failed its check:\n- ${smoke.failures.join("\n- ")}`);
    warnings = smoke.warnings;
  } catch (error) {
    throw await recover(s, live, versions[0], asStageError("publish", error));
  }
  return {
    outcome: "redeployed",
    versionNumber: release.version.version_number,
    commit: release.version.source.commit_sha,
    url: release.deployment.url,
    message: `Settings applied; version ${release.version.version_number} is live.${staleNote(warnings)}`,
  };
}

/** `previous` is the release before the newest one, so asking twice does not walk further back. */
export async function runRollback(s: ReleaseSteps, target: "previous" | number): Promise<ReleaseResult> {
  s.step("Reading the Site");
  const versions = await listVersions(s.sites, s.projectId);
  const { releases, live } = await readReleases(s.sites, s.projectId, versions);
  const choice = target === "previous" ? releases[1] : releases.find((r) => r.version.version_number === target);
  if (!choice) {
    const known = releases.map((r) => r.version.version_number).join(", ") || "none";
    throw new ReleaseError("prepare", target === "previous" ? "There is no earlier release to go back to." : `Version ${target} was never released (released: ${known}).`);
  }
  if (live?.version.id === choice.version.id) {
    return { outcome: "already-live", versionNumber: choice.version.version_number, commit: choice.version.source.commit_sha, url: live.deployment.url, message: `Version ${choice.version.version_number} is already live.` };
  }
  s.step(`Deploying version ${choice.version.version_number}`);
  let release: Release;
  try {
    release = await deployAndConfirm(s, choice.version, "rollback");
  } catch (error) {
    throw await recover(s, live, versions[0], asStageError("rollback", error));
  }
  s.step("Checking the live plugin");
  const { failures } = await s.smoke(false);
  if (failures.length) throw new ReleaseError("smoke", `Version ${choice.version.version_number} is live but failed its check:\n- ${failures.join("\n- ")}`);
  return {
    outcome: "rolled-back",
    versionNumber: release.version.version_number,
    commit: release.version.source.commit_sha,
    url: release.deployment.url,
    message: `Version ${release.version.version_number} is live again.`,
  };
}
