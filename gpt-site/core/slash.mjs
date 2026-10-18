// Slash commands in agent chats: which commands a chat's agent offers, what each one does, whether
// God Mode runs it, and what a run did. Pure; the Paseo calls are in paseo.mjs
// (listSlashCommandsOn, runSlashCommandOn), so all of this runs under node --test.
//
// What Paseo 0.11.4 offers, read from its code and checked on live chats (2026-10-18):
// - list_commands gives a chat's commands as { name, description, argumentHint, kind }, from the
//   agent's runtime: Claude Code's supportedCommands(), or what Paseo's Codex provider assembles
//   (compact, goal, skills/list, ~/.codex/prompts). Nothing says where a command comes from or what
//   it risks; that is what the adapters below add.
// - There is no command RPC. A command runs when the chat gets the message "/name args" and the
//   provider behind the chat interprets it: Claude Code expands it itself, Paseo's Codex provider
//   turns /compact and /goal into app-server calls (thread/compact/start, thread/goal/*), a skill
//   into a native skill input and a custom prompt into its text. Anything else reaches the model as
//   an ordinary message (Claude Code 2.1.274+ answers an unknown /name with a model turn), so God
//   Mode sends only a name the chat lists and its adapter knows how the provider runs.
// - A command sent to a working chat replaces the turn in progress, even with steer (Paseo falls
//   back to interrupting when the provider refuses to steer a command), so God Mode holds it unless
//   the user says to interrupt.

import { normalize, resolve, truncate } from "./text.mjs";

export const MAX_ARGS = 2000;
const RISK_ORDER = ["low", "outward", "disruptive", "destructive"];

// ---- What each provider runs -------------------------------------------------------------------

// A command God Mode knows: its risk (the levels of the plugin contract, docs/plugin-capabilities.md),
// what it does in words a listener understands, and whether it calls the model (costs tokens).
const known = (risk, effect, extra = {}) => ({ risk, effect, ...extra });
// A command God Mode does not run, with why and what to use instead.
const blocked = (reason) => ({ blocked: reason });
const each = (list, policy) => Object.fromEntries(list.map((name) => [name, policy]));

const SESSION = "It changes this chat's session settings behind Paseo's back; change them in Paseo on the computer.";
const MODEL = "It switches this chat's model or effort behind Paseo's back; change it in Paseo on the computer.";
const TERMINAL = "A screen or control of the agent's own terminal app; it does nothing useful in a Paseo chat.";
const ACCOUNT = "Account, billing or access settings; do it on the computer.";
const ELSEWHERE = "It moves the conversation to another session or device, which Paseo does not follow; start_chat opens a new chat instead.";
const REMOVED = "Removed from Claude Code.";
const NEW_CHAT = "Start a new chat with start_chat (and archive this one with archive_chat if it is done).";

// "--fix" edits files and "--comment" posts on the pull request: reading and reporting is low risk,
// those two are not.
function reviewRisk(args) {
  const notes = [];
  let risk = null;
  if (/(^|\s)--fix(\s|=|$)/.test(args)) {
    notes.push("--fix edits files");
    risk = "disruptive";
  }
  if (/(^|\s)--comment(\s|=|$)/.test(args)) {
    notes.push("--comment posts on the pull request");
    risk = risk ?? "outward";
  }
  return risk ? { risk, notes } : null;
}

const REVIEW = known("low", "Reviews the current diff, or a PR, branch or path given as args, and reports bugs; reads only unless --fix or --comment.", { model: true, argRisk: reviewRisk });
const USAGE = known("low", "Shows the session's cost and the plan's usage limits. No model call.", { model: false });
const CLEAR = blocked(`It starts a fresh Claude session inside this chat, which Paseo does not follow (Paseo's own /clear archives the chat and opens a new one). ${NEW_CHAT}`);
const REWIND = blocked("It rolls files and the conversation back to an earlier message, chosen by an id God Mode does not have; do it in Paseo on the computer.");

// Claude Code 2.1.296 as Paseo lists it (56 commands in a live chat), plus the built-ins of its
// command reference that a chat may list. Names missing here are a user's, project's or plugin's
// own commands, or newer built-ins; those run only after the user's yes.
const CLAUDE = {
  compact: known("disruptive", "Summarises the conversation so far to free the context window; whatever the summary leaves out is gone for the agent. Seconds, or minutes on a full context.", {
    model: true,
    compaction: true,
    args: "optional: what the summary should keep",
  }),
  context: known("low", "Shows how full the context window is and what fills it. No model call.", { model: false }),
  usage: USAGE,
  cost: USAGE,
  stats: USAGE,
  "code-review": REVIEW,
  review: REVIEW,
  "security-review": known("low", "Reviews the changes on the current branch for security problems; reads only.", { model: true }),
  recap: known("low", "Writes a one-line recap of the session.", { model: true }),
  insights: known("low", "Writes a report on recent Claude Code sessions on this computer.", { model: true }),
  "skill-doctor": known("low", "Shows which skills go unused and what they cost in context.", { model: false }),
  "list-agents": known("low", "Lists the subagents and other Claude sessions this agent can message.", { model: false }),
  debug: known("low", "Turns on debug logging for this session and helps diagnose an issue.", { model: true }),
  "deep-research": known("low", "Researches a question on the web with many parallel searches; heavy on tokens.", { model: true }),
  "claude-api": known("low", "Loads the Claude API reference for the agent.", { model: true }),
  dataviz: known("low", "Loads chart and dashboard design guidance for the agent.", { model: true }),
  "workflow-authoring": known("low", "Loads the workflow script reference for the agent.", { model: true }),
  verify: known("low", "Builds and exercises the project to check that a change works.", { model: true }),
  run: known("low", "Launches the project's app and drives it to see a change working.", { model: true }),
  "reload-skills": known("low", "Picks up skills and commands added on disk during the session.", { model: false }),
  "reload-plugins": known("low", "Activates pending Claude Code plugin changes in this session.", { model: false }),
  "team-onboarding": known("low", "Writes a Claude Code onboarding guide from this computer's usage.", { model: true }),
  init: known("disruptive", "Writes or rewrites the project's CLAUDE.md.", { model: true }),
  simplify: known("disruptive", "Reviews the changed code and applies cleanups to the files.", { model: true }),
  batch: known("disruptive", "Plans a large change and carries it out across the codebase in parallel.", { model: true }),
  goal: known("disruptive", "Sets a goal: the agent keeps working, turn after turn, until the condition is met.", { model: true }),
  loop: known("disruptive", "Runs a prompt again and again on an interval while the session is open.", { model: true }),
  schedule: known("outward", "Creates, changes or runs routines that run in Anthropic's cloud.", { model: true }),
  "update-config": known("disruptive", "Changes Claude Code's settings: permissions, hooks, environment.", { model: true }),
  "fewer-permission-prompts": known("disruptive", "Adds allow rules for commands found in past sessions to the permission settings.", { model: true }),
  "run-skill-generator": known("disruptive", "Writes a project skill that teaches /run how to build and launch the app.", { model: true }),
  doctor: known("disruptive", "Checks the Claude Code setup and fixes the problems it finds.", { model: true }),
  "plugin-authoring": known("disruptive", "Makes a mod: a change to Claude Code's own interface or behaviour.", { model: true }),
  "design-sync": known("outward", "Converts the repo's React design system and uploads it to claude.ai/design.", { model: true }),
  subtask: known("disruptive", "Starts a forked background subagent on a task; its result comes back to this chat.", { model: true }),
  clear: CLEAR,
  reset: CLEAR,
  new: CLEAR,
  rewind: REWIND,
  checkpoint: REWIND,
  undo: REWIND,
  heapdump: blocked("It writes a memory dump with the whole conversation and credentials to the Desktop."),
  bug: blocked("It sends the conversation to Anthropic; not from ChatGPT."),
  feedback: blocked("It sends the conversation to Anthropic; not from ChatGPT."),
  export: blocked("It writes the conversation to a file or the clipboard; ask the agent instead."),
  "workflow-launch-exec": blocked("Internal to Claude Code's cloud workflows."),
  ...each(["model", "effort", "fast", "advisor"], blocked(MODEL)),
  ...each(["config", "output-style", "autocompact", "auto-mode-setup", "import", "mcp", "rename", "permissions", "plan", "hooks", "memory", "add-dir", "cd", "sandbox", "plugin"], blocked(SESSION)),
  ...each(
    [
      "color", "focus", "keybindings", "theme", "statusline", "tui", "voice", "ide", "chrome", "terminal-setup", "scroll-speed", "skills",
      "help", "exit", "copy", "tasks", "workflows", "artifacts", "release-notes", "powerup", "stickers", "radio", "btw", "status", "diff", "stop",
    ],
    blocked(TERMINAL),
  ),
  ...each(
    [
      "login", "logout", "upgrade", "usage-credits", "extra-usage", "privacy-settings", "passes", "rate-limit-options", "design", "design-consent",
      "design-revoke", "design-login", "install-github-app", "install-slack-app", "web-setup", "setup-bedrock", "setup-vertex", "remote-env",
    ],
    blocked(ACCOUNT),
  ),
  ...each(["fork", "branch", "background", "resume", "teleport", "remote-control", "desktop", "mobile", "ios", "android", "autofix-pr", "ultrareview"], blocked(ELSEWHERE)),
  ...each(["agents", "pr-comments", "ultraplan", "vim"], blocked(REMOVED)),
};

// Paseo drops the aliases Claude Code reports, so a chat lists /code-review but not /review. A name
// asked for by its alias runs as the command the chat does list.
const CLAUDE_ALIASES = {
  review: "code-review",
  cost: "usage",
  stats: "usage",
  reset: "clear",
  new: "clear",
  checkpoint: "rewind",
  undo: "rewind",
  proactive: "loop",
  routines: "schedule",
  peers: "list-agents",
};

// Claude Code puts the scope of a user's or project's own command at the end of its description
// ("God Mode test command; answers pong (project)"); plugins namespace theirs as plugin:name, and MCP
// prompts are mcp__server__prompt. Such a command is the user's or a plugin's even when its name is
// also a built-in's (a project /review shadows the bundled one).
function ownClaude(item) {
  const description = String(item.description ?? "");
  if (item.name.startsWith("__")) return { source: "internal", blocked: "Internal to Claude Code." };
  if (item.name.startsWith("mcp__") || /\(MCP\)\s*$/.test(description)) {
    return { source: "mcp_prompt", effect: `Sends the MCP prompt ${item.name} to the agent: ${description}` };
  }
  const scope = description.match(/\((project|user|local)\)\s*$/)?.[1];
  if (scope) return { source: "custom", effect: `Runs the ${scope}'s own command: ${description.replace(/\s*\((project|user|local)\)\s*$/, "")}` };
  if (item.name.includes(":")) return { source: "plugin", effect: `Runs a plugin's command: ${description}` };
  return null;
}

// Codex as Paseo's provider runs it: compact and goal are app-server calls Paseo makes outside any
// turn; everything else Paseo lists is a skill (a native skill input) or a custom prompt it fills in.
const CODEX = {
  compact: known("disruptive", "Codex summarises the thread to free the context window (its thread/compact/start API); whatever the summary leaves out is gone for the agent. A turn in progress is stopped.", {
    model: true,
    compaction: true,
    outOfBand: true,
    noArgs: "Codex compacts without instructions.",
  }),
  goal: known("disruptive", "Sets, pauses, resumes or clears the thread's goal (Codex's thread/goal API); with a goal set, Codex keeps working toward it.", {
    model: null,
    outOfBand: true,
    whenBusy: "alongside",
  }),
};

function ownCodex(item) {
  const description = String(item.description ?? "");
  if (item.name.startsWith("prompts:")) {
    return { source: "custom_prompt", effect: `Sends the custom prompt ${item.name.slice("prompts:".length)}, filled in by Paseo from ~/.codex/prompts: ${description}` };
  }
  if (item.kind === "skill") return { source: "skill", effect: `Runs the Codex skill ${item.name}: ${description}` };
  return null;
}

// Codex's own commands that Paseo does not run. As text they would reach the model as ordinary
// messages, so they are not available, each with what to do instead. The first six are listed with
// the chat's commands; the rest are explained when someone asks to run one.
const CODEX_NOT_HERE = {
  review: "Codex has a native review (its review/start API: uncommitted changes, a base branch, a commit or custom instructions), but Paseo 0.11.4 does not expose it, and as text it would reach the model as an ordinary message. Ask the agent to review the changes instead.",
  init: "The Codex terminal app sends its own AGENTS.md prompt for /init; Paseo has no equivalent. Ask the agent to write AGENTS.md instead.",
  model: MODEL,
  new: NEW_CHAT,
  diff: "Terminal-only in Codex; ask the agent to show the diff.",
  status: "Terminal-only in Codex; read_chat and read_activity tell the chat's state and how full its context is.",
  clear: NEW_CHAT,
  fork: "Paseo does not expose Codex's fork; start_chat opens a new chat.",
  undo: "Paseo does not expose a Codex rollback to ChatGPT; do it in Paseo on the computer.",
  goal: "This chat's Codex runs without goals, so Paseo does not offer /goal here.",
  ...each(
    [
      "plan", "rename", "archive", "delete", "resume", "skills", "mcp", "ps", "stop", "usage", "mention", "recap", "side", "btw", "permissions",
      "approve", "approvals", "experimental", "memories", "hooks", "plugins", "apps", "ide", "cd", "pwd", "copy", "export", "raw", "vim", "keymap",
      "theme", "pets", "title", "statusline", "tui", "voice", "agents", "subagents", "feedback", "logout", "quit", "exit", "worktree", "app",
      "import", "daybreak", "daemon", "warnings", "rollout",
    ],
    "Terminal-only in Codex; Paseo has no way to run it.",
  ),
};

const ADAPTERS = {
  claude: { label: "Claude Code", runs: true, known: CLAUDE, aliases: CLAUDE_ALIASES, own: ownClaude, notHere: {}, shownNotHere: [] },
  codex: { label: "Codex", runs: true, known: CODEX, aliases: {}, own: ownCodex, notHere: CODEX_NOT_HERE, shownNotHere: ["review", "init", "model", "new", "diff", "status"] },
};

// The adapter of a chat's provider. Other providers are listed through Paseo but not run: how each
// one turns "/name" into a command through Paseo has not been verified.
export function adapterFor(provider) {
  const adapter = ADAPTERS[provider];
  if (adapter) return adapter;
  const label = provider ? String(provider) : "this agent";
  return {
    label,
    runs: false,
    reason: `God Mode runs slash commands only in Claude Code and Codex chats; how ${label} runs them through Paseo has not been verified.`,
    known: {},
    aliases: {},
    own: (item) => ({ source: item.kind === "skill" ? "skill" : "command", effect: String(item.description ?? "") }),
    notHere: {},
    shownNotHere: [],
  };
}

// ---- The catalog ------------------------------------------------------------------------------

// One command as God Mode treats it. The fields after `when_busy` say how to run it and read its
// result; commandData leaves them out of what ChatGPT gets.
function entryOf(adapter, item) {
  const name = item.name;
  const hint = String(item.argumentHint ?? "").trim();
  const description = String(item.description ?? "").trim();
  const policy = adapter.own(item) ?? adapter.known[name] ?? { source: "unclassified", effect: `A command this God Mode version does not know: ${description}` };
  const source = policy.source ?? "built_in";
  const reason = !adapter.runs ? "God Mode does not run this agent's commands (not verified)." : policy.blocked ?? null;
  const risk = reason ? null : policy.risk ?? "unknown";
  return {
    name,
    usage: hint ? `/${name} ${hint}` : `/${name}`,
    source,
    description,
    effect: policy.effect ?? description,
    args: policy.noArgs ? "none" : policy.args ?? (hint || "none"),
    runs_model: policy.model === undefined ? null : policy.model,
    risk: risk ?? "unknown",
    asks_first: Boolean(risk && risk !== "low"),
    available: !reason,
    ...(reason ? { reason } : {}),
    when_busy: policy.whenBusy ?? "waits",
    compaction: Boolean(policy.compaction),
    outOfBand: Boolean(policy.outOfBand),
    noArgs: policy.noArgs ?? null,
    argRisk: policy.argRisk ?? null,
  };
}

// A command the provider has but this chat does not list: it cannot run here, and says why.
function missingEntry(name, reason) {
  return {
    name,
    usage: `/${name}`,
    source: "built_in",
    description: "",
    effect: reason,
    args: "none",
    runs_model: null,
    risk: "unknown",
    asks_first: false,
    available: false,
    reason,
    when_busy: "waits",
    compaction: false,
    outOfBand: false,
    noArgs: null,
    argRisk: null,
  };
}

function missingReason(adapter, name) {
  if (adapter.notHere[name]) return adapter.notHere[name];
  const policy = adapter.known[name];
  if (policy?.blocked) return policy.blocked;
  if (policy) return `${adapter.label} does not offer /${name} in this chat right now.`;
  return null;
}

const GROUP = (e) => (!e.available ? 2 : e.asks_first ? 1 : 0);

// The chat's commands as list_commands gave them, each with God Mode's verdict, runnable ones
// first; then the provider's notable commands that the chat cannot run here.
export function describeCommands(provider, listed) {
  const adapter = adapterFor(provider);
  const entries = (Array.isArray(listed) ? listed : [])
    .filter((item) => item && typeof item.name === "string" && item.name.trim() && !/[\s/]/.test(item.name))
    .map((item) => entryOf(adapter, item))
    .filter((entry, i, all) => all.findIndex((e) => e.name === entry.name) === i);
  const names = new Set(entries.map((e) => e.name));
  const missing = adapter.shownNotHere.filter((name) => !names.has(name)).map((name) => missingEntry(name, adapter.notHere[name]));
  entries.sort((a, b) => GROUP(a) - GROUP(b) || a.name.localeCompare(b.name));
  return {
    provider: provider ?? null,
    label: adapter.label,
    runs: adapter.runs,
    ...(adapter.reason ? { reason: adapter.reason } : {}),
    entries: [...entries, ...missing],
    alias: (name) => adapter.aliases[name] ?? null,
    missing: (name) => (adapter.runs ? missingReason(adapter, name) : null),
  };
}

// The fields list_slash_commands returns for one command; how it runs stays inside.
const DATA_FIELDS = ["name", "usage", "source", "description", "effect", "args", "runs_model", "risk", "asks_first", "available", "reason", "when_busy"];

export function commandData(entry) {
  return Object.fromEntries(DATA_FIELDS.filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]]));
}

// The commands whose name, description or effect has any of the query's words, best first; the
// name itself ranks a command above one that only mentions it.
export function filterCommands(catalog, query) {
  const raw = String(query ?? "").trim().replace(/^\/+/, "").toLowerCase();
  const words = normalize(raw).split(" ").filter((w) => w.length >= 2);
  if (!words.length) return catalog.entries;
  return catalog.entries
    .map((entry) => {
      const text = normalize(`${entry.name} ${entry.description} ${entry.effect}`);
      const score = words.filter((w) => text.includes(w)).length + (entry.name.toLowerCase() === raw ? words.length : 0);
      return { entry, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || GROUP(a.entry) - GROUP(b.entry))
    .map((s) => s.entry);
}

// ---- Picking a command and its arguments ------------------------------------------------------

// The name and the arguments. "/review --fix" given as the command is the name and its args; given
// args as well, the call is ambiguous.
export function splitCommand(command, args) {
  const text = String(command ?? "").trim().replace(/^\/+/, "");
  const space = text.search(/\s/);
  if (space < 0) return { name: text, args: String(args ?? "") };
  if (String(args ?? "").trim()) return { invalid: "Put the arguments in args, and only the command's name in command." };
  return { name: text.slice(0, space), args: text.slice(space + 1) };
}

// The command the user meant: an exact name (ignoring case and the slash), a name the provider has
// but this chat does not list (so the answer can say why), or the best words of name and
// description. Otherwise up to three candidates, runnable ones first.
export function findCommand(catalog, query) {
  const name = String(query ?? "").trim().replace(/^\/+/, "").toLowerCase();
  if (!name) return { candidates: [] };
  const exact = catalog.entries.find((e) => e.name.toLowerCase() === name);
  if (exact) return { match: exact };
  const aliased = catalog.alias(name) && catalog.entries.find((e) => e.name === catalog.alias(name));
  if (aliased) return { match: aliased };
  const reason = catalog.missing(name);
  if (reason) return { match: missingEntry(name, reason) };
  // Names only: matching descriptions offers commands that merely mention a word of the query.
  const found = resolve(catalog.entries, name, { id: (e) => e.name.toLowerCase(), text: (e) => e.name.replaceAll(/[-_:]/g, " ") });
  if (found.match) return { match: found.match };
  const candidates = [...(found.top ?? []), ...found.candidates].filter((e, i, all) => all.indexOf(e) === i);
  return { candidates: candidates.sort((a, b) => GROUP(a) - GROUP(b)).slice(0, 3) };
}

// Arguments as one line of text after the name. A second command cannot ride along: args that start
// with a slash are refused.
export function prepareCommandArgs(entry, raw) {
  const args = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!args) return { args: "" };
  if (entry.noArgs) return { invalid: `/${entry.name} takes no arguments here: ${entry.noArgs}` };
  if (args.startsWith("/")) return { invalid: "args must not start with a slash: one call runs one command." };
  if (args.length > MAX_ARGS) return { invalid: `args are limited to ${MAX_ARGS} characters.` };
  return { args };
}

export function commandText(entry, args) {
  return args ? `/${entry.name} ${args}` : `/${entry.name}`;
}

// The risk of this run: the command's own, raised by arguments that make it act (code-review --fix).
// Anything but low asks first.
export function runRisk(entry, args) {
  const raised = entry.argRisk?.(args) ?? null;
  const risk = raised && (entry.risk === "unknown" || RISK_ORDER.indexOf(raised.risk) > RISK_ORDER.indexOf(entry.risk)) ? raised.risk : entry.risk;
  return { risk, asksFirst: risk !== "low", notes: raised?.notes ?? [] };
}

const sentence = (text) => (/[.!?…]$/.test(text) ? text : `${text}.`);

// What the user hears before saying yes: the command, the chat, what it does, and what this run adds.
export function confirmText(entry, { chatTitle, label, args, notes = [], interrupting = false, mode = null }) {
  const parts = [`Run ${commandText(entry, args)} in «${truncate(chatTitle, 60)}» (${label}): ${sentence(truncate(entry.effect, 260))}`];
  if (notes.length) parts.push(`This run: ${notes.join("; ")}.`);
  if (mode === "bypassPermissions") parts.push("The chat runs with permissions bypassed, so nothing asks before it acts.");
  if (interrupting) parts.push("It stops the chat's current work first.");
  return parts.join(" ");
}

// ---- What a run did ---------------------------------------------------------------------------

// The timeline items after the user message God Mode sent (found by its client message id), or null
// while that message is not in the timeline yet.
export function afterCommand(items, messageId) {
  const at = items.findIndex((item) => item?.type === "user_message" && item.clientMessageId === messageId);
  return at < 0 ? null : items.slice(at + 1);
}

const textsOf = (items) => items.filter((i) => i.type === "assistant_message" && String(i.text ?? "").trim()).map((i) => i.text.trim());
const errorsOf = (items) => items.filter((i) => i.type === "error").map((i) => String(i.message ?? "error"));
const FAILED = /^(\[Error\]|Failed to |Error:)/i;
const isBusy = (status) => status === "running" || status === "initializing";

function contextAfterCompaction(item, before, after) {
  const max = after?.contextWindowMaxTokens ?? before?.contextWindowMaxTokens;
  const was = Number.isFinite(item.preTokens) ? item.preTokens : before?.contextWindowUsedTokens;
  const now = after?.contextWindowUsedTokens;
  const changed = Number.isFinite(now) && now !== before?.contextWindowUsedTokens;
  const context = {};
  if (Number.isFinite(was)) context.before_tokens = was;
  if (changed) context.after_tokens = now;
  if (Number.isFinite(max) && max > 0) {
    context.max_tokens = max;
    if (changed) context.percent_used = Math.round((now / max) * 100);
  }
  return context;
}

// What one command did, from the items the timeline gained after it and the chat's state:
// { outcome, settled, reply?, reason?, error?, context?, approval? }. settled=false: the result may
// still come (a poll keeps going until its deadline).
//
// Observed on Claude Code 2.1.296 through Paseo: a done /compact adds compaction items (loading, then
// completed with preTokens) and Paseo then repeats the previous local output as a reply, which is not
// this command's; a /compact that cannot run says why ("Not enough messages to compact.") and leaves
// the loading item open. Codex's /compact (outside any turn) adds the same items, or Paseo's
// "Failed to compact context: …".
export function commandResult(entry, { items, status, usageBefore = null, usageAfter = null, approval = null }) {
  if (entry.compaction) {
    const done = items.find((i) => i.type === "compaction" && i.status === "completed");
    if (done) return { outcome: "done", settled: true, context: contextAfterCompaction(done, usageBefore, usageAfter) };
  }
  if (!entry.compaction && approval) return { outcome: "waiting_for_approval", settled: true, approval };
  const said = textsOf(items).join("\n\n");
  const errors = errorsOf(items);
  if (status === "error" || errors.length) return { outcome: "error", settled: true, error: truncate(errors.join("; ") || said || "the chat stopped with an error", 300) };
  if (said && (entry.compaction || entry.outOfBand)) {
    if (FAILED.test(said)) return { outcome: "error", settled: true, error: truncate(said, 300) };
    // A compaction that did not happen says why; a command run outside a turn says what it did.
    return entry.compaction ? { outcome: "refused", settled: true, reason: truncate(said, 300) } : { outcome: "replied", settled: true, reply: said };
  }
  if (isBusy(status) || entry.outOfBand) return { outcome: "still_working", settled: false };
  if (entry.compaction) return { outcome: "error", settled: true, error: "it ended without saying whether the context was compacted (it may have been stopped)" };
  return { outcome: "replied", settled: true, reply: said };
}

function tokens(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${Number((n / 1_000_000).toFixed(1))}M`;
}

// "context 23k → 2k tokens (0% of 1M)", or what is known of it.
export function contextChange(context) {
  if (!context || (context.before_tokens === undefined && context.after_tokens === undefined)) return null;
  if (context.after_tokens !== undefined && context.before_tokens !== undefined) {
    const of = context.max_tokens ? ` (${context.percent_used}% of ${tokens(context.max_tokens)})` : "";
    return `context ${tokens(context.before_tokens)} → ${tokens(context.after_tokens)} tokens${of}`;
  }
  return context.before_tokens !== undefined ? `context was ${tokens(context.before_tokens)} tokens` : `context now ${tokens(context.after_tokens)} tokens`;
}

// read_chat: a done compaction as a line of the turn's text.
export function compactionNote(item) {
  const was = Number.isFinite(item.preTokens) ? ` from ${tokens(item.preTokens)} tokens` : "";
  return `[context compacted${was}${item.trigger === "auto" ? ", automatically" : ""}]`;
}

// A /compact turn ends with the compaction: the text Paseo shows after a done manual compaction
// repeats an earlier output and is not that turn's reply. An automatic compaction happens in the
// middle of a turn, and what the agent writes after it is its reply.
export function withoutRepeatAfterCompaction(items) {
  const at = items.findIndex((i) => i.type === "compaction" && i.status === "completed" && i.trigger === "manual");
  if (at < 0) return items;
  return [...items.slice(0, at + 1), ...items.slice(at + 1).filter((i) => i.type !== "assistant_message")];
}

// ---- What list_slash_commands says ------------------------------------------------------------

const namesOf = (entries) => entries.map((e) => e.name).join(", ");

// The list as text to read or speak: how many, what runs at once, what asks first, what cannot run;
// then where commands run. Each command's details are in the data; a query or a short list gets
// them in the text too.
export function listText({ chatLine, catalog, shown, total, query, mode }) {
  const head = `${chatLine}\n${catalog.label}: ${total} command(s)${query ? ` matching "${query}"` : ""}.`;
  if (!catalog.runs) return [head, catalog.reason, shown.length ? `Listed: ${namesOf(shown)}.` : null].filter(Boolean).join("\n");
  if (shown.length === 0) return `${head}\n${query ? "None matches; try other words, or no query." : "None."}`;
  const lines = [head];
  if (query || shown.length <= 8) {
    for (const e of shown) {
      const how = !e.available ? `Not from here: ${e.reason}` : e.asks_first ? `Asks first (${e.risk}).` : "Runs at once.";
      lines.push(`- ${e.usage}: ${truncate(e.effect, 200)} ${how}`);
    }
  } else {
    const runs = shown.filter((e) => e.available && !e.asks_first);
    const asks = shown.filter((e) => e.available && e.asks_first);
    const not = shown.filter((e) => !e.available);
    if (runs.length) lines.push(`Runs at once: ${namesOf(runs)}.`);
    if (asks.length) lines.push(`Runs after the user's yes: ${namesOf(asks)}.`);
    if (not.length) lines.push(`Not from here: ${namesOf(not)} (each one's reason is in the data).`);
  }
  const bypass = mode === "bypassPermissions" ? " Permissions are bypassed in this chat, so nothing asks before a command acts." : "";
  lines.push(`Commands run inside this chat: its folder, its conversation and its settings.${bypass} While the chat is working, a command waits for the user's word to interrupt.`);
  return lines.join("\n");
}
