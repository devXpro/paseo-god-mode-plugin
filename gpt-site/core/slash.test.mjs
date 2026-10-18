// Run with: node --test core/*.test.mjs
// The slash command adapters: what each provider's commands are taken for, which ones run, how
// arguments and risk are judged, and how a run's timeline items read. Pure; no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adapterFor,
  afterCommand,
  commandData,
  commandResult,
  commandText,
  compactionNote,
  confirmText,
  contextChange,
  describeCommands,
  filterCommands,
  findCommand,
  listText,
  prepareCommandArgs,
  runRisk,
  splitCommand,
  withoutRepeatAfterCompaction,
} from "./slash.mjs";

// A slice of what Paseo listed for a live Claude Code 2.1.296 chat (2026-10-18), plus the shapes a
// plugin command and an MCP prompt take.
const CLAUDE_LIST = [
  { name: "__remote-workflow", description: "Run the workflow script delivered in this session environment", argumentHint: "", kind: "skill" },
  { name: "clear", description: "Start a new session with empty context; previous session stays on disk", argumentHint: "[name]", kind: "command" },
  { name: "code-review", description: "Review the current diff, or a PR number/branch/path target, for correctness bugs", argumentHint: "[low|medium|high|xhigh|max] [--fix] [--comment] [<pr#>|<branch>|<path>]", kind: "skill" },
  { name: "compact", description: "Free up context by summarizing the conversation so far", argumentHint: "<optional custom summarization instructions>", kind: "command" },
  { name: "context", description: "Show current context usage", argumentHint: "", kind: "command" },
  { name: "gm-ping", description: "God Mode test command; answers pong (project)", argumentHint: "[word]", kind: "skill" },
  { name: "heapdump", description: "Dump the JS heap to the Desktop", argumentHint: "", kind: "command" },
  { name: "model", description: "Set the AI model for Claude Code", argumentHint: "<model>", kind: "skill" },
  { name: "rewind", description: "Rewind tracked files to a previous user message", argumentHint: "[user_message_uuid]" },
  { name: "security-review", description: "Complete a security review of the pending changes on the current branch", argumentHint: "", kind: "skill" },
  { name: "simplify", description: "Review the changed code for reuse, simplification, efficiency", argumentHint: "[<target>]", kind: "skill" },
  { name: "workflow-launch-exec", description: "Execute a server-launched workflow handoff", argumentHint: "", kind: "skill" },
  { name: "deploy:prod", description: "Deploy the app to production", argumentHint: "", kind: "skill" },
  { name: "mcp__github__pr", description: "Summarise a pull request (MCP)", argumentHint: "<number>", kind: "skill" },
  { name: "shiny-new", description: "A built-in this God Mode does not know yet", argumentHint: "", kind: "skill" },
];

// What Paseo 0.11.4's Codex provider lists: its two built-ins, a skill from skills/list and a
// custom prompt from ~/.codex/prompts.
const CODEX_LIST = [
  { name: "compact", description: "Summarize conversation to prevent hitting the context limit", argumentHint: "", kind: "command" },
  { name: "goal", description: "Set, pause, resume, or clear the agent's goal", argumentHint: "[<objective>|pause|resume|clear]", kind: "command" },
  { name: "lint-fix", description: "Run the linters and fix what they find", argumentHint: "", kind: "skill" },
  { name: "prompts:release", description: "Draft release notes", argumentHint: "VERSION=<v>", kind: "command" },
];

const byName = (catalog) => Object.fromEntries(catalog.entries.map((e) => [e.name, e]));

test("Claude: built-ins get God Mode's verdict, the user's and plugins' own commands ask first, risky ones are refused with a reason", () => {
  const catalog = describeCommands("claude", CLAUDE_LIST);
  const c = byName(catalog);
  assert.equal(catalog.label, "Claude Code");
  assert.equal(catalog.runs, true);
  assert.deepEqual(commandData(c.context), {
    name: "context",
    usage: "/context",
    source: "built_in",
    description: "Show current context usage",
    effect: "Shows how full the context window is and what fills it. No model call.",
    args: "none",
    runs_model: false,
    risk: "low",
    asks_first: false,
    available: true,
    when_busy: "waits",
  });
  assert.equal(c.compact.risk, "disruptive");
  assert.equal(c.compact.asks_first, true);
  assert.equal(c.compact.args, "optional: what the summary should keep");
  assert.equal(c.compact.usage, "/compact <optional custom summarization instructions>");
  assert.equal(c["code-review"].asks_first, false, "a review that only reads runs at once");
  assert.equal(c.simplify.asks_first, true, "simplify edits files");
  for (const name of ["clear", "heapdump", "model", "rewind", "workflow-launch-exec", "__remote-workflow"]) {
    assert.equal(c[name].available, false, name);
    assert.ok(c[name].reason.length > 20, `${name} says why`);
  }
  assert.match(c.clear.reason, /archive_chat and start_chat|start_chat/);
  assert.match(c.heapdump.reason, /credentials/);
  assert.equal(c["__remote-workflow"].source, "internal");
  assert.equal(c["gm-ping"].source, "custom");
  assert.match(c["gm-ping"].effect, /^Runs the project's own command: God Mode test command; answers pong$/);
  assert.equal(c["deploy:prod"].source, "plugin");
  assert.equal(c.mcp__github__pr.source, "mcp_prompt");
  assert.equal(c["shiny-new"].source, "unclassified");
  for (const name of ["gm-ping", "deploy:prod", "mcp__github__pr", "shiny-new"]) {
    assert.equal(c[name].risk, "unknown", name);
    assert.equal(c[name].asks_first, true, `${name} runs only after a yes`);
    assert.equal(c[name].available, true, name);
  }
  const order = catalog.entries.map((e) => (!e.available ? 2 : e.asks_first ? 1 : 0));
  assert.deepEqual(order, [...order].sort(), "runs at once, then asks first, then not available");
  assert.equal(commandData(c.compact).compaction, undefined, "how it runs stays internal");
});

test("Claude: a project's own command that shadows a built-in name is the project's, and asks first", () => {
  const catalog = describeCommands("claude", [{ name: "code-review", description: "Our own team review checklist (project)", argumentHint: "", kind: "skill" }]);
  const review = catalog.entries[0];
  assert.equal(review.source, "custom");
  assert.equal(review.risk, "unknown");
  assert.equal(review.asks_first, true);
});

test("Codex: compact and goal are Paseo's app-server calls, skills and prompts ask first, and its own review is honestly not here", () => {
  const catalog = describeCommands("codex", CODEX_LIST);
  const c = byName(catalog);
  assert.equal(catalog.label, "Codex");
  assert.equal(c.compact.outOfBand, true);
  assert.equal(c.compact.compaction, true);
  assert.equal(c.compact.args, "none");
  assert.match(c.compact.effect, /thread\/compact\/start/);
  assert.equal(c.goal.when_busy, "alongside");
  assert.equal(c.goal.asks_first, true);
  assert.equal(c["lint-fix"].source, "skill");
  assert.equal(c["lint-fix"].asks_first, true);
  assert.equal(c["prompts:release"].source, "custom_prompt");
  assert.match(c["prompts:release"].effect, /filled in by Paseo from ~\/\.codex\/prompts/);
  for (const name of ["review", "init", "model", "new", "diff", "status"]) {
    assert.equal(c[name].available, false, `${name} is listed as not available`);
  }
  assert.match(c.review.reason, /native review \(its review\/start API/);
  assert.match(c.review.reason, /Paseo 0\.11\.4 does not expose it/);
  const plan = findCommand(catalog, "plan");
  assert.equal(plan.match.available, false);
  assert.match(plan.match.reason, /Terminal-only in Codex/);
  const goalOff = findCommand(describeCommands("codex", CODEX_LIST.filter((i) => i.name !== "goal")), "goal");
  assert.match(goalOff.match.reason, /without goals/);
});

test("other providers are listed but not run: how they run commands through Paseo is not verified", () => {
  const catalog = describeCommands("opencode", [{ name: "summarize", description: "Summarise the session", argumentHint: "", kind: "command" }]);
  assert.equal(catalog.runs, false);
  assert.match(catalog.reason, /only in Claude Code and Codex chats/);
  assert.equal(catalog.entries[0].available, false);
  assert.equal(adapterFor(undefined).runs, false);
  assert.equal(findCommand(catalog, "compact").candidates.length, 0, "no provider knowledge to explain a missing name with");
});

test("a command is found by its exact name, a prefix or its words; unclear names give candidates, runnable ones first", () => {
  const catalog = describeCommands("claude", CLAUDE_LIST);
  assert.equal(findCommand(catalog, "/Compact").match.name, "compact");
  assert.equal(findCommand(catalog, "compac").match.name, "compact", "a 6-letter prefix");
  assert.equal(findCommand(catalog, "security review").match.name, "security-review");
  assert.equal(findCommand(catalog, "review").match.name, "code-review", "Paseo drops aliases; /review runs as the listed /code-review");
  const rev = findCommand(catalog, "rev");
  assert.equal(rev.match, undefined);
  assert.deepEqual(rev.candidates.map((e) => e.name), ["code-review", "security-review"]);
  assert.deepEqual(findCommand(catalog, "definitely-not-a-command").candidates, []);
  assert.deepEqual(findCommand(catalog, "").candidates, []);
  const resume = findCommand(catalog, "resume");
  assert.equal(resume.match.available, false, "a known built-in this chat does not list says why");
  assert.match(resume.match.reason, /another session/);
});

test("the name and its arguments: inline arguments split off, or args, never both", () => {
  assert.deepEqual(splitCommand("/code-review --fix", undefined), { name: "code-review", args: "--fix" });
  assert.deepEqual(splitCommand("compact", "keep the API notes"), { name: "compact", args: "keep the API notes" });
  assert.deepEqual(splitCommand("compact", undefined), { name: "compact", args: "" });
  assert.ok(splitCommand("/compact keep it", "and this").invalid);
});

test("arguments are one line; a second command cannot ride along, and Codex's compact takes none", () => {
  const claude = byName(describeCommands("claude", CLAUDE_LIST));
  const codex = byName(describeCommands("codex", CODEX_LIST));
  assert.deepEqual(prepareCommandArgs(claude.compact, "  keep\n the   API notes "), { args: "keep the API notes" });
  assert.deepEqual(prepareCommandArgs(claude.compact, ""), { args: "" });
  assert.match(prepareCommandArgs(claude.compact, "/clear").invalid, /must not start with a slash/);
  assert.match(prepareCommandArgs(claude.compact, "x".repeat(2001)).invalid, /2000/);
  assert.match(prepareCommandArgs(codex.compact, "keep notes").invalid, /takes no arguments here: Codex compacts without instructions/);
  assert.deepEqual(prepareCommandArgs(codex.compact, "  "), { args: "" });
  assert.equal(commandText(claude.compact, "keep notes"), "/compact keep notes");
  assert.equal(commandText(claude.context, ""), "/context");
});

test("arguments that make a review act raise its risk", () => {
  const review = byName(describeCommands("claude", CLAUDE_LIST))["code-review"];
  assert.deepEqual(runRisk(review, "high"), { risk: "low", asksFirst: false, notes: [] });
  assert.deepEqual(runRisk(review, "--fix"), { risk: "disruptive", asksFirst: true, notes: ["--fix edits files"] });
  assert.deepEqual(runRisk(review, "123 --comment"), { risk: "outward", asksFirst: true, notes: ["--comment posts on the pull request"] });
  assert.equal(runRisk(review, "--comment --fix").risk, "disruptive");
  assert.equal(runRisk(review, "--fixes").risk, "low", "only the flag itself");
  const ping = byName(describeCommands("claude", CLAUDE_LIST))["gm-ping"];
  assert.deepEqual(runRisk(ping, "hi"), { risk: "unknown", asksFirst: true, notes: [] });
});

test("the confirmation says the command, the chat, what it does, and what this run adds", () => {
  const c = byName(describeCommands("claude", CLAUDE_LIST));
  const plain = confirmText(c["gm-ping"], { chatTitle: "Fleet map", label: "Claude Code", args: "hi" });
  assert.equal(plain, "Run /gm-ping hi in «Fleet map» (Claude Code): Runs the project's own command: God Mode test command; answers pong.");
  const loud = confirmText(c["code-review"], { chatTitle: "Fleet map", label: "Claude Code", args: "--fix", notes: ["--fix edits files"], interrupting: true, mode: "bypassPermissions" });
  assert.match(loud, /^Run \/code-review --fix in «Fleet map» \(Claude Code\): Reviews the current diff/);
  assert.match(loud, /This run: --fix edits files\./);
  assert.match(loud, /permissions bypassed, so nothing asks before it acts/);
  assert.match(loud, /It stops the chat's current work first\.$/);
});

test("the run's own items are the ones after its message", () => {
  const items = [
    { type: "assistant_message", text: "earlier" },
    { type: "user_message", text: "/context", clientMessageId: "m1" },
    { type: "assistant_message", text: "## Context Usage" },
  ];
  assert.deepEqual(afterCommand(items, "m1"), [{ type: "assistant_message", text: "## Context Usage" }]);
  assert.equal(afterCommand(items, "m2"), null);
});

const BEFORE = { contextWindowMaxTokens: 1_000_000, contextWindowUsedTokens: 22684 };
const AFTER = { contextWindowMaxTokens: 1_000_000, contextWindowUsedTokens: 1755 };

test("a done /compact reports the context before and after, and ignores the earlier output Paseo repeats", () => {
  const compact = byName(describeCommands("claude", CLAUDE_LIST)).compact;
  // Seen live: loading, completed with preTokens, then the previous /context output again.
  const items = [
    { type: "compaction", status: "loading" },
    { type: "compaction", status: "completed", trigger: "manual", preTokens: 22772 },
    { type: "assistant_message", text: "## Context Usage …" },
  ];
  const result = commandResult(compact, { items, status: "idle", usageBefore: BEFORE, usageAfter: AFTER });
  assert.deepEqual(result, { outcome: "done", settled: true, context: { before_tokens: 22772, after_tokens: 1755, max_tokens: 1_000_000, percent_used: 0 } });
  assert.equal(contextChange(result.context), "context 23k → 2k tokens (0% of 1M)");
  const unknownAfter = commandResult(compact, { items, status: "idle", usageBefore: BEFORE, usageAfter: BEFORE });
  assert.deepEqual(unknownAfter.context, { before_tokens: 22772, max_tokens: 1_000_000 });
  assert.equal(contextChange(unknownAfter.context), "context was 23k tokens");
});

test("a /compact that cannot run says why; a failed one is an error; a running one is not settled", () => {
  const claude = byName(describeCommands("claude", CLAUDE_LIST)).compact;
  const codex = byName(describeCommands("codex", CODEX_LIST)).compact;
  const refused = commandResult(claude, { items: [{ type: "compaction", status: "loading" }, { type: "assistant_message", text: "Not enough messages to compact." }], status: "idle" });
  assert.deepEqual(refused, { outcome: "refused", settled: true, reason: "Not enough messages to compact." });
  const failed = commandResult(codex, { items: [{ type: "assistant_message", text: "Failed to compact context: thread is busy" }], status: "idle" });
  assert.deepEqual(failed, { outcome: "error", settled: true, error: "Failed to compact context: thread is busy" });
  assert.deepEqual(commandResult(claude, { items: [{ type: "compaction", status: "loading" }], status: "running" }), { outcome: "still_working", settled: false });
  assert.deepEqual(commandResult(codex, { items: [], status: "idle" }), { outcome: "still_working", settled: false }, "Codex compacts outside any turn: not there yet");
  assert.equal(commandResult(claude, { items: [], status: "idle" }).outcome, "error", "a turn that ended with nothing is not confirmed");
});

test("other commands: their output, an approval, an error, or still running", () => {
  const c = byName(describeCommands("claude", CLAUDE_LIST));
  const goal = byName(describeCommands("codex", CODEX_LIST)).goal;
  assert.deepEqual(commandResult(c.context, { items: [{ type: "assistant_message", text: "## Context Usage" }], status: "idle" }), { outcome: "replied", settled: true, reply: "## Context Usage" });
  assert.deepEqual(commandResult(c["gm-ping"], { items: [], status: "idle" }), { outcome: "replied", settled: true, reply: "" });
  assert.deepEqual(commandResult(c["gm-ping"], { items: [], status: "running", approval: "run: rm -rf build" }), { outcome: "waiting_for_approval", settled: true, approval: "run: rm -rf build" });
  assert.deepEqual(commandResult(c["gm-ping"], { items: [{ type: "error", message: "overloaded" }], status: "idle" }), { outcome: "error", settled: true, error: "overloaded" });
  assert.deepEqual(commandResult(c["gm-ping"], { items: [{ type: "assistant_message", text: "half" }], status: "running" }), { outcome: "still_working", settled: false });
  assert.deepEqual(commandResult(goal, { items: [{ type: "assistant_message", text: "Goal paused." }], status: "running" }), { outcome: "replied", settled: true, reply: "Goal paused." }, "Codex's /goal answers beside a running turn");
});

test("read_chat: a manual compaction ends its turn, an automatic one does not", () => {
  const manual = [
    { type: "user_message", text: "/compact" },
    { type: "compaction", status: "completed", trigger: "manual", preTokens: 22772 },
    { type: "assistant_message", text: "## Context Usage (repeated)" },
  ];
  assert.deepEqual(withoutRepeatAfterCompaction(manual).map((i) => i.type), ["user_message", "compaction"]);
  const auto = [{ type: "compaction", status: "completed", trigger: "auto", preTokens: 160000 }, { type: "assistant_message", text: "Done: the tests pass." }];
  assert.equal(withoutRepeatAfterCompaction(auto).length, 2);
  assert.equal(compactionNote(manual[1]), "[context compacted from 23k tokens]");
  assert.equal(compactionNote(auto[0]), "[context compacted from 160k tokens, automatically]");
});

test("a query finds commands by name first, then by what they do", () => {
  const catalog = describeCommands("claude", CLAUDE_LIST);
  assert.deepEqual(filterCommands(catalog, "review").map((e) => e.name), ["code-review", "security-review", "simplify"]);
  assert.equal(filterCommands(catalog, "/compact")[0].name, "compact");
  assert.equal(filterCommands(catalog, "").length, catalog.entries.length);
  assert.deepEqual(filterCommands(catalog, "сожми"), [], "Russian words do not match English descriptions; ChatGPT passes the English name");
});

test("the list reads as groups, or in detail for a query, and says where commands run", () => {
  const catalog = describeCommands("claude", CLAUDE_LIST);
  const all = listText({ chatLine: "Fleet map (proxy): idle", catalog, shown: catalog.entries, total: catalog.entries.length, query: "", mode: "bypassPermissions" });
  assert.match(all, /^Fleet map \(proxy\): idle\nClaude Code: 15 command\(s\)\./);
  assert.match(all, /\nRuns at once: code-review, context, security-review\.\n/);
  assert.match(all, /\nRuns after the user's yes: compact, deploy:prod, gm-ping, mcp__github__pr, shiny-new, simplify\.\n/);
  assert.match(all, /\nNot from here: __remote-workflow, clear, heapdump, model, rewind, workflow-launch-exec /);
  assert.match(all, /nothing asks before a command acts/);
  const one = listText({ chatLine: "Fleet map (proxy): idle", catalog, shown: [byName(catalog).compact], total: 1, query: "compact", mode: "default" });
  assert.match(one, /- \/compact <optional custom summarization instructions>: Summarises the conversation so far .* Asks first \(disruptive\)\./);
  assert.doesNotMatch(one, /bypassed/);
  const other = describeCommands("opencode", [{ name: "summarize", description: "Summarise", argumentHint: "" }]);
  assert.match(listText({ chatLine: "X", catalog: other, shown: other.entries, total: 1, query: "" }), /only in Claude Code and Codex chats[^\n]*\nListed: summarize\./);
});
