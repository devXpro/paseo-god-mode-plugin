// Run with: node --test core/
// start_chat in a workspace that already exists: how a name or id settles on one row of Paseo's sidebar, and
// the request that opens the chat there, against a fake daemon that answers as Paseo 0.14 does (workspace
// descriptors in pages, the active chats, create with a workspaceId). No network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startChatOn } from "./paseo.mjs";
import { rowsQuestion, settleRow } from "./text.mjs";

const NOW = Date.now();
const at = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

const PROJECTS = [
  { projectDisplayName: "lab", projectRootPath: "/Users/r/lab" },
  { projectDisplayName: "proxy", projectRootPath: "/Users/r/proxy" },
];
const workspace = (id, name, project, fields = {}) => ({
  id,
  name,
  projectDisplayName: project,
  projectRootPath: `/Users/r/${project}`,
  workspaceDirectory: `/Users/r/${project}`,
  status: "done",
  gitRuntime: null,
  pinnedAt: null,
  ...fields,
});
const chat = (id, title, ws, minutes) => ({
  agent: { id, title, workspaceId: ws.id, status: "idle", pendingPermissions: [], updatedAt: at(minutes), createdAt: at(minutes + 60), archivedAt: null, cwd: ws.workspaceDirectory, provider: "claude", currentModeId: "default" },
  project: { projectName: ws.projectDisplayName, workspaceName: ws.name },
});

const FLEET = workspace("wks_fleet", "Fleet map", "proxy");
// A Paseo-made worktree: its folder is not the project's.
const RELAY = workspace("wks_relay", "Fix relay", "proxy", { workspaceDirectory: "/Users/r/proxy-worktrees/fix-relay", gitRuntime: { currentBranch: "fix-relay" } });
const TWIN_A = workspace("wks_twin_a", "Deploy scripts", "lab");
const TWIN_B = workspace("wks_twin_b", "Deploy scripts", "lab");
const NOTES = workspace("wks_notes", "Notes", "lab");
const CHATS = [
  chat("a2252400-0000-4000-8000-000000000001", "Fleet map, stage D", FLEET, 2),
  chat("a2252400-0000-4000-8000-000000000002", "Fleet map tests", FLEET, 9),
  chat("5d6e7f80-0000-4000-8000-000000000003", "Relay timeouts", RELAY, 4),
  chat("739a96bc-0000-4000-8000-000000000004", "Deploy scripts, first pass", TWIN_A, 30),
  chat("739a96bc-0000-4000-8000-000000000005", "Deploy scripts, second pass", TWIN_B, 20),
];

const levels = (ids) => ids.map((id) => ({ id, label: id }));
const SNAPSHOT = [{ provider: "claude", label: "Claude", status: "ready", enabled: true, modes: [{ id: "default", label: "Always Ask" }] }];
const MODELS = [{ provider: "claude", id: "claude-opus-5-5", label: "Opus 5.5", isDefault: true, thinkingOptions: levels(["low", "medium", "max"]), defaultThinkingOptionId: "medium" }];

function daemon({ workspaces = [FLEET, RELAY, TWIN_A, TWIN_B, NOTES] } = {}) {
  const calls = [];
  const rows = [...workspaces];
  return {
    calls,
    async listProjects() {
      return { projects: PROJECTS };
    },
    async fetchWorkspaces() {
      return { entries: rows, pageInfo: { nextCursor: null, prevCursor: null, hasMore: false } };
    },
    async fetchAgents() {
      return { entries: CHATS };
    },
    async getProvidersSnapshot(options) {
      calls.push(["snapshot", options]);
      return { entries: SNAPSHOT };
    },
    async listProviderModels(provider) {
      return { provider, models: MODELS, error: null };
    },
    async listProviderModes(provider) {
      return { provider, modes: SNAPSHOT[0].modes, error: null };
    },
    // As Paseo: with a workspaceId the agent joins it, else a workspace of its own is made.
    async createAgent(options) {
      calls.push(["create", options]);
      // A chat made without a workspace gets one, which Paseo's list shows from then on.
      if (!options.workspaceId) rows.push(workspace("wks_made_now", "Reply OK.", options.cwd.split("/").at(-1)));
      return { id: "7d3f1c2a-9b8e-4f60-a1b2-c3d4e5f60718", provider: options.provider, cwd: options.cwd, workspaceId: options.workspaceId ?? "wks_made_now", model: options.model ?? null, currentModeId: "default" };
    },
    async waitForFinish() {
      return { status: "idle", lastMessage: "OK" };
    },
  };
}
const created = (paseo) => paseo.calls.filter((c) => c[0] === "create").map((c) => c[1]);

test("a workspace id opens the chat in that workspace's own folder, and the answer says it joined", async () => {
  const paseo = daemon();
  const { text, data } = await startChatOn(paseo, { workspace: "wks_relay", prompt: "Reply OK.", waitSeconds: 5 });
  assert.deepEqual(created(paseo), [{ provider: "claude", cwd: "/Users/r/proxy-worktrees/fix-relay", workspaceId: "wks_relay", initialPrompt: "Reply OK.", labels: { source: "god-mode" } }]);
  assert.deepEqual(paseo.calls.find((c) => c[0] === "snapshot")[1], { cwd: "/Users/r/proxy-worktrees/fix-relay" }, "the catalog of that folder");
  assert.match(text, /^Started a new chat in proxy, in its workspace "Fix relay" \(Claude, [^)]*\); the task arrived\. Do not start it again\./);
  assert.deepEqual([data.project, data.workspace_id, data.new_workspace, data.outcome], ["proxy", "wks_relay", false, "replied"]);
});

test("a name settles on the row it names: its title, or the title of a chat in it, with or without the project", async () => {
  for (const name of ["Fix relay", "fix relay (proxy)", "Relay timeouts", "relay timeouts proxy", "fix-relay"]) {
    const paseo = daemon();
    const result = await startChatOn(paseo, { workspace: name, prompt: "go", waitSeconds: 0 });
    assert.equal(created(paseo)[0]?.workspaceId, "wks_relay", name);
    assert.equal(result.data.new_workspace, false, name);
  }
  const empty = daemon();
  await startChatOn(empty, { workspace: "Notes", prompt: "go", waitSeconds: 0 });
  assert.equal(created(empty)[0].workspaceId, "wks_notes", "a row with no chat is reached by its title");
  assert.equal(created(empty)[0].cwd, "/Users/r/lab");
  const several = daemon();
  await startChatOn(several, { workspace: "fleet map stage", prompt: "go", waitSeconds: 0 });
  assert.equal(created(several)[0].workspaceId, "wks_fleet", "the words of one chat's title are enough: only that row has them all");
});

test("a project narrows the rows, and a workspace of another project is not taken", async () => {
  const inProxy = daemon();
  await startChatOn(inProxy, { project: "proxy", workspace: "Fix relay", prompt: "go", waitSeconds: 0 });
  assert.equal(created(inProxy)[0].workspaceId, "wks_relay");
  const wrong = daemon();
  const result = await startChatOn(wrong, { project: "lab", workspace: "Fix relay", prompt: "go", waitSeconds: 0 });
  assert.equal(created(wrong).length, 0, "nothing started");
  assert.deepEqual([result.data.needs_clarification.kind, result.data.needs_clarification.reason], ["workspace", "no_match"]);
  assert.deepEqual(result.data.needs_clarification.candidates.map((c) => c.workspace_id).sort(), ["wks_notes", "wks_twin_a", "wks_twin_b"], "only lab's rows are offered");
  const spoken = await startChatOn(daemon(), { project: "прокси", workspace: "Fix relay", prompt: "go" });
  assert.equal(spoken.data.needs_clarification.kind, "project", "a project that matches nothing lists the projects");
});

test("two rows with the same name, a partial name and no match start nothing and offer the rows", async () => {
  const twins = daemon();
  const same = await startChatOn(twins, { workspace: "Deploy scripts", prompt: "go" });
  assert.equal(created(twins).length, 0);
  assert.deepEqual([same.data.needs_clarification.kind, same.data.needs_clarification.reason], ["workspace", "same_name"]);
  assert.deepEqual(same.data.needs_clarification.candidates.map((c) => c.workspace_id), ["wks_twin_b", "wks_twin_a"], "the one with the newest chat first");
  assert.match(same.text, /^2 workspaces are named "Deploy scripts", so no chat was started\.\nAsk the user which one, naming what tells them apart\./);
  assert.match(same.text, /Deploy scripts \(lab\): 1 chats?|Deploy scripts \(lab\): idle/);
  const partial = await startChatOn(daemon(), { workspace: "fleet zebra", prompt: "go" });
  assert.equal(partial.data.needs_clarification.reason, "partial", "a word that fits no row is no reason to pick the nearest");
  const none = await startChatOn(daemon(), { workspace: "прокси", prompt: "go" });
  assert.equal(none.data.needs_clarification.reason, "no_match");
  assert.equal(none.data.needs_clarification.candidates.length, 5, "the most recent rows, for a name said in another script");
  assert.match(none.text, /^No workspace matches "прокси", so no chat was started\.\nThe most recent workspaces follow; the user may have said a name in another language or spelling\./);
  assert.equal(created(twins).length + created(daemon()).length, 0);
});

test("without a workspace the chat gets one of its own, as before, and the answer names it for the next call", async () => {
  const paseo = daemon();
  const { text, data } = await startChatOn(paseo, { project: "lab", prompt: "Reply OK.", waitSeconds: 5 });
  assert.deepEqual(created(paseo), [{ provider: "claude", cwd: "/Users/r/lab", initialPrompt: "Reply OK.", labels: { source: "god-mode" } }], "no workspaceId in the request");
  assert.match(text, /^Started a new chat in lab \(/);
  assert.deepEqual([data.workspace_id, data.new_workspace], ["wks_made_now", true], "its workspace, to open another chat beside it");
  const beside = await startChatOn(paseo, { workspace: data.workspace_id, prompt: "Another.", waitSeconds: 0 });
  assert.deepEqual([beside.data.new_workspace, beside.data.workspace_id], [false, "wks_made_now"], "another chat beside the one just started");
  assert.deepEqual(created(paseo)[1], { provider: "claude", cwd: "/Users/r/lab", workspaceId: "wks_made_now", initialPrompt: "Another.", labels: { source: "god-mode" } });
});

test("the runtime, model and level asked for are checked in the workspace's catalog", async () => {
  const paseo = daemon();
  const { data } = await startChatOn(paseo, { workspace: "wks_fleet", prompt: "go", model: "Opus 5.5", thinking: "max", waitSeconds: 0 });
  assert.deepEqual(created(paseo)[0], { provider: "claude", cwd: "/Users/r/proxy", workspaceId: "wks_fleet", initialPrompt: "go", model: "claude-opus-5-5", thinkingOptionId: "max", labels: { source: "god-mode" } });
  assert.equal(data.new_workspace, false);
  const bad = daemon();
  const ask = await startChatOn(bad, { workspace: "wks_fleet", prompt: "go", thinking: "ultra" });
  assert.equal(ask.data.needs_clarification.kind, "thinking");
  assert.equal(created(bad).length, 0);
});

test("settleRow and rowsQuestion: whole names and every word, never a partial match", () => {
  const row = (id, name, project, titles = [], branch = null) => ({ id, name, project, branch, pinnedAt: null, status: "done", directory: `/Users/r/${project}`, chats: titles.map((title, i) => ({ id: `${id}-${i}`, title, project, status: "idle", permissions: [], updatedAt: at(i + 1) })) });
  const rows = [row("a", "Fleet map", "proxy", ["Fleet map, stage D"], "fleet-d"), row("b", "Local cluster", "lab", ["Cluster step 6 helm"], "helm"), row("c", "Deploy", "lab"), row("d", "Deploy", "proxy")];
  assert.equal(settleRow(rows, "fleet map").row.id, "a");
  assert.equal(settleRow(rows, "Fleet map (proxy)").row.id, "a");
  assert.equal(settleRow(rows, "cluster helm").row.id, "b", "every word, across the title and the branch and a chat's title");
  assert.equal(settleRow(rows, "deploy lab").row.id, "c", "the project tells twins apart");
  assert.deepEqual(settleRow(rows, "deploy").ask, "same_name");
  assert.deepEqual(settleRow(rows, "deploy").rows.map((r) => r.id), ["c", "d"]);
  assert.equal(settleRow(rows, "fleet zebra").ask, "partial");
  assert.equal(settleRow(rows, "zebra").ask, "no_match");
  assert.equal(settleRow(rows, "  ").ask, "no_match");
  const question = rowsQuestion("deploy", "same_name", rows.slice(2));
  assert.equal(question.data.needs_clarification.candidates.length, 2);
  assert.equal(question.data.needs_clarification.candidates[0].workspace_id, "c");
  assert.match(question.text, /- Deploy \(lab\): no active chat/);
});
