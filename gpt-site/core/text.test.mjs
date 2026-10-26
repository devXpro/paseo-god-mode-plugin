// Run with: node --test core/
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activityData,
  activityText,
  chatData,
  chatLine,
  chatQuestion,
  choiceLine,
  contextLine,
  contextOf,
  describePermission,
  describeRelease,
  describeStep,
  describeToolCall,
  duration,
  imageName,
  imageRef,
  imagesText,
  imageTarget,
  isStep,
  latestFirstWithin,
  matchChat,
  matchPinned,
  pickActive,
  pinnedLine,
  pinnedResult,
  releaseData,
  repliedOutcome,
  resolve,
  settleChat,
  withImagePlaceholders,
  withoutImages,
  snippet,
  toIso,
  tokensOf,
  toolCallData,
  truncate,
} from "./text.mjs";

test("toIso gives one explicit UTC form or null", () => {
  assert.equal(toIso("2026-10-16T15:48:00.160Z"), "2026-10-16T15:48:00.160Z");
  assert.equal(toIso("2026-10-16T18:48:00+03:00"), "2026-10-16T15:48:00.000Z");
  assert.equal(toIso(null), null);
  assert.equal(toIso("not a date"), null);
});

test("snippet centres on the phrase, then on its longest word", () => {
  const text = `${"a ".repeat(100)}читаю скилл dataviz до кода графиков ${"b ".repeat(100)}`;
  const s = snippet(text, "dataviz", 20);
  assert.match(s, /^….*dataviz.*…$/);
  assert.ok(s.length < 70);
  assert.match(snippet("Rate = 0, солана не долбит", "выключена ли солана", 10), /солана/);
  assert.equal(snippet("short text", "absent"), "short text");
  assert.match(snippet("Ёлка и ЕЛКА", "елка"), /Ёлка/);
});

test("chatData carries ISO times next to the relative ones", () => {
  const data = chatData(
    { id: "a22524f0-1", title: "Fleet", project: "proxy", workspace: null, status: "idle", attention: "finished", permissions: [], updatedAt: "2026-10-16T11:50:00Z", createdAt: "2026-10-16T10:00:00Z", archived: true },
    Date.parse("2026-10-16T12:00:00Z"),
  );
  assert.deepEqual(data, {
    id: "a22524f0-1",
    short_id: "a22524f",
    title: "Fleet",
    project: "proxy",
    workspace: null,
    status: "idle",
    state: "new reply",
    pending_approvals: [],
    updated_at: "2026-10-16T11:50:00.000Z",
    updated_ago: "10 min ago",
    created_at: "2026-10-16T10:00:00.000Z",
    archived: true,
  });
});

test("the context window reads as Paseo's meter shows it, and is absent when unknown", () => {
  const usage = { inputTokens: 4, cachedInputTokens: 55401, outputTokens: 68, totalCostUsd: 2.2, contextWindowMaxTokens: 1000000, contextWindowUsedTokens: 59606 };
  const context = contextOf(usage);
  assert.deepEqual(context, { used_tokens: 59606, max_tokens: 1000000, percent_used: 6, remaining_tokens: 940394 });
  assert.equal(contextLine(context), "Context window: 6% used (60k of 1M tokens).");
  assert.equal(contextLine(contextOf({ contextWindowMaxTokens: 200000, contextWindowUsedTokens: 187500 })), "Context window: 94% used (188k of 200k tokens).");
  assert.equal(contextOf({ contextWindowMaxTokens: 200000, contextWindowUsedTokens: 210000 }).remaining_tokens, 0);
  for (const unknown of [null, undefined, {}, { contextWindowUsedTokens: 10 }, { contextWindowMaxTokens: 0, contextWindowUsedTokens: 0 }]) {
    assert.equal(contextOf(unknown), null);
  }
  assert.equal(contextLine(null), null);
  const chat = { id: "a22524f0-1", title: "Fleet", project: "proxy", status: "idle", permissions: [], updatedAt: "2026-10-16T11:50:00Z" };
  assert.deepEqual(chatData({ ...chat, usage }).context, context);
  assert.equal("context" in chatData({ ...chat, usage: null }), false, "no context field when Paseo does not know it");
});

test("toolCallData keeps kind, name, status and the readable line", () => {
  const call = { type: "tool_call", name: "Bash", status: "completed", detail: { type: "shell", command: "ls", output: "a" } };
  assert.deepEqual(toolCallData(call, 100), { kind: "shell", name: "Bash", status: "completed", text: "$ ls\na" });
});

const chats = [
  { id: "a22524f0-0000", name: "Карта флота (SRV-274), этап D — фронт карты" },
  { id: "f0d91250-0000", name: "Карта флота (SRV-274), этап C — бэк дашборда" },
  { id: "3a716313-0000", name: "Продолжаем карту флота, этап B" },
  { id: "054f3945-0000", name: "Ответь одним словом: pong" },
];

test("an id prefix of six or more characters wins outright", () => {
  assert.equal(resolve(chats, "#a22524").match, chats[0]);
  assert.equal(resolve(chats, "a22524f").match, chats[0]);
  assert.equal(resolve(chats, "a225").match, undefined);
});

test("a single distinguishing letter settles near-identical titles", () => {
  assert.equal(resolve(chats, "карта флота этап D").match, chats[0]);
  assert.equal(resolve(chats, "этап c").match, chats[1]);
});

test("inflected Russian words match their stems", () => {
  assert.equal(resolve(chats, "продолжаем карты флоту").match, chats[2]);
});

test("ambiguous queries return up to three candidates, no match", () => {
  const found = resolve(chats, "карта флота");
  assert.equal(found.match, undefined);
  assert.equal(found.candidates.length, 3);
});

test("nothing in common returns no candidates", () => {
  assert.deepEqual(resolve(chats, "погода в Варшаве"), { candidates: [] });
  assert.deepEqual(resolve(chats, "  "), { candidates: [] });
});

test("truncate prefers a sentence end, then a word boundary", () => {
  assert.equal(truncate("short", 10), "short");
  assert.equal(truncate("One. Two three four five six seven", 30), "One. Two three four five six …");
  assert.equal(truncate("A first sentence here. Then more words follow", 30), "A first sentence here. …");
  assert.equal(truncate("abcdefghijklmnopqrstuvwxyz", 10), "abcdefghij …");
});

test("latestFirstWithin keeps the final message and marks the cut", () => {
  assert.equal(latestFirstWithin(["early", "middle", "final"], 100), "early\n\nmiddle\n\nfinal");
  assert.equal(latestFirstWithin(["x".repeat(80), "final"], 50), "(1 earlier message(s) omitted)\n\nfinal");
  assert.equal(latestFirstWithin(["long ".repeat(40), "  "], 60).startsWith("long long"), true);
  assert.equal(latestFirstWithin([], 100), "");
});

test("permissions read as what will happen", () => {
  assert.equal(
    describePermission({ kind: "plan", name: "ExitPlanMode", input: { plan: "# Plan: create hello.txt\n\nSteps" } }),
    "plan: create hello.txt",
  );
  assert.equal(describePermission({ kind: "tool", name: "Bash", detail: { type: "shell", command: "npm test" } }), "run: npm test");
  assert.equal(describePermission({ kind: "tool", name: "Edit", detail: { type: "edit", filePath: "a.ts" } }), "edit a.ts");
  assert.equal(describePermission({ kind: "tool", name: "Mystery" }), "Mystery");
});

test("tool calls show the command and a cut of its output", () => {
  const call = { type: "tool_call", name: "Bash", status: "completed", detail: { type: "shell", command: "ls", output: "a\nb\nc" } };
  assert.equal(describeToolCall(call, 100), "$ ls\na\nb\nc");
  assert.equal(describeToolCall({ ...call, status: "failed", detail: { type: "edit", filePath: "x.js" } }, 100), "edit x.js (failed)");
});

test("a chat line is spoken words: title, project, state and age, no id", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  const chat = { id: "a22524f0-1", title: "Fleet map", project: "proxy", status: "running", attention: null, permissions: [], updatedAt: "2026-10-16T11:50:00Z" };
  assert.equal(chatLine(chat, now), "Fleet map (proxy): running, 10 min ago");
  assert.equal(chatLine({ ...chat, subagentsRunning: 2 }, now), "Fleet map (proxy): running, 2 subagent(s) working, 10 min ago");
  assert.equal(chatLine({ ...chat, status: "idle", attention: "finished", subagentsRunning: 1 }, now), "Fleet map (proxy): 1 subagent(s) working, 10 min ago");
});

test("the release status reads as one or two sentences", () => {
  const now = Date.parse("2026-10-16T19:05:00Z");
  const status = (job, installed = "0.1.0") => ({ installed, live: { versionNumber: 7 }, job });
  assert.equal(describeRelease(releaseData(null, "0.1.0"), now), "God Mode 0.1.0 is live. The Mac is offline, so updates cannot be checked or started right now.");
  assert.equal(describeRelease(releaseData(status(null, "0.1.1"), "0.1.0"), now), "God Mode 0.1.0 is live; the Mac has 0.1.1, so an update is available.");
  const running = { action: "update", state: "running", step: "Building and testing", startedAt: "2026-10-16T19:01:00Z", finishedAt: null, result: null, error: null };
  assert.equal(describeRelease(releaseData(status(running), "0.1.0"), now), "The update is running: Building and testing, started 4 min ago.");
  const failed = { ...running, state: "failed", error: "The live plugin failed its check:\n- overview: broken\nRolled back to version 6." };
  assert.equal(describeRelease(releaseData(status(failed), "0.1.0"), now), "God Mode 0.1.0 is live and up to date with the Mac. The last update failed: The live plugin failed its check:");
  const done = { ...running, action: "rollback", state: "succeeded", result: { message: "Version 6 is live again." } };
  assert.match(describeRelease(releaseData(status(done), "0.1.0"), now), /The last rollback succeeded: Version 6 is live again\./);
});

test("a newer release on GitHub is mentioned, and the build travels in the data", () => {
  const data = releaseData({ installed: "0.5.0", live: { versionNumber: 9 }, latest: { version: "0.6.0", newer: true }, job: null }, "0.5.0", "v0.5.0");
  assert.equal(data.build, "v0.5.0");
  assert.equal(describeRelease(data), "God Mode 0.5.0 is live and up to date with the Mac. Version 0.6.0 is out on GitHub; update the God Mode plugin in Paseo to get it.");
  const same = releaseData({ installed: "0.5.0", latest: { version: "0.5.0", newer: false }, job: null }, "0.5.0");
  assert.doesNotMatch(describeRelease(same), /GitHub/);
});

test("a project name picks the one active chat for reads, never between two", () => {
  const chat = (id, title, status, extra = {}) => ({ id, title, project: "jobby-jobs", status, attention: null, permissions: [], ...extra });
  const items = [chat("a1b2c3d4-1", "Auth refactor", "running"), chat("b1b2c3d4-2", "README", "idle"), chat("c1b2c3d4-3", "Docs", "idle"), chat("d1b2c3d4-4", "Lint", "idle")];
  const found = resolve(items, "jobby", { text: (c) => `${c.title} ${c.project}` });
  assert.equal(found.match, undefined);
  assert.equal(found.candidates.length, 3, "three are offered to the user");
  assert.equal(found.top.length, 4, "every best match is kept for picking");
  assert.equal(pickActive(found.top), items[0]);
  assert.equal(pickActive([...items, chat("e1b2c3d4-5", "Tests", "running")]), null, "two active chats still need the user");
  assert.equal(pickActive([items[1], chat("f1", "Waiting", "idle", { permissions: [{ kind: "tool", name: "Bash" }] })]).id, "f1");
  assert.equal(pickActive([items[1], { ...items[2], subagentsRunning: 1 }]).id, "c1b2c3d4-3");
});

// Chats as paseo.mjs maps them. The lab ones have the shape of a real case (2026-10-23): Paseo
// titled two active chats with the same first line cut at 60 characters, mid-word.
const NOW_R = Date.parse("2026-10-23T09:30:00Z");
const ch = (id, title, extra = {}) => ({
  id,
  title,
  project: "proxy",
  workspace: null,
  status: "idle",
  attention: null,
  permissions: [],
  updatedAt: "2026-10-23T09:00:00Z",
  archived: false,
  ...extra,
});
const CUT = "Продолжаем учебный кластер demo-dev на миникубе в тестовом а";
const STEP5 = ch("5e7a0c11-0000", CUT, { project: "lab", workspace: "Продолжить demo-dev minikube: шаг 5 in-cluster", updatedAt: "2026-10-23T06:27:00Z" });
const PLAN4 = ch("6b2f9d40-0000", CUT, { project: "lab", workspace: "Plan demo-dev minikube monitoring questions §4", updatedAt: "2026-10-22T06:39:00Z" });
const STAGE = ch("7c1d2e3f-0000", "Обкатка demo-dev на стенде + дока для прода", { project: "lab", workspace: "lab" });

test("a title Paseo cut at 60 characters is named by its whole first line, and chats sharing it stay equal", () => {
  assert.equal(CUT.length, 60);
  const said = "Продолжаем учебный кластер demo-dev на миникубе в тестовом аккаунте";
  const found = matchChat([STEP5, PLAN4, STAGE], said);
  assert.equal(found.tier, "exact");
  assert.deepEqual(found.best, [STEP5, PLAN4], "only the two that carry the name, not a third lookalike");
  assert.deepEqual(settleChat([STEP5, PLAN4, STAGE], said), { ask: "same_name", chats: [STEP5, PLAN4] });
  assert.deepEqual(settleChat([STEP5, PLAN4, STAGE], said, { read: true }), { ask: "same_name", chats: [STEP5, PLAN4] }, "both idle: a read does not guess either");
  assert.deepEqual(settleChat([STEP5, PLAN4, STAGE], CUT), { ask: "same_name", chats: [STEP5, PLAN4] });
  assert.equal(matchChat([ch("x", "Fleet map")], "Fleet map D").tier, "partial", "a short title is no cut: a longer name is not exactly it");
});

test("a workspace title tells chats with one title apart", () => {
  const chats = [STEP5, PLAN4, STAGE];
  assert.deepEqual(settleChat(chats, "Продолжить demo-dev minikube: шаг 5 in-cluster"), { chat: STEP5 });
  assert.deepEqual(settleChat(chats, "шаг 5 in-cluster"), { chat: STEP5 });
  assert.deepEqual(settleChat(chats, "monitoring questions"), { chat: PLAN4 });
  assert.equal(matchChat([STAGE], "lab").tier, "words", "a workspace named like its project is no name of its own");
});

test("an exact title wins over titles that contain it, which the project in the text once hid", () => {
  const fleet = ch("a1", "Fleet map");
  const fleetD = ch("a2", "Fleet map D", { updatedAt: "2026-10-23T09:20:00Z" });
  assert.deepEqual(settleChat([fleetD, fleet], "fleet map"), { chat: fleet });
  assert.deepEqual(settleChat([fleetD, fleet], "Fleet map D"), { chat: fleetD });
  assert.equal(resolve([fleetD, fleet], "fleet map", { text: (c) => `${c.title} ${c.project}` }).match, undefined, "the old matching asked here");
});

test("a project named with the title narrows it", () => {
  const proxy = ch("b1", "Auth refactor");
  const jobby = ch("b2", "Auth refactor", { project: "jobby-jobs" });
  assert.deepEqual(settleChat([proxy, jobby], "Auth refactor"), { ask: "same_name", chats: [proxy, jobby] });
  assert.deepEqual(settleChat([proxy, jobby], "Auth refactor (jobby-jobs)"), { chat: jobby });
  assert.deepEqual(settleChat([proxy, jobby], "auth refactor proxy"), { chat: proxy });
});

test("a write takes no partial match, a read takes the closest", () => {
  const fleet = ch("c1", "Fleet map D");
  const deploy = ch("c2", "Deploy fixes", { project: "jobby-jobs" });
  const found = matchChat([fleet, deploy], "fleet map deploy");
  assert.equal(found.tier, "partial");
  assert.deepEqual(settleChat([fleet, deploy], "fleet map deploy"), { ask: "partial", chats: [fleet, deploy] });
  assert.deepEqual(settleChat([fleet, deploy], "fleet map deploy", { read: true }), { chat: fleet });
  assert.deepEqual(settleChat([fleet, deploy], "fleet"), { chat: fleet }, "one word that only one chat has is a whole match");
});

test("between equals a write never picks by recency or state; a read takes the only one at work", () => {
  const idle = ch("e1", "Release notes", { updatedAt: "2026-10-23T09:29:00Z" });
  const busy = ch("e2", "Release notes", { status: "running", updatedAt: "2026-10-22T09:00:00Z" });
  const waiting = ch("e3", "Release notes", { permissions: [{ kind: "tool", name: "Bash" }] });
  assert.deepEqual(settleChat([idle, busy], "release notes"), { ask: "same_name", chats: [idle, busy] });
  assert.deepEqual(settleChat([idle, waiting], "release notes"), { ask: "same_name", chats: [idle, waiting] }, "an approval waiting in one is no reason");
  const read = settleChat([idle, busy], "release notes", { read: true });
  assert.equal(read.chat, busy);
  assert.equal(read.note, '"release notes" matches 2 chats; this is the only active one.');
  assert.deepEqual(settleChat([idle, busy, waiting], "release notes", { read: true }).ask, "same_name", "two at work: a read asks too");
});

test("nothing in common, or under half, matches nothing and offers the closest", () => {
  assert.deepEqual(settleChat([STEP5, STAGE], "погода Варшава"), { ask: "no_match", chats: [] });
  const weak = settleChat([STEP5, STAGE], "lab grafana alerts loki");
  assert.equal(weak.ask, "no_match");
  assert.ok(weak.chats.length > 0);
  assert.deepEqual(matchChat([STEP5], "  "), { tier: null, best: [], near: [] });
});

test("a choice line names the workspace only where it tells chats apart", () => {
  assert.equal(
    choiceLine(STEP5, NOW_R),
    'Продолжаем учебный кластер demo-dev на миникубе в тестовом а (lab, workspace "Продолжить demo-dev minikube: шаг 5 in-cluster"): idle, 3 h ago',
  );
  assert.equal(choiceLine(STAGE, NOW_R), "Обкатка demo-dev на стенде + дока для прода (lab): idle, 30 min ago");
  assert.equal(choiceLine({ ...STAGE, archived: true }, NOW_R), "Обкатка demo-dev на стенде + дока для прода (lab): idle, archived, 30 min ago");
});

test("a chat question says nothing was done, tells the chats apart without ids, and carries the ids", () => {
  const write = chatQuestion("Продолжаем учебный кластер", "same_name", [STEP5, PLAN4], { now: NOW_R });
  assert.match(write.text, /^2 chats are named "Продолжаем учебный кластер", so nothing was done\.\n/);
  assert.match(write.text, /\nAsk the user which one, naming what tells them apart\./);
  assert.match(write.text, /"the latest" is the one updated most recently; "the one about X" is the one whose title or workspace says X/, "the user's own words may pick one");
  assert.match(write.text, /Words they all share, or coming first, are no reason to pick:\n- /, "never the first one by default");
  assert.match(write.text, /workspace "Plan demo-dev minikube monitoring questions §4"/);
  assert.doesNotMatch(write.text, /5e7a0c11|6b2f9d40/, "no ids to read aloud");
  assert.deepEqual(write.data.needs_clarification.candidates.map((c) => c.id), [STEP5.id, PLAN4.id]);
  assert.equal(write.data.needs_clarification.reason, "same_name");
  assert.equal(write.data.needs_clarification.kind, "chat");
  const read = chatQuestion("release", "similar", [STEP5, PLAN4], { read: true, now: NOW_R });
  assert.match(read.text, /^"release" fits 2 chats equally\.\n/);
  const many = chatQuestion("lab", "similar", Array.from({ length: 7 }, (_, i) => ch(`f${i}`, `Chat ${i}`)), { now: NOW_R });
  assert.equal(many.data.needs_clarification.candidates.length, 5);
  assert.match(many.text, /… and 2 more; a fuller name narrows it down\.$/);
  assert.equal(
    chatQuestion("weather", "no_match", [], { now: NOW_R }).text,
    'No active chat matches "weather", so nothing was done.\nArchived chats were not searched: look there (list_chats with include_archived) only if the user asks. Otherwise ask the user for another name.',
  );
  const closest = chatQuestion("lab grafana", "no_match", [STAGE], { read: true, now: NOW_R }).text;
  assert.match(closest, /^No active chat matches "lab grafana"\.\nArchived chats were not searched: look there \(list_chats with include_archived\) only if the user asks\. The closest active ones:\n/);
  assert.match(chatQuestion("0f0f0f0f-1111-4222-8333-444444444444", "unknown_id", []).text, /It was deleted, or the id is wrong/);
});

test("steps read as speech: a command, a file name, a host, a first sentence", () => {
  const call = (detail, name = "Tool") => ({ type: "tool_call", name, status: "running", detail });
  assert.equal(describeStep(call({ type: "shell", command: "npm test -- auth" })), "running npm test -- auth");
  assert.equal(describeStep(call({ type: "read", filePath: "/Users/r/p/src/auth/session.ts" })), "reading session.ts");
  assert.equal(describeStep(call({ type: "edit", filePath: "src/a.ts" })), "editing a.ts");
  assert.equal(describeStep(call({ type: "fetch", url: "https://developers.openai.com/plugins/x.md" })), "opening developers.openai.com");
  assert.equal(describeStep(call({ type: "sub_agent", description: "Map routes" })), "waiting for a subagent: Map routes");
  assert.equal(describeStep(call({ type: "unknown" }, "WebSearch")), "using WebSearch");
  assert.equal(describeStep({ type: "reasoning", text: "I should check the docs. Then more." }), "thinking: I should check the docs.");
  assert.equal(describeStep(null), null);
  assert.equal(isStep(call({ type: "plain_text", label: "Background task completed" }, "task_notification")), false);
  assert.equal(isStep(call({ type: "shell", command: "ls" }, "Bash")), true);
  assert.equal(isStep({ type: "user_message", text: "go" }), false);
  assert.equal(duration(42_000), "42 s");
  assert.equal(duration(4 * 60_000), "4 min");
  assert.equal(duration(65 * 60_000), "1 h 5 min");
  assert.equal(tokensOf("general-purpose · Opus 5.5 · Max · 45.1k tokens"), "45.1k");
  assert.equal(tokensOf(null), null);
});

test("activity shows running subagents first, then those finished this turn, with steps and results", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
  const chat = { id: "b7c1d2e3-4f50", title: "Auth refactor", project: "jobby-jobs", status: "running", attention: null, permissions: [], updatedAt: at(1), createdAt: at(40) };
  const sub = (id, status, created, updated, extra = {}) => ({ id, title: "Explore", description: `task ${id}`, status, createdAt: at(created), updatedAt: at(updated), subtitle: "Explore · Opus · 38.2k tokens", ...extra });
  const subagents = [
    sub("old", "completed", 120, 110, { result: "from an earlier turn" }),
    sub("done", "completed", 33, 30, { result: "14 routes" }),
    sub("run", "running", 29, 0, { step: "reading session.ts" }),
  ];
  const a = activityData({ chat, subagents, turnStartedAt: at(35), parentStep: "waiting for a subagent: task run", now });
  assert.equal(a.working, true);
  assert.equal(a.turn_elapsed, "35 min");
  assert.equal(a.current_step, "waiting for 1 subagent(s)");
  assert.deepEqual(a.subagents.map((s) => s.id), ["run", "done"], "the earlier turn's subagent only counts");
  assert.equal(a.subagents_running, 1);
  assert.equal(a.subagents_done, 2);
  assert.equal(a.subagents[0].elapsed, "29 min");
  assert.equal(a.subagents[0].current_step, "reading session.ts");
  assert.equal(a.subagents[1].result, "14 routes");
  assert.equal(a.subagents[1].elapsed, "3 min");
  assert.equal(a.subagents[1].tokens, "38.2k");
  assert.equal(a.chat.subagents_running, 1);
  assert.equal(
    activityText(a),
    [
      "Auth refactor (jobby-jobs) is working, 35 min into the turn: waiting for 1 subagent(s).",
      '- Explore "task run": running for 29 min, now reading session.ts.',
      '- Explore "task done": completed after 3 min. Result: 14 routes',
    ].join("\n"),
  );
  const idle = activityData({ chat: { ...chat, status: "idle", attention: "finished" }, subagents: [sub("bg", "running", 14, 2)], turnStartedAt: at(20), parentStep: null, now });
  assert.equal(idle.working, true, "a backgrounded subagent keeps an idle chat working");
  assert.equal(idle.current_step, null);
  assert.match(activityText(idle), /^Auth refactor \(jobby-jobs\) is working\./);
});

// ---- Images ----------------------------------------------------------------------------------

const SHOT = "file:///var/folders/f7/xtj/T/paseo-attachments-TI5aFz/00067c18163b0105541019fff2ab8a039756c1cab995214b5fdbf4c0548cad76.png";

test("images in agent text become numbered placeholders, with their sources", () => {
  const glued = `Done, see:![Image](${SHOT})![Login page](<docs/shots/login page.png> "after the fix")`;
  const { text, images } = withImagePlaceholders(glued);
  assert.equal(text, "Done, see:[image 1][image 2]");
  assert.deepEqual(images, [
    { n: 1, alt: "Image", source: SHOT },
    { n: 2, alt: "Login page", source: "docs/shots/login page.png" },
  ]);
  assert.equal(withImagePlaceholders(`![x](${SHOT})`, 3).text, "[image 3]", "numbering continues through a turn");
  assert.deepEqual(withImagePlaceholders("plain [link](https://example.com) and no image").images, []);
  assert.equal(withoutImages(`Shot: ![Image](${SHOT}).`), "Shot: [image].");
});

test("image syntax inside code is text about images, not an image", () => {
  const writing = "The daemon records `![Image](file:///var/folders/…)` like this:\n```\n![Image](file:///tmp/a.png)\n```\nand here is one: ![Image](file:///tmp/b.png)";
  const { text, images } = withImagePlaceholders(writing);
  assert.deepEqual(images.map((i) => i.source), ["file:///tmp/b.png"]);
  assert.equal(text, "The daemon records `![Image](file:///var/folders/…)` like this:\n```\n![Image](file:///tmp/a.png)\n```\nand here is one: [image 1]");
  assert.equal(withoutImages("`![x](/tmp/a.png)` ![x](/tmp/b.png)"), "`![x](/tmp/a.png)` [image]");
});

test("an image source becomes a file read, a link or nothing", () => {
  assert.deepEqual(imageTarget(SHOT), { file: { cwd: "/var/folders/f7/xtj/T/paseo-attachments-TI5aFz", path: SHOT.split("/").at(-1) } });
  assert.deepEqual(imageTarget("file:///Users/r/My%20Shots/a.PNG"), { file: { cwd: "/Users/r/My Shots", path: "a.PNG" } });
  assert.deepEqual(imageTarget("/tmp/b.jpeg"), { file: { cwd: "/tmp", path: "b.jpeg" } });
  assert.deepEqual(imageTarget("~/Desktop/c.webp"), { file: { cwd: "~/Desktop", path: "c.webp" } });
  assert.deepEqual(imageTarget("./out/chart.png", "/Users/r/proj"), { file: { cwd: "/Users/r/proj", path: "out/chart.png" } });
  assert.deepEqual(imageTarget("out/chart.png"), { unsupported: true }, "relative without a working directory");
  assert.deepEqual(imageTarget("https://example.com/x.png"), { link: "https://example.com/x.png" });
  assert.deepEqual(imageTarget("data:image/png;base64,iVBORw0KGgo="), { inline: { mime: "image/png", data: "iVBORw0KGgo=" } });
  for (const source of ["/tmp/logo.svg", "/tmp/scan.bmp", "/tmp/photo.heic", "data:image/svg+xml;base64,PHN2Zz4=", "/tmp/notes.txt"]) {
    assert.deepEqual(imageTarget(source), { unsupported: true }, source);
  }
});

test("images are named by their alt text, else by number, and marked viewable", () => {
  assert.equal(imageName({ n: 2, alt: "Image" }), "image 2");
  assert.equal(imageName({ n: 1, alt: "" }), "image 1");
  assert.equal(imageName({ n: 1, alt: "Login page after the fix" }), "Login page after the fix");
  assert.deepEqual(imageRef({ n: 1, alt: "Image", source: SHOT }), { n: 1, name: "image 1", viewable: true });
  assert.deepEqual(imageRef({ n: 2, alt: "", source: "https://example.com/x.png" }), { n: 2, name: "image 2", viewable: false });
});

test("show_images reads as speech: the chat, the turn, what is on screen, what was not, never a path", () => {
  const chat = { title: "Fleet map", project: "proxy" };
  assert.equal(imagesText({ chat, turn: null, found: 0, shown: [], skipped: [] }), "No images in the latest turns of Fleet map (proxy).");
  assert.equal(imagesText({ chat, turn: 2, found: 0, shown: [], skipped: [] }), "No images in turn 2 of Fleet map (proxy).");
  const text = imagesText({
    chat,
    turn: null,
    found: 3,
    shown: [{ n: 1, turn: 1, name: "Login page" }],
    skipped: [{ n: 2, turn: 1, name: "image 2", reason: "missing" }],
  });
  assert.match(text, /^Showing 1 image\(s\) from Fleet map \(proxy\), turn 1: Login page\. They are on the user's screen now\./);
  assert.match(text, /do not guess what they show/);
  assert.match(text, /Not shown: image 2, no longer on the Mac/);
  assert.match(text, /1 more image\(s\) in these turns/);
  assert.doesNotMatch(text, /\/|paseo-attachments/);
});

test("a step that is an image reads as one, not as a path", () => {
  assert.equal(describeStep({ type: "assistant_message", text: `![Image](${SHOT})` }), "writing: [image]");
});

test("a write's reply counts its images instead of reading their paths", () => {
  assert.deepEqual(repliedOutcome("pong"), { text: "Agent replied: pong", data: { outcome: "replied", delivered: true, reply: "pong" } });
  const shot = repliedOutcome(`Done: ![Image](${SHOT})`);
  assert.equal(shot.text, "Agent replied: Done: [image 1]\nThe reply has 1 image(s); show_images puts them on the user's screen.");
  assert.deepEqual(shot.data, { outcome: "replied", delivered: true, reply: "Done: [image 1]", images: 1 });
});

// ---- Pinned chats ----------------------------------------------------------------------------------

const PIN_NOW = Date.parse("2026-10-26T18:00:00Z");
const pinChat = (id, title, fields = {}) => ({
  id,
  title,
  project: "lab",
  workspace: null,
  status: "idle",
  attention: null,
  permissions: [],
  updatedAt: "2026-10-26T17:50:00Z",
  createdAt: "2026-10-26T10:00:00Z",
  archived: false,
  ...fields,
});
// A pinned row as list_pinned_chats builds it from Paseo's workspace: latest pin first in ROWS.
const pinRow = (id, name, chats, fields = {}) => ({ id, name, project: "lab", branch: null, pinnedAt: "2026-10-26T15:00:00Z", status: "done", chats, ...fields });
const FLEET_PIN = pinRow("wks_fleet", "Fleet map", [pinChat("a2252400-0000-4000-8000-000000000001", "Fleet map, stage D", { project: "proxy", status: "running", updatedAt: "2026-10-26T17:58:00Z" })], {
  project: "proxy",
  pinnedAt: "2026-10-26T17:00:00Z",
  status: "running",
});
const DEPLOY_PIN = pinRow("wks_deploy", "Deploy scripts", [], { branch: "ci-hooks", pinnedAt: "2026-10-26T12:00:00Z" });
const CLUSTER_PIN = pinRow("wks_cluster", "Local cluster, step 6 (helm)", [pinChat("739a96bc-0000-4000-8000-000000000002", "Продолжаем учебный кластер на миникубе в тестовом а")], {
  pinnedAt: "2026-10-26T09:00:00Z",
});
const NOTES_PIN = pinRow(
  "wks_notes",
  "Release notes",
  [
    pinChat("c3d4e5f6-0000-4000-8000-000000000003", "Release notes 0.6", { attention: "finished", updatedAt: "2026-10-26T17:55:00Z" }),
    pinChat("c3d4e5f6-0000-4000-8000-000000000004", "Release notes 0.5", { updatedAt: "2026-10-26T17:00:00Z" }),
  ],
  { pinnedAt: "2026-10-26T08:00:00Z", status: "attention" },
);
const ROWS = [FLEET_PIN, DEPLOY_PIN, CLUSTER_PIN, NOTES_PIN];

test("a pinned row reads as the sidebar shows it: its name, project and what its chats do", () => {
  assert.equal(pinnedLine(FLEET_PIN, PIN_NOW), "Fleet map (proxy): running, 2 min ago");
  assert.equal(pinnedLine(DEPLOY_PIN, PIN_NOW), "Deploy scripts (lab): no active chat");
  assert.equal(pinnedLine(NOTES_PIN, PIN_NOW), "Release notes (lab): 2 chats: Release notes 0.6, new reply, 5 min ago; Release notes 0.5, idle, 1 h ago");
});

test("a query picks pinned rows by every word, else by half of them, else gives every row back", () => {
  assert.deepEqual(matchPinned(ROWS, undefined), { match: null, rows: ROWS });
  assert.deepEqual(matchPinned(ROWS, "  "), { match: null, rows: ROWS });
  // An inflected word of a chat's title: the row's own name is in English.
  assert.deepEqual(matchPinned(ROWS, "миникуб"), { match: "all_words", rows: [CLUSTER_PIN] });
  assert.deepEqual(matchPinned(ROWS, "fleet proxy"), { match: "all_words", rows: [FLEET_PIN] }, "the name and the project");
  assert.deepEqual(matchPinned(ROWS, "deploy scripts"), { match: "all_words", rows: [DEPLOY_PIN] });
  assert.deepEqual(matchPinned(ROWS, "hooks"), { match: "all_words", rows: [DEPLOY_PIN] }, "a word of the branch alone");
  assert.deepEqual(matchPinned(ROWS, "release"), { match: "all_words", rows: [NOTES_PIN] }, "one row, however many chats match");
  assert.deepEqual(matchPinned(ROWS, "fleet zebra"), { match: "some_words", rows: [FLEET_PIN] });
  // Another script: nothing matches, so every row comes back for the model to match itself.
  assert.deepEqual(matchPinned(ROWS, "хелм"), { match: "none", rows: ROWS });
});

test("list_pinned_chats answers with the rows, the way the query matched, and the ids in the data", () => {
  const all = pinnedResult(ROWS, { scope: "all projects", query: undefined, now: PIN_NOW });
  assert.equal(
    all.text,
    [
      "4 pinned, latest pin first:",
      "Fleet map (proxy): running, 2 min ago",
      "Deploy scripts (lab): no active chat",
      "Local cluster, step 6 (helm) (lab): idle, 10 min ago",
      "Release notes (lab): 2 chats: Release notes 0.6, new reply, 5 min ago; Release notes 0.5, idle, 1 h ago",
      "The data carries each chat's id: pass it to the next tool. If the user meant one and several fit, ask which.",
    ].join("\n"),
  );
  assert.deepEqual(Object.keys(all.data), ["scope", "query", "total", "pinned"], "no query_match without a query");
  assert.equal(all.data.total, 4);
  assert.deepEqual(all.data.pinned[0], {
    workspace_id: "wks_fleet",
    name: "Fleet map",
    project: "proxy",
    branch: null,
    pinned_at: "2026-10-26T17:00:00.000Z",
    pinned_ago: "1 h ago",
    status: "running",
    chats: [chatData(FLEET_PIN.chats[0], PIN_NOW)],
  });
  assert.equal(all.data.pinned[1].branch, "ci-hooks");
  assert.deepEqual(all.data.pinned[1].chats, []);
  assert.deepEqual(all.data.pinned[3].chats.map((c) => c.state), ["new reply", "idle"]);

  const one = pinnedResult(ROWS, { scope: "all projects", query: "миникуб", now: PIN_NOW });
  assert.match(one.text, /^1 pinned match "миникуб":\nLocal cluster, step 6/);
  assert.equal(one.data.query_match, "all_words");
  assert.deepEqual(one.data.pinned.map((r) => r.workspace_id), ["wks_cluster"]);

  const closest = pinnedResult(ROWS, { scope: "all projects", query: "fleet zebra", now: PIN_NOW });
  assert.match(closest.text, /^No pinned chat has every word of "fleet zebra"; the closest 1:\nFleet map/);
  assert.equal(closest.data.query_match, "some_words");

  const none = pinnedResult([FLEET_PIN], { scope: "proxy", query: "хелм", now: PIN_NOW });
  assert.match(none.text, /^No pinned chat in proxy has the words of "хелм"\. All 1 pinned in proxy, latest pin first; the user may have said a name in another language or spelling:\nFleet map/);
  assert.equal(none.data.query_match, "none");
  assert.equal(none.data.total, 1, "every row comes back");

  assert.deepEqual(pinnedResult([], { scope: "all projects", now: PIN_NOW }), { text: "Nothing is pinned.", data: { scope: "all projects", query: null, total: 0, pinned: [] } });
  assert.equal(pinnedResult([], { scope: "proxy", query: "fleet", now: PIN_NOW }).text, "Nothing is pinned in proxy.");
});
