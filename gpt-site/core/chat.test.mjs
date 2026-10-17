// Run with: node --test core/
// read_chat's thinking view and context window, and archive_chat, against a fake daemon client.
// No network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { archiveChatOn, readChatOn } from "./paseo.mjs";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const at = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const ID = "b33635af-166c-45c9-b0ad-93d0a21e8f32";
const USAGE = { inputTokens: 4, cachedInputTokens: 55401, outputTokens: 68, totalCostUsd: 2.2, contextWindowMaxTokens: 1000000, contextWindowUsedTokens: 59606 };

// One chat: `items` are its timeline items in order, a user_message starting each turn.
function fakeClient({ status = "idle", archivedAt, usage = USAGE, subagents = [], items = [] } = {}) {
  const archived = [];
  const entries = items.map((item, i) => ({ seqStart: i + 1, timestamp: at(items.length - i), item }));
  const agent = () => ({
    agent: { id: ID, title: "Relay probe", status, requiresAttention: false, pendingPermissions: [], updatedAt: at(1), createdAt: at(60), archivedAt, cwd: "/Users/r/proxy", lastUsage: usage },
    project: { projectName: "proxy", workspaceName: null },
  });
  return {
    archived,
    async fetchAgents() {
      return { entries: archivedAt ? [] : [agent()] };
    },
    async fetchAgent(id) {
      return id === ID ? agent() : null;
    },
    async listAgentTimelinePrompts() {
      const prompts = entries.filter((e) => e.item.type === "user_message");
      return { epoch: "e1", prompts: prompts.map((e) => ({ seq: e.seqStart, preview: e.item.text, timestamp: e.timestamp })) };
    },
    async fetchAgentTimeline() {
      return { entries };
    },
    async listProviderSubagents() {
      return { subagents };
    },
    async archiveAgent(id) {
      archived.push(id);
      return { archivedAt: "2026-10-17T12:00:00.000Z" };
    },
  };
}

const TURNS = [
  { type: "user_message", text: "is the relay up?" },
  { type: "reasoning", text: "The user asks about the relay. I should ping it." },
  { type: "tool_call", name: "Bash", status: "completed", detail: { type: "shell", command: "curl -m 5 relay" } },
  { type: "reasoning", text: "It answered 200, so it is up." },
  { type: "assistant_message", text: "The relay is up." },
  { type: "user_message", text: "thanks" },
  { type: "assistant_message", text: "Any time." },
];

test("view thinking reads the agent's reasoning per turn, and says so when the model shared none", async () => {
  const one = await readChatOn(fakeClient({ items: TURNS }), { chat: "relay", view: "thinking", turn: 2 });
  assert.equal(one.data.turns[0].thinking, "The user asks about the relay. I should ping it.\n\nIt answered 200, so it is up.");
  assert.equal(one.data.turns[0].omitted_thoughts, 0);
  assert.match(one.text, /Turn 2 of 2, counted from the latest, the agent's thinking:\nThe user asks about the relay/);
  assert.doesNotMatch(one.text, /The relay is up\./, "no reply text in the thinking view");
  const none = await readChatOn(fakeClient({ items: TURNS }), { chat: "relay", view: "thinking" });
  assert.equal(none.data.turns[0].thinking, "");
  assert.match(none.text, /Turn 1 of 2, counted from the latest: no thinking recorded; the model shared none in this turn\./);
  const cut = await readChatOn(fakeClient({ items: TURNS }), { chat: "relay", view: "thinking", turn: 2, maxChars: 200 });
  assert.ok(cut.data.turns[0].thinking.length <= 200);
});

test("the text view still leaves the reasoning out", async () => {
  const text = await readChatOn(fakeClient({ items: TURNS }), { chat: "relay", turn: 2 });
  assert.match(text.text, /Agent replied: The relay is up\./);
  assert.doesNotMatch(text.text, /ping it/);
});

test("read_chat tells how full the context window is, and nothing when Paseo does not know", async () => {
  const known = await readChatOn(fakeClient({ items: TURNS }), { chat: "relay" });
  assert.match(known.text, /^Relay probe \(proxy\): idle, .*\nContext window: 6% used \(60k of 1M tokens\)\./);
  assert.deepEqual(known.data.chat.context, { used_tokens: 59606, max_tokens: 1000000, percent_used: 6, remaining_tokens: 940394 });
  const unknown = await readChatOn(fakeClient({ usage: null, items: TURNS }), { chat: "relay", view: "commands" });
  assert.doesNotMatch(unknown.text, /Context window/);
  assert.equal(unknown.data.chat.context, undefined);
});

test("archive_chat archives an idle chat once and says how to bring it back", async () => {
  const client = fakeClient({ items: TURNS });
  const result = await archiveChatOn(client, { chat: "relay" });
  assert.deepEqual(client.archived, [ID]);
  assert.deepEqual(result.data, { chat_id: ID, short_id: "b33635a", outcome: "archived", done: true, archived_at: "2026-10-17T12:00:00.000Z" });
  assert.match(result.text, /^Archived Relay probe\. Its history is kept; a new message to it brings it back\.$/);
});

test("archive_chat leaves a busy chat alone: a working agent or working subagents", async () => {
  for (const busy of [{ status: "running" }, { status: "initializing" }, { subagents: [{ id: "toolu_1", status: "running" }] }]) {
    const client = fakeClient({ items: TURNS, ...busy });
    const result = await archiveChatOn(client, { chat: "relay" });
    assert.deepEqual(client.archived, [], JSON.stringify(busy));
    assert.equal(result.data.outcome, "busy");
    assert.equal(result.data.done, false);
    assert.match(result.text, /^Not archived: Relay probe is busy/);
  }
  const finished = fakeClient({ items: TURNS, subagents: [{ id: "toolu_1", status: "completed" }] });
  assert.equal((await archiveChatOn(finished, { chat: "relay" })).data.outcome, "archived", "finished subagents do not hold it");
});

test("archive_chat changes nothing for an archived chat or an unclear name", async () => {
  const archived = fakeClient({ archivedAt: at(5), items: TURNS });
  const again = await archiveChatOn(archived, { chat: ID });
  assert.equal(again.data.outcome, "already_archived");
  assert.deepEqual(archived.archived, []);
  const client = fakeClient({ items: TURNS });
  const unclear = await archiveChatOn(client, { chat: "weather" });
  assert.equal(unclear.data.needs_clarification.kind, "chat");
  assert.deepEqual(client.archived, []);
});
