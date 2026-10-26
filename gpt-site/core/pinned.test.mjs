// Run with: node --test core/
// list_pinned_chats against a fake daemon that answers as Paseo 0.13 does: workspaces in pages of
// descriptors, a pinned one carrying pinnedAt, and the active chats, each with the workspace it runs
// in. No network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { listPinnedChatsOn } from "./paseo.mjs";

const NOW = Date.now();
const at = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

// A workspace descriptor; pinnedAt is how long ago it was pinned, in minutes.
const workspace = (id, name, fields = {}) => ({ id, name, projectDisplayName: "lab", status: "done", gitRuntime: null, ...fields, pinnedAt: fields.pinnedAt === undefined ? null : at(fields.pinnedAt) });
// An active chat as fetch_agents gives it, in its workspace.
const chat = (id, title, ws, minutes) => ({
  agent: {
    id,
    title,
    workspaceId: ws.id,
    status: "idle",
    pendingPermissions: [],
    updatedAt: at(minutes),
    createdAt: at(minutes + 60),
    archivedAt: null,
    cwd: "/Users/r/lab",
    provider: "claude",
    currentModeId: "default",
  },
  project: { projectName: ws.projectDisplayName, workspaceName: ws.name },
});

const FLEET = workspace("wks_fleet", "Fleet map", { projectDisplayName: "proxy", pinnedAt: 30, status: "running" });
const OPEN = workspace("wks_open", "Not pinned");
const CLUSTER = workspace("wks_cluster", "Local cluster, step 6 (helm)", { pinnedAt: 5, gitRuntime: { currentBranch: "helm" } });
const DEPLOY = workspace("wks_deploy", "Deploy scripts", { pinnedAt: 300 });
const PROJECTS = [
  { projectDisplayName: "lab", projectRootPath: "/Users/r/lab" },
  { projectDisplayName: "proxy", projectRootPath: "/Users/r/proxy" },
];

function fakeDaemon({ pages, chats }) {
  const log = { cursors: [], projectLists: 0, history: 0 };
  // Newest first, as the daemon sorts them for fetchChats.
  const active = [...chats].sort((a, b) => Date.parse(b.agent.updatedAt) - Date.parse(a.agent.updatedAt));
  return {
    log,
    async fetchWorkspaces(options) {
      const cursor = options?.page?.cursor ?? null;
      log.cursors.push(cursor);
      const index = cursor ? Number(cursor.slice(1)) : 0;
      const hasMore = index + 1 < pages.length;
      return { entries: pages[index], pageInfo: { nextCursor: hasMore ? `p${index + 1}` : null, prevCursor: null, hasMore } };
    },
    async fetchAgents() {
      return { entries: active };
    },
    async fetchAgentHistory() {
      log.history += 1;
      return { entries: [] };
    },
    async listProjects() {
      log.projectLists += 1;
      return { projects: PROJECTS };
    },
  };
}

const daemon = () =>
  fakeDaemon({
    pages: [[FLEET, OPEN], [CLUSTER, DEPLOY]],
    chats: [
      chat("a2252400-0000-4000-8000-000000000001", "Fleet map, stage D", FLEET, 2),
      chat("b7c1d2e3-0000-4000-8000-000000000002", "Open work", OPEN, 1),
      chat("739a96bc-0000-4000-8000-000000000003", "Продолжаем учебный кластер на миникубе", CLUSTER, 40),
      chat("739a96bc-0000-4000-8000-000000000004", "Кластер, шаг 6: helm", CLUSTER, 10),
    ],
  });

test("every pinned row comes back from every page, latest pin first, with the chats in it", async () => {
  const paseo = daemon();
  const { text, data } = await listPinnedChatsOn(paseo, {});
  assert.deepEqual(paseo.log.cursors, [null, "p1"], "the second page is read too");
  assert.deepEqual(data.pinned.map((r) => r.name), ["Local cluster, step 6 (helm)", "Fleet map", "Deploy scripts"]);
  assert.equal(data.scope, "all projects");
  assert.equal(data.total, 3);
  const [cluster, fleet, deploy] = data.pinned;
  assert.deepEqual(cluster.chats.map((c) => c.title), ["Кластер, шаг 6: helm", "Продолжаем учебный кластер на миникубе"], "newest chat first");
  assert.equal(cluster.branch, "helm");
  assert.equal(fleet.project, "proxy");
  assert.equal(fleet.status, "running");
  assert.equal(fleet.chats[0].id, "a2252400-0000-4000-8000-000000000001");
  assert.deepEqual(deploy.chats, [], "a pin whose chat is gone holds none");
  assert.match(text, /^3 pinned, latest pin first:\nLocal cluster, step 6 \(helm\) \(lab\): 2 chats: /);
  assert.equal(paseo.log.projectLists, 0, "no project asked, none listed");
  assert.equal(paseo.log.history, 0, "the archive is never looked in");
});

test("a project narrows the pins, and one Paseo does not know lists the projects", async () => {
  const proxy = await listPinnedChatsOn(daemon(), { project: "proxy" });
  assert.equal(proxy.data.scope, "proxy");
  assert.deepEqual(proxy.data.pinned.map((r) => r.name), ["Fleet map"]);
  assert.match(proxy.text, /^1 pinned in proxy, latest pin first:\nFleet map \(proxy\): idle, 2 min ago/);
  const lab = await listPinnedChatsOn(daemon(), { project: "lab" });
  assert.deepEqual(lab.data.pinned.map((r) => r.name), ["Local cluster, step 6 (helm)", "Deploy scripts"]);
  // Said in another script: the projects come back for ChatGPT to map the name and call again.
  const spoken = await listPinnedChatsOn(daemon(), { project: "прокси" });
  assert.deepEqual(spoken.data.needs_clarification, { kind: "project", query: "прокси", candidates: ["lab", "proxy"] });
  assert.equal(spoken.data.pinned, undefined);
});

test("words of a pinned chat's title find its row", async () => {
  const { data } = await listPinnedChatsOn(daemon(), { query: "миникуб" });
  assert.equal(data.query_match, "all_words");
  assert.deepEqual(data.pinned.map((r) => r.workspace_id), ["wks_cluster"]);
});

test("nothing pinned says so", async () => {
  const paseo = fakeDaemon({ pages: [[OPEN]], chats: [chat("b7c1d2e3-0000-4000-8000-000000000002", "Open work", OPEN, 1)] });
  assert.deepEqual(await listPinnedChatsOn(paseo, {}), { text: "Nothing is pinned.", data: { scope: "all projects", query: null, total: 0, pinned: [] } });
});
