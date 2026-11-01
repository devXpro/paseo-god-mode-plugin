// Run with: node --test core/
// read_activity over a fake daemon client: which subagents it lists, how many it reads in detail, and
// the model and effort it gives for each. No network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readActivityOn } from "./paseo.mjs";

// readActivityOn reads the clock itself, so the fixture is laid out from now.
const NOW = Date.now();
const at = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const ID = "6194696e-afb1-4724-9bec-bec061a5a54f";

const sub = (n, subtitle, extra = {}) => ({
  id: `toolu_${n}`,
  parentAgentId: ID,
  parentSubagentId: null,
  provider: "claude",
  title: "general-purpose",
  description: `task ${n}`,
  status: "running",
  createdAt: at(15),
  updatedAt: at(1),
  toolCallId: `toolu_${n}`,
  cwd: null,
  subtitle,
  ...extra,
});

// The subagents of one working chat, laid out as Paseo 0.14.0 listed them on a live chat: seven running
// on three models, one resumed by SendMessage (an effort and no model), one finished this turn.
const SUBAGENTS = [
  sub(1, "general-purpose · Opus 5.5 · Max · 305.1k tokens"),
  sub(2, "general-purpose · Opus 5.5 · Max · 346.3k tokens"),
  sub(3, "general-purpose · Opus 5.5 · Max · 220.5k tokens"),
  sub(4, "general-purpose · Sonnet 5.5 · Max · 180.4k tokens"),
  sub(5, "general-purpose · Haiku 5.5 · Max · 83.2k tokens"),
  sub(6, "general-purpose · Haiku 5.5 · Max · 66.3k tokens"),
  sub(7, "general-purpose · Haiku 5.5 · Max"),
  sub(8, "general-purpose · Max · 262.3k tokens"),
  sub(9, "Explore · Opus 5.5 · Max · 284.1k tokens", { title: "Explore", status: "completed", updatedAt: at(3) }),
];

function fakeClient({ subagents = SUBAGENTS, status = "running" } = {}) {
  const read = [];
  const entry = {
    agent: { id: ID, title: "Gaslight Me", status, requiresAttention: false, pendingPermissions: [], updatedAt: at(1), createdAt: at(600), cwd: "/Users/r/lacoNote", provider: "claude", model: "claude-opus-5-5", thinkingOptionId: "max" },
    project: { projectName: "lacoNote", workspaceName: null },
  };
  return {
    read,
    async fetchAgents() {
      return { entries: [entry] };
    },
    async fetchAgent(id) {
      return id === ID ? entry : null;
    },
    async listAgentTimelinePrompts() {
      return { prompts: [{ seq: 1, preview: "go", timestamp: at(30) }] };
    },
    async fetchAgentTimeline() {
      return { entries: [] };
    },
    async listProviderSubagents() {
      return { subagents };
    },
    async fetchProviderSubagentTimeline(_chat, id) {
      read.push(id);
      return { rows: [{ item: { type: "assistant_message", text: `result of ${id}` } }] };
    },
  };
}

test("one named chat gives every subagent with its model and effort, and reads only the first six in detail", async () => {
  const client = fakeClient();
  const { text, data } = await readActivityOn(client, { chat: "Gaslight Me", maxChars: 6000 });
  const [activity] = data.chats;
  assert.equal(activity.subagents.length, 9, "none is cut off");
  assert.deepEqual(
    activity.subagents.map((s) => [s.model, s.effort]),
    [
      ["Opus 5.5", "Max"],
      ["Opus 5.5", "Max"],
      ["Opus 5.5", "Max"],
      ["Sonnet 5.5", "Max"],
      ["Haiku 5.5", "Max"],
      ["Haiku 5.5", "Max"],
      ["Haiku 5.5", "Max"],
      [null, "Max"],
      ["Opus 5.5", "Max"],
    ],
  );
  assert.equal(activity.subagents[7].model, null, "the resumed subagent has no model of its own: unknown, not its parent's");
  assert.equal(activity.subagents_running, 8);
  assert.equal(activity.subagents_done, 1);
  assert.deepEqual(client.read, SUBAGENTS.slice(0, 6).map((s) => s.id), "timelines are read for six only");
  assert.equal(activity.subagents[8].result, null, "a subagent beyond the six has no result read");
  assert.match(text, /- general-purpose \(Sonnet 5\.5, Max effort\) "task 4": running for 15 min/);
  assert.match(text, /- general-purpose \(model not reported, Max effort\) "task 8": running for 15 min/);
  assert.match(text, /- Explore \(Opus 5\.5, Max effort\) "task 9": completed after 12 min/);
});

test("without a chat the first six of each chat are listed, and their counts say how many there are", async () => {
  const client = fakeClient();
  const { data } = await readActivityOn(client, {});
  const [activity] = data.chats;
  assert.equal(activity.subagents.length, 6);
  assert.equal(activity.subagents_running, 8);
  assert.deepEqual(activity.subagents.map((s) => s.model), ["Opus 5.5", "Opus 5.5", "Opus 5.5", "Sonnet 5.5", "Haiku 5.5", "Haiku 5.5"]);
  assert.equal(client.read.length, 6);
});

test("the six read in detail are the six listed first: running ones, then the most recently finished", async () => {
  // Eight finished this turn, listed by Paseo oldest first: the last one finished most recently.
  const finished = Array.from({ length: 8 }, (_, i) => sub(i + 1, "general-purpose · Haiku 5.5 · Max · 10k tokens", { status: "completed", createdAt: at(20), updatedAt: at(10 - i) }));
  const client = fakeClient({ subagents: finished, status: "idle" });
  const { data } = await readActivityOn(client, { chat: "Gaslight Me" });
  const listed = data.chats[0].subagents;
  assert.deepEqual(listed.map((s) => s.id), finished.map((s) => s.id).reverse(), "most recently finished first");
  assert.deepEqual(listed.filter((s) => s.result !== null).map((s) => s.id), listed.slice(0, 6).map((s) => s.id), "results are there for the first six");
  assert.deepEqual([...client.read].sort(), listed.slice(0, 6).map((s) => s.id).sort(), "and only those were read");
});

test("a chat with no subagents, or whose daemon lists none, gives an empty list", async () => {
  const { data } = await readActivityOn(fakeClient({ subagents: [], status: "idle" }), { chat: "Gaslight Me" });
  assert.deepEqual(data.chats[0].subagents, []);
  assert.equal(data.chats[0].subagents_running, 0);
});
