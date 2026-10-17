// Run with: node --test core/
// show_images against a fake daemon client: the timeline calls read_chat uses, and readFile, the
// relay call Paseo's own client uses for the pictures in a chat. No network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readChatOn, showImagesOn } from "./paseo.mjs";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const at = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const TEMP = "/var/folders/f7/xtj/T/paseo-attachments-TI5aFz";
const HASH = "00067c18163b0105541019fff2ab8a039756c1cab995214b5fdbf4c0548cad76";
const shot = (name) => `![Image](file://${TEMP}/${name})`;
const png = (size) => Uint8Array.from({ length: size }, (_, i) => i % 251);

// A chat as fetchAgents returns it, with its turns as user and agent message texts, oldest first.
function chat(id, title, { project = "proxy", cwd = "/Users/r/proxy", minutes = 5, turns }) {
  return { id, title, project, cwd, minutes, turns };
}

// Answers the calls the operation makes. `files` maps "cwd|path" to bytes or an Error to throw.
function fakeClient(chats, files = {}) {
  const reads = [];
  const byId = Object.fromEntries(chats.map((c) => [c.id, c]));
  const entries = (c) => {
    let seq = 0;
    return c.turns.flatMap((t, i) => [
      { seqStart: ++seq, timestamp: at(c.minutes + (c.turns.length - i) * 10), item: { type: "user_message", text: t.user } },
      ...t.agent.map((text) => ({ seqStart: ++seq, timestamp: at(c.minutes), item: { type: "assistant_message", text } })),
    ]);
  };
  const agent = (c) => ({
    agent: { id: c.id, title: c.title, status: "idle", requiresAttention: false, pendingPermissions: [], updatedAt: at(c.minutes), createdAt: at(600), cwd: c.cwd },
    project: { projectName: c.project, workspaceName: null },
  });
  return {
    reads,
    async fetchAgents() {
      return { entries: [...chats].sort((a, b) => a.minutes - b.minutes).map(agent) };
    },
    async fetchAgent(id) {
      return byId[id] ? agent(byId[id]) : null;
    },
    async listAgentTimelinePrompts(id) {
      const prompts = entries(byId[id]).filter((e) => e.item.type === "user_message");
      return { epoch: "e1", prompts: prompts.map((e) => ({ seq: e.seqStart, preview: e.item.text, timestamp: e.timestamp })) };
    },
    async fetchAgentTimeline(id) {
      return { entries: entries(byId[id]) };
    },
    async readFile(cwd, path, requestId, maxBytes) {
      reads.push({ cwd, path, maxBytes });
      const file = files[`${cwd}|${path}`];
      if (file instanceof Error) throw file;
      if (!file) throw new Error(`ENOENT: no such file or directory, open '${cwd}/${path}'`);
      if (maxBytes && file.length > maxBytes) throw new Error("File is too large to display");
      return { bytes: file, mime: "image/png", size: file.length, path, kind: "image", modifiedAt: at(1) };
    },
  };
}

const FLEET = chat("a22524fe-055b-44b8-a9b6-82c9910d7e21", "Fleet map", {
  turns: [
    { user: "make the chart", agent: ["Chart ready: ![chart](out/chart.png)", "And the docs one: ![](https://example.com/docs.png)"] },
    { user: "screenshot the login page", agent: ["Taking it.", shot(`${HASH}.png`), "The login page renders without errors now."] },
  ],
});

test("the newest image of a chat comes back as bytes for the widget and as speech without a path", async () => {
  const bytes = png(2048);
  const client = fakeClient([FLEET], { [`${TEMP}|${HASH}.png`]: bytes });
  const result = await showImagesOn(client, { chat: "fleet" });
  assert.deepEqual(client.reads, [{ cwd: TEMP, path: `${HASH}.png`, maxBytes: 1_000_000 }], "the file is read from its own directory, capped");
  assert.equal(result.meta["god-mode/images"].images[0].data, Buffer.from(bytes).toString("base64"));
  assert.deepEqual(result.meta["god-mode/images"].chat, { title: "Fleet map", project: "proxy" });
  assert.deepEqual(result.data.images, [{ n: 1, turn: 1, name: "image 1", mime: "image/png", bytes: 2048 }]);
  assert.equal(result.data.total_images, 3, "the latest turns hold three");
  assert.match(result.text, /2 more image\(s\) in these turns/);
  assert.equal(result.data.chat.id, FLEET.id);
  assert.match(result.text, /^Showing 1 image\(s\) from Fleet map \(proxy\), turn 1: image 1\. They are on the user's screen now\./);
  for (const leak of [TEMP, HASH, FLEET.id, "file://"]) assert.ok(!result.text.includes(leak), leak);
  assert.ok(!JSON.stringify(result.data).includes(TEMP), "no path in what the model reads");
});

test("a turn shows all its images in order: a relative path from the agent's directory, a web link skipped", async () => {
  const client = fakeClient([FLEET], { "/Users/r/proxy|out/chart.png": png(100) });
  const result = await showImagesOn(client, { chat: FLEET.id, turn: 2 });
  assert.deepEqual(client.reads.map((r) => [r.cwd, r.path]), [["/Users/r/proxy", "out/chart.png"]], "the Site never fetches web links");
  assert.deepEqual(result.data.images.map((i) => [i.turn, i.n, i.name]), [[2, 1, "chart"]]);
  assert.deepEqual(result.data.skipped, [{ n: 2, turn: 2, name: "image 2", reason: "link" }]);
  assert.match(result.text, /Not shown: image 2, a web link/);
  const second = await showImagesOn(fakeClient([FLEET]), { chat: FLEET.id, turn: 2, image: 3 });
  assert.match(second.text, /has 2 image\(s\), so there is no image 3/);
  assert.equal(second.meta, undefined);
});

test("files that are gone, too big or too much at once are named, not shown", async () => {
  const many = chat("b7c1d2e3-4f50-4a61-8b72-93a4b5c6d7e8", "Screens", {
    turns: [{ user: "three screens", agent: [shot("a.png"), shot("b.png"), shot("c.png"), shot("d.png")] }],
  });
  const client = fakeClient([many], {
    [`${TEMP}|a.png`]: png(900_000),
    [`${TEMP}|b.png`]: png(900_000),
    [`${TEMP}|c.png`]: png(1_200_000),
  });
  const result = await showImagesOn(client, { chat: many.id, turn: 1 });
  assert.deepEqual(result.data.images.map((i) => i.n), [1]);
  assert.deepEqual(
    result.data.skipped.map((i) => [i.n, i.reason]),
    [
      [2, "too_much_at_once"],
      [3, "too_large"],
      [4, "missing"],
    ],
  );
  assert.match(result.text, /no longer on the Mac/);
  assert.deepEqual(result.meta["god-mode/images"].images.map((i) => i.n), [1]);
  const refused = await showImagesOn(fakeClient([many], { [`${TEMP}|a.png`]: new Error("Access outside of workspace is not allowed") }), { chat: many.id, turn: 1, image: 1 });
  assert.deepEqual(refused.data.skipped.map((i) => i.reason), ["refused"]);
});

test("without a chat, the newest image comes from the most recent chat that has one", async () => {
  const quiet = chat("c3d4e5f6-1a2b-4c3d-9e4f-5a6b7c8d9e0f", "Release notes", { minutes: 1, turns: [{ user: "draft", agent: ["Draft ready."] }] });
  const client = fakeClient([quiet, FLEET], { [`${TEMP}|${HASH}.png`]: png(10) });
  const result = await showImagesOn(client, {});
  assert.equal(result.data.chat.title, "Fleet map");
  assert.equal(result.data.images.length, 1);
  const none = await showImagesOn(fakeClient([quiet]), {});
  assert.equal(none.text, "No images in the latest turns of the 1 most recent chats.");
  assert.deepEqual(none.data, { total_images: 0, images: [], skipped: [] });
});

test("a chat looks further back when its latest turns have no image", async () => {
  const older = chat("d4e5f6a7-2b3c-4d5e-8f60-718293a4b5c6", "Old shot", {
    turns: [
      { user: "shoot", agent: [shot("old.png")] },
      ...Array.from({ length: 4 }, (_, i) => ({ user: `step ${i}`, agent: ["ok"] })),
    ],
  });
  const result = await showImagesOn(fakeClient([older], { [`${TEMP}|old.png`]: png(10) }), { chat: older.id });
  assert.deepEqual(result.data.images.map((i) => [i.turn, i.n]), [[5, 1]]);
  const empty = await showImagesOn(fakeClient([older]), { chat: older.id, turn: 1 });
  assert.equal(empty.text, "No images in turn 1 of Old shot (proxy).");
});

test("an unknown chat asks which one instead of guessing", async () => {
  const result = await showImagesOn(fakeClient([FLEET]), { chat: "weather" });
  assert.equal(result.data.needs_clarification.kind, "chat");
  assert.equal(result.meta, undefined);
});

test("read_chat says [image N] and points to show_images, never the file path", async () => {
  const client = fakeClient([FLEET]);
  const one = await readChatOn(client, { chat: "fleet" });
  assert.match(one.text, /Agent replied: Taking it\.\n\n\[image 1\]\n\nThe login page renders without errors now\./);
  assert.match(one.text, /1 image\(s\) in turn 1: show_images \(turn 1\) puts them on the user's screen\./);
  assert.deepEqual(one.data.turns[0].images, [{ n: 1, name: "image 1", viewable: true }]);
  assert.equal(one.data.turns[0].agent_text.includes("file://"), false);
  for (const leak of [TEMP, "file://", HASH]) assert.ok(!JSON.stringify(one).includes(leak), leak);
  assert.deepEqual(client.reads, [], "reading a chat reads no image");
  const both = await readChatOn(client, { chat: "fleet", turns: 2 });
  assert.match(both.text, /Agent: Chart ready: \[image 1\]\n\nAnd the docs one: \[image 2\]/);
  assert.match(both.text, / {2}2 image\(s\) in turn 2: show_images \(turn 2\)/);
  assert.deepEqual(both.data.turns[0].images, [
    { n: 1, name: "chart", viewable: true },
    { n: 2, name: "image 2", viewable: false },
  ]);
  const plain = await readChatOn(fakeClient([chat("c3d4e5f6-1a2b-4c3d-9e4f-5a6b7c8d9e0f", "Release notes", { turns: [{ user: "draft", agent: ["Draft ready."] }] })]), { chat: "release" });
  assert.equal(plain.data.turns[0].images, undefined, "no images, no field");
  assert.doesNotMatch(plain.text, /image/);
});
