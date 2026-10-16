// Run with: node --test core/
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activityData,
  activityText,
  chatData,
  chatLine,
  describePermission,
  describeRelease,
  describeStep,
  describeToolCall,
  duration,
  isStep,
  latestFirstWithin,
  pickActive,
  releaseData,
  resolve,
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
