// Run with: node --test core/
// list_pinned_chats and pin_chat against a fake daemon that answers as Paseo 0.13 does: workspaces in
// pages of descriptors, a pinned one carrying pinnedAt, the active chats, each with the workspace it
// runs in, and the pin request of Paseo's Pin and Unpin. No network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { listPinnedChatsOn, pinChatOn } from "./paseo.mjs";

const NOW = Date.now();
const at = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

// A workspace descriptor; pinnedAt is how long ago it was pinned, in minutes.
const workspace = (id, name, fields = {}) => ({ id, name, projectDisplayName: "lab", status: "done", gitRuntime: null, ...fields, pinnedAt: fields.pinnedAt === undefined ? null : at(fields.pinnedAt) });
// A chat as fetch_agents gives it, in its workspace; active unless fields say otherwise.
const chat = (id, title, ws, minutes, fields = {}) => ({
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
    ...fields,
  },
  project: { projectName: ws.projectDisplayName, workspaceName: ws.name },
});

const FLEET = workspace("wks_fleet", "Fleet map", { projectDisplayName: "proxy", pinnedAt: 30, status: "running" });
const OPEN = workspace("wks_open", "Not pinned");
const CLUSTER = workspace("wks_cluster", "Local cluster, step 6 (helm)", { pinnedAt: 5, gitRuntime: { currentBranch: "helm" } });
const DEPLOY = workspace("wks_deploy", "Deploy scripts", { pinnedAt: 300 });
// Not pinned, on the second page, with two chats: the row titled like the first of them.
const RELAY = workspace("wks_relay", "Relay timeouts", { projectDisplayName: "proxy" });
const PROJECTS = [
  { projectDisplayName: "lab", projectRootPath: "/Users/r/lab" },
  { projectDisplayName: "proxy", projectRootPath: "/Users/r/proxy" },
];

function fakeDaemon({ pages, chats }) {
  const log = { cursors: [], projectLists: 0, history: 0, pins: [] };
  // Newest first, as the daemon sorts them for fetchChats.
  const active = chats.filter((c) => !c.agent.archivedAt).sort((a, b) => Date.parse(b.agent.updatedAt) - Date.parse(a.agent.updatedAt));
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
    // As Paseo's resolveAgentIdentifier: an id or the start of one, archived chats included.
    async fetchAgent(identifier) {
      const found = chats.filter((c) => c.agent.id.startsWith(identifier));
      return found.length === 1 ? found[0] : null;
    },
    // Paseo's workspace.pin.set: pinnedAt is the time of the request, or null.
    async setWorkspacePinned(workspaceId, pinned) {
      log.pins.push({ workspaceId, pinned });
      return { pinnedAt: pinned ? new Date(NOW).toISOString() : null };
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

const FLEET_CHAT = "a2252400-0000-4000-8000-000000000001";
const OPEN_CHAT = "b7c1d2e3-0000-4000-8000-000000000002";
const RELAY_CHAT = "5d6e7f80-0000-4000-8000-000000000005";
const LOAD_CHAT = "5d6e7f80-0000-4000-8000-000000000006";

const daemon = (more = []) =>
  fakeDaemon({
    pages: [[FLEET, OPEN], [CLUSTER, DEPLOY, RELAY]],
    chats: [
      chat(FLEET_CHAT, "Fleet map, stage D", FLEET, 2),
      chat(OPEN_CHAT, "Open work", OPEN, 1),
      chat("739a96bc-0000-4000-8000-000000000003", "Продолжаем учебный кластер на миникубе", CLUSTER, 40),
      chat("739a96bc-0000-4000-8000-000000000004", "Кластер, шаг 6: helm", CLUSTER, 10),
      chat(RELAY_CHAT, "Relay timeouts", RELAY, 3),
      chat(LOAD_CHAT, "Relay load test", RELAY, 50),
      ...more,
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

test("pin_chat pins a chat's row on any page, as Paseo's Pin does, and names the chats that go with it", async () => {
  const paseo = daemon();
  const { text, data } = await pinChatOn(paseo, { chat: "Relay load test", action: "pin" });
  assert.deepEqual(paseo.log.pins, [{ workspaceId: "wks_relay", pinned: true }], "the second page is read, and the row is pinned once");
  assert.equal(
    text,
    'Pinned Relay load test (proxy): its row "Relay timeouts" is in the Pinned section at the top of Paseo\'s sidebar now. Paseo pins the whole row, so its other chat goes with it: Relay timeouts.',
  );
  assert.equal(data.chat_id, LOAD_CHAT);
  assert.equal(data.workspace_id, "wks_relay");
  assert.equal(data.name, "Relay timeouts");
  assert.equal(data.project, "proxy");
  assert.equal(data.action, "pin");
  assert.equal(data.outcome, "pinned");
  assert.equal(data.done, true);
  assert.equal(data.pinned_at, new Date(NOW).toISOString());
  assert.deepEqual(data.chats.map((c) => c.id), [RELAY_CHAT, LOAD_CHAT], "the row's chats, newest first");
  assert.equal(paseo.log.history, 0, "the archive is never looked in");
});

test("pin_chat by id reaches the chat just started, and a row that holds only it says nothing more", async () => {
  const paseo = daemon();
  const { text, data } = await pinChatOn(paseo, { chat: OPEN_CHAT, action: "pin" });
  assert.deepEqual(paseo.log.pins, [{ workspaceId: "wks_open", pinned: true }]);
  assert.equal(text, 'Pinned Open work (lab): its row "Not pinned" is in the Pinned section at the top of Paseo\'s sidebar now.');
  assert.equal(data.outcome, "pinned");
});

test("a name the chats of one row share names the row: pinned without asking which chat", async () => {
  // "Relay timeouts" is the first chat's title and its row's title, so it is a whole name of both.
  const paseo = daemon();
  const { text, data } = await pinChatOn(paseo, { chat: "Relay timeouts", action: "pin" });
  assert.deepEqual(paseo.log.pins, [{ workspaceId: "wks_relay", pinned: true }]);
  assert.equal(data.needs_clarification, undefined);
  assert.equal(data.chat_id, undefined, "no one chat was picked");
  assert.equal(text, "Pinned Relay timeouts (proxy): its row is in the Pinned section at the top of Paseo's sidebar now. The row holds: Relay timeouts; Relay load test.");
});

test("chats of different rows a name fits equally are asked about, and nothing is pinned", async () => {
  const twin = workspace("wks_twin", "Relay timeouts, again", { projectDisplayName: "lab" });
  const paseo = fakeDaemon({ pages: [[RELAY, twin]], chats: [chat(RELAY_CHAT, "Relay timeouts", RELAY, 3), chat("5d6e7f80-0000-4000-8000-000000000007", "Relay timeouts", twin, 9)] });
  const { text, data } = await pinChatOn(paseo, { chat: "Relay timeouts", action: "pin" });
  assert.equal(data.needs_clarification.reason, "same_name");
  assert.equal(data.needs_clarification.candidates.length, 2);
  assert.match(text, /^2 chats are named "Relay timeouts", so nothing was done\./);
  assert.deepEqual(paseo.log.pins, []);
});

test("unpin takes a pinned chat's row out of Pinned; a pin or unpin already as asked changes nothing", async () => {
  let paseo = daemon();
  const unpinned = await pinChatOn(paseo, { chat: FLEET_CHAT.slice(0, 7), action: "unpin" });
  assert.deepEqual(paseo.log.pins, [{ workspaceId: "wks_fleet", pinned: false }]);
  assert.equal(unpinned.text, 'Unpinned Fleet map, stage D (proxy): its row "Fleet map" left the Pinned section of Paseo\'s sidebar.');
  assert.deepEqual([unpinned.data.outcome, unpinned.data.done, unpinned.data.pinned_at], ["unpinned", true, null]);
  // Pinning again would move the row to the top of Pinned: a pin is left as it is.
  paseo = daemon();
  const again = await pinChatOn(paseo, { chat: "Fleet map, stage D", action: "pin" });
  assert.equal(again.text, "Fleet map, stage D (proxy) is already pinned, since 30 min ago; nothing changed.");
  assert.deepEqual([again.data.outcome, again.data.done], ["already_pinned", false]);
  assert.equal(again.data.pinned_at, FLEET.pinnedAt, "its place in Pinned is kept");
  const loose = await pinChatOn(paseo, { chat: "Open work", action: "unpin" });
  assert.equal(loose.text, "Open work (lab) is not pinned; nothing changed.");
  assert.deepEqual([loose.data.outcome, loose.data.done], ["not_pinned", false]);
  assert.deepEqual(paseo.log.pins, []);
});

test("a pinned row with no chat is unpinned by its workspace id; an id of no row is asked about", async () => {
  const paseo = daemon();
  const { text, data } = await pinChatOn(paseo, { workspaceId: "wks_deploy", action: "unpin" });
  assert.deepEqual(paseo.log.pins, [{ workspaceId: "wks_deploy", pinned: false }]);
  assert.equal(text, "Unpinned Deploy scripts (lab): its row left the Pinned section of Paseo's sidebar. The row holds no active chat.");
  assert.deepEqual([data.workspace_id, data.outcome, data.done, data.chats], ["wks_deploy", "unpinned", true, []]);
  const gone = await pinChatOn(paseo, { workspaceId: "wks_gone", action: "unpin" });
  assert.deepEqual(gone.data, { needs_clarification: { kind: "workspace", query: "wks_gone", candidates: [] } });
  assert.match(gone.text, /^No row of Paseo's sidebar has the workspace id "wks_gone", so nothing was done\./);
  assert.equal(paseo.log.pins.length, 1);
});

test("an archived chat, reached by its id only, and a chat with no row change nothing", async () => {
  const lost = workspace("wks_lost", "Archived away");
  const paseo = daemon([
    chat("6e7f8091-0000-4000-8000-000000000008", "Old DNSSEC check", DEPLOY, 900, { archivedAt: at(800) }),
    chat("6e7f8091-0000-4000-8000-000000000009", "Orphan", lost, 4),
  ]);
  const archived = await pinChatOn(paseo, { chat: "6e7f8091-0000-4000-8000-000000000008", action: "pin" });
  assert.equal(archived.text, "Nothing changed: Old DNSSEC check (lab) is archived, so it is not in Paseo's sidebar.");
  assert.deepEqual([archived.data.outcome, archived.data.done, archived.data.workspace_id], ["archived", false, undefined]);
  const leftover = await pinChatOn(paseo, { chat: "6e7f8091-0000-4000-8000-000000000008", action: "unpin" });
  assert.match(leftover.text, /list_pinned_chats gives that row's workspace_id to unpin it\.$/);
  const byName = await pinChatOn(paseo, { chat: "Old DNSSEC check", action: "pin" });
  assert.equal(byName.data.needs_clarification.reason, "no_match", "a name never reaches the archive");
  const orphan = await pinChatOn(paseo, { chat: "Orphan", action: "pin" });
  assert.equal(orphan.text, "Nothing changed: Paseo's sidebar shows no row for Orphan (lab).");
  assert.deepEqual([orphan.data.outcome, orphan.data.done], ["no_row", false]);
  assert.deepEqual(paseo.log.pins, []);
  assert.equal(paseo.log.history, 0);
});

test("a row with no chat is reached by every word of its name, when only one such row has them", async () => {
  let paseo = daemon();
  const unpinned = await pinChatOn(paseo, { chat: "Deploy scripts", action: "unpin" });
  assert.deepEqual(paseo.log.pins, [{ workspaceId: "wks_deploy", pinned: false }], "no chat has the name: the empty pinned row does");
  assert.equal(unpinned.text, "Unpinned Deploy scripts (lab): its row left the Pinned section of Paseo's sidebar. The row holds no active chat.");
  // A chat that has only some of the words does not stand in the way of the row that has them all.
  paseo = daemon([chat("7f8091a2-0000-4000-8000-00000000000a", "Deploy fixes", OPEN, 6)]);
  assert.equal((await pinChatOn(paseo, { chat: "deploy scripts", action: "unpin" })).data.workspace_id, "wks_deploy");
  // Two empty rows with the word: nothing to settle on, so the user is asked, and nothing changes.
  const notes = workspace("wks_notes", "Deploy notes");
  paseo = fakeDaemon({ pages: [[DEPLOY, notes]], chats: [chat(OPEN_CHAT, "Open work", OPEN, 1)] });
  const unclear = await pinChatOn(paseo, { chat: "deploy", action: "unpin" });
  assert.equal(unclear.data.needs_clarification.reason, "no_match");
  assert.deepEqual(paseo.log.pins, []);
});
