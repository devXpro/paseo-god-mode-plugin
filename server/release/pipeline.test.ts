import assert from "node:assert/strict";
import { test } from "node:test";
import type { Deployment, SiteVersion, ToolCaller } from "../sites/sites.ts";
import { ReleaseError, type ReleaseSteps, runConfigure, runRollback, runUpdate } from "./pipeline.ts";

/** A small Sites: saved versions, their deployments, and a clock so "most recent" means something. */
class FakeSites implements ToolCaller {
  versions: SiteVersion[] = [];
  deployments = new Map<string, Deployment>();
  deployCalls: string[] = [];
  failDeploysOf = new Set<string>();
  private clock = 0;

  save(commit: string, deploy: "succeeded" | "failed" | null): SiteVersion {
    const number = (this.versions[0]?.version_number ?? 0) + 1;
    const version: SiteVersion = { id: `v${number}`, version_number: number, source: { commit_sha: commit }, deployment_id: null };
    this.versions.unshift(version);
    if (deploy) this.deploy(version.id, deploy);
    return version;
  }

  deploy(versionId: string, status: "succeeded" | "failed"): Deployment {
    this.clock += 1;
    const id = `d${this.clock}`;
    const deployment: Deployment = { id, version_id: versionId, type: "publish", status, url: "https://site.example", failure_message: status === "failed" ? "boom" : null, updated_at: new Date(Date.UTC(2026, 9, 16, 12, this.clock)).toISOString() };
    this.deployments.set(id, deployment);
    const version = this.versions.find((v) => v.id === versionId);
    if (version) version.deployment_id = id;
    return deployment;
  }

  live(): number | null {
    let best: Deployment | null = null;
    for (const d of this.deployments.values()) {
      const version = this.versions.find((v) => v.id === d.version_id);
      if (d.status !== "succeeded" || version?.deployment_id !== d.id) continue;
      if (!best || d.updated_at > best.updated_at) best = d;
    }
    return best ? (this.versions.find((v) => v.id === best.version_id)?.version_number ?? null) : null;
  }

  async callTool(tool: string, args: Record<string, unknown> = {}) {
    const ok = (structured: unknown) => ({ isError: false, text: "", structured: structured as Record<string, unknown> });
    switch (tool) {
      case "sites.list_site_versions":
        return ok({ items: this.versions.slice(0, (args.limit as number) ?? 20).map((v) => ({ ...v, source: { ...v.source } })) });
      case "sites.get_deployment_status":
        return ok(this.deployments.get(args.deployment_id as string));
      case "sites.deploy_private_site_version": {
        this.deployCalls.push(args.version_id as string);
        return ok(this.deploy(args.version_id as string, this.failDeploysOf.has(args.version_id as string) ? "failed" : "succeeded"));
      }
      default:
        return { isError: true, text: `unexpected ${tool}`, structured: null };
    }
  }
}

function steps(sites: FakeSites, overrides: Partial<ReleaseSteps> & { commit?: string; publishAs?: "succeeded" | "failed" | "nothing" } = {}) {
  const calls: string[] = [];
  const s: ReleaseSteps = {
    sites,
    projectId: "p",
    log: () => {},
    step: (name) => calls.push(`step:${name}`),
    prepare: async () => overrides.commit ?? "new-sha",
    build: async () => {
      calls.push("build");
      return "/tmp/archive.tgz";
    },
    push: async () => {
      calls.push("push");
    },
    configure: async () => {
      calls.push("configure");
    },
    publish: async (commit) => {
      calls.push("publish");
      if (overrides.publishAs === "nothing") throw new Error("codex exec failed");
      sites.save(commit, overrides.publishAs ?? "succeeded");
    },
    smoke: async () => ({ failures: [], warnings: [] }),
    wait: { intervalMs: 0 },
    ...overrides,
  };
  return { s, calls };
}

function siteAtV5() {
  const sites = new FakeSites();
  sites.save("c1", "succeeded");
  sites.save("c4", "succeeded");
  sites.save("c5", "succeeded");
  return sites;
}

test("an update publishes a new version and leaves it live", async () => {
  const sites = siteAtV5();
  const { s, calls } = steps(sites);
  const result = await runUpdate(s);
  assert.equal(result.outcome, "published");
  assert.equal(result.versionNumber, 4);
  assert.equal(sites.live(), 4);
  assert.deepEqual(calls.filter((c) => !c.startsWith("step:")), ["build", "configure", "push", "publish"]);
});

test("the commit that is already live is not rebuilt", async () => {
  const sites = siteAtV5();
  const { s, calls } = steps(sites, { commit: "c5" });
  const result = await runUpdate(s);
  assert.equal(result.outcome, "already-live");
  assert.ok(!calls.includes("build"));
  assert.equal(sites.deployCalls.length, 0);
});

test("a saved version that is not live is deployed again, not rebuilt", async () => {
  const sites = siteAtV5();
  sites.deploy("v2", "succeeded"); // rolled back to the c4 version
  const { s, calls } = steps(sites, { commit: "c5" });
  const result = await runUpdate(s);
  assert.equal(result.outcome, "redeployed");
  assert.equal(sites.live(), 3);
  assert.ok(!calls.includes("build"));
});

test("a release that fails its live check is rolled back by itself", async () => {
  const sites = siteAtV5();
  const smoke = async (metadata: boolean) => ({ failures: metadata ? ["overview: no structured result"] : [], warnings: [] });
  const { s } = steps(sites, { smoke });
  await assert.rejects(runUpdate(s), (error: ReleaseError) => {
    assert.equal(error.stage, "smoke");
    assert.equal(error.critical, false);
    assert.match(error.message, /Rolled back to version 3/);
    return true;
  });
  assert.equal(sites.live(), 3);
});

test("a failed build never touches production", async () => {
  const sites = siteAtV5();
  const build = async () => {
    throw new Error("npm run check failed");
  };
  const { s } = steps(sites, { build });
  await assert.rejects(runUpdate(s), (error: ReleaseError) => error.stage === "build");
  assert.equal(sites.deployCalls.length, 0);
  assert.equal(sites.live(), 3);
});

test("a publish that saved nothing reports production as unchanged", async () => {
  const sites = siteAtV5();
  const { s } = steps(sites, { publishAs: "nothing" });
  await assert.rejects(runUpdate(s), (error: ReleaseError) => /Production is unchanged: version 3 is still live/.test(error.message));
  assert.equal(sites.deployCalls.length, 0);
});

test("a rollback that cannot be done is critical", async () => {
  const sites = siteAtV5();
  sites.failDeploysOf.add("v3");
  const smoke = async () => ({ failures: ["read_chat: broken"], warnings: [] });
  const { s } = steps(sites, { smoke });
  await assert.rejects(runUpdate(s), (error: ReleaseError) => error.critical && error.stage === "rollback");
});

test("rolling back twice lands on the same release, and saved-only versions are skipped", async () => {
  const sites = siteAtV5();
  sites.save("probe", null); // saved, never deployed
  sites.save("c7", "succeeded");
  const first = await runRollback(steps(sites).s, "previous");
  assert.equal(first.outcome, "rolled-back");
  assert.equal(first.versionNumber, 3);
  assert.equal(sites.live(), 3);
  const second = await runRollback(steps(sites).s, "previous");
  assert.equal(second.outcome, "already-live");
});

test("a rollback to a version that was never released is refused", async () => {
  const sites = siteAtV5();
  sites.save("probe", null);
  await assert.rejects(runRollback(steps(sites).s, 4), /never released/);
});

test("configuring writes the settings and redeploys the live version so they apply", async () => {
  const sites = siteAtV5();
  const { s, calls } = steps(sites);
  const result = await runConfigure(s);
  assert.equal(result.outcome, "redeployed");
  assert.equal(result.versionNumber, 3);
  assert.ok(calls.includes("configure"));
  assert.deepEqual(sites.deployCalls, ["v3"]);
  assert.equal(sites.live(), 3);
});

test("configuring a Site that was never published only saves the settings", async () => {
  const sites = new FakeSites();
  const { s, calls } = steps(sites);
  const result = await runConfigure(s);
  assert.equal(result.outcome, "already-live");
  assert.ok(calls.includes("configure"));
  assert.equal(sites.deployCalls.length, 0);
});

test("a release whose new tools ChatGPT has not shown yet stays live, with a note", async () => {
  const sites = siteAtV5();
  const smoke = async () => ({ failures: [], warnings: ["ChatGPT does not show the new tool update_site yet"] });
  const { s } = steps(sites, { smoke });
  const result = await runUpdate(s);
  assert.equal(result.outcome, "published");
  assert.equal(sites.live(), 4);
  assert.match(result.message, /still shows the previous tool list/);
});

test("a stale tool list after publishing is fixed by deploying the same version once more", async () => {
  const sites = siteAtV5();
  let checks = 0;
  const smoke = async () => ({ failures: [], warnings: checks++ === 0 ? ["ChatGPT does not show the new tool update_site yet"] : [] });
  const { s } = steps(sites, { smoke });
  const result = await runUpdate(s);
  assert.equal(result.outcome, "published");
  assert.deepEqual(sites.deployCalls, ["v4"], "the new version is deployed again");
  assert.doesNotMatch(result.message, /previous tool list/);
  assert.equal(sites.live(), 4);
});
