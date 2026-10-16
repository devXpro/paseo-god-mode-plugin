// Run with: node --test core/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { createMcpHandler, readConfig, TOOLS } from "./mcp.mjs";
import { PaseoOffline } from "./paseo.mjs";
import { BUILD } from "./build.mjs";
import { VERSION } from "./version.mjs";
import { chatData } from "./text.mjs";

const SECRET = "https://app.paseo.sh/#offer=secret-offer";

const sampleChat = chatData(
  {
    id: "a22524fe-055b-44b8-a9b6-82c9910d7e21",
    title: "Fleet map",
    project: "proxy",
    workspace: "Fleet map D",
    status: "running",
    attention: null,
    permissions: [],
    updatedAt: "2026-10-16T16:36:24.043Z",
    createdAt: "2026-10-16T14:40:52.697Z",
    archived: false,
  },
  Date.parse("2026-10-16T16:40:00Z"),
);

function fakeOps(overrides = {}) {
  const calls = [];
  const op = (name) => async (url, args) => {
    calls.push({ name, url, args });
    return overrides[name] ? overrides[name](args) : { text: `${name} ok`, data: { echo: name } };
  };
  const ops = Object.fromEntries(
    ["overview", "listChats", "readChat", "readActivity", "searchMessages", "startChat", "sendMessage", "answerApproval", "stopChat", "releaseStatus", "releaseStart"].map((n) => [n, op(n)]),
  );
  return { ops, calls };
}

function fakeLog() {
  const rows = [];
  return {
    rows,
    async record(entry) {
      rows.push(entry);
    },
    async recent() {
      return `${rows.length} row(s)`;
    },
  };
}

const rpc = (method, params) => ({ jsonrpc: "2.0", id: 1, method, params });
const call = (name, args) => rpc("tools/call", { name, arguments: args });
const configured = (env = {}) => readConfig({ PASEO_PAIRING_URL: SECRET, ...env });

// Enough JSON Schema to check our own outputs: type (incl. arrays of types),
// properties, required, items, enum.
function validate(schema, value, path = "$") {
  const errors = [];
  const types = [].concat(schema.type ?? []);
  const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
  if (types.length && !types.some((t) => t === typeOf(value) || (t === "number" && typeof value === "number"))) {
    return [`${path}: expected ${types.join("|")}, got ${typeOf(value)}`];
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: ${value} not in enum`);
  if (typeOf(value) === "object") {
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${path}.${key}: missing`);
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (value[key] !== undefined) errors.push(...validate(sub, value[key], `${path}.${key}`));
    }
  }
  if (typeOf(value) === "array" && schema.items) value.forEach((v, i) => errors.push(...validate(schema.items, v, `${path}[${i}]`)));
  return errors;
}

const schemaOf = (name) => TOOLS.find((t) => t.name === name).outputSchema;

test("readConfig: defaults, flags and clamping", () => {
  const config = readConfig({ PASEO_PAIRING_URL: SECRET, PASEO_WAIT_SECONDS: "90", PASEO_CONFIRM_RISKY: "off", PASEO_NEW_CHAT_MODE: "nonsense" });
  assert.equal(config.waitSeconds, 25);
  assert.equal(config.confirmRisky, false);
  assert.equal(config.log, true);
  assert.equal(config.mode, undefined);
  assert.equal(readConfig({}).waitSeconds, 15);
  assert.equal(readConfig({ PASEO_NEW_CHAT_MODE: "bypassPermissions" }).mode, "bypassPermissions");
});

test("instructions follow the language and the confirmation setting, and route each request to one call", async () => {
  const { ops } = fakeOps();
  const ru = await createMcpHandler({ config: readConfig({ PASEO_LANGUAGE: "ru" }), ops })(rpc("initialize"));
  const text = ru.result.instructions;
  assert.match(text, /^Paseo runs the user's coding agents \(Claude, Codex…\)/);
  assert.match(text, /Speak to the user in Russian/);
  assert.match(text, /по SEO/);
  assert.match(text, /subagents are doing now → read_activity/);
  assert.match(text, /where something was said → search_messages/);
  assert.match(text, /call them only when the user explicitly tells you to act now/);
  assert.match(text, /"ok" or "fine" after a draft you did not ask about/);
  assert.match(text, /never send it again unless the user says to send it again/);
  assert.match(text, /busy = not delivered/);
  assert.match(text, /a plain "send it" means add it \(if_busy steer\)/);
  assert.match(text, /do not poll/);
  assert.match(text, /never read ids, hashes or links aloud/);
  assert.match(text, /must have heard exactly what will happen and said yes/);
  const plain = await createMcpHandler({ config: readConfig({ PASEO_CONFIRM_RISKY: "off" }), ops })(rpc("server/discover"));
  assert.match(plain.result.instructions, /Answer in the user's language/);
  assert.doesNotMatch(plain.result.instructions, /по SEO/);
  assert.match(plain.result.instructions, /no read-back needed/);
  const marker = "→ search_messages.";
  const routingEnd = text.indexOf(marker) + marker.length;
  assert.ok(routingEnd > marker.length && routingEnd <= 512, `the routing sits in the first 512 characters (ends at ${routingEnd})`);
});

test("the server version changes with anything the model reads", async () => {
  const ops = fakeOps().ops;
  const en = (await createMcpHandler({ config: readConfig({}), ops })(rpc("initialize"))).result.serverInfo.version;
  const ru = (await createMcpHandler({ config: readConfig({ PASEO_LANGUAGE: "ru" }), ops })(rpc("initialize"))).result.serverInfo.version;
  const again = (await createMcpHandler({ config: readConfig({}), ops })(rpc("server/discover"))).result.serverInfo.version;
  assert.match(en, new RegExp(`^${VERSION.replaceAll(".", "\\.")}\\+[0-9a-f]{8}$`));
  assert.notEqual(en, ru, "instructions differ, so the version does");
  assert.equal(en, again, "stable for the same metadata");
});

test("initialize negotiates the protocol version", async () => {
  const handle = createMcpHandler({ config: readConfig({}), ops: fakeOps().ops });
  assert.equal((await handle(rpc("initialize", { protocolVersion: "2025-11-25" }))).result.protocolVersion, "2025-11-25");
  assert.equal((await handle(rpc("initialize", { protocolVersion: "1999-01-01" }))).result.protocolVersion, "2025-06-18");
});

test("tools/list exposes twelve tools, output schemas and honest annotations", async () => {
  const { result } = await createMcpHandler({ config: readConfig({}), ops: fakeOps().ops })(rpc("tools/list"));
  assert.deepEqual(
    result.tools.map((t) => t.name),
    ["overview", "list_chats", "read_chat", "read_activity", "search_messages", "start_chat", "send_message", "answer_approval", "stop_chat", "update_status", "update_site", "get_logs"],
  );
  for (const tool of result.tools) {
    assert.equal(Boolean(tool.outputSchema), tool.name !== "get_logs", `${tool.name} outputSchema`);
  }
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
  assert.equal(byName.read_chat.annotations.readOnlyHint, true);
  assert.equal(byName.read_activity.annotations.readOnlyHint, true);
  assert.equal(byName.search_messages.annotations.readOnlyHint, true);
  assert.equal(byName.send_message.annotations.readOnlyHint, false);
  assert.equal(byName.stop_chat.annotations.destructiveHint, true);
  assert.equal(byName.update_status.annotations.readOnlyHint, true);
  assert.equal(byName.update_site.annotations.destructiveHint, true);
  assert.match(byName.update_site.description, /wait for the user's yes before calling/);
  assert.ok(TOOLS.every((t) => t.annotations.openWorldHint === false));
  assert.match(byName.read_chat.description, /turns=5/);
  assert.match(byName.search_messages.description, /Do not read chats one by one/);
  assert.deepEqual(byName.read_chat.inputSchema.properties.view.enum, ["text", "commands"]);
  assert.equal(byName.read_chat.inputSchema.properties.query, undefined);
  assert.equal(byName.read_activity.inputSchema.required, undefined, "read_activity works without a chat");
});

test("the call rules are repeated where ChatGPT picks the tool", () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
  assert.match(byName.list_chats.description, /^Use this only to find chats/);
  assert.match(byName.list_chats.description, /If you already have the chat, skip this/);
  assert.match(byName.overview.description, /do not list chats afterwards/);
  assert.match(byName.read_chat.description, /never turn by turn/);
  assert.match(byName.read_chat.description, /use read_activity/);
  assert.match(byName.read_activity.description, /Leave chat empty to cover every chat/);
  assert.match(byName.search_messages.description, /pass chat to search a single chat/);
  for (const tool of ["read_chat", "read_activity", "send_message", "answer_approval", "stop_chat"]) {
    assert.match(byName[tool].inputSchema.properties.chat.description, /Ids are for calls only/, tool);
    assert.match(byName[tool].inputSchema.properties.chat.description, /Keep the chat being discussed/, tool);
  }
  // Write tools: only on an explicit command, the outcome is the truth, no duplicates, no polling.
  assert.match(byName.send_message.description, /only when the user explicitly tells you to send it now/);
  assert.match(byName.send_message.description, /ask "Send it\?" first/);
  assert.match(byName.send_message.description, /busy = NOT delivered/);
  assert.match(byName.send_message.description, /never send it again unless the user says to send it again/);
  assert.match(byName.send_message.description, /never say it was sent/);
  assert.match(byName.send_message.inputSchema.properties.if_busy.description, /a plain "send it"/);
  assert.match(byName.start_chat.description, /explicitly tells you to start one now/);
  assert.match(byName.start_chat.description, /never start the same task twice/);
  assert.match(byName.start_chat.description, /do not poll/);
  assert.match(byName.answer_approval.description, /wait for their yes first/);
  assert.match(byName.answer_approval.description, /use send_message/);
  assert.match(byName.stop_chat.description, /wait for their yes/);
  assert.match(byName.update_site.description, /after one update_status call/);
  assert.match(byName.update_site.description, /update the God Mode plugin in Paseo first/);
});

test("without the secret, tools refuse except get_logs", async () => {
  const { ops, calls } = fakeOps();
  const handle = createMcpHandler({ config: readConfig({}), ops, log: fakeLog() });
  const refused = await handle(call("overview", {}));
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /PASEO_PAIRING_URL/);
  assert.equal(calls.length, 0);
  assert.equal((await handle(call("get_logs", {}))).result.isError, undefined);
});

test("structured data travels as structuredContent next to the text", async () => {
  const response = await createMcpHandler({ config: configured(), ops: fakeOps().ops })(call("list_chats", {}));
  assert.equal(response.result.content[0].text, "listChats ok");
  assert.deepEqual(response.result.structuredContent, { echo: "listChats" });
});

test("operations that still return a plain string keep working", async () => {
  const { ops } = fakeOps({ overview: () => "plain text" });
  const response = await createMcpHandler({ config: configured(), ops })(call("overview", {}));
  assert.equal(response.result.content[0].text, "plain text");
  assert.equal(response.result.structuredContent, undefined);
});

test("read_chat, read_activity, list_chats and search_messages pass their arguments through", async () => {
  const { ops, calls } = fakeOps();
  const handle = createMcpHandler({ config: configured(), ops });
  await handle(call("read_chat", { chat: "#a22524f", turns: 5, max_chars: 3000 }));
  assert.deepEqual(calls.at(-1).args, { chat: "#a22524f", view: "text", turn: 1, turns: 5, maxChars: 3000 });
  await handle(call("read_chat", { chat: "fleet" }));
  assert.equal(calls.at(-1).args.turns, 1, "one turn stays the default");
  const before = calls.length;
  for (const view of ["turns", "search"]) assert.equal((await handle(call("read_chat", { chat: "fleet", view }))).error.code, -32602, view);
  assert.equal(calls.length, before, "removed views run nothing");
  await handle(call("read_activity", {}));
  assert.deepEqual(calls.at(-1), { name: "readActivity", url: SECRET, args: { chat: undefined, maxChars: undefined } });
  await handle(call("read_activity", { chat: "fleet", max_chars: 900 }));
  assert.deepEqual(calls.at(-1).args, { chat: "fleet", maxChars: 900 });
  await handle(call("list_chats", { query: "DNSSEC", include_archived: true }));
  assert.deepEqual(calls.at(-1).args, { project: undefined, status: undefined, query: "DNSSEC", includeArchived: true, limit: 10 });
  await handle(call("search_messages", { query: "dataviz", project: "proxy", scan: 30 }));
  assert.deepEqual(calls.at(-1).args, { query: "dataviz", project: "proxy", chat: undefined, includeArchived: false, scan: 30, limit: 10 });
});

test("start_chat fills unset options from the site settings", async () => {
  const { ops, calls } = fakeOps();
  const config = configured({ PASEO_NEW_CHAT_MODEL: "claude-sonnet-5-5", PASEO_NEW_CHAT_MODE: "bypassPermissions", PASEO_WAIT_SECONDS: "10" });
  await createMcpHandler({ config, ops })(call("start_chat", { project: "proxy", prompt: "run tests", mode: "plan" }));
  assert.deepEqual(calls[0].args, { project: "proxy", prompt: "run tests", model: "claude-sonnet-5-5", thinking: undefined, mode: "plan", waitSeconds: 10 });
  assert.equal(calls[0].url, SECRET);
});

test("missing required arguments are a JSON-RPC error and nothing runs", async () => {
  const { ops, calls } = fakeOps();
  const handle = createMcpHandler({ config: configured(), ops });
  assert.equal((await handle(call("send_message", { chat: "x" }))).error.code, -32602);
  assert.equal((await handle(call("search_messages", {}))).error.code, -32602);
  assert.equal(calls.length, 0);
});

test("a tool from an outdated tool list gets a way out, not a bare error", async () => {
  const log = fakeLog();
  const response = await createMcpHandler({ config: configured(), ops: fakeOps().ops, log })(call("list_projects", {}));
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /outdated tool list/);
  assert.match(response.result.content[0].text, /start a new chat/);
  assert.match(response.result.content[0].text, /search_messages/);
  assert.equal(log.rows[0].tool, "list_projects");
});

test("a failed write never reads as done", async () => {
  const { ops } = fakeOps({
    sendMessage: () => {
      throw new Error("no answer within 45 s");
    },
    stopChat: () => {
      throw new PaseoOffline("connect timed out");
    },
    readChat: () => {
      throw new Error("relay closed");
    },
  });
  const handle = createMcpHandler({ config: configured(), ops });
  assert.match((await handle(call("send_message", { chat: "x", text: "go" }))).result.content[0].text, /Unknown whether it took effect: never say it did\./);
  assert.match((await handle(call("stop_chat", { chat: "x" }))).result.content[0].text, /Nothing was sent\./);
  assert.doesNotMatch((await handle(call("read_chat", { chat: "x" }))).result.content[0].text, /took effect/);
});

test("an offline daemon becomes one sentence, logged with the detail, never the secret", async () => {
  const { ops } = fakeOps({
    overview: () => {
      throw new PaseoOffline(`connect failed for ${SECRET}`);
    },
  });
  const log = fakeLog();
  const response = await createMcpHandler({ config: configured(), ops, log })(call("overview", {}));
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /Paseo is offline/);
  assert.equal(log.rows.length, 1);
  assert.equal(log.rows[0].ok, false);
  assert.ok(!JSON.stringify(response).includes(SECRET));
  assert.ok(!JSON.stringify(log.rows).includes(SECRET));
});

test("long arguments are cut before they reach the log", async () => {
  const log = fakeLog();
  await createMcpHandler({ config: configured(), ops: fakeOps().ops, log })(call("send_message", { chat: "#a22524f", text: "x".repeat(2000) }));
  assert.ok(log.rows[0].args.length < 400);
  assert.equal(log.rows[0].ok, true);
});

test("notifications get no body", async () => {
  assert.equal(await createMcpHandler({ config: readConfig({}), ops: fakeOps().ops })({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
});

test("the shapes the operations produce match the declared output schemas", () => {
  const clarification = { needs_clarification: { kind: "chat", query: "fleet", candidates: [sampleChat] } };
  const cases = [
    ["overview", { summary: "1 running", hours: 12, waiting: [], running: [{ ...sampleChat, subagents_running: 2 }], new: [], projects: [{ name: "proxy", chats: 3 }] }],
    ["list_chats", { scope: "proxy", query: null, include_archived: false, total: 1, chats: [sampleChat] }],
    ["list_chats", clarification],
    [
      "read_chat",
      {
        chat: sampleChat,
        total_turns: 4,
        turns: [{ turn: 2, position: 3, started_at: "2026-10-16T15:48:00.160Z", ended_at: null, user_text: "go", agent_text: "done", omitted_messages: 0, errors: [] }],
      },
    ],
    ["read_chat", { chat: sampleChat, total_turns: 4, turns: [{ turn: 1, position: 4, started_at: null, total_tool_calls: 2, tool_calls: [{ kind: "shell", name: "Bash", status: "completed", text: "$ ls" }] }] }],
    ["read_chat", { chat: sampleChat, note: '"proxy" matches 2 chats; this is the only active one.', total_turns: 1, turns: [] }],
    [
      "read_activity",
      {
        summary: "1 chat(s) working, 1 subagent(s) running.",
        chats: [
          {
            chat: { ...sampleChat, subagents_running: 1 },
            working: true,
            turn_started_at: "2026-10-16T16:30:00.000Z",
            turn_elapsed: "10 min",
            current_step: "waiting for 1 subagent(s)",
            subagents_running: 1,
            subagents_done: 1,
            subagents: [
              { id: "toolu_1", title: "Explore", task: "Find call sites", status: "running", started_at: "2026-10-16T16:31:00.000Z", updated_at: "2026-10-16T16:39:00.000Z", elapsed: "9 min", current_step: "reading session.ts", result: null, tokens: "52.4k" },
              { id: "toolu_2", title: "Explore", task: "Map routes", status: "completed", started_at: null, updated_at: null, elapsed: "3 min", current_step: null, result: "14 routes", tokens: null },
            ],
          },
        ],
      },
    ],
    ["read_activity", { summary: "Nothing is working right now.", chats: [] }],
    [
      "search_messages",
      {
        query: "x",
        searched_chats: 20,
        matched_chats: 1,
        total_matches: 1,
        matches: [{ chat: { id: sampleChat.id, short_id: "a22524f", title: "Fleet map", project: "proxy", updated_at: sampleChat.updated_at, archived: false }, turn: 2, role: "user", at: null, snippet: "x" }],
      },
    ],
    ["start_chat", { chat_id: sampleChat.id, short_id: "a22524f", project: "proxy", outcome: "replied", reply: "pong" }],
    ["send_message", { chat_id: sampleChat.id, short_id: "a22524f", outcome: "busy" }],
    ["answer_approval", { chat_id: sampleChat.id, done: false, what: null }],
    ["stop_chat", { chat_id: sampleChat.id, done: true }],
    ["update_status", { site_version: "0.1.0", build: "v0.1.0-2-gabc1234", installed_version: "0.1.1", update_available: true, latest_release: "0.2.0", latest_is_newer: true, live_release: 7, mac_online: true, job: { action: "update", state: "running", step: "Publishing", started_at: "2026-10-16T19:00:00.000Z", finished_at: null, message: null, error: null } }],
    ["update_status", { site_version: "0.1.0", build: null, installed_version: null, update_available: null, latest_release: null, latest_is_newer: null, live_release: null, mac_online: false }],
    ["update_site", { started: true, action: "update", job_id: "j1", message: "update started" }],
  ];
  for (const [tool, data] of cases) {
    assert.deepEqual(validate(schemaOf(tool), data), [], tool);
  }
  assert.notDeepEqual(validate(schemaOf("start_chat"), { outcome: "maybe" }), [], "the validator does catch a bad value");
});

test("update_site runs only for a signed-in ChatGPT user, with a known action", async () => {
  const { ops, calls } = fakeOps();
  const anonymous = createMcpHandler({ config: configured(), ops });
  const refused = await anonymous(call("update_site", { action: "update" }));
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /signed-in ChatGPT user/);
  const signedIn = createMcpHandler({ config: configured(), ops, caller: { identified: true } });
  assert.equal((await signedIn(call("update_site", { action: "deploy-anything" }))).error.code, -32602);
  await signedIn(call("update_site", { action: "rollback" }));
  assert.deepEqual(calls.map((c) => [c.name, c.args]), [["releaseStart", { action: "rollback" }]]);
});

test("update_status asks the Mac with the version this Site is built from", async () => {
  const { ops, calls } = fakeOps();
  await createMcpHandler({ config: configured(), ops })(call("update_status", {}));
  assert.equal(calls[0].name, "releaseStatus");
  assert.deepEqual(calls[0].args, { siteVersion: VERSION, build: BUILD.source });
});

test("no tool declares a nullable object, which ChatGPT may refuse in a tool list", () => {
  const walk = (schema, path) => {
    if (!schema || typeof schema !== "object") return [];
    const own = Array.isArray(schema.type) && schema.type.includes("object") ? [path] : [];
    return [...own, ...Object.entries(schema.properties ?? {}).flatMap(([k, v]) => walk(v, `${path}.${k}`)), ...walk(schema.items, `${path}[]`)];
  };
  const offenders = TOOLS.flatMap((t) => [...walk(t.inputSchema, `${t.name}.in`), ...walk(t.outputSchema, `${t.name}.out`)]);
  assert.deepEqual(offenders, []);
});
