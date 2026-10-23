// Run with: node --test core/
// Which chat a reference reaches, through every tool that takes one, against a fake daemon that
// answers as Paseo 0.12 does: the active chats, the history with archived ones, and an id lookup
// that takes the start of an id and refuses one several ids share. No network.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  answerApprovalOn,
  archiveChatOn,
  listSlashCommandsOn,
  readActivityOn,
  readChatOn,
  runSlashCommandOn,
  searchMessagesOn,
  sendMessageOn,
  showImagesOn,
  stopChatOn,
} from "./paseo.mjs";

const NOW = Date.now();
const at = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

// The shape of a real case (2026-10-23): Paseo titles a chat with the first line of its first
// message cut at 60 characters, so two chats continuing the same work are both titled CUT, and the
// user (or ChatGPT) says the whole line.
const CUT = "Продолжаем учебный кластер demo-dev на миникубе в тестовом а";
const SAID = "Продолжаем учебный кластер demo-dev на миникубе в тестовом аккаунте";

// A chat as the daemon keeps it; minutes since its last update orders the list, newest first.
const chat = (id, title, fields = {}) => ({ id, title, project: "lab", workspace: null, status: "idle", minutes: 30, permissions: [], archived: false, ...fields });
const STEP5 = chat("5e7a0c11-2b3c-4d5e-8f60-718293a4b5c6", CUT, { workspace: "Продолжить demo-dev minikube: шаг 5 in-cluster", minutes: 180 });
const PLAN4 = chat("6b2f9d40-3c4d-4e5f-9a01-2b3c4d5e6f70", CUT, { workspace: "Plan demo-dev minikube monitoring questions §4", minutes: 1500 });
const OLD3 = chat("8a9b0c1d-4d5e-4f60-8a12-3b4c5d6e7f81", CUT, { workspace: "Настроить demo-dev: ingress", minutes: 2000, archived: true });
const STAGE = chat("7c1d2e3f-5e6f-4a70-9b81-c2d3e4f5a6b7", "Обкатка demo-dev на стенде + дока для прода", { minutes: 600 });
const LAB = [STEP5, PLAN4, OLD3, STAGE];

const APPROVAL = { id: "perm-1", kind: "tool", name: "Bash", title: "Bash", detail: { type: "shell", command: "npm publish" }, actions: [{ id: "allow-once", behavior: "allow" }] };
const IDLE_TWIN = chat("1a2b3c4d-0000-4000-8000-000000000001", "Release notes 0.6", { minutes: 2 });
const BUSY_TWIN = chat("4e5f6a7b-0000-4000-8000-000000000002", "Release notes 0.6", { minutes: 400, status: "running", permissions: [APPROVAL] });

function fakeDaemon(chats) {
  const log = { sent: [], answered: [], cancelled: [], archived: [], read: [] };
  let archiveLookups = 0;
  const agent = (c) => ({
    agent: {
      id: c.id,
      title: c.title,
      status: c.status,
      requiresAttention: c.permissions.length > 0,
      attentionReason: c.permissions.length > 0 ? "permission" : null,
      pendingPermissions: c.permissions,
      updatedAt: at(c.minutes),
      createdAt: at(c.minutes + 60),
      archivedAt: c.archived ? at(c.minutes) : null,
      cwd: `/Users/r/${c.project}`,
      provider: "claude",
      currentModeId: "default",
    },
    // Paseo's workspace name: the workspace's own title, else the project's name.
    project: { projectName: c.project, workspaceName: c.workspace ?? c.project },
  });
  const newestFirst = () => [...chats].sort((a, b) => a.minutes - b.minutes);
  const byId = (id) => chats.find((c) => c.id === id);
  const timeline = (c) => [
    { seqStart: 1, timestamp: at(c.minutes + 5), item: { type: "user_message", text: "go on" } },
    { seqStart: 2, timestamp: at(c.minutes), item: { type: "assistant_message", text: `Reply from ${c.id.slice(0, 8)}.` } },
  ];
  return {
    log,
    // How often the archive was listed: never, unless the user asked for it.
    get archiveLookups() {
      return archiveLookups;
    },
    async fetchAgents() {
      return { entries: newestFirst().filter((c) => !c.archived).map(agent) };
    },
    async fetchAgentHistory() {
      archiveLookups += 1;
      return { entries: newestFirst().map(agent) };
    },
    // As Paseo's resolveAgentIdentifier: an id or the start of one id; null for none.
    async fetchAgent(identifier) {
      const found = chats.filter((c) => c.id.startsWith(identifier));
      if (found.length > 1) throw new Error(`Agent identifier "${identifier}" is ambiguous (${found.map((c) => c.id.slice(0, 8)).join(", ")})`);
      return found.length === 1 ? agent(found[0]) : null;
    },
    async sendAgentMessage(id, text, options) {
      log.sent.push({ id, text, options });
    },
    async waitForFinish() {
      return { status: "idle", lastMessage: "On it." };
    },
    async respondToPermissionAndWait(id, permissionId, response) {
      log.answered.push({ id, permissionId, behavior: response.behavior });
    },
    async cancelAgent(id) {
      log.cancelled.push(id);
    },
    async archiveAgent(id) {
      log.archived.push(id);
      return { archivedAt: at(0) };
    },
    async listProviderSubagents() {
      return { subagents: [] };
    },
    async listAgentTimelinePrompts(id) {
      log.read.push(id);
      return { epoch: "e1", prompts: [{ seq: 1, preview: "go on", timestamp: at(byId(id).minutes + 5) }] };
    },
    async fetchAgentTimeline(id) {
      return { epoch: "e1", entries: timeline(byId(id)) };
    },
    async searchAgentTimeline({ agentId }) {
      log.read.push(agentId);
      return { epoch: "e1", locations: [] };
    },
    async listCommands({ agentId }) {
      log.read.push(agentId);
      return { commands: [{ name: "compact", description: "Free up context by summarizing the conversation so far", argumentHint: "", kind: "command" }] };
    },
  };
}

const NOTHING = { sent: [], answered: [], cancelled: [], archived: [], read: [] };
const send = (daemon, chatRef, extra = {}) => sendMessageOn(daemon, { chat: chatRef, text: "проверь поды", waitSeconds: 1, ...extra });

// Every tool that takes a chat, by the operation behind it.
const WRITES = {
  send_message: (daemon, ref) => send(daemon, ref),
  answer_approval: (daemon, ref) => answerApprovalOn(daemon, { chat: ref, decision: "allow" }),
  stop_chat: (daemon, ref) => stopChatOn(daemon, { chat: ref }),
  archive_chat: (daemon, ref) => archiveChatOn(daemon, { chat: ref }),
  run_slash_command: (daemon, ref) => runSlashCommandOn(daemon, { chat: ref, command: "compact", secret: "s", waitSeconds: 0 }),
};
const READS = {
  read_chat: (daemon, ref) => readChatOn(daemon, { chat: ref }),
  read_activity: (daemon, ref) => readActivityOn(daemon, { chat: ref }),
  show_images: (daemon, ref) => showImagesOn(daemon, { chat: ref }),
  search_messages: (daemon, ref) => searchMessagesOn(daemon, { query: "поды", chat: ref }),
  list_slash_commands: (daemon, ref) => listSlashCommandsOn(daemon, { chat: ref }),
};

test("the case: two active chats share a cut title; the whole line asks about those two only, and nothing is sent", async () => {
  const daemon = fakeDaemon(LAB);
  const result = await send(daemon, SAID);
  const ask = result.data.needs_clarification;
  assert.equal(ask.kind, "chat");
  assert.equal(ask.reason, "same_name");
  assert.deepEqual(ask.candidates.map((c) => c.id), [STEP5.id, PLAN4.id], "not the archived one, not the lookalike");
  assert.deepEqual(ask.candidates.map((c) => c.workspace), [STEP5.workspace, PLAN4.workspace]);
  assert.match(result.text, /^2 chats are named "Продолжаем учебный кластер demo-dev на миникубе в тестовом аккаунте", so nothing was done\.\n/);
  assert.match(result.text, /\nAsk the user which one, naming what tells them apart\. Pick one yourself \(call again with its id\) only if the user's words pick it/);
  assert.match(result.text, /workspace "Продолжить demo-dev minikube: шаг 5 in-cluster"\): idle, 3 h ago/);
  assert.match(result.text, /workspace "Plan demo-dev minikube monitoring questions §4"\): idle, 25 h ago/);
  assert.doesNotMatch(result.text, /5e7a0c11|6b2f9d40/, "the text has no ids to read aloud");
  assert.deepEqual(daemon.log, NOTHING);
  assert.equal(daemon.archiveLookups, 0, "the archived chat with that title is not even looked at");
});

test("its id, short id, #short id or workspace title reach the one chat in a single call", async () => {
  for (const ref of [STEP5.id, STEP5.id.toUpperCase(), STEP5.id.slice(0, 7), `#${STEP5.id.slice(0, 7)}`, "шаг 5 in-cluster", STEP5.workspace, `${CUT} (lab)`.replace(CUT, STEP5.workspace)]) {
    const daemon = fakeDaemon(LAB);
    const result = await send(daemon, ref);
    assert.equal(result.data.chat_id, STEP5.id, ref);
    assert.equal(result.data.delivered, true, ref);
    assert.deepEqual(daemon.log.sent.map((s) => s.id), [STEP5.id], ref);
  }
});

test("no write chooses between chats a name fits equally, not by recency, not by which one waits or runs", async () => {
  for (const ref of ["Release notes 0.6", "release notes"]) {
    for (const [tool, run] of Object.entries(WRITES)) {
      const daemon = fakeDaemon([IDLE_TWIN, BUSY_TWIN]);
      const result = await run(daemon, ref);
      assert.ok(["same_name", "similar"].includes(result.data.needs_clarification?.reason), `${tool} ${ref}`);
      assert.deepEqual(result.data.needs_clarification.candidates.map((c) => c.id), [IDLE_TWIN.id, BUSY_TWIN.id], `${tool} ${ref}`);
      assert.match(result.text, /so nothing was done/, tool);
      assert.deepEqual(daemon.log, NOTHING, `${tool} did nothing`);
    }
  }
});

test("reads take the only chat at work among equals and say so; among idle equals they ask", async () => {
  for (const [tool, run] of Object.entries(READS)) {
    const daemon = fakeDaemon([IDLE_TWIN, BUSY_TWIN]);
    const result = await run(daemon, "Release notes 0.6");
    assert.equal(result.data.needs_clarification, undefined, tool);
    assert.equal(result.data.note, '"Release notes 0.6" matches 2 chats; this is the only active one.', tool);
    assert.ok(daemon.log.read.length > 0 && daemon.log.read.every((id) => id === BUSY_TWIN.id), tool);
    const idle = fakeDaemon(LAB);
    const asked = await run(idle, SAID);
    assert.equal(asked.data.needs_clarification?.reason, "same_name", tool);
    assert.doesNotMatch(asked.text, /nothing was done/, "a read changes nothing anyway");
    assert.deepEqual(idle.log, NOTHING, tool);
  }
});

test("by id a write reaches its chat whatever shares its name, and acts on its state now", async () => {
  const both = () => fakeDaemon([IDLE_TWIN, BUSY_TWIN]);
  let daemon = both();
  await answerApprovalOn(daemon, { chat: BUSY_TWIN.id, decision: "allow" });
  assert.deepEqual(daemon.log.answered, [{ id: BUSY_TWIN.id, permissionId: "perm-1", behavior: "allow" }]);
  daemon = both();
  const none = await answerApprovalOn(daemon, { chat: IDLE_TWIN.id, decision: "allow" });
  assert.equal(none.data.done, false, "nothing waits in the idle one: nothing is allowed, and not in its twin");
  assert.deepEqual(daemon.log.answered, []);
  daemon = both();
  await stopChatOn(daemon, { chat: BUSY_TWIN.id.slice(0, 8) });
  assert.deepEqual(daemon.log.cancelled, [BUSY_TWIN.id]);
  daemon = both();
  const busy = await send(daemon, BUSY_TWIN.id);
  assert.equal(busy.data.outcome, "busy", "a running chat still asks add-or-interrupt");
  assert.deepEqual(daemon.log.sent, []);
  daemon = both();
  await send(daemon, IDLE_TWIN.id);
  assert.deepEqual(daemon.log.sent.map((s) => s.id), [IDLE_TWIN.id]);
});

test("a project said with the name settles a title two projects share", async () => {
  const proxy = chat("2b3c4d5e-0000-4000-8000-000000000001", "Auth refactor", { project: "proxy", minutes: 10 });
  const jobby = chat("2b3c4d5e-0000-4000-8000-000000000002", "Auth refactor", { project: "jobby-jobs", minutes: 20 });
  let daemon = fakeDaemon([proxy, jobby]);
  assert.equal((await send(daemon, "Auth refactor")).data.needs_clarification.reason, "same_name");
  for (const ref of ["Auth refactor (jobby-jobs)", "auth refactor jobby-jobs"]) {
    daemon = fakeDaemon([proxy, jobby]);
    await send(daemon, ref);
    assert.deepEqual(daemon.log.sent.map((s) => s.id), [jobby.id], ref);
  }
});

test("an exact title wins over titles that contain it; a write takes no partial match, a read takes the closest", async () => {
  const fleet = chat("3c4d5e6f-0000-4000-8000-000000000001", "Fleet map", { minutes: 50 });
  const fleetD = chat("3c4d5e6f-0000-4000-8000-000000000002", "Fleet map D", { minutes: 5 });
  const deploy = chat("3c4d5e6f-0000-4000-8000-000000000003", "Deploy fixes", { minutes: 7 });
  let daemon = fakeDaemon([fleet, fleetD, deploy]);
  await send(daemon, "fleet map");
  assert.deepEqual(daemon.log.sent.map((s) => s.id), [fleet.id]);
  daemon = fakeDaemon([fleetD, deploy]);
  const partial = await send(daemon, "fleet map deploy");
  assert.equal(partial.data.needs_clarification.reason, "partial");
  assert.deepEqual(partial.data.needs_clarification.candidates.map((c) => c.id), [fleetD.id, deploy.id]);
  assert.match(partial.text, /^No chat has every word of "fleet map deploy", so nothing was done\.\nThe closest:/);
  assert.deepEqual(daemon.log.sent, []);
  const read = await readChatOn(daemon, { chat: "fleet map deploy" });
  assert.equal(read.data.chat.id, fleetD.id);
});

test("an archived chat whose title an active one now has gets nothing by its old id, unless the user wants it back", async () => {
  const daemon = fakeDaemon(LAB);
  const stale = await send(daemon, OLD3.id);
  assert.equal(stale.data.outcome, "archived");
  assert.equal(stale.data.delivered, false);
  assert.equal(stale.data.chat_id, OLD3.id);
  assert.deepEqual(stale.data.same_title.map((c) => c.id), [STEP5.id, PLAN4.id]);
  assert.match(stale.text, /^Not sent: .* is archived, and 2 active chats have its title, most likely its continuation:\n- /);
  assert.match(stale.text, /Only if they want the archived one back with this message, call again with if_archived "restore"\.$/);
  assert.deepEqual(daemon.log.sent, []);
  const back = await send(daemon, OLD3.id, { ifArchived: "restore" });
  assert.equal(back.data.delivered, true);
  assert.match(back.text, /^Sent to .*; it arrived\. It was archived; the message brought it back\. Do not send it again\./);
  assert.deepEqual(daemon.log.sent.map((s) => s.id), [OLD3.id]);
  const read = await readChatOn(fakeDaemon(LAB), { chat: OLD3.id });
  assert.equal(read.data.chat.id, OLD3.id, "reading an archived chat by id needs nothing more");
});

test("an archived chat no active one stands in for takes a message by its id or short id, as before, and says it came back", async () => {
  const lone = chat("9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a", "DNSSEC check", { archived: true, minutes: 5000 });
  for (const ref of [lone.id, lone.id.slice(0, 7)]) {
    const daemon = fakeDaemon([...LAB, lone]);
    const result = await send(daemon, ref);
    assert.equal(result.data.delivered, true, ref);
    assert.match(result.text, /It was archived; the message brought it back\./, ref);
    assert.deepEqual(daemon.log.sent.map((s) => s.id), [lone.id], ref);
  }
});

test("names are matched among active chats only: an archived chat's name finds nothing, and the archive is not listed", async () => {
  const lone = chat("9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a", "DNSSEC check", { archived: true, minutes: 5000 });
  const daemon = fakeDaemon([...LAB, lone]);
  for (const [tool, run] of Object.entries({ ...READS, ...WRITES })) {
    const result = await run(daemon, "dnssec check");
    assert.equal(result.data.needs_clarification?.reason, "no_match", tool);
    assert.match(result.text, /^No active chat matches "dnssec check"/, tool);
    assert.match(result.text, /Archived chats were not searched: look there \(list_chats with include_archived\) only if the user asks\./, tool);
  }
  assert.equal(daemon.archiveLookups, 0);
  assert.deepEqual(daemon.log, NOTHING);
  const byId = await readChatOn(daemon, { chat: lone.id });
  assert.equal(byId.data.chat.id, lone.id, "its id, from a search the user asked for, still reaches it");
  assert.equal(daemon.archiveLookups, 0);
});

test("an unknown id says so; the start of several ids, archived ones included, is asked about; nothing runs", async () => {
  let daemon = fakeDaemon(LAB);
  for (const [tool, run] of Object.entries(WRITES)) {
    const gone = await run(daemon, "0f0f0f0f-1111-4222-8333-444444444444");
    assert.equal(gone.data.needs_clarification.reason, "unknown_id", tool);
    assert.match(gone.text, /^No chat has the id "0f0f0f0f-1111-4222-8333-444444444444", so nothing was done\.\nIt was deleted, or the id is wrong/, tool);
  }
  assert.deepEqual(daemon.log, NOTHING);
  const alpha = chat("abcdef01-0000-4000-8000-000000000001", "Alpha", { minutes: 1 });
  const beta = chat("abcdef02-0000-4000-8000-000000000002", "Beta", { minutes: 2 });
  daemon = fakeDaemon([alpha, beta]);
  const shared = await send(daemon, "abcdef0");
  assert.equal(shared.data.needs_clarification.reason, "id_prefix");
  assert.deepEqual(shared.data.needs_clarification.candidates.map((c) => c.id), [alpha.id, beta.id]);
  daemon = fakeDaemon([alpha, { ...beta, archived: true }]);
  const withArchived = await send(daemon, "abcdef0");
  assert.equal(withArchived.data.needs_clarification.reason, "id_prefix", "an archived chat's short id is never taken for the active one's");
  assert.deepEqual(daemon.log.sent, []);
  await send(daemon, "abcdef01");
  assert.deepEqual(daemon.log.sent.map((s) => s.id), [alpha.id]);
});

test("a name nothing matches says nothing was done, and leaves the archive to the user", async () => {
  const daemon = fakeDaemon(LAB);
  const result = await stopChatOn(daemon, { chat: "погода Варшава" });
  assert.deepEqual(result.data.needs_clarification, { kind: "chat", query: "погода Варшава", reason: "no_match", candidates: [] });
  assert.equal(
    result.text,
    'No active chat matches "погода Варшава", so nothing was done.\nArchived chats were not searched: look there (list_chats with include_archived) only if the user asks. Otherwise ask the user for another name.',
  );
  assert.deepEqual(daemon.log, NOTHING);
  assert.equal(daemon.archiveLookups, 0);
});
