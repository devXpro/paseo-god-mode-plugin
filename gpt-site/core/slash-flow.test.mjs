// Run with: node --test core/*.test.mjs
// list_slash_commands and run_slash_command end to end against a fake daemon that answers the way
// Paseo 0.11.4 did on live chats: a Claude command is a turn of its own, Codex's /compact is run
// outside any turn and shows up in the timeline a moment later. No network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { issueConfirmation } from "./capabilities.mjs";
import { listSlashCommandsOn, readChatOn, runSlashCommandOn } from "./paseo.mjs";

const NOW = Date.parse("2026-10-18T07:00:00Z");
const ID = "293cb3db-bede-4667-b017-faaed6ab58a1";
const SECRET = "https://app.paseo.sh/#offer=test-secret";
const BEFORE = { contextWindowMaxTokens: 1_000_000, contextWindowUsedTokens: 22684 };
const AFTER = { contextWindowMaxTokens: 1_000_000, contextWindowUsedTokens: 1755 };

const CLAUDE = [
  { name: "clear", description: "Start a new session with empty context", argumentHint: "[name]", kind: "command" },
  { name: "code-review", description: "Review the current diff for correctness bugs", argumentHint: "[--fix] [--comment]", kind: "skill" },
  { name: "compact", description: "Free up context by summarizing the conversation so far", argumentHint: "<optional custom summarization instructions>", kind: "command" },
  { name: "context", description: "Show current context usage", argumentHint: "", kind: "command" },
  { name: "gm-ping", description: "God Mode test command; answers pong (project)", argumentHint: "[word]", kind: "skill" },
];
const CODEX = [
  { name: "compact", description: "Summarize conversation to prevent hitting the context limit", argumentHint: "", kind: "command" },
  { name: "goal", description: "Set, pause, resume, or clear the agent's goal", argumentHint: "[<objective>|pause|resume|clear]", kind: "command" },
  { name: "lint-fix", description: "Run the linters and fix what they find", argumentHint: "", kind: "skill" },
];

// One chat on a fake daemon. `onSend` plays the provider: it gets the daemon state, the text and
// the send options; `onRead` runs on every timeline read (for results that arrive later).
function fakeDaemon({ provider = "claude", status = "idle", permissions = [], archivedAt = null, mode = "default", commands = CLAUDE, listError = null, history = [], onSend, onRead } = {}) {
  const state = { status, permissions, usage: BEFORE, items: [...history], sent: [], lists: 0, readsSinceSend: 0 };
  const entries = () => state.items.map((item, i) => ({ seqStart: i + 1, timestamp: new Date(NOW + i * 1000).toISOString(), item }));
  const agent = () => ({
    agent: {
      id: ID,
      title: "Fleet map",
      provider,
      status: state.status,
      requiresAttention: false,
      pendingPermissions: state.permissions,
      updatedAt: new Date(NOW).toISOString(),
      createdAt: new Date(NOW - 3_600_000).toISOString(),
      archivedAt,
      cwd: "/Users/r/proxy",
      lastUsage: state.usage,
      currentModeId: mode,
    },
    project: { projectName: "proxy", workspaceName: null },
  });
  return {
    state,
    async fetchAgents() {
      return { entries: archivedAt ? [] : [agent()] };
    },
    async fetchAgent(id) {
      return id === ID ? agent() : null;
    },
    async listCommands({ agentId }) {
      state.lists += 1;
      return { agentId, commands: listError ? [] : commands, error: listError, requestId: "r1" };
    },
    async listAgentTimelinePrompts() {
      const prompts = entries().filter((e) => e.item.type === "user_message");
      return { epoch: "e1", prompts: prompts.map((e) => ({ seq: e.seqStart, preview: e.item.text, timestamp: e.timestamp })) };
    },
    async fetchAgentTimeline(_id, { direction = "tail", cursor, limit = 200 } = {}) {
      if (state.sent.length) {
        state.readsSinceSend += 1;
        onRead?.(state);
      }
      const all = entries();
      if (direction === "after") return { epoch: "e1", entries: all.filter((e) => e.seqStart >= cursor.seq).slice(0, limit) };
      if (direction === "before") return { epoch: "e1", entries: all.filter((e) => e.seqStart < cursor.seq).slice(-limit) };
      return { epoch: "e1", entries: all.slice(-limit) };
    },
    async sendAgentMessage(_id, text, options) {
      state.sent.push({ text, options });
      state.readsSinceSend = 0;
      onSend?.(state, text, options);
    },
    async waitForFinish() {
      return { status: state.permissions.length ? "permission" : state.status === "running" ? "timeout" : state.status };
    },
    async listProviderSubagents() {
      return { subagents: [] };
    },
  };
}

const userMessage = (text, options) => ({ type: "user_message", text, clientMessageId: options.messageId, messageId: options.messageId });

// Claude Code through Paseo, as seen live: a /compact turn, then the previous output repeated.
function claudeCompacts(state, text, options) {
  state.items.push(userMessage(text, options), { type: "compaction", status: "loading" }, { type: "compaction", status: "completed", trigger: "manual", preTokens: 22772 }, { type: "assistant_message", text: "## Context Usage (the earlier output)" });
  state.usage = AFTER;
  state.status = "idle";
  state.permissions = [];
}

const claudeAnswers = (reply) => (state, text, options) => {
  state.items.push(userMessage(text, options), { type: "assistant_message", text: reply });
  state.status = "idle";
};

const run = (client, args) => runSlashCommandOn(client, { chat: ID, secret: SECRET, now: NOW, waitSeconds: 5, pollMs: 5, ...args });

test("list: the chat's own commands, each with what it does and whether God Mode runs it", async () => {
  const client = fakeDaemon({ mode: "bypassPermissions" });
  const listed = await listSlashCommandsOn(client, { chat: "fleet" });
  assert.equal(listed.data.provider, "claude");
  assert.equal(listed.data.runtime, "Claude Code");
  assert.equal(listed.data.runs_commands, true);
  assert.deepEqual([listed.data.total, listed.data.runs_at_once, listed.data.asks_first, listed.data.unavailable, listed.data.shown], [5, 2, 2, 1, 5]);
  assert.deepEqual(listed.data.commands.map((c) => c.name), ["code-review", "context", "compact", "gm-ping", "clear"]);
  assert.equal(listed.data.commands[4].available, false);
  assert.match(listed.text, /^Fleet map \(proxy\): idle, .*\nClaude Code: 5 command\(s\)\./);
  assert.match(listed.text, /Permissions are bypassed in this chat/);
  const one = await listSlashCommandsOn(client, { chat: ID, query: "compact" });
  assert.equal(one.data.shown, 1);
  assert.match(one.text, /- \/compact <optional custom summarization instructions>: Summarises/);
  const few = await listSlashCommandsOn(client, { chat: ID, limit: 2 });
  assert.equal(few.data.shown, 2);
  assert.match(few.text, /3 more not shown; narrow it with a query\./);
});

test("list: an archived chat, a provider Paseo cannot start, and one God Mode does not run", async () => {
  const archived = await listSlashCommandsOn(fakeDaemon({ archivedAt: "2026-10-17T00:00:00Z" }), { chat: ID });
  assert.match(archived.text, /It is archived, and Paseo lists the commands of active chats only/);
  assert.deepEqual(archived.data.commands, []);
  const broken = await listSlashCommandsOn(fakeDaemon({ provider: "codex", listError: "Codex binary not found. Install the Codex CLI" }), { chat: ID });
  assert.match(broken.text, /Paseo could not list its commands: Codex binary not found/);
  assert.match(broken.data.error, /Codex binary not found/);
  const other = await listSlashCommandsOn(fakeDaemon({ provider: "opencode", commands: [{ name: "summarize", description: "Summarise", argumentHint: "", kind: "command" }] }), { chat: ID });
  assert.equal(other.data.runs_commands, false);
  assert.match(other.data.reason, /only in Claude Code and Codex chats/);
});

test("Claude /compact: asks first, then runs as a message Claude Code expands, and tells the context before and after", async () => {
  const client = fakeDaemon({ onSend: claudeCompacts });
  const asked = await run(client, { command: "compact", args: "keep the API notes" });
  assert.equal(asked.data.outcome, "needs_confirmation");
  assert.equal(asked.data.delivered, false);
  assert.equal(asked.data.risk, "disruptive");
  assert.equal(asked.data.command, "/compact keep the API notes");
  assert.match(asked.data.confirm_text, /^Run \/compact keep the API notes in «Fleet map» \(Claude Code\): Summarises the conversation so far/);
  assert.match(asked.text, /Tell the user: ".*" Only after they say yes, call run_slash_command again with the same chat, command and args plus this confirmation\./);
  assert.equal(client.state.sent.length, 0, "nothing is sent before the yes");
  const done = await run(client, { command: "compact", args: "keep the API notes", confirmation: asked.data.confirmation });
  assert.equal(client.state.sent.length, 1);
  assert.equal(client.state.sent[0].text, "/compact keep the API notes");
  assert.equal(client.state.sent[0].options.activeTurnBehavior, undefined, "an idle chat needs no turn behaviour");
  assert.match(client.state.sent[0].options.messageId, /^[0-9a-f-]{36}$/);
  assert.equal(done.data.outcome, "done");
  assert.equal(done.data.delivered, true);
  assert.deepEqual(done.data.context, { before_tokens: 22772, after_tokens: 1755, max_tokens: 1_000_000, percent_used: 0 });
  assert.match(done.text, /^Ran \/compact keep the API notes in Fleet map: the context was compacted \(context 23k → 2k tokens \(0% of 1M\)\)\. It ran once; never run it again for this request\.$/);
  assert.doesNotMatch(done.text, /Context Usage/, "the repeated earlier output is not this command's result");
});

test("a confirmation fits one chat, command, arguments and moment only", async () => {
  const client = fakeDaemon({ onSend: claudeCompacts });
  const asked = await run(client, { command: "compact" });
  const other = await run(client, { command: "compact", args: "something else", confirmation: asked.data.confirmation });
  assert.equal(other.data.outcome, "needs_confirmation");
  assert.match(other.text, /^That confirmation was for something else\./);
  const late = await runSlashCommandOn(client, { chat: ID, command: "compact", confirmation: asked.data.confirmation, secret: SECRET, now: NOW + 3 * 60_000, waitSeconds: 5, pollMs: 5 });
  assert.match(late.text, /^That confirmation expired\./);
  const forged = await run(client, { command: "compact", confirmation: (await issueConfirmation("another secret", { tool: "run_slash_command", chat: ID, command: "/compact", interrupt: false }, NOW)).token });
  assert.equal(forged.data.outcome, "needs_confirmation");
  assert.equal(client.state.sent.length, 0);
});

test("a low-risk command runs at once and its output comes back; an unclear or unknown name sends nothing", async () => {
  const client = fakeDaemon({ onSend: claudeAnswers("## Context Usage\n\n**Tokens:** 22.7k / 1m (2%)") });
  const context = await run(client, { command: "/context" });
  assert.equal(context.data.outcome, "replied");
  assert.equal(context.data.risk, "low");
  assert.match(context.data.reply, /^## Context Usage/);
  assert.match(context.text, /^Ran \/context in Fleet map\. It ran once; never run it again for this request\. Result:\n## Context Usage/);
  const unknown = await run(client, { command: "definitely-not-a-command" });
  assert.equal(unknown.data.needs_clarification.kind, "command");
  assert.match(unknown.text, /No command of Fleet map matches "definitely-not-a-command", so nothing was sent\. Its commands: code-review, context, compact, gm-ping\./);
  const unclear = await run(client, { command: "co" });
  assert.ok(unclear.data.needs_clarification.candidates.length > 1);
  assert.equal(client.state.sent.length, 1, "only /context was sent");
});

test("refused commands say why and what to use instead, and send nothing", async () => {
  const client = fakeDaemon();
  const clear = await run(client, { command: "clear" });
  assert.equal(clear.data.outcome, "unavailable");
  assert.equal(clear.data.delivered, false);
  assert.match(clear.data.reason, /start_chat/);
  const archived = await run(fakeDaemon({ archivedAt: "2026-10-17T00:00:00Z" }), { command: "context" });
  assert.match(archived.text, /archived/);
  const other = await run(fakeDaemon({ provider: "opencode", commands: [{ name: "summarize", description: "Summarise", argumentHint: "" }] }), { command: "summarize" });
  assert.equal(other.data.outcome, "unavailable");
  assert.match(other.data.reason, /not been verified/);
  const broken = await run(fakeDaemon({ listError: "Agent not found" }), { command: "context" });
  assert.match(broken.data.reason, /Paseo could not list this chat's commands: Agent not found/);
  assert.equal(client.state.sent.length, 0);
});

test("bad arguments are refused before anything is sent", async () => {
  const client = fakeDaemon();
  assert.match((await run(client, { command: "compact", args: "/clear" })).invalid, /must not start with a slash/);
  assert.match((await run(client, { command: "/compact now", args: "and more" })).invalid, /Put the arguments in args/);
  assert.equal(client.state.sent.length, 0);
});

test("a working chat holds the command until the user says to interrupt, and the yes covers the interruption", async () => {
  const client = fakeDaemon({ status: "running", onSend: claudeCompacts });
  const busy = await run(client, { command: "context" });
  assert.equal(busy.data.outcome, "busy");
  assert.equal(busy.data.delivered, false);
  assert.match(busy.text, /would stop that work\. Ask the user whether to interrupt it; only on their explicit yes call again with if_busy interrupt\./);
  const asked = await run(client, { command: "compact", ifBusy: "interrupt" });
  assert.equal(asked.data.outcome, "needs_confirmation");
  assert.match(asked.data.confirm_text, /It stops the chat's current work first\.$/);
  const idleToken = (await issueConfirmation(SECRET, { tool: "run_slash_command", chat: ID, command: "/compact", interrupt: false }, NOW)).token;
  const notThatYes = await run(client, { command: "compact", ifBusy: "interrupt", confirmation: idleToken });
  assert.equal(notThatYes.data.outcome, "needs_confirmation", "a yes to compacting is not a yes to interrupting");
  const done = await run(client, { command: "compact", ifBusy: "interrupt", confirmation: asked.data.confirmation });
  assert.equal(done.data.outcome, "done");
  assert.equal(client.state.sent.length, 1);
  assert.equal(client.state.sent[0].options.activeTurnBehavior, "interrupt");
  const waiting = await run(fakeDaemon({ status: "running", permissions: [{ id: "p1", detail: { type: "shell", command: "rm -rf build" } }] }), { command: "context" });
  assert.match(waiting.text, /is waiting for an approval/);
});

test("a command that asks for an approval, ends in an error, or is not awaited", async () => {
  const approving = fakeDaemon({
    onSend: (state, text, options) => {
      state.items.push(userMessage(text, options), { type: "tool_call", name: "Bash", status: "running", detail: { type: "shell", command: "make clean" } });
      state.status = "running";
      state.permissions = [{ id: "p1", detail: { type: "shell", command: "make clean" } }];
    },
  });
  const asked = await run(approving, { command: "code-review" });
  assert.equal(asked.data.outcome, "waiting_for_approval");
  assert.equal(asked.data.approval, "run: make clean");
  const failing = fakeDaemon({ onSend: (state, text, options) => state.items.push(userMessage(text, options), { type: "error", message: "API overloaded" }) });
  const failed = await run(failing, { command: "context" });
  assert.equal(failed.data.outcome, "error");
  assert.equal(failed.data.delivered, true, "it reached the agent: never run it again");
  const quick = await run(fakeDaemon({ onSend: claudeAnswers("x") }), { command: "context", waitSeconds: 0 });
  assert.equal(quick.data.outcome, "not_waiting");
  assert.equal(quick.data.delivered, true);
});

test("Codex /compact runs as its thread/compact/start through Paseo, outside any turn; the result is read from the timeline", async () => {
  // Paseo records the command at once and runs it out of band; the compaction items arrive a moment later.
  const client = fakeDaemon({
    provider: "codex",
    commands: CODEX,
    onSend: (state, text, options) => state.items.push(userMessage(text, options)),
    onRead: (state) => {
      if (state.readsSinceSend === 3) {
        state.items.push({ type: "compaction", status: "loading", trigger: "manual" }, { type: "compaction", status: "completed", trigger: "manual" });
        state.usage = AFTER;
      }
    },
  });
  assert.match((await run(client, { command: "compact", args: "keep notes" })).invalid, /takes no arguments here: Codex compacts without instructions/);
  const asked = await run(client, { command: "compact" });
  assert.match(asked.data.confirm_text, /\(Codex\): Codex summarises the thread .*thread\/compact\/start/);
  const done = await run(client, { command: "compact", confirmation: asked.data.confirmation });
  assert.equal(client.state.sent[0].text, "/compact");
  assert.equal(done.data.outcome, "done");
  assert.deepEqual(done.data.context, { before_tokens: 22684, after_tokens: 1755, max_tokens: 1_000_000, percent_used: 0 });
});

test("Codex: a compaction still going at the deadline, a failed one, /goal beside a running turn, and review not here", async () => {
  const slow = fakeDaemon({ provider: "codex", commands: CODEX, onSend: (state, text, options) => state.items.push(userMessage(text, options)) });
  const token = (await run(slow, { command: "compact" })).data.confirmation;
  const going = await run(slow, { command: "compact", confirmation: token, waitSeconds: 1 });
  assert.equal(going.data.outcome, "still_working");
  assert.match(going.text, /still running \(compacting the context\)\. It ran once; never run it again for this request\. Offer to check later with read_chat; do not poll\./);
  const failing = fakeDaemon({
    provider: "codex",
    commands: CODEX,
    onSend: (state, text, options) => state.items.push(userMessage(text, options), { type: "assistant_message", text: "Failed to compact context: thread not loaded" }),
  });
  const failed = await run(failing, { command: "compact", confirmation: (await run(failing, { command: "compact" })).data.confirmation });
  assert.equal(failed.data.outcome, "error");
  assert.match(failed.data.error, /thread not loaded/);
  const goal = fakeDaemon({
    provider: "codex",
    commands: CODEX,
    status: "running",
    onSend: (state, text, options) => state.items.push(userMessage(text, options), { type: "assistant_message", text: "Goal paused." }),
  });
  const pausedAsk = await run(goal, { command: "goal", args: "pause" });
  assert.equal(pausedAsk.data.outcome, "needs_confirmation", "not busy: /goal runs beside the turn");
  assert.doesNotMatch(pausedAsk.data.confirm_text, /stops the chat's current work/);
  const paused = await run(goal, { command: "goal", args: "pause", confirmation: pausedAsk.data.confirmation });
  assert.equal(paused.data.outcome, "replied");
  assert.equal(paused.data.reply, "Goal paused.");
  assert.equal(goal.state.sent[0].options.activeTurnBehavior, undefined, "Paseo runs it out of band; nothing to interrupt");
  const review = await run(fakeDaemon({ provider: "codex", commands: CODEX }), { command: "review" });
  assert.equal(review.data.outcome, "unavailable");
  assert.match(review.data.reason, /native review \(its review\/start API/);
});

test("read_chat shows a compaction as a line and drops the output Paseo repeats after a manual one", async () => {
  const client = fakeDaemon({
    history: [
      { type: "user_message", text: "fix the tests" },
      { type: "assistant_message", text: "## Context Usage" },
      { type: "user_message", text: "/compact" },
      { type: "compaction", status: "loading" },
      { type: "compaction", status: "completed", trigger: "manual", preTokens: 22772 },
      { type: "assistant_message", text: "## Context Usage" },
    ],
  });
  const read = await readChatOn(client, { chat: ID });
  assert.match(read.text, /User asked: \/compact\nAgent replied: \[context compacted from 23k tokens\]$/);
  const both = await readChatOn(client, { chat: ID, turns: 2 });
  assert.equal(both.data.turns[0].agent_text, "## Context Usage");
  assert.equal(both.data.turns[1].agent_text, "[context compacted from 23k tokens]");
});
