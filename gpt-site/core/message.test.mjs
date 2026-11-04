// Run with: node --test core/
// read_message against a fake daemon client that pages its timeline the way Paseo does (tail, before
// and after a cursor, a limit, hasOlder), and read_chat's marks for what it cut. No network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readActivityOn, readApprovalOn, readChatOn, readMessageOn, searchMessagesOn } from "./paseo.mjs";
import { callText, charCount, joined, MESSAGE_PAGE, messageRef, messageWindow, parseMessageRef } from "./text.mjs";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const at = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const ID = "b3f0d3fa-5082-43b1-998d-68986fae7bcb";

// A chat whose timeline is `items`, a user_message starting each turn. Positions are not the items'
// indexes: an agent message is many chunks in Paseo, so seqs jump (here by 7 per item) and a message
// spans several of them. Reads go through the same paging rules as the daemon's: a limit counts
// entries, `before` and `after` take a seq, and every call is recorded.
function fakeChat({ items = [], title = "55611 Workspace", project = "seks", status = "idle", permissions = [], subagents = [] } = {}) {
  const entries = items.map((item, i) => ({
    item,
    timestamp: at(items.length - i),
    seqStart: 10 + i * 7,
    // A message streams in chunks and a tool call runs, then completes: both span several seqs.
    seqEnd: 10 + i * 7 + (["assistant_message", "tool_call"].includes(item.type) ? 3 : 0),
  }));
  const calls = [];
  const state = { entries };
  const agent = () => ({
    agent: { id: ID, title, status, requiresAttention: false, pendingPermissions: permissions, updatedAt: at(1), createdAt: at(600), cwd: "/Users/r/seks", lastUsage: null, provider: "claude" },
    project: { projectName: project, workspaceName: null },
  });
  const page = (list, hasOlder, hasNewer) => ({ epoch: "e1", entries: list, hasOlder, hasNewer });
  return {
    calls,
    state,
    push(item) {
      const last = state.entries.at(-1);
      const seqStart = last ? last.seqEnd + 7 : 10;
      state.entries.push({ item, timestamp: at(0), seqStart, seqEnd: seqStart });
    },
    async fetchAgents() {
      calls.push("fetchAgents");
      return { entries: [agent()] };
    },
    async fetchAgent(id) {
      calls.push("fetchAgent");
      return id === ID ? agent() : null;
    },
    async listAgentTimelinePrompts() {
      calls.push("listAgentTimelinePrompts");
      const prompts = state.entries.filter((e) => e.item.type === "user_message");
      // Paseo's preview: whitespace collapsed, 120 characters at most.
      const preview = (text) => (text.replace(/\s+/g, " ").trim().length <= 120 ? text.replace(/\s+/g, " ").trim() : `${text.replace(/\s+/g, " ").trim().slice(0, 119)}…`);
      return { epoch: "e1", prompts: prompts.map((e) => ({ seq: e.seqStart, preview: preview(e.item.text), timestamp: e.timestamp })) };
    },
    async fetchAgentTimeline(_id, { direction = "tail", cursor, limit = 200 } = {}) {
      calls.push(`fetchAgentTimeline ${direction}${cursor ? ` ${cursor.seq}` : ""} limit ${limit}`);
      const all = state.entries;
      if (direction === "tail") {
        const list = all.slice(-limit);
        return page(list, all.length > list.length, false);
      }
      if (direction === "before") {
        const earlier = all.filter((e) => e.seqEnd < cursor.seq);
        const list = earlier.slice(-limit);
        return page(list, earlier.length > list.length, true);
      }
      // After a cursor: every entry with a part after it, as the daemon's source ranges select them.
      const later = all.filter((e) => e.seqEnd > cursor.seq);
      const list = later.slice(0, limit);
      return page(list, all.some((e) => e.seqEnd <= cursor.seq), later.length > list.length);
    },
    // Paseo's search: where each message holding the words ends, and whose it is, never its text;
    // oldest first, 200 to a page, the next page after the cursor's seq.
    async searchAgentTimeline({ query, cursor = 0 }) {
      calls.push(`searchAgentTimeline${cursor ? ` ${cursor}` : ""}`);
      const words = query.toLowerCase();
      const found = state.entries.filter((e) => e.seqEnd > cursor && ["user_message", "assistant_message"].includes(e.item.type) && e.item.text.toLowerCase().includes(words));
      const locations = found.slice(0, 200).map((e) => ({ seq: e.seqEnd, role: e.item.type === "user_message" ? "user" : "assistant", count: 1 }));
      return { epoch: "e1", locations, nextCursor: found.length > 200 ? locations.at(-1).seq : null };
    },
    // Claude's subagents, each with its own timeline of `items`, paged like the chat's.
    async listProviderSubagents() {
      calls.push("listProviderSubagents");
      const descriptor = (s) => Object.fromEntries(Object.entries(s).filter(([key]) => key !== "items"));
      return { subagents: subagents.map((s) => ({ parentAgentId: ID, provider: "claude", subtitle: s.title, ...descriptor(s) })) };
    },
    async fetchProviderSubagentTimeline(_id, subagentId, { direction = "tail", cursor, limit = 200 } = {}) {
      calls.push(`fetchProviderSubagentTimeline ${direction}${cursor ? ` ${cursor.seq}` : ""} limit ${limit}`);
      const rows = (subagents.find((s) => s.id === subagentId)?.items ?? []).map((item, i) => ({ item, timestamp: at(30 - i / 100), seq: i + 1, seqStart: i + 1, seqEnd: i + 1 }));
      const before = direction === "before" ? rows.filter((r) => r.seqEnd < cursor.seq) : rows;
      const list = before.slice(-limit);
      return { epoch: "s1", rows: list, hasOlder: before.length > list.length, hasNewer: direction === "before" };
    },
  };
}

const user = (text) => ({ type: "user_message", text });
const agent = (text) => ({ type: "assistant_message", text });
const tool = (n) => ({ type: "tool_call", name: "Bash", status: "completed", detail: { type: "shell", command: `echo ${n}` } });

// A message of `length` characters in which every character says where it is, so a window is easy to check.
function numbered(length) {
  let out = "";
  for (let i = 0; out.length < length; i += 1) out += `[${i}]`;
  return out.slice(0, length);
}

const LONG = numbered(10_974);
const UNICODE = "Привет 😀 мир 👩‍💻 ".repeat(40);

// ---- the window itself --------------------------------------------------------------------------

test("messageWindow: head, tail and full windows, and the edges between them", () => {
  const text = "abcdefghij";
  assert.deepEqual(messageWindow(text, { mode: "head", size: 3 }), { text: "abc", total: 10, start: 0, end: 3 });
  assert.deepEqual(messageWindow(text, { mode: "tail", size: 3 }), { text: "hij", total: 10, start: 7, end: 10 });
  assert.deepEqual(messageWindow(text, { mode: "full", size: 4, offset: 4 }), { text: "efgh", total: 10, start: 4, end: 8 });
  // The size of the whole message, one more, one less.
  assert.equal(messageWindow(text, { mode: "head", size: 10 }).text, text);
  assert.equal(messageWindow(text, { mode: "head", size: 11 }).text, text);
  assert.equal(messageWindow(text, { mode: "head", size: 9 }).text, "abcdefghi");
  assert.equal(messageWindow(text, { mode: "tail", size: 10 }).text, text);
  assert.equal(messageWindow(text, { mode: "tail", size: 11 }).text, text);
  assert.equal(messageWindow(text, { mode: "tail", size: 9 }).text, "bcdefghij");
  assert.equal(messageWindow(text, { mode: "head", size: 1 }).text, "a");
  assert.equal(messageWindow(text, { mode: "tail", size: 1 }).text, "j");
  // The last page is short, an offset at the end is empty, one past it is empty at the end.
  assert.deepEqual(messageWindow(text, { mode: "full", size: 4, offset: 8 }), { text: "ij", total: 10, start: 8, end: 10 });
  assert.deepEqual(messageWindow(text, { mode: "full", size: 4, offset: 10 }), { text: "", total: 10, start: 10, end: 10 });
  assert.deepEqual(messageWindow(text, { mode: "full", size: 4, offset: 99 }), { text: "", total: 10, start: 10, end: 10 });
  assert.deepEqual(messageWindow("", { mode: "head", size: 5 }), { text: "", total: 0, start: 0, end: 0 });
  assert.deepEqual(messageWindow("", { mode: "tail", size: 5 }), { text: "", total: 0, start: 0, end: 0 });
});

test("messageWindow counts characters, not UTF-16 halves: an emoji is never split", () => {
  const text = "a😀b👩‍💻c";
  assert.equal(charCount(text), 7, "a, the emoji, b, then woman, joiner, laptop and c");
  assert.equal(messageWindow(text, { mode: "head", size: 2 }).text, "a😀");
  assert.equal(messageWindow(text, { mode: "tail", size: 1 }).text, "c");
  assert.equal(messageWindow(text, { mode: "full", size: 1, offset: 1 }).text, "😀");
  // Every page boundary of every size keeps the pages whole and in order.
  for (let size = 1; size <= 9; size += 1) {
    let rebuilt = "";
    for (let offset = 0; offset < 7; offset += size) {
      const piece = messageWindow(text, { mode: "full", size, offset }).text;
      assert.ok(!/[\ud800-\udbff]$|^[\udc00-\udfff]/.test(piece), `size ${size}, offset ${offset}: a half of a pair`);
      rebuilt += piece;
    }
    assert.equal(rebuilt, text, `size ${size}`);
  }
});

test("a message id names a role and a position, and nothing else", () => {
  assert.equal(messageRef("agent", 1117), "agent-1117");
  assert.deepEqual(parseMessageRef("user-166"), { role: "user", seq: 166 });
  assert.deepEqual(parseMessageRef(" agent-0 "), { role: "agent", seq: 0 });
  for (const bad of ["", "agent", "agent-", "agent-x", "assistant-12", "user-12-3", "12", undefined, null, 12]) assert.equal(parseMessageRef(bad), null, String(bad));
});

// ---- the bug: a long user message --------------------------------------------------------------

test("a user's message of 10974 characters is readable whole, as its start and as its end", async () => {
  const chat = fakeChat({ items: [user("first"), agent("ok"), user(LONG), tool(1), tool(2), agent("working on it")] });
  const full = await readMessageOn(chat, { chat: "55611", role: "user" });
  assert.equal(full.data.text, LONG.slice(0, MESSAGE_PAGE), "a page of it, not 300 characters");
  assert.equal(full.data.total_chars, 10_974);
  assert.equal(full.data.returned_chars, MESSAGE_PAGE);
  assert.equal(full.data.remaining_chars, 10_974 - MESSAGE_PAGE);
  assert.equal(full.data.truncated, true);
  assert.equal(full.data.next_offset, MESSAGE_PAGE);
  assert.equal(full.data.previous_offset, null);
  assert.equal(full.data.mode, "full");
  assert.equal(full.data.role, "user");
  assert.equal(full.data.turn, 1);
  // The way on comes before the text, so a client that cuts the answer short does not cut it off.
  assert.match(
    full.text,
    /The user's message, turn 1 of 2 counted from the latest: 6000 of 10974 characters, offset 0 to 6000\.\n4974 more characters follow: call read_message again with message_id user-\d+, mode full and offset 6000\.\n\n\[0\]\[1\]/,
  );
  const rest = await readMessageOn(chat, { chat: "55611", id: full.data.message_id, offset: full.data.next_offset });
  assert.deepEqual([rest.data.offset, rest.data.returned_chars, rest.data.remaining_chars, rest.data.truncated, rest.data.next_offset], [MESSAGE_PAGE, 4974, 0, true, null]);
  assert.equal(full.data.text + rest.data.text, LONG, "two pages are the whole text");
  assert.ok(rest.text.endsWith(LONG.slice(MESSAGE_PAGE)), "nothing follows the text when nothing is left");

  const head = await readMessageOn(chat, { chat: "55611", role: "user", mode: "head", size: 500 });
  assert.equal(head.data.text, LONG.slice(0, 500));
  assert.deepEqual([head.data.offset, head.data.returned_chars, head.data.remaining_chars, head.data.truncated, head.data.next_offset, head.data.previous_offset], [0, 500, 10_474, true, 500, null]);
  assert.match(head.text, /500 of 10974 characters, offset 0 to 500, the start\.\n10474 more characters follow: call read_message again with message_id user-\d+, mode full and offset 500\.\n\n\[0\]/);

  const tail = await readMessageOn(chat, { chat: "55611", role: "user", mode: "tail", size: 700 });
  assert.equal(tail.data.text, LONG.slice(-700));
  assert.deepEqual([tail.data.offset, tail.data.returned_chars, tail.data.remaining_chars, tail.data.truncated, tail.data.next_offset, tail.data.previous_offset], [10_274, 700, 0, true, null, 9574]);
  assert.match(tail.text, /700 of 10974 characters, offset 10274 to 10974, the end\.\n10274 characters come before: message_id user-\d+, mode full, offset 9574 and size 700 read the part just before this one\.\n\n/);
  assert.doesNotMatch(tail.text, /more characters follow/);
});

test("read_chat still cuts the user's message at 300 characters, and now says so and where the rest is", async () => {
  const chat = fakeChat({ items: [user("first"), agent("ok"), user(LONG), agent("working on it")] });
  const read = await readChatOn(chat, { chat: "55611", maxChars: 6000 });
  const t = read.data.turns[0];
  assert.ok(t.user_text.length <= 302, "the same cut as before");
  assert.ok(t.user_text.endsWith(" …"));
  assert.equal(t.user_text_truncated, true);
  assert.equal(t.user_chars, 10_974);
  assert.equal(t.agent_text, "working on it");
  assert.equal(t.agent_text_truncated, false);
  assert.equal(t.agent_chars, 13);
  assert.match(read.text, /^User asked: \[0\]\[1\]/m);
  assert.match(read.text, /^Cut: the user's message \(10974 characters, message_id user-24\)\. read_message gives a whole message, or its start or end\.$/m);
  assert.equal(t.user_message_id, "user-24", "the id read_message takes for it");
  assert.equal((await readMessageOn(chat, { chat: "55611", id: t.user_message_id, mode: "tail", size: 30 })).data.text, LONG.slice(-30));
  // Several turns: the same, per turn, with the turn to ask for.
  const both = await readChatOn(chat, { chat: "55611", turns: 2 });
  assert.equal(both.data.turns[0].user_text_truncated, false, "the short turn is whole");
  assert.equal(both.data.turns[1].user_text_truncated, true);
  assert.match(both.text, /^ {2}Cut: the user's message \(10974 characters, message_id user-24\)\. read_message turn 1 gives a whole message, or its start or end\.$/m);
  assert.equal((both.text.match(/Cut:/g) ?? []).length, 1, "only the cut turn carries the line");
});

test("read_chat marks a short message whole and adds nothing to its text", async () => {
  const chat = fakeChat({ items: [user("is the relay up?"), agent("The relay is up.")] });
  const read = await readChatOn(chat, { chat: "55611" });
  const t = read.data.turns[0];
  assert.deepEqual([t.user_text, t.user_chars, t.user_text_truncated, t.agent_text, t.agent_chars, t.agent_text_truncated], ["is the relay up?", 16, false, "The relay is up.", 16, false]);
  assert.match(read.text, /^55611 Workspace \(seks\): idle, [^\n]+\nTurn 1 of 1, counted from the latest\.\nUser asked: is the relay up\?\nAgent replied: The relay is up\.$/);
});

test("read_chat says when the agent's last message was cut to fit, and when earlier ones were left out", async () => {
  const reply = numbered(4021);
  const chat = fakeChat({ items: [user("go"), agent("one"), tool(1), agent("two"), tool(2), agent(reply)] });
  const read = await readChatOn(chat, { chat: "55611", maxChars: 1500 });
  const t = read.data.turns[0];
  assert.equal(t.agent_text_truncated, true);
  assert.equal(t.agent_chars, 4021);
  assert.equal(t.omitted_messages, 2);
  assert.match(read.text, /^Cut: the agent's last message \(4021 characters, message_id agent-45\), 2 earlier agent message\(s\)\. read_message gives/m);
  assert.equal(t.agent_message_id, "agent-45");
  assert.equal((await readMessageOn(chat, { chat: "55611", id: t.agent_message_id })).data.text, reply, "the id reads the message that was cut, whole");
  const whole = await readChatOn(chat, { chat: "55611", maxChars: 6000 });
  assert.equal(whole.data.turns[0].agent_text_truncated, false, "it fits the budget");
  assert.equal(whole.data.turns[0].omitted_messages, 0);
  assert.doesNotMatch(whole.text, /Cut:/);
});

test("read_chat's counts ignore the empty message a cancelled turn leaves behind", async () => {
  const reply = numbered(4021);
  const chat = fakeChat({ items: [user("go"), agent(reply), tool(1), agent("  ")] });
  const read = await readChatOn(chat, { chat: "55611", maxChars: 1500 });
  const t = read.data.turns[0];
  assert.deepEqual([t.agent_chars, t.agent_text_truncated], [4021, true], "the last message with words in it, not the empty one after it");
  const whole = await readMessageOn(chat, { chat: "55611", mode: "tail", size: 20 });
  assert.equal(whole.data.text, reply.slice(-20), "read_message reads the same message");
});

// ---- pages: full and the offset ---------------------------------------------------------------

test("full reads a message longer than a page in pages that join up to it exactly", async () => {
  const long = numbered(30_001);
  const chat = fakeChat({ items: [user(long), agent("ok")] });
  let rebuilt = "";
  let offset;
  let id;
  const sizes = [];
  for (let i = 0; i < 10; i += 1) {
    const page = await readMessageOn(chat, { chat: "55611", role: "user", ...(id ? { id, offset } : {}) });
    sizes.push(page.data.returned_chars);
    assert.equal(page.data.offset, rebuilt.length, "each page starts where the last one ended");
    assert.equal(page.data.truncated, true);
    rebuilt += page.data.text;
    id = page.data.message_id;
    if (page.data.next_offset === null) break;
    assert.equal(page.data.next_offset, page.data.offset + page.data.returned_chars);
    assert.equal(page.data.remaining_chars, 30_001 - rebuilt.length);
    offset = page.data.next_offset;
  }
  assert.deepEqual(sizes, [6000, 6000, 6000, 6000, 6000, 1], "pages of 6000 and what is left");
  assert.equal(rebuilt, long);
});

test("full pages of every size, one character to past the whole message, join up exactly", async () => {
  const message = "Привет, мир! 😀\nВторая строка.\n\nИ третья 👩‍💻 строка.";
  const total = charCount(message);
  const chat = fakeChat({ items: [user(message), agent("ok")] });
  for (const size of [1, 2, 3, 7, total - 1, total, total + 1, 12_000]) {
    let rebuilt = "";
    let offset = 0;
    for (let guard = 0; guard < total + 2; guard += 1) {
      const page = await readMessageOn(chat, { chat: "55611", role: "user", size, offset });
      rebuilt += page.data.text;
      assert.ok(page.data.returned_chars <= Math.min(size, 12_000));
      if (page.data.next_offset === null) break;
      offset = page.data.next_offset;
    }
    assert.equal(rebuilt, message, `size ${size}`);
  }
});

test("a page that ends exactly at the end of the message has nothing left to read", async () => {
  const chat = fakeChat({ items: [user(numbered(100)), agent("ok")] });
  const exact = await readMessageOn(chat, { chat: "55611", role: "user", size: 100 });
  assert.deepEqual([exact.data.truncated, exact.data.remaining_chars, exact.data.next_offset], [false, 0, null]);
  const short = await readMessageOn(chat, { chat: "55611", role: "user", size: 99 });
  assert.deepEqual([short.data.truncated, short.data.remaining_chars, short.data.next_offset], [true, 1, 99]);
  const last = await readMessageOn(chat, { chat: "55611", role: "user", size: 99, offset: 99 });
  assert.deepEqual([last.data.text, last.data.truncated, last.data.remaining_chars, last.data.next_offset, last.data.previous_offset], [numbered(100).slice(99), true, 0, null, 0]);
});

test("an offset past the end says so instead of looking like an empty message", async () => {
  const chat = fakeChat({ items: [user(numbered(100)), agent("ok")] });
  const past = await readMessageOn(chat, { chat: "55611", role: "user", offset: 5000 });
  assert.deepEqual([past.data.text, past.data.offset, past.data.returned_chars, past.data.total_chars, past.data.remaining_chars, past.data.truncated, past.data.next_offset], ["", 100, 0, 100, 0, true, null]);
  assert.match(past.text, /there is nothing at offset 5000: the message has 100 characters\./);
  assert.match(past.text, /100 characters come before: message_id user-\d+, mode full, offset 0 and size 100/);
  const atEnd = await readMessageOn(chat, { chat: "55611", role: "user", offset: 100 });
  assert.equal(atEnd.data.text, "");
  assert.equal(atEnd.data.truncated, true);
});

test("a size above a page is a page, and says how much is left", async () => {
  const chat = fakeChat({ items: [user(numbered(20_000)), agent("ok")] });
  const page = await readMessageOn(chat, { chat: "55611", role: "user", size: 50_000 });
  assert.equal(page.data.returned_chars, MESSAGE_PAGE);
  assert.equal(page.data.remaining_chars, 14_000);
  assert.equal(page.data.next_offset, MESSAGE_PAGE);
  const head = await readMessageOn(chat, { chat: "55611", role: "user", mode: "head", size: 99_999 });
  assert.equal(head.data.returned_chars, MESSAGE_PAGE, "head and tail are capped the same way");
  const defaults = await readMessageOn(chat, { chat: "55611", role: "user", mode: "tail" });
  assert.equal(defaults.data.returned_chars, 1500, "a tail or a head with no size takes 1500");
});

test("an empty message is empty, not truncated", async () => {
  const chat = fakeChat({ items: [user(""), agent("hello")] });
  for (const mode of ["head", "tail", "full"]) {
    const read = await readMessageOn(chat, { chat: "55611", role: "user", mode });
    assert.deepEqual([read.data.text, read.data.total_chars, read.data.truncated, read.data.next_offset, read.data.previous_offset], ["", 0, false, null, null], mode);
    assert.match(read.text, /counted from the latest: empty\.$/, mode);
  }
});

test("characters are code points in every count the answer gives", async () => {
  const chat = fakeChat({ items: [user(UNICODE), agent("ok")] });
  const total = charCount(UNICODE);
  assert.ok(UNICODE.length > total, "the text has surrogate pairs");
  const head = await readMessageOn(chat, { chat: "55611", role: "user", mode: "head", size: 100 });
  assert.equal(head.data.total_chars, total);
  assert.equal(charCount(head.data.text), 100);
  assert.equal(head.data.remaining_chars, total - 100);
  const tail = await readMessageOn(chat, { chat: "55611", role: "user", mode: "tail", size: 33 });
  assert.equal(tail.data.text, Array.from(UNICODE).slice(-33).join(""));
  assert.equal(tail.data.offset, total - 33);
});

// ---- the agent's messages ---------------------------------------------------------------------

test("an agent's message is read whole, by turn and by its number from the last", async () => {
  const final = numbered(MESSAGE_PAGE);
  const chat = fakeChat({ items: [user("old"), agent("old reply"), user("go"), agent("first message"), tool(1), agent("second message"), tool(2), agent(final)] });
  const last = await readMessageOn(chat, { chat: "55611" });
  assert.deepEqual([last.data.role, last.data.message, last.data.agent_messages, last.data.total_chars, last.data.truncated], ["agent", 1, 3, 6000, false], "a message of exactly a page is whole");
  assert.equal(last.data.text, final);
  assert.match(last.text.slice(0, 200), /^55611 Workspace \(seks\): idle, [^\n]+\nThe agent's last message, turn 1 of 2 counted from the latest: all 6000 characters\.\n\n\[0\]/);
  const middle = await readMessageOn(chat, { chat: "55611", message: 2 });
  assert.equal(middle.data.text, "second message");
  assert.deepEqual([middle.data.message, middle.data.agent_messages], [2, 3]);
  assert.match(middle.text, /^The agent's message 2 of 3 counted from the last, turn 1 of 2 counted from the latest: all 14 characters\.$/m);
  const first = await readMessageOn(chat, { chat: "55611", message: 3 });
  assert.equal(first.data.text, "first message");
  const older = await readMessageOn(chat, { chat: "55611", turn: 2 });
  assert.equal(older.data.text, "old reply");
  assert.deepEqual([older.data.turn, older.data.position], [2, 1]);
  const none = await readMessageOn(chat, { chat: "55611", message: 4 });
  assert.match(none.data.missing, /Turn 1 has 3 agent message\(s\), so there is no message 4 counted from the last\./);
  assert.equal(none.data.text, undefined);
});

test("an agent's long message: head, tail and the pages in between", async () => {
  const final = numbered(9000);
  const chat = fakeChat({ items: [user("go"), tool(1), agent(final)] });
  assert.equal((await readMessageOn(chat, { chat: "55611", mode: "head", size: 250 })).data.text, final.slice(0, 250));
  assert.equal((await readMessageOn(chat, { chat: "55611", mode: "tail", size: 250 })).data.text, final.slice(-250));
  const mid = await readMessageOn(chat, { chat: "55611", offset: 4000, size: 1000 });
  assert.equal(mid.data.text, final.slice(4000, 5000));
  assert.deepEqual([mid.data.next_offset, mid.data.previous_offset, mid.data.remaining_chars], [5000, 3000, 4000]);
});

test("a turn the agent has not answered yet, and a turn that does not exist, say so", async () => {
  const chat = fakeChat({ items: [user("hello"), agent("hi"), user("work on it"), tool(1)] });
  const waiting = await readMessageOn(chat, { chat: "55611" });
  assert.equal(waiting.data.missing, "The agent has not written a message in turn 1 yet.");
  assert.equal(waiting.data.total_turns, 2);
  assert.match(waiting.text, /idle, [^\n]+\nThe agent has not written a message in turn 1 yet\.$/);
  const user2 = await readMessageOn(chat, { chat: "55611", role: "user" });
  assert.equal(user2.data.text, "work on it", "its own message is there all the same");
  const far = await readMessageOn(chat, { chat: "55611", turn: 9, role: "user" });
  assert.equal(far.data.missing, "The chat has 2 turn(s); turn 9 does not exist.");
});

test("empty agent messages are not counted, and the images read as [image N] counted through the turn", async () => {
  const chat = fakeChat({
    items: [user("show"), agent("Here: ![shot](file:///Users/r/shot-1.png) and ![b](https://example.test/b.png)"), tool(1), agent("   "), agent("Then ![c](/Users/r/c.png) done.")],
  });
  const last = await readMessageOn(chat, { chat: "55611" });
  assert.equal(last.data.text, "Then [image 3] done.", "the numbering runs on from the first message");
  assert.equal(last.data.agent_messages, 2, "the blank message is not one");
  assert.deepEqual(last.data.images, [{ n: 3, name: "c", viewable: true }], "named by its alt text, as read_chat names it");
  assert.match(last.text, /1 image\(s\) in turn 1: show_images \(turn 1\) puts them on the user's screen\.$/);
  assert.doesNotMatch(JSON.stringify(last), /\/Users\/r\/c\.png|shot-1/, "no path reaches the model");
  const first = await readMessageOn(chat, { chat: "55611", message: 2 });
  assert.equal(first.data.text, "Here: [image 1] and [image 2]");
  assert.deepEqual(first.data.images.map((i) => [i.n, i.viewable]), [[1, true], [2, false]]);
});

// ---- the message id holds still ---------------------------------------------------------------

test("a message id keeps pointing at its message after the chat moves on", async () => {
  const final = numbered(20_000);
  const chat = fakeChat({ items: [user("go"), agent(final)] });
  const first = await readMessageOn(chat, { chat: "55611" });
  assert.equal(first.data.text, final.slice(0, MESSAGE_PAGE));
  assert.equal(first.data.turn, 1);
  // The user writes again and the agent answers: turn 1 is now another turn.
  chat.push(user("and another thing"));
  chat.push(agent("another answer"));
  const wrong = await readMessageOn(chat, { chat: "55611", offset: first.data.next_offset });
  assert.equal(wrong.data.text, "", "by turn, the page would come from the new turn");
  const right = await readMessageOn(chat, { chat: "55611", id: first.data.message_id, offset: first.data.next_offset });
  assert.equal(right.data.text, final.slice(MESSAGE_PAGE, 2 * MESSAGE_PAGE), "by id, it is the same message");
  assert.deepEqual([right.data.turn, right.data.position, right.data.role, right.data.message_id], [2, 1, "agent", first.data.message_id]);
  // A user's message keeps its id too.
  const prompt = await readMessageOn(chat, { chat: "55611", role: "user", turn: 2 });
  assert.equal(prompt.data.text, "go");
  const again = await readMessageOn(chat, { chat: "55611", id: prompt.data.message_id, role: "agent", turn: 1 });
  assert.equal(again.data.text, "go", "the id wins over role and turn");
});

test("a message id that names nothing in the chat says so", async () => {
  const chat = fakeChat({ items: [user("go"), agent("done")] });
  const ghost = await readMessageOn(chat, { chat: "55611", id: "agent-9999" });
  assert.equal(ghost.data.missing, "The chat has no message agent-9999.");
  const notAPrompt = await readMessageOn(chat, { chat: "55611", id: "user-17" });
  assert.equal(notAPrompt.data.missing, "The chat has no message user-17.");
  const before = await readMessageOn(chat, { chat: "55611", id: "user-1" });
  assert.equal(before.data.missing, "The chat has no message user-1.");
  assert.deepEqual(await readMessageOn(chat, { chat: "55611", id: "nonsense" }), { invalid: 'message_id is one that read_message returned, such as "agent-1117".' });
});

// ---- long turns: the page limit must not hide a message ---------------------------------------

test("in a turn of more than 400 entries the user's message and the last agent message are still whole", async () => {
  const prompt = numbered(5000);
  const items = [user("earlier"), agent("earlier reply"), user(prompt)];
  for (let i = 0; i < 950; i += 1) items.push(tool(i));
  items.push(agent("the answer"));
  const chat = fakeChat({ items });
  chat.calls.length = 0;
  const own = await readMessageOn(chat, { chat: "55611", role: "user" });
  assert.equal(own.data.text, prompt, "found by its position, not by paging through the turn");
  assert.ok(chat.calls.every((c) => !c.startsWith("fetchAgentTimeline tail")), chat.calls.join("; "));
  chat.calls.length = 0;
  const last = await readMessageOn(chat, { chat: "55611" });
  assert.equal(last.data.text, "the answer");
  assert.equal(last.data.agent_messages, undefined, "the turn was not read to its start, so its message count is not claimed");
  assert.equal(chat.calls.filter((c) => c.startsWith("fetchAgentTimeline")).length, 1, "one page was enough");
});

test("an earlier agent message in a turn longer than a page is found by reading further back", async () => {
  const items = [user("go"), agent("the very first message")];
  for (let i = 0; i < 900; i += 1) items.push(tool(i));
  items.push(agent("the last message"));
  const chat = fakeChat({ items });
  const first = await readMessageOn(chat, { chat: "55611", message: 2 });
  assert.equal(first.data.text, "the very first message");
  assert.equal(first.data.agent_messages, 2, "read to the turn's start, so now it is known");
  assert.equal(first.data.message, 2);
  const byId = await readMessageOn(chat, { chat: "55611", id: first.data.message_id });
  assert.equal(byId.data.text, "the very first message");
  assert.equal(byId.data.message, 2);
});

test("a turn too long to read back to its start says so instead of claiming the message is not there", async () => {
  const items = [user("go"), agent("the very first message")];
  for (let i = 0; i < 3500; i += 1) items.push(tool(i));
  items.push(agent("the last message"));
  const chat = fakeChat({ items });
  chat.calls.length = 0;
  const missing = await readMessageOn(chat, { chat: "55611", message: 2 });
  assert.match(missing.data.missing, /^Message 2 counted from the last is not among the last \d+ entries of turn 1, which is longer than can be read\.$/);
  assert.equal(chat.calls.filter((c) => c.startsWith("fetchAgentTimeline")).length, 8, "it read what it may, and stopped");
  const last = await readMessageOn(chat, { chat: "55611" });
  assert.equal(last.data.text, "the last message", "the final message needs one page");
  const none = await readMessageOn(fakeChat({ items: [user("go"), ...items.slice(2, 3502)] }), { chat: "55611" });
  assert.match(none.data.missing, /^Message 1 counted from the last is not among the last \d+ entries of turn 1, which is longer than can be read\.$/);
});

test("read_chat shows a long turn's real user message, not Paseo's 120-character preview", async () => {
  const prompt = `Передаю все 12 ответов ДОСЛОВНО. ${numbered(2000)}`;
  const items = [user(prompt)];
  for (let i = 0; i < 700; i += 1) items.push(tool(i));
  items.push(agent("done"));
  const chat = fakeChat({ items });
  const read = await readChatOn(chat, { chat: "55611" });
  const t = read.data.turns[0];
  assert.equal(t.user_chars, charCount(prompt), "the message itself was read");
  assert.equal(t.user_text_truncated, true);
  assert.match(t.user_text, /^Передаю все 12 ответов ДОСЛОВНО\. \[0\]\[1\]/);
  assert.ok(t.user_text.length > 150, "more than the preview's 120");
});

// ---- the chat is never touched -----------------------------------------------------------------

test("read_message only reads: a client without any write method is enough", async () => {
  const chat = fakeChat({ items: [user(LONG), agent("ok")] });
  const readOnly = new Proxy(chat, {
    get(target, name) {
      if (typeof name === "string" && /^(send|archive|apply|set|create|update|delete|pin|cancel|append|resume|import|refresh|restore|remove)/.test(name)) throw new Error(`a write was called: ${name}`);
      return target[name];
    },
  });
  for (const mode of ["head", "tail", "full"]) await readMessageOn(readOnly, { chat: "55611", role: "user", mode });
  await readMessageOn(readOnly, { chat: "55611" });
  const names = new Set(chat.calls.map((c) => c.split(" ")[0]));
  assert.deepEqual([...names].sort(), ["fetchAgentTimeline", "fetchAgents", "listAgentTimelinePrompts"]);
});

test("read_message resolves its chat like the other reads: by name, by id, or it asks", async () => {
  const chat = fakeChat({ items: [user("hello"), agent("hi")] });
  assert.equal((await readMessageOn(chat, { chat: ID, role: "user" })).data.text, "hello");
  assert.equal((await readMessageOn(chat, { chat: "55611 Workspace", role: "user" })).data.text, "hello");
  const unknown = await readMessageOn(chat, { chat: "weather forecast", role: "user" });
  assert.equal(unknown.data.needs_clarification.kind, "chat");
  assert.equal(unknown.data.text, undefined);
});

// ---- the reported case: an answer of seven sections, cut at the sixth --------------------------

// Shaped like the answer read_chat could not finish (2026-11-03): an opening line and seven sections,
// the sixth starting before character 6000 and the seventh after it, about 8160 characters. Russian,
// with a ZWJ sequence, a flag, a letter with a combining mark and a character beyond the BMP in every
// sentence, so UTF-16 units and characters part ways long before the cut. read_chat's budget counts
// UTF-16 units, so its cut too falls in the sixth section.
function sevenSections() {
  const sentence = (n, i) => `Развилка ${n}.${i}: держим «напоминания» только для чтения — 👩‍💻 смотрит, 🇵🇱 спит, й и 𠀋 на месте 😀.`;
  const sections = [17, 10, 10, 9, 9, 12, 16].map((count, s) => {
    const body = Array.from({ length: count }, (_, i) => sentence(s + 1, i + 1)).join(" ");
    return `## ${s + 1}. Раздел ${s + 1}\n\n${body}`;
  });
  return ["Кадр, держи развилки по архитектуре. Коротко по каждой:", ...sections].join("\n\n");
}

const SEVEN = sevenSections();
// Where a section starts, in characters.
const sectionAt = (n) => charCount(SEVEN.slice(0, SEVEN.indexOf(`## ${n}.`)));
const halfPair = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

// Eight turns, the answer in the sixth from the start (turn 3 from the latest), as in the report.
function reportedChat() {
  const items = [];
  for (let position = 1; position <= 8; position += 1) {
    items.push(user(`вопрос ${position}`));
    if (position === 6) items.push({ type: "reasoning", text: "думаю" }, agent(SEVEN));
    else items.push(tool(position), agent(`ответ ${position}`));
  }
  return fakeChat({ items, title: "Research ChatGPT reminders read-only architecture", project: "voxbridge" });
}

test("the seven-section answer: read_chat cuts it in the sixth section and says so, with the id that reads the rest", async () => {
  assert.ok(sectionAt(6) < MESSAGE_PAGE && sectionAt(7) > MESSAGE_PAGE, `sections 6 at ${sectionAt(6)} and 7 at ${sectionAt(7)}`);
  assert.ok(SEVEN.length > charCount(SEVEN) + 400, "far more UTF-16 units than characters");
  const chat = reportedChat();
  const read = await readChatOn(chat, { chat: ID, turn: 3, turns: 1, maxChars: 6000 });
  const [t] = read.data.turns;
  assert.deepEqual([read.data.total_turns, t.turn, t.position, t.omitted_messages], [8, 3, 6, 0]);
  assert.match(t.agent_text, /^Кадр, держи развилки/);
  assert.match(t.agent_text, /## 6\. Раздел 6/);
  assert.doesNotMatch(t.agent_text, /## 7\./, "the cut the report describes");
  assert.ok(t.agent_text.endsWith(" …"));
  assert.doesNotMatch(t.agent_text, halfPair);
  assert.deepEqual([t.agent_text_truncated, t.agent_chars], [true, charCount(SEVEN)], "the cut is no longer silent");
  assert.match(t.agent_message_id, /^agent-\d+$/);
  assert.ok(read.text.includes(`Cut: the agent's last message (${charCount(SEVEN)} characters, message_id ${t.agent_message_id}). read_message gives a whole message, or its start or end.`));
});

test("the seven-section answer reads whole through read_message: two pages by its id, every section, nothing lost", async () => {
  const chat = reportedChat();
  const { data } = await readChatOn(chat, { chat: ID, turn: 3, maxChars: 6000 });
  const id = data.turns[0].agent_message_id;
  const first = await readMessageOn(chat, { chat: ID, id });
  assert.deepEqual(
    [first.data.turn, first.data.position, first.data.role, first.data.offset, first.data.returned_chars, first.data.total_chars, first.data.truncated, first.data.next_offset],
    [3, 6, "agent", 0, MESSAGE_PAGE, charCount(SEVEN), true, MESSAGE_PAGE],
  );
  assert.match(first.text, new RegExp(`${charCount(SEVEN) - MESSAGE_PAGE} more characters follow: call read_message again with message_id ${id}, mode full and offset ${MESSAGE_PAGE}\\.\\n\\nКадр, держи развилки`));
  // The chat moves on before the second page is asked for: the id still names the same answer.
  chat.push(user("а что с седьмым?"));
  const second = await readMessageOn(chat, { chat: ID, id, offset: first.data.next_offset });
  assert.deepEqual([second.data.turn, second.data.position, second.data.offset, second.data.remaining_chars, second.data.next_offset], [4, 6, MESSAGE_PAGE, 0, null]);
  const whole = first.data.text + second.data.text;
  assert.equal(whole, SEVEN, "the pages join up to the answer exactly");
  for (let n = 1; n <= 7; n += 1) assert.match(whole, new RegExp(`## ${n}\\. Раздел ${n}\\n\\n(Развилка ${n}\\.\\d+: [^\\n]+ ?)+`), `section ${n}`);
  assert.ok(second.data.text.includes(SEVEN.slice(SEVEN.indexOf("## 7."))), "the seventh section comes whole on the second page");
  for (const page of [first.data.text, second.data.text]) assert.doesNotMatch(page, halfPair);
  // Or only its end: the seventh section and nothing before it.
  const seventh = charCount(SEVEN) - sectionAt(7);
  const tail = await readMessageOn(chat, { chat: ID, id, mode: "tail", size: seventh });
  assert.equal(tail.data.text, SEVEN.slice(SEVEN.indexOf("## 7.")));
  assert.equal(tail.data.offset, sectionAt(7));
});

test("pages of every size over a long Unicode answer keep each character whole and join up exactly", async () => {
  const chat = reportedChat();
  const total = charCount(SEVEN);
  for (const size of [997, 1500, 2048, 4999, MESSAGE_PAGE]) {
    let joined = "";
    let page = await readMessageOn(chat, { chat: ID, turn: 3, size });
    const id = page.data.message_id;
    for (let guard = 0; guard < 20; guard += 1) {
      assert.doesNotMatch(page.data.text, halfPair, `size ${size}, offset ${page.data.offset}`);
      assert.equal(charCount(page.data.text), page.data.returned_chars, "returned_chars counts characters");
      joined += page.data.text;
      if (page.data.next_offset === null) break;
      page = await readMessageOn(chat, { chat: ID, id, size, offset: page.data.next_offset });
    }
    assert.equal(joined, SEVEN, `size ${size}`);
    assert.equal(page.data.total_chars, total);
  }
});

// ---- search_messages leads to the whole message ------------------------------------------------

test("a search match carries the id of its message, and read_message reads that message whole", async () => {
  const items = [user("покажи развилки"), agent(SEVEN), tool(1), agent("Готово, это всё."), user("спасибо"), agent("пожалуйста")];
  const chat = fakeChat({ items, title: "Research ChatGPT reminders read-only architecture", project: "voxbridge" });
  const found = await searchMessagesOn(chat, { chat: ID, query: "Развилка 7.16" });
  assert.equal(found.data.matches.length, 1);
  const [match] = found.data.matches;
  assert.deepEqual([match.turn, match.role, match.message_id], [2, "assistant", "agent-17"], "where the answer starts, though Paseo places the match at its end");
  assert.ok(charCount(match.snippet) < 200, "a snippet, not the message");
  // read_chat of that turn shows the turn's last message, not the one that matched.
  const digest = await readChatOn(chat, { chat: ID, turn: match.turn, maxChars: 6000 });
  assert.equal(digest.data.turns[0].agent_text, "Готово, это всё.");
  assert.equal(digest.data.turns[0].omitted_messages, 1);
  // The match's id reads the matched message itself.
  const first = await readMessageOn(chat, { chat: ID, id: match.message_id });
  const rest = await readMessageOn(chat, { chat: ID, id: match.message_id, offset: first.data.next_offset });
  assert.equal(first.data.text + rest.data.text, SEVEN);
  assert.deepEqual([first.data.message, first.data.agent_messages], [2, 2]);
  // A match in the user's own message names it the way read_chat does.
  const own = await searchMessagesOn(chat, { chat: ID, query: "покажи развилки" });
  assert.equal(own.data.matches[0].message_id, "user-10");
  assert.equal((await readMessageOn(chat, { chat: ID, id: own.data.matches[0].message_id })).data.text, "покажи развилки");
  assert.equal((await readChatOn(chat, { chat: ID, turn: 2 })).data.turns[0].user_message_id, "user-10");
  // The search text keeps its lines as they were.
  assert.match(found.text, /^"Развилка 7\.16" found in 1 of 1 chat\(s\) searched:\nResearch ChatGPT reminders read-only architecture \(voxbridge\), turn 2 \(assistant\): /);
  assert.doesNotMatch(found.text, /agent-17/);
});

test("read_chat names each turn's messages, and a turn with no reply yet has no agent message", async () => {
  const chat = fakeChat({ items: [user("hello"), agent("hi"), user("work on it"), tool(1)] });
  const both = await readChatOn(chat, { chat: ID, turns: 2 });
  const [older, latest] = both.data.turns;
  assert.deepEqual([older.user_message_id, older.agent_message_id], ["user-10", "agent-17"]);
  assert.deepEqual([latest.user_message_id, latest.agent_message_id], ["user-24", null]);
  assert.doesNotMatch(both.text, /message_id|Cut:/, "nothing was cut, so nothing extra is said");
});

// ---- every long text God Mode cuts, read whole by its id (sizes measured on this Mac's chats) ------

// A text of `length` characters with Cyrillic, an emoji and a ZWJ sequence every few words, ending in
// a marker so its tail is easy to look for.
function longText(length, tag) {
  const end = `<<END ${tag}>>`;
  const unit = Array.from(`${tag}: строка вывода 😀 тест 👩‍💻 ok. `);
  const chars = [];
  while (chars.length < length - charCount(end)) chars.push(...unit);
  return chars.slice(0, length - charCount(end)).join("") + end;
}

const shell = (command, output, status = "completed") => ({ type: "tool_call", callId: "c1", name: "Bash", status, error: null, detail: { type: "shell", command, output } });
const mcpCall = (output) => ({ type: "tool_call", callId: "c2", name: "mcp__proxy-mcp-prod__ssh_exec", status: "completed", error: null, detail: { type: "unknown", input: { host: "srv-1", command: "journalctl -n 500" }, output } });
const readCall = { type: "tool_call", callId: "c3", name: "Read", status: "completed", error: null, detail: { type: "read", filePath: "/Users/r/app/main.go", content: longText(57_192, "file") } };
const thought = (text) => ({ type: "reasoning", text });

// Pages of read_message for one id, joined.
async function readWhole(chat, id) {
  let page = await readMessageOn(chat, { chat: ID, id });
  assert.equal(page.data.missing, undefined, page.data.missing);
  let text = page.data.text;
  while (page.data.next_offset !== null) {
    page = await readMessageOn(chat, { chat: ID, id, offset: page.data.next_offset });
    text += page.data.text;
  }
  return { text, total: page.data.total_chars, role: page.data.role, last: page };
}

test("view commands: a long shell command and output and an MCP call shown by name say they are cut; their ids read them whole", async () => {
  const command = longText(32_547, "cmd");
  const output = longText(28_718, "out");
  const remote = longText(54_223, "ssh");
  const chat = fakeChat({ items: [user("deploy and check"), shell(command, output), mcpCall(remote), readCall, agent("done")] });
  const read = await readChatOn(chat, { chat: ID, view: "commands", maxChars: 6000 });
  const [bash, ssh, file] = read.data.turns[0].tool_calls;
  assert.deepEqual([bash.truncated, bash.chars, bash.id], [true, charCount(callText(shell(command, output))), "call-17"]);
  assert.ok(charCount(bash.text) < 2300, "the view still shows a cut: 160 of the command, 2000 of the output");
  assert.deepEqual([ssh.truncated, ssh.text, ssh.id], [true, "mcp__proxy-mcp-prod__ssh_exec", "call-24"], "an MCP call shows its name only");
  assert.deepEqual([file.truncated, file.text], [false, "read /Users/r/app/main.go"], "a file read stays a path, by design");
  assert.match(read.text, /^Turn 1 of 1, counted from the latest, 3 tool call\(s\):\nShown in part, read_message with the id reads one whole: call-17, call-24\.\n\$ /m);
  const wholeBash = await readWhole(chat, bash.id);
  assert.equal(wholeBash.text, `$ ${command}\n${output}`, "the whole command and output, every character");
  assert.equal(wholeBash.role, "call");
  assert.ok(wholeBash.text.endsWith("<<END out>>"), "the output's end, where a test run's summary is");
  const wholeSsh = await readWhole(chat, ssh.id);
  assert.ok(wholeSsh.text.startsWith('mcp__proxy-mcp-prod__ssh_exec\ninput: {\n  "host": "srv-1"'));
  assert.ok(wholeSsh.text.endsWith(`output: ${remote}`));
  assert.equal(wholeSsh.total, charCount(callText(mcpCall(remote))));
  assert.match((await readMessageOn(chat, { chat: ID, id: file.id })).data.text, /^read \/Users\/r\/app\/main\.go$/, "never the file's content");
  for (const bad of ["call-10", "call-38", "call-9999"]) assert.match((await readMessageOn(chat, { chat: ID, id: bad })).data.missing, /^The chat has no message call-\d+\.$/, bad);
});

test("view thinking: 37 086 characters of thinking in 39 parts say they are cut; thinking_id reads all of it", async () => {
  const parts = Array.from({ length: 39 }, (_, i) => longText(i === 38 ? 37_086 - 38 * 950 - 38 * 2 : 950, `t${i}`));
  const chat = fakeChat({ items: [user("think it through"), ...parts.flatMap((p, i) => [thought(p), tool(i)]), agent("here is the plan"), user("thanks"), agent("you are welcome")] });
  const read = await readChatOn(chat, { chat: ID, view: "thinking", turn: 2, maxChars: 6000 });
  const t = read.data.turns[0];
  assert.equal(t.thinking_truncated, true);
  assert.equal(t.thinking_chars, charCount(joined(parts)));
  assert.equal(t.thinking_chars, 37_086, "the size measured on a real chat");
  assert.ok(t.omitted_thoughts > 30);
  assert.equal(t.thinking_id, "thinking-10");
  assert.match(read.text, /the agent's thinking, the notes Paseo shows the user in the chat \(\d+ earlier part\(s\) omitted\):\nCut: the turn's thinking has 37086 characters \(message_id thinking-10\); read_message reads it whole\.\n/);
  const whole = await readWhole(chat, t.thinking_id);
  assert.equal(whole.text, joined(parts), "every part, in order, as read_chat joins them");
  assert.equal(whole.role, "thinking");
  assert.match(whole.last.text, /^55611 Workspace \(seks\): idle, [^\n]+\nThe agent's thinking, turn 2 of 2 counted from the latest: \d+ of 37086 characters/);
  const none = await readChatOn(chat, { chat: ID, view: "thinking" });
  assert.equal(none.data.turns[0].thinking_id, undefined, "a turn with no thinking has nothing to read");
  assert.equal((await readMessageOn(chat, { chat: ID, id: "thinking-11" })).data.missing, "The chat has no message thinking-11.", "only a turn's start names its thinking");
});

test("view thinking of a turn longer than a page: the length is unknown there, the id still reads it whole", async () => {
  const items = [user("go"), thought("first idea")];
  for (let i = 0; i < 600; i += 1) items.push(tool(i));
  items.push(thought("last idea"), agent("done"));
  const chat = fakeChat({ items });
  const t = (await readChatOn(chat, { chat: ID, view: "thinking" })).data.turns[0];
  assert.deepEqual([t.thinking, t.thinking_chars, t.thinking_truncated], ["last idea", null, true]);
  assert.equal((await readWhole(chat, t.thinking_id)).text, "first idea\n\nlast idea");
});

test("read_activity: a subagent's 52 329-character final message is cut at 300 and its result_id reads it whole", async () => {
  const report = longText(52_329, "report");
  const deep = longText(5188, "deep");
  const subagents = [
    { id: "toolu_01TaARTVXCQjvZeqWfVXKADD", title: "general-purpose", description: "Research the read-only reminders", status: "completed", createdAt: at(1.8), updatedAt: at(1.2), items: [tool(1), tool(2), agent("halfway"), tool(3), agent(report)] },
    // Its final message is further back than read_activity looks: no result there, read_message finds it.
    { id: "toolu_016G5iV7eJsJMVEBAtNAqPnP", title: "Explore", description: "Find the call sites", status: "completed", createdAt: at(1.7), updatedAt: at(1.3), items: [tool(0), agent(deep), ...Array.from({ length: 70 }, (_, i) => tool(i + 1))] },
  ];
  // Both started in the latest turn, the one read_activity lists.
  const chat = fakeChat({ items: [user("research it"), agent("asked two subagents")], subagents });
  const activity = await readActivityOn(chat, { chat: ID });
  const [first, second] = activity.data.chats[0].subagents;
  assert.equal(first.result_truncated, true);
  assert.equal(first.result_chars, 52_329);
  assert.ok(first.result.length <= 302 && first.result.endsWith(" …"));
  assert.equal(first.result_id, "subagent-toolu_01TaARTVXCQjvZeqWfVXKADD");
  assert.deepEqual([second.result, second.result_id], [null, "subagent-toolu_016G5iV7eJsJMVEBAtNAqPnP"]);
  assert.match(activity.text, /^[^\n]+\nResults are cut here: read_message with a subagent's result_id reads its whole final message\.\n- general-purpose/);
  const whole = await readWhole(chat, first.result_id);
  assert.equal(whole.text, report);
  assert.equal(whole.role, "subagent");
  assert.match(whole.last.text, /^55611 Workspace \(seks\): idle, [^\n]+\nThe last message of subagent "general-purpose": \d+ of 52329 characters, offset \d+ to 52329\./);
  assert.equal((await readWhole(chat, second.result_id)).text, deep, "found by reading its timeline further back");
  assert.equal((await readMessageOn(chat, { chat: ID, id: "subagent-toolu_nobody" })).data.missing, "The chat has no subagent subagent-toolu_nobody.");
});

test("search_messages: the newest matches first, older ones by offset, every page of Paseo's read for the count", async () => {
  const items = [];
  for (let i = 1; i <= 250; i += 1) items.push(user(`вопрос ${i}`), agent(`ответ ${i}: голос номер ${i}`));
  const chat = fakeChat({ items });
  const first = await searchMessagesOn(chat, { chat: ID, query: "голос", limit: 30 });
  assert.equal(first.data.total_matches, 250, "both of Paseo's pages counted, not 200");
  assert.deepEqual(first.data.matches.map((m) => m.turn), [1, 2, 3, 4, 5, 6, 7, 8], "the newest, not the oldest");
  assert.deepEqual([first.data.offset, first.data.next_offset], [0, 8]);
  assert.match(first.text, /^"голос" found in 1 of 1 chat\(s\) searched; 8 of 250 matches shown, newest first:\n/);
  assert.match(first.text, /\n242 older match\(es\): search_messages with this chat and offset 8 shows them\.$/);
  const second = await searchMessagesOn(chat, { chat: ID, query: "голос", limit: 30, offset: first.data.next_offset });
  assert.deepEqual(second.data.matches.map((m) => m.turn), [9, 10, 11, 12, 13, 14, 15, 16]);
  const last = await searchMessagesOn(chat, { chat: ID, query: "голос", limit: 30, offset: 248 });
  assert.deepEqual([last.data.matches.map((m) => m.turn), last.data.next_offset], [[249, 250], null]);
  assert.doesNotMatch(last.text, /older match/);
  const past = await searchMessagesOn(chat, { chat: ID, query: "голос", offset: 900 });
  assert.equal(past.text, '"голос" has 250 match(es) in this chat, none at offset 900.');
  // The match's id reads the matched message, the newest one first.
  assert.equal((await readMessageOn(chat, { chat: ID, id: first.data.matches[0].message_id })).data.text, "ответ 250: голос номер 250");
});

test("read_approval: a plan waiting for approval comes whole, a long command too, a short one stays a line", async () => {
  const plan = `# План: напоминания только для чтения\n\n${longText(4200, "plan")}`;
  const longCommand = longText(9000, "cmd");
  // The request as Paseo's Claude provider builds it for ExitPlanMode and for a shell command.
  const permissions = [
    { id: "permission-1", provider: "claude", name: "ExitPlanMode", kind: "plan", title: "Plan", input: { plan }, metadata: { toolUseId: "toolu_plan", planText: plan } },
    { id: "permission-2", provider: "claude", name: "Bash", kind: "tool", title: "Bash", input: { command: longCommand }, detail: { type: "shell", command: longCommand } },
    { id: "permission-3", provider: "claude", name: "Bash", kind: "tool", title: "Bash", input: { command: "npm publish" }, detail: { type: "shell", command: "npm publish" } },
  ];
  const chat = fakeChat({ items: [user("plan it"), agent("here")], status: "running", permissions });
  const read = await readApprovalOn(chat, { chat: ID });
  const [planned, long, short] = read.data.requests;
  assert.equal(planned.what, "plan: План: напоминания только для чтения", "its line, as before");
  assert.deepEqual([planned.text, planned.text_chars, planned.text_truncated], [plan, charCount(plan), false], "and now the plan itself");
  assert.ok(read.text.includes(`The plan:\n${plan}\n`));
  assert.deepEqual([long.text_chars, long.text_truncated, charCount(long.text)], [9000, true, MESSAGE_PAGE]);
  assert.match(read.text, /The command \(the first 6000 of its 9000 characters; read_chat view commands gives its call's id, and read_message reads it whole\):\n/);
  assert.deepEqual([short.what, short.text], ["run: npm publish", undefined], "a line that says it all gets nothing more");
});

test("view commands: a subagent's call from an earlier turn leads to its whole final message, which read_activity no longer lists", async () => {
  const report = longText(29_274, "older");
  const id = "toolu_01HRNUgS8WW6vxHF2nVJKrUd";
  const call = { type: "tool_call", callId: id, name: "Agent", status: "completed", error: null, detail: { type: "sub_agent", subAgentType: "general-purpose", description: "Compare the reminder APIs", log: "", actions: [] } };
  const subagents = [{ id, title: "general-purpose", description: "Compare the reminder APIs", status: "completed", createdAt: at(9), updatedAt: at(8), items: [tool(1), agent(report)] }];
  const chat = fakeChat({ items: [user("compare them"), call, agent("compared"), user("thanks"), agent("ok")], subagents });
  assert.equal((await readActivityOn(chat, { chat: ID })).data.chats[0].subagents.length, 0, "only the latest turn's subagents are listed");
  const [entry] = (await readChatOn(chat, { chat: ID, view: "commands", turn: 2 })).data.turns[0].tool_calls;
  assert.equal(entry.text, `Agent general-purpose: Compare the reminder APIs (its final message: read_message subagent-${id})`);
  assert.equal(entry.result_id, `subagent-${id}`);
  assert.equal(entry.truncated, false, "the call itself is all there");
  assert.equal((await readWhole(chat, entry.result_id)).text, report);
});

test("view commands pages a long turn's earlier calls by offset, down to the subagent calls the last eight hide", async () => {
  // As on a real chat: 39 calls in the turn, four subagent calls 20 to 23 from its end.
  const report = longText(25_840, "subagent");
  const agentCall = (n) => ({ type: "tool_call", callId: `toolu_${n}`, name: "Agent", status: "completed", error: null, detail: { type: "sub_agent", subAgentType: "general-purpose", description: `Part ${n}`, log: "", actions: [] } });
  const calls = [...Array.from({ length: 16 }, (_, i) => tool(i)), agentCall(1), agentCall(2), agentCall(3), agentCall(4), ...Array.from({ length: 19 }, (_, i) => tool(100 + i))];
  const subagents = [1, 2, 3, 4].map((n) => ({ id: `toolu_${n}`, title: "general-purpose", description: `Part ${n}`, status: "completed", createdAt: at(50), updatedAt: at(40), items: [agent(n === 3 ? report : `part ${n} done`)] }));
  const chat = fakeChat({ items: [user("split it into four"), ...calls, agent("all four are back")], subagents });
  const seen = [];
  let offset;
  let pages = 0;
  do {
    const read = await readChatOn(chat, { chat: ID, view: "commands", ...(offset === undefined ? {} : { offset }) });
    const t = read.data.turns[0];
    seen.unshift(...t.tool_calls);
    if (pages === 0) {
      assert.deepEqual([t.total_tool_calls, t.tool_calls.length, t.offset, t.next_offset], [39, 8, 0, 8]);
      assert.match(read.text, /the last 8 of 39 tool calls:\n31 earlier call\(s\): read_chat with view commands, turn 1 and offset 8 shows them\.\n/);
    }
    if (pages === 1) assert.match(read.text, /tool calls 24-31 of 39:\n23 earlier call\(s\): read_chat with view commands, turn 1 and offset 16 shows them\.\n/);
    offset = t.next_offset;
    pages += 1;
  } while (offset !== null && pages < 10);
  assert.equal(pages, 5, "39 calls, 8 at a time");
  assert.deepEqual(seen.map((c) => c.name), calls.map((c) => c.name), "every call once, in order");
  const third = seen.find((c) => c.result_id === "subagent-toolu_3");
  assert.equal((await readWhole(chat, third.result_id)).text, report);
  const past = await readChatOn(chat, { chat: ID, view: "commands", offset: 100 });
  assert.match(past.text, /39 tool call\(s\), none at offset 100:$/m);
});

// ---- signals a model needs to find the right turn and to stop reading --------------------------

test("every turn of the text view says whether it has thinking and tool calls, and where to read them", async () => {
  const thoughts = [longText(9000, "why"), longText(4447, "so")];
  const chat = fakeChat({ items: [user("where to keep reminders?"), thought(thoughts[0]), tool(1), thought(thoughts[1]), tool(2), agent("A local database."), user("ok"), agent("ok")] });
  const one = await readChatOn(chat, { chat: ID, turn: 2 });
  const [t] = one.data.turns;
  assert.deepEqual([t.total_tool_calls, t.thinking_id, t.thinking_chars], [2, "thinking-10", charCount(joined(thoughts))]);
  assert.match(one.text, /\nThis turn also has the agent's thinking, shown to the user in Paseo \(13449 characters; read_chat view thinking turn 2\) and 2 tool call\(s\) \(view commands\)\.$/);
  assert.equal((await readWhole(chat, t.thinking_id)).text, joined(thoughts), "the id in the text view reads the thinking whole");
  const both = await readChatOn(chat, { chat: ID, turns: 2 });
  assert.match(both.text, /\n {2}This turn also has the agent's thinking, shown to the user in Paseo \(13449 characters; read_chat view thinking turn 2\) and 2 tool call\(s\) \(view commands\)\.\n- Turn 1/);
  assert.deepEqual([both.data.turns[1].total_tool_calls, both.data.turns[1].thinking_id], [0, undefined], "a plain turn says nothing more");
  assert.doesNotMatch((await readChatOn(chat, { chat: ID })).text, /also has/);
});

test("read_chat says which turn comes before the ones read, so a long chat is read back to its start", async () => {
  const items = [];
  for (let i = 1; i <= 23; i += 1) items.push(user(`question ${i}`), agent(`answer ${i}`));
  const chat = fakeChat({ items });
  const seen = [];
  let turn = 1;
  let calls = 0;
  while (turn !== null && calls < 5) {
    const read = await readChatOn(chat, { chat: ID, turn, turns: 10 });
    seen.push(...read.data.turns.map((t) => t.turn));
    if (read.data.next_turn) assert.match(read.text, new RegExp(`\\n${23 - read.data.next_turn + 1} earlier turn\\(s\\): read_chat with turn ${read.data.next_turn} reads on\\.$`));
    else assert.doesNotMatch(read.text, /earlier turn/);
    turn = read.data.next_turn;
    calls += 1;
  }
  assert.equal(calls, 3);
  assert.deepEqual([...seen].sort((a, b) => a - b), Array.from({ length: 23 }, (_, i) => i + 1), "every turn once");
  const single = await readChatOn(chat, { chat: ID });
  assert.equal(single.data.next_turn, 2);
  assert.doesNotMatch(single.text, /earlier turn/, "one turn read: no line about the rest");
});

test("view thinking of a turn without any names the turns that have it, as the failed run needed", async () => {
  // As in the run that gave up: the latest turn has no thinking, the decision was made turns earlier.
  const reasoning = longText(13_447, "decision");
  const items = [user("sources?"), agent("three"), user("where to keep reminders?"), thought(reasoning), agent("A local database."), user("tests"), tool(1), agent("ran them"), user("thanks"), agent("welcome")];
  const chat = fakeChat({ items });
  const latest = await readChatOn(chat, { chat: ID, view: "thinking" });
  assert.equal(latest.data.turns[0].thinking, "");
  assert.deepEqual(latest.data.thinking_elsewhere, { turns: [{ turn: 3, prompt: "where to keep reminders?", thinking_chars: 13_447, thinking_id: "thinking-24" }], looked: 4, all: true });
  // What the user asked there tells the model which turn the question is about.
  assert.match(latest.text, /Turn 1 of 4, counted from the latest: no thinking in this turn\.\nTurns with thinking: turn 3, asked "where to keep reminders\?" \(13447 characters\)\. Read the one the question is about: read_chat view thinking with its turn shows its latest part, where the conclusion is; read_message with its thinking_id reads all of it, from the start\.$/);
  assert.equal((await readWhole(chat, "thinking-24")).text, reasoning);
  const none = await readChatOn(fakeChat({ items: [user("hi"), agent("hello"), user("bye"), agent("bye")] }), { chat: ID, view: "thinking" });
  assert.match(none.text, /no thinking in this turn\.\nNo other turn has thinking either\.$/);
  assert.equal((await readChatOn(chat, { chat: ID, view: "thinking", turn: 3 })).data.thinking_elsewhere, undefined, "a turn that has it reads as before");
});

test("view thinking in a long chat says how far back it looked", async () => {
  const items = [user("old question"), thought("old thinking"), agent("old answer")];
  for (let i = 0; i < 450; i += 1) items.push(user(`q${i}`), agent(`a${i}`));
  const chat = fakeChat({ items });
  const latest = await readChatOn(chat, { chat: ID, view: "thinking" });
  assert.equal(latest.data.thinking_elsewhere.all, false);
  assert.equal(latest.data.thinking_elsewhere.turns.length, 0);
  assert.match(latest.text, new RegExp(`No other turn has thinking either among the latest ${latest.data.thinking_elsewhere.looked}; turns before the latest ${latest.data.thinking_elsewhere.looked} were not looked at: view thinking with turn ${latest.data.thinking_elsewhere.looked + 1} and turns 10 looks further back\\.$`));
});

test("a budget or a limit above what is used is taken and cut to it, not refused", async () => {
  const chat = reportedChat();
  const big = await readChatOn(chat, { chat: ID, turn: 3, maxChars: 20_000 });
  const page = await readChatOn(chat, { chat: ID, turn: 3, maxChars: 6000 });
  assert.equal(big.data.turns[0].agent_text, page.data.turns[0].agent_text, "6000 at most, as the description says");
  assert.equal(big.data.turns[0].agent_text_truncated, true);
  const items = [];
  for (let i = 1; i <= 50; i += 1) items.push(user(`q ${i}`), agent(`голос ${i}`));
  const found = await searchMessagesOn(fakeChat({ items }), { chat: ID, query: "голос", limit: 100 });
  assert.deepEqual([found.data.matches.length, found.data.next_offset, found.data.total_matches], [8, 8, 50]);
});

test("view thinking over several turns names only the other turns with thinking, never one it just showed", async () => {
  const items = [user("first"), thought("early idea"), agent("ok"), user("second"), thought("middle idea"), agent("ok"), user("third"), agent("ok")];
  const chat = fakeChat({ items });
  const read = await readChatOn(chat, { chat: ID, view: "thinking", turns: 2 });
  assert.deepEqual(read.data.turns.map((t) => [t.turn, t.thinking]), [[2, "middle idea"], [1, ""]]);
  assert.deepEqual(read.data.thinking_elsewhere.turns.map((t) => [t.turn, t.prompt]), [[3, "first"]], "turn 2 was just shown");
});
