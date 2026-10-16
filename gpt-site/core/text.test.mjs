// Run with: node --test core/
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chatData,
  chatLine,
  describePermission,
  describeRelease,
  describeToolCall,
  latestFirstWithin,
  releaseData,
  resolve,
  snippet,
  toIso,
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

test("a chat line carries short id, title, project and state", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  const line = chatLine(
    { id: "a22524f0-1", title: "Fleet map", project: "proxy", status: "running", attention: null, permissions: [], updatedAt: "2026-10-16T11:50:00Z" },
    now,
  );
  assert.equal(line, "#a22524f Fleet map - proxy - running, 10 min ago");
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
