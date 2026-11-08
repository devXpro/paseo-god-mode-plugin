// Run with: node --test core/
// rename_chat and rename_workspace against a fake daemon that answers as Paseo 0.15 does: a workspace's
// name is its title, else its derived name, the title request leaves its pin alone, and a chat's rename
// is accepted even where Paseo drops it. Every name in an answer comes from reading Paseo back. No network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createMcpHandler, readConfig } from "./mcp.mjs";
import { listPinnedChatsOn, renameChatOn, renameWorkspaceOn } from "./paseo.mjs";
import { rowsQuestion } from "./text.mjs";

const NOW = Date.now();
const at = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const PIN_TIME = at(90);

const workspace = (id, title, project, fields = {}) => ({ id, title, displayName: project, projectDisplayName: project, status: "done", gitRuntime: null, pinnedAt: null, ...fields });
const FLEET = workspace("wks_fleet", "Fleet map", "proxy", { pinnedAt: PIN_TIME, status: "running" });
const OPEN = workspace("wks_open", null, "lab", { displayName: "open-branch" });
const TWIN_A = workspace("wks_twin_a", "Deploy scripts", "lab");
const TWIN_B = workspace("wks_twin_b", "Deploy scripts", "lab");
const EMPTY = workspace("wks_empty", "Old notes", "lab", { pinnedAt: PIN_TIME });

const FLEET_D = "a2252400-0000-4000-8000-000000000001";
const FLEET_E = "a2252400-0000-4000-8000-000000000002";
const OPEN_CHAT = "b7c1d2e3-0000-4000-8000-000000000003";
const TWIN_CHAT_A = "c3d4e5f6-0000-4000-8000-000000000004";
const TWIN_CHAT_B = "c3d4e5f6-0000-4000-8000-000000000005";
const ARCHIVED_CHAT = "d4e5f607-0000-4000-8000-000000000006";

const chat = (id, title, ws, minutes, fields = {}) => ({
  agent: { id, title, workspaceId: ws.id, status: "idle", pendingPermissions: [], updatedAt: at(minutes), createdAt: at(minutes + 60), archivedAt: null, cwd: "/Users/r/lab", provider: "claude", currentModeId: "default", ...fields },
  project: { projectName: ws.projectDisplayName, workspaceName: ws.title ?? ws.displayName },
});

// quirks: refuse (the request fails), drop (accepted, nothing written), other (accepted, another name
// stands), unreadable (reading back fails), landed (the request fails, the name is written all the same).
function daemon({ quirks = {} } = {}) {
  const calls = [];
  const rows = [FLEET, OPEN, TWIN_A, TWIN_B, EMPTY].map((w) => ({ ...w }));
  const agents = [
    chat(FLEET_D, "Fleet map, stage D", FLEET, 2, { status: "running" }),
    chat(FLEET_E, "Fleet map tests", FLEET, 9),
    chat(OPEN_CHAT, "Open work", OPEN, 1),
    chat(TWIN_CHAT_A, "Scripts first pass", TWIN_A, 30),
    chat(TWIN_CHAT_B, "Scripts second pass", TWIN_B, 20),
    chat(ARCHIVED_CHAT, "Retired gadget", OPEN, 400, { archivedAt: at(300) }),
  ];
  let wrote = false;
  const written = (write, value) => {
    if (quirks.drop) return;
    write(quirks.other ?? value);
    wrote = true;
  };
  return {
    calls,
    async fetchWorkspaces() {
      if (wrote && quirks.unreadable) throw new Error("relay closed");
      return { entries: rows.map((w) => ({ ...w, name: w.title ?? w.displayName })), pageInfo: { nextCursor: null, prevCursor: null, hasMore: false } };
    },
    async fetchAgents() {
      const active = agents.filter((a) => !a.agent.archivedAt);
      return { entries: active.sort((a, b) => Date.parse(b.agent.updatedAt) - Date.parse(a.agent.updatedAt)) };
    },
    async fetchAgentHistory() {
      return { entries: agents };
    },
    // As Paseo's resolveAgentIdentifier: an id or the start of one, archived chats included.
    async fetchAgent(identifier) {
      if (wrote && quirks.unreadable) throw new Error("relay closed");
      const found = agents.filter((a) => a.agent.id.startsWith(identifier));
      return found.length === 1 ? found[0] : null;
    },
    async listProjects() {
      return { projects: [{ projectDisplayName: "lab", projectRootPath: "/Users/r/lab" }, { projectDisplayName: "proxy", projectRootPath: "/Users/r/proxy" }] };
    },
    async updateAgent(id, updates) {
      calls.push(["updateAgent", id, updates]);
      if (quirks.refuse) throw new Error(quirks.refuse);
      written((name) => {
        agents.find((a) => a.agent.id === id).agent.title = name;
      }, updates.name);
      if (quirks.landed) throw new Error("no answer in time");
    },
    // Paseo's workspace.title.set: only title and updatedAt change.
    async setWorkspaceTitle(id, title) {
      calls.push(["setWorkspaceTitle", id, title]);
      if (quirks.refuse) throw new Error(quirks.refuse);
      written((name) => {
        const row = rows.find((w) => w.id === id);
        row.title = name;
        row.updatedAt = new Date(NOW).toISOString();
      }, title);
      if (quirks.landed) throw new Error("no answer in time");
      return { title };
    },
  };
}

const LIST_AFTER = (result) => result.data.pinned.map((row) => ({ id: row.workspace_id, name: row.name, pinned_at: row.pinned_at, chats: row.chats.map((c) => c.id) }));

test("rename_workspace: the Pinned section shows the new name, the pin and the chats stay, and both names are Paseo's", async () => {
  const paseo = daemon();
  const before = await listPinnedChatsOn(paseo, {});
  const { text, data } = await renameWorkspaceOn(paseo, { workspace: "Fleet map", name: "Proxy fleet" });
  assert.deepEqual(paseo.calls, [["setWorkspaceTitle", "wks_fleet", "Proxy fleet"]], "one request, for that row");
  assert.equal(data.workspace_id, "wks_fleet");
  assert.equal(data.project, "proxy");
  assert.equal(data.outcome, "renamed");
  assert.equal(data.done, true);
  assert.equal(data.old_name, "Fleet map");
  assert.equal(data.new_name, "Proxy fleet");
  assert.equal(data.pinned, true, "read back after the change");
  assert.equal(data.pinned_at, PIN_TIME, "the pin is the same pin, not a new one");
  assert.deepEqual(data.chats.map((c) => [c.id, c.title]), [[FLEET_D, "Fleet map, stage D"], [FLEET_E, "Fleet map tests"]]);
  assert.match(text, /^Renamed the workspace "Fleet map" to "Proxy fleet" \(proxy\)\. Paseo's sidebar shows the new name now\. It stays pinned, and the Pinned section shows the new name\. Its 2 chats keep their own names\.$/);
  assert.doesNotMatch(text, /wks_|a2252400/, "no ids to read aloud");
  const after = await listPinnedChatsOn(paseo, {});
  const [was, now] = [LIST_AFTER(before)[0], LIST_AFTER(after)[0]];
  assert.deepEqual(now, { ...was, name: "Proxy fleet" }, "list_pinned_chats: only the label moved");
  assert.equal(after.data.total, before.data.total, "no row came or went");
  assert.deepEqual(LIST_AFTER(after).slice(1), LIST_AFTER(before).slice(1), "the other pins are untouched");
});

test("rename_workspace reaches a row by its id, its name with the project, or a chat in it", async () => {
  for (const reference of ["wks_fleet", " wks_fleet ", "Fleet map (proxy)", "fleet map proxy", "Fleet map tests"]) {
    const paseo = daemon();
    const { data } = await renameWorkspaceOn(paseo, { workspace: reference, name: "Proxy fleet" });
    assert.deepEqual(paseo.calls, [["setWorkspaceTitle", "wks_fleet", "Proxy fleet"]], reference);
    assert.equal(data.outcome, "renamed", reference);
  }
});

test("rename_workspace names a row with no title of its own by the name it shows, and says nothing of a pin it has not got", async () => {
  const paseo = daemon();
  const { text, data } = await renameWorkspaceOn(paseo, { workspace: "open-branch", name: "Open work area" });
  assert.equal(data.old_name, "open-branch", "the derived name, as the sidebar showed it");
  assert.equal(data.new_name, "Open work area");
  assert.equal(data.pinned, false);
  assert.equal(data.pinned_at, null);
  assert.doesNotMatch(text, /pinned/i);
  assert.match(text, /Its chat keeps its own name\.$/);
});

test("rename_workspace leaves a row without chats a plain answer", async () => {
  const { text, data } = await renameWorkspaceOn(daemon(), { workspace: "Old notes", name: "Older notes" });
  assert.equal(data.outcome, "renamed");
  assert.deepEqual(data.chats, []);
  assert.doesNotMatch(text, /chat/i);
});

test("rename_workspace acts only on one clear match: anything else asks, says nothing was renamed, and sends nothing", async () => {
  for (const [reference, reason, ids] of [
    ["Deploy scripts", "same_name", ["wks_twin_b", "wks_twin_a"]],
    ["fleet zebra", "partial", ["wks_fleet"]],
    ["zebra", "no_match", null],
    ["wks_gone", "no_match", null],
  ]) {
    const paseo = daemon();
    const { text, data } = await renameWorkspaceOn(paseo, { workspace: reference, name: "New name" });
    assert.deepEqual(paseo.calls, [], reference);
    assert.equal(data.needs_clarification.kind, "workspace", reference);
    assert.equal(data.needs_clarification.reason, reason, reference);
    if (ids) assert.deepEqual(data.needs_clarification.candidates.map((c) => c.workspace_id), ids, reference);
    assert.match(text, /, so nothing was renamed\.\n/, reference);
    assert.doesNotMatch(text, /start the chat|no chat was started/, reference);
  }
});

test("start_chat's question about a workspace is unchanged", () => {
  const question = rowsQuestion("zebra", "no_match", [{ id: "w", name: "Notes", project: "lab", chats: [], status: "done", pinnedAt: null }], { now: NOW });
  assert.match(question.text, /^No workspace matches "zebra", so no chat was started\.\nThe most recent workspaces follow; the user may have said a name in another language or spelling\. Ask which one, or start the chat in the project alone, which gives it a workspace of its own:/);
});

test("rename_workspace to the name it already shows changes nothing and sends nothing", async () => {
  const paseo = daemon();
  const { text, data } = await renameWorkspaceOn(paseo, { workspace: "wks_fleet", name: "Fleet map" });
  assert.deepEqual(paseo.calls, []);
  assert.equal(data.outcome, "unchanged");
  assert.equal(data.done, false);
  assert.equal(data.new_name, "Fleet map");
  assert.equal(data.pinned_at, PIN_TIME);
  assert.match(text, /already named "Fleet map" \(proxy\); nothing changed/);
});

test("rename_workspace reports a refusal with the name Paseo still shows, never a new name", async () => {
  const paseo = daemon({ quirks: { refuse: "Workspace not found" } });
  const { text, data } = await renameWorkspaceOn(paseo, { workspace: "wks_fleet", name: "Proxy fleet" });
  assert.equal(data.outcome, "error");
  assert.equal(data.done, false);
  assert.equal(data.old_name, "Fleet map");
  assert.equal(data.new_name, undefined);
  assert.equal(data.current_name, "Fleet map");
  assert.equal(data.error, "Paseo refused it: Workspace not found");
  assert.equal(text, 'Not renamed: Paseo refused it: Workspace not found. Paseo shows "Fleet map" now.');
});

test("rename_workspace takes only what Paseo shows afterwards as the outcome", async () => {
  const accepted = await renameWorkspaceOn(daemon({ quirks: { other: "Someone else's name" } }), { workspace: "wks_fleet", name: "Proxy fleet" });
  assert.equal(accepted.data.outcome, "error", "accepted, but another name stands");
  assert.equal(accepted.data.current_name, "Someone else's name");
  assert.equal(accepted.data.new_name, undefined);
  assert.match(accepted.text, /^Not renamed: Paseo accepted "Proxy fleet", but it does not show that name\. Paseo shows "Someone else's name" now\.$/);

  const dark = await renameWorkspaceOn(daemon({ quirks: { unreadable: true } }), { workspace: "wks_fleet", name: "Proxy fleet" });
  assert.equal(dark.data.outcome, "error", "it could not be read back");
  assert.equal(dark.data.done, false);
  assert.equal(dark.data.new_name, undefined);
  assert.equal(dark.data.current_name, undefined);
  assert.equal(dark.data.pinned, undefined, "nothing read, nothing claimed");
  assert.match(dark.text, /^Not confirmed: Paseo accepted the new name, but it could not be read back\. Whether it took effect is unknown: never say it did\.$/);

  const landed = await renameWorkspaceOn(daemon({ quirks: { landed: true } }), { workspace: "wks_fleet", name: "Proxy fleet" });
  assert.equal(landed.data.outcome, "renamed", "the request failed, but Paseo shows the name");
  assert.equal(landed.data.new_name, "Proxy fleet");
});

test("rename_chat renames a chat by id, confirms it from Paseo, and points at the row's own name", async () => {
  const paseo = daemon();
  const { text, data } = await renameChatOn(paseo, { chat: FLEET_D, name: "Fleet map, stage E" });
  assert.deepEqual(paseo.calls, [["updateAgent", FLEET_D, { name: "Fleet map, stage E" }]], "one request, working chat included");
  assert.equal(data.chat_id, FLEET_D);
  assert.equal(data.short_id, FLEET_D.slice(0, 7));
  assert.equal(data.project, "proxy");
  assert.equal(data.workspace_id, "wks_fleet");
  assert.equal(data.workspace, "Fleet map");
  assert.equal(data.outcome, "renamed");
  assert.equal(data.done, true);
  assert.equal(data.old_name, "Fleet map, stage D");
  assert.equal(data.new_name, "Fleet map, stage E");
  assert.equal(text, 'Renamed the chat "Fleet map, stage D" to "Fleet map, stage E" (proxy). Paseo shows the new name now. Its row in the sidebar keeps the name "Fleet map": that is the workspace\'s name, and rename_workspace changes it.');
  assert.equal((await paseo.fetchAgent(FLEET_D)).agent.title, "Fleet map, stage E", "Paseo itself holds the new name");
  const { data: pinned } = await listPinnedChatsOn(paseo, {});
  assert.equal(pinned.pinned[0].name, "Fleet map", "the row's label is the workspace's");
  assert.equal(pinned.pinned[0].pinned_at, PIN_TIME);
});

test("rename_chat by name takes one whole match; the row's note goes when it already reads the same", async () => {
  const paseo = daemon();
  const { text, data } = await renameChatOn(paseo, { chat: "Open work", name: "open-branch" });
  assert.equal(data.chat_id, OPEN_CHAT);
  assert.equal(data.new_name, "open-branch");
  assert.doesNotMatch(text, /keeps the name/);
});

test("rename_chat asks on anything less than one clear match, and sends nothing", async () => {
  for (const [reference, reason] of [["Scripts pass", "similar"], ["Fleet zebra", "partial"], ["zebra", "no_match"], ["00000000-0000-4000-8000-000000000000", "unknown_id"]]) {
    const paseo = daemon();
    const { data } = await renameChatOn(paseo, { chat: reference, name: "New name" });
    assert.deepEqual(paseo.calls, [], reference);
    assert.equal(data.needs_clarification.kind, "chat", reference);
    assert.equal(data.needs_clarification.reason, reason, reference);
  }
});

test("an archived chat is left alone, and a name never reaches it", async () => {
  const byId = daemon();
  const { text, data } = await renameChatOn(byId, { chat: ARCHIVED_CHAT, name: "New name" });
  assert.deepEqual(byId.calls, []);
  assert.equal(data.outcome, "archived");
  assert.equal(data.done, false);
  assert.equal(data.old_name, "Retired gadget");
  assert.equal(data.new_name, undefined);
  assert.match(text, /^Nothing changed: "Retired gadget" \(lab\) is archived\./);
  const byName = daemon();
  assert.equal((await renameChatOn(byName, { chat: "Retired gadget", name: "New name" })).data.needs_clarification.reason, "no_match");
  assert.deepEqual(byName.calls, []);
});

test("rename_chat to the name it has changes nothing", async () => {
  const paseo = daemon();
  const { text, data } = await renameChatOn(paseo, { chat: OPEN_CHAT, name: "Open work" });
  assert.deepEqual(paseo.calls, []);
  assert.equal(data.outcome, "unchanged");
  assert.equal(data.done, false);
  assert.equal(data.new_name, "Open work");
  assert.match(text, /already named "Open work" \(lab\); nothing changed/);
});

test("rename_chat takes only what Paseo shows afterwards as the outcome, also where it accepted the name and dropped it", async () => {
  const refused = await renameChatOn(daemon({ quirks: { refuse: "Agent not found" } }), { chat: OPEN_CHAT, name: "New name" });
  assert.equal(refused.data.outcome, "error");
  assert.equal(refused.data.done, false);
  assert.equal(refused.data.new_name, undefined);
  assert.equal(refused.data.current_name, "Open work");
  assert.equal(refused.text, 'Not renamed: Paseo refused it: Agent not found. Paseo shows "Open work" now.');

  const dropped = await renameChatOn(daemon({ quirks: { drop: true } }), { chat: OPEN_CHAT, name: "New name" });
  assert.equal(dropped.data.outcome, "error", "Paseo said accepted");
  assert.equal(dropped.data.current_name, "Open work");
  assert.equal(dropped.data.new_name, undefined);
  assert.match(dropped.text, /^Not renamed: Paseo accepted "New name", but it does not show that name\. Paseo shows "Open work" now\.$/);

  const dark = await renameChatOn(daemon({ quirks: { unreadable: true } }), { chat: OPEN_CHAT, name: "New name" });
  assert.equal(dark.data.outcome, "error");
  assert.equal(dark.data.current_name, undefined);
  assert.match(dark.text, /^Not confirmed: Paseo accepted the new name, but it could not be read back\. Whether it took effect is unknown: never say it did\.$/);

  const landed = await renameChatOn(daemon({ quirks: { landed: true } }), { chat: OPEN_CHAT, name: "New name" });
  assert.equal(landed.data.outcome, "renamed");
  assert.equal(landed.data.new_name, "New name");
});

test("the MCP handler reaches the same operations with the name it was given, trimmed", async () => {
  const paseo = daemon();
  const url = "https://app.paseo.sh/#offer=secret";
  const ops = {
    renameChat: (_url, args) => renameChatOn(paseo, args),
    renameWorkspace: (_url, args) => renameWorkspaceOn(paseo, args),
  };
  const handle = createMcpHandler({ config: readConfig({ PASEO_PAIRING_URL: url }), ops });
  const call = (name, args) => handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const chat = await call("rename_chat", { chat: OPEN_CHAT, new_name: "  Spoken name  " });
  assert.equal(chat.result.structuredContent.new_name, "Spoken name");
  const row = await call("rename_workspace", { workspace: " wks_empty ", new_name: "  Spoken row\t" });
  assert.equal(row.result.structuredContent.new_name, "Spoken row");
  assert.deepEqual(paseo.calls, [["updateAgent", OPEN_CHAT, { name: "Spoken name" }], ["setWorkspaceTitle", "wks_empty", "Spoken row"]]);
});
