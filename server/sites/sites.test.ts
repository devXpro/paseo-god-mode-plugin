import assert from "node:assert/strict";
import { test } from "node:test";
import { type Deployment, type SiteVersion, type ToolCaller, liveVersion, listSites, waitForDeployment } from "./sites.ts";

function fakeCaller(handlers: Record<string, (args: Record<string, unknown>) => unknown>): ToolCaller & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async callTool(tool, args = {}) {
      calls.push(tool);
      const handler = handlers[tool];
      if (!handler) return { isError: true, text: `no ${tool}`, structured: null };
      return { isError: false, text: "", structured: handler(args) as Record<string, unknown> };
    },
  };
}

const deployment = (id: string, versionId: string, updated: string, extra: Partial<Deployment> = {}): Deployment => ({
  id,
  version_id: versionId,
  type: "publish",
  status: "succeeded",
  url: "https://example",
  failure_message: null,
  updated_at: updated,
  ...extra,
});

test("the live version is the newest successful publish, not the newest saved one", async () => {
  const versions: SiteVersion[] = [
    { id: "v6", version_number: 6, source: { commit_sha: "c6" }, deployment_id: "d6" },
    { id: "v5", version_number: 5, source: { commit_sha: "c5" }, deployment_id: "d5b" },
    { id: "v4", version_number: 4, source: { commit_sha: "c4" }, deployment_id: "d4" },
    { id: "v3", version_number: 3, source: { commit_sha: "c3" }, deployment_id: null },
  ];
  const deployments: Record<string, Deployment> = {
    d6: deployment("d6", "v6", "2026-10-16T17:00:00+00:00"),
    // v5 was rolled back to after v6 went out
    d5b: deployment("d5b", "v5", "2026-10-16T17:10:00+00:00"),
    d4: deployment("d4", "v4", "2026-10-16T18:00:00+00:00", { status: "failed" }),
  };
  const caller = fakeCaller({ "sites.get_deployment_status": (args) => deployments[args.deployment_id as string] });
  const live = await liveVersion(caller, "p", versions);
  assert.equal(live?.version.id, "v5");
});

test("no successful publish means nothing is live", async () => {
  const caller = fakeCaller({ "sites.get_deployment_status": () => deployment("d", "v1", "2026-10-16T17:00:00+00:00", { type: "preview" }) });
  assert.equal(await liveVersion(caller, "p", [{ id: "v1", version_number: 1, source: { commit_sha: "c" }, deployment_id: "d" }]), null);
});

test("waiting stops at a terminal deployment state", async () => {
  const states = ["pending", "building", "publishing", "succeeded"];
  const caller = fakeCaller({ "sites.get_deployment_status": () => deployment("d", "v", "2026-10-16T17:00:00+00:00", { status: states.shift() as Deployment["status"] }) });
  const seen: string[] = [];
  const done = await waitForDeployment(caller, "p", "d", { intervalMs: 0, log: (line) => seen.push(line) });
  assert.equal(done.status, "succeeded");
  assert.equal(seen.length, 3);
});

test("site listings never carry credentials out", async () => {
  const caller = fakeCaller({
    "sites.list_sites": () => ({
      items: [{ id: "p", title: "T", slug: "t", status: "active", current_live_url: "u", latest_version_number: 2, source_repository_credential: { token: "x" } }],
    }),
  });
  const [site] = await listSites(caller);
  assert.deepEqual(Object.keys(site).sort(), ["current_live_url", "id", "latest_version_number", "slug", "status", "title"]);
});

test("a tool error becomes a SitesError with scrubbed text", async () => {
  const caller: ToolCaller = { async callTool() { return { isError: true, text: "denied for Bearer abc123", structured: null }; } };
  await assert.rejects(listSites(caller), (error: Error) => error.message.includes("Bearer [redacted]") && !error.message.includes("abc123"));
});
