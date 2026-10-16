// Typed calls to the ChatGPT Sites tools, made through the Codex app-server with no model turn.
import type { ToolResult } from "../codex/app-server.ts";
import { redact, scrubText } from "../safety.ts";

export interface ToolCaller {
  callTool(tool: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<ToolResult>;
}

export class SitesError extends Error {}

export interface SiteSummary {
  id: string;
  title: string;
  slug: string;
  status: string;
  current_live_url: string | null;
  latest_version_number: number;
}

export interface SiteVersion {
  id: string;
  version_number: number;
  source: { commit_sha: string };
  deployment_id?: string | null;
}

export interface Deployment {
  id: string;
  version_id: string;
  type: "preview" | "publish";
  status: "pending" | "building" | "publishing" | "succeeded" | "failed";
  url: string | null;
  failure_message: string | null;
  updated_at: string;
}

/** A short-lived git credential. Its token goes to git through the environment and nowhere else. */
export interface Credential {
  remote_url: string;
  branch: string;
  token: string;
  auth_mode: string;
}

async function call<T>(caller: ToolCaller, tool: string, args: Record<string, unknown>, timeoutMs?: number): Promise<T> {
  const result = await caller.callTool(tool, args, timeoutMs);
  if (result.isError || !result.structured) {
    throw new SitesError(`${tool}: ${scrubText(result.text).slice(0, 300) || "no result"}`);
  }
  return result.structured as T;
}

export async function listSites(caller: ToolCaller): Promise<SiteSummary[]> {
  const page = await call<{ items: SiteSummary[] }>(caller, "sites.list_sites", { limit: 50, role: "owner" });
  return page.items.map((site) => {
    const { id, title, slug, status, current_live_url, latest_version_number } = redact(site);
    return { id, title, slug, status, current_live_url, latest_version_number };
  });
}

export async function listVersions(caller: ToolCaller, projectId: string, limit = 20): Promise<SiteVersion[]> {
  const page = await call<{ items: SiteVersion[] }>(caller, "sites.list_site_versions", { project_id: projectId, limit });
  return page.items;
}

export const getDeployment = (caller: ToolCaller, projectId: string, deploymentId: string) =>
  call<Deployment>(caller, "sites.get_deployment_status", { project_id: projectId, deployment_id: deploymentId });

export const deployVersion = (caller: ToolCaller, projectId: string, versionId: string) =>
  call<Deployment>(caller, "sites.deploy_private_site_version", { project_id: projectId, version_id: versionId });

export const createCredential = (caller: ToolCaller, projectId: string) =>
  call<Credential>(caller, "sites.create_source_repository_write_credential", { project_id: projectId });

export interface EnvEntry {
  key: string;
  /** Null for secrets, and always null for the pairing link, which is a key to the daemon. */
  value: string | null;
  is_secret: boolean;
}

export const PAIRING_KEY = "PASEO_PAIRING_URL";

export async function getEnvironment(caller: ToolCaller, projectId: string): Promise<EnvEntry[]> {
  const result = await call<{ entries: { key: string; value: string | null; is_secret?: boolean }[] }>(caller, "sites.get_environment_variables", { project_id: projectId });
  return result.entries.map(({ key, value, is_secret }) => ({
    key,
    value: is_secret || key === PAIRING_KEY ? null : value,
    is_secret: Boolean(is_secret),
  }));
}

/** Sets and removes runtime variables; they apply with the next deployment. */
export async function updateEnvironment(
  caller: ToolCaller,
  projectId: string,
  set: { key: string; value: string; is_secret?: boolean }[],
  remove: string[] = [],
): Promise<number> {
  const result = await call<{ revision: number }>(caller, "sites.update_environment_variables", {
    project_id: projectId,
    set_values: set,
    ...(remove.length ? { remove } : {}),
  });
  return result.revision;
}

export async function checkSlug(caller: ToolCaller, slug: string): Promise<{ slug: string; status: "available" | "invalid" | "taken" }> {
  const result = await call<{ slug: string; status: "available" | "invalid" | "taken" }>(caller, "sites.check_slug_availability", { slug });
  return { slug: result.slug, status: result.status };
}

/** A new private Site. Its git credential is dropped here; releases mint their own. */
export async function createSite(caller: ToolCaller, title: string, slug: string, description: string): Promise<SiteSummary> {
  const site = await call<SiteSummary>(caller, "sites.create_site", { title, slug, description, creation_intent: "user_requested" });
  const { id, status, current_live_url, latest_version_number } = site;
  return { id, title: site.title, slug: site.slug, status, current_live_url, latest_version_number };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForDeployment(
  caller: ToolCaller,
  projectId: string,
  deploymentId: string,
  { timeoutMs = 10 * 60_000, intervalMs = 5_000, log = (_line: string) => {} } = {},
): Promise<Deployment> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const deployment = await getDeployment(caller, projectId, deploymentId);
    if (deployment.status === "succeeded" || deployment.status === "failed") return deployment;
    if (Date.now() > deadline) throw new SitesError(`Deployment is still ${deployment.status} after ${Math.round(timeoutMs / 60_000)} min.`);
    log(`deployment ${deployment.status}…`);
    await sleep(intervalMs);
  }
}

export interface Release {
  version: SiteVersion;
  deployment: Deployment;
}

export interface Releases {
  /** Versions whose latest publish succeeded, newest version first. Saved-only versions are not here. */
  releases: Release[];
  live: Release | null;
}

/** Sites has no "current version" field. The live version is the release whose deployment succeeded
 *  most recently: a rollback redeploys an older version and makes it the newest success. */
export async function readReleases(caller: ToolCaller, projectId: string, versions: SiteVersion[]): Promise<Releases> {
  const deployed = versions.filter((v) => v.deployment_id);
  const deployments = await Promise.all(
    deployed.map((v) => getDeployment(caller, projectId, v.deployment_id as string).catch(() => null)),
  );
  const releases: Release[] = [];
  deployed.forEach((version, i) => {
    const deployment = deployments[i];
    if (deployment && deployment.type === "publish" && deployment.status === "succeeded") releases.push({ version, deployment });
  });
  releases.sort((a, b) => b.version.version_number - a.version.version_number);
  let live: Release | null = null;
  for (const release of releases) {
    if (!live || Date.parse(release.deployment.updated_at) > Date.parse(live.deployment.updated_at)) live = release;
  }
  return { releases, live };
}

export async function liveVersion(caller: ToolCaller, projectId: string, versions: SiteVersion[]): Promise<Release | null> {
  return (await readReleases(caller, projectId, versions)).live;
}
