// Run with: node --test core/
// Plugins that describe themselves through meta.describe, against a made-up plugin and a fake
// daemon client: the point is that nothing in God Mode knows any real plugin. No network.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonical,
  checkConfirmation,
  confirmationText,
  CONFIRMATION_TTL_MS,
  issueConfirmation,
  parseCapabilities,
  pickOperation,
  pickPlugin,
  prepareArgs,
  projectResult,
  signature,
  judgeOutcome,
  targetFacts,
  UNTRUSTED_NOTE,
} from "./capabilities.mjs";
import { pluginActionOn, pluginReadOn } from "./paseo.mjs";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const SECRET = "https://app.paseo.sh/#offer=secret-offer";

const LEVEL = { anyOf: [{ type: "number", const: 10 }, { type: "number", const: 50 }, { type: "number", const: 100 }] };

function lamp() {
  return {
    schema: "paseo.capabilities/1",
    title: "Desk lamp",
    summary: "The lamp on the desk.",
    aliases: ["light", "лампа"],
    operations: [
      { id: "state", kind: "read", method: "lamp.get", title: "Lamp state", description: "On or off, and how bright.", input: { type: "object", properties: {} }, default: true, output: { fields: ["on", "level"] } },
      { id: "history", kind: "read", method: "lamp.history", title: "When it was switched", input: { type: "object", properties: { days: { type: "integer", minimum: 1, maximum: 7 } } } },
      { id: "dim", kind: "action", method: "lamp.set", fixed: { mode: "level" }, title: "Dim the lamp", input: { type: "object", properties: { level: LEVEL }, required: ["level"] }, risk: "low", confirm: "none", output: { fields: ["on", "level"] } },
      { id: "off", kind: "action", method: "lamp.set", fixed: { mode: "off" }, title: "Turn the lamp off", input: { type: "object", properties: {} }, risk: "disruptive", confirm: "none", confirmText: "Turn the lamp off: the room goes dark." },
    ],
  };
}

// Answers listPlugins and invokePluginRpc the way the daemon does, and records every RPC.
function fakeClient(plugins) {
  const calls = [];
  return {
    calls,
    async listPlugins() {
      return plugins.map(({ id, name, status = "running" }) => ({ id, name, status, enabled: true, path: `/plugins/${id}` }));
    },
    async invokePluginRpc(pluginId, method, input) {
      calls.push([pluginId, method, input]);
      const plugin = plugins.find((p) => p.id === pluginId);
      const handler = plugin?.rpc?.[method];
      if (!handler) throw new Error(`Request failed: Plugin ${pluginId} does not contribute RPC ${method} requestType=plugin.rpc.invoke.request code=handler_error`);
      return handler(input);
    },
  };
}

const installed = () => [
  {
    id: "lamp",
    rpc: {
      "meta.describe": () => lamp(),
      "lamp.get": () => ({ on: true, level: 50, token: "s3cr3t", wiring: "internal" }),
      "lamp.history": (input) => ({ last: "today", days: input.days }),
      "lamp.set": (input) => ({ on: input.mode !== "off", level: input.level ?? 0, token: "s3cr3t" }),
    },
  },
  { id: "voice", rpc: { "voice.status": () => ({}) } },
  { id: "notes", status: "failed", rpc: {} },
];

const described = () => parseCapabilities(lamp()).capabilities;

test("a description is checked, broken operations are dropped one by one, and risk decides confirmation", () => {
  const raw = lamp();
  raw.operations.push(
    { id: "Bad Id", kind: "read", method: "lamp.get", title: "x" },
    { id: "describe", kind: "read", method: "meta.describe", title: "Itself" },
    { id: "clash", kind: "action", method: "lamp.set", fixed: { mode: "on" }, title: "Clash", input: { type: "object", properties: { mode: {} } } },
    { id: "dim", kind: "action", method: "lamp.set", title: "Again" },
    { id: "unknown_risk", kind: "action", method: "lamp.set", title: "Who knows" },
  );
  const { capabilities } = parseCapabilities(raw);
  assert.deepEqual(capabilities.operations.map((op) => op.id), ["state", "history", "dim", "off", "unknown_risk"]);
  assert.deepEqual(capabilities.skipped.map((s) => s.id), ["Bad Id", "describe", "clash", "dim"]);
  const byId = Object.fromEntries(capabilities.operations.map((op) => [op.id, op]));
  assert.equal(byId.dim.confirm, "none", "low risk may skip asking");
  assert.equal(byId.off.confirm, "always", "anything above low asks first, whatever it says");
  assert.equal(byId.unknown_risk.risk, "destructive", "no risk reads as the worst");
  assert.equal(byId.unknown_risk.confirm, "always");
  assert.deepEqual(parseCapabilities({ ...lamp(), schema: "something/2" }), { invalid: "not paseo.capabilities/1" });
  assert.deepEqual(parseCapabilities({ ...lamp(), operations: [{ id: "x" }] }), { invalid: "no usable operations" });
  assert.deepEqual(parseCapabilities("nope"), { invalid: "not paseo.capabilities/1" });
});

test("plugins are found by id, title, alias or a spoken word; operations by id or title", () => {
  const entries = [
    { id: "lamp", name: "lamp", capabilities: described() },
    { id: "voice", name: "voice", capabilities: null },
  ];
  assert.equal(pickPlugin(entries, "lamp").match.id, "lamp");
  assert.equal(pickPlugin(entries, "Desk lamp").match.id, "lamp");
  assert.equal(pickPlugin(entries, "лампа").match.id, "lamp");
  assert.equal(pickPlugin(entries, "the desk light").match.id, "lamp");
  assert.equal(pickPlugin(entries, "toaster").match, undefined);
  const caps = described();
  assert.equal(pickOperation(caps, undefined, "read").match.id, "state", "no operation = the main read");
  assert.equal(pickOperation(caps, "history", "read").match.id, "history");
  assert.equal(pickOperation(caps, "dim", "action").match.id, "dim");
  assert.equal(pickOperation(caps, "turn the lamp off", "action").match.id, "off");
  assert.equal(pickOperation(caps, "dim", "read").wrongKind.id, "dim");
  assert.deepEqual(pickOperation(caps, undefined, "action").candidates.map((op) => op.id), ["dim", "off"]);
});

test("arguments: fixed ones are the plugin's, unknown ones and wrong values are refused with what it takes", () => {
  const byId = Object.fromEntries(described().operations.map((op) => [op.id, op]));
  assert.deepEqual(prepareArgs(byId.dim, { level: 10 }), { args: { level: 10, mode: "level" } });
  assert.deepEqual(prepareArgs(byId.dim, { level: 10, mode: "level" }), { args: { level: 10, mode: "level" } }, "repeating a fixed value is harmless");
  assert.match(prepareArgs(byId.dim, { level: 10, mode: "off" }).invalid, /mode is fixed to "level"/);
  assert.match(prepareArgs(byId.dim, { level: 30 }).invalid, /args\.level must be 10 \| 50 \| 100/);
  assert.match(prepareArgs(byId.dim, {}).invalid, /args\.level is required/);
  assert.match(prepareArgs(byId.dim, { level: 10, colour: "red" }).invalid, /colour: not an argument of dim; it takes level: 10 \| 50 \| 100 \(required\)/);
  assert.match(prepareArgs(byId.history, { days: 30 }).invalid, /at most 7/);
  assert.match(prepareArgs(byId.history, { days: 1.5 }).invalid, /must be integer/);
  assert.match(prepareArgs(byId.dim, "bright").invalid, /args must be an object/);
  assert.equal(signature(byId.off), "no arguments");
});

test("results keep the fields the plugin marked, never a secret, and are always an object", () => {
  const byId = Object.fromEntries(described().operations.map((op) => [op.id, op]));
  assert.deepEqual(projectResult(byId.state, { on: true, level: 50, wiring: "x" }), { on: true, level: 50 });
  assert.deepEqual(projectResult(byId.history, { last: "today", apiKey: "k", nested: { password: "p", ok: 1 } }), { last: "today", apiKey: "[redacted]", nested: { password: "[redacted]", ok: 1 } });
  assert.deepEqual(projectResult(byId.history, ["a", "b"]), { value: ["a", "b"] });
  assert.deepEqual(projectResult(byId.history, undefined), { value: null });
});

test("a confirmation is bound to the exact arguments and lasts two minutes", async () => {
  const subject = { plugin: "lamp", operation: "off", method: "lamp.set", args: { mode: "off" } };
  const { token, expiresAt } = await issueConfirmation(SECRET, subject, NOW);
  assert.equal(expiresAt, new Date(NOW + CONFIRMATION_TTL_MS).toISOString());
  assert.equal(await checkConfirmation(SECRET, token, subject, NOW + 1_000), "ok");
  assert.equal(await checkConfirmation(SECRET, token, { ...subject, args: { mode: "on" } }, NOW), "mismatch");
  assert.equal(await checkConfirmation(SECRET, token, { ...subject, plugin: "other" }, NOW), "mismatch");
  assert.equal(await checkConfirmation("another-secret", token, subject, NOW), "mismatch");
  assert.equal(await checkConfirmation(SECRET, token, subject, NOW + CONFIRMATION_TTL_MS + 1), "expired");
  assert.equal(await checkConfirmation(SECRET, "garbage", subject, NOW), "mismatch");
  assert.equal(canonical({ b: 1, a: [{ d: 2, c: 3 }] }), canonical({ a: [{ c: 3, d: 2 }], b: 1 }), "key order does not matter");
});

test("plugin_read without a plugin lists every installed plugin, with what each offers or why not", async () => {
  const client = fakeClient(installed());
  const { text, data } = await pluginReadOn(client, {});
  assert.deepEqual(data.plugins.map((p) => [p.id, p.available]), [["lamp", true], ["voice", false], ["notes", false]]);
  assert.deepEqual(data.plugins[0].reads.map((r) => [r.id, r.main]), [["state", true], ["history", false]]);
  assert.equal(data.plugins[0].reads[0].description, "On or off, and how bright.");
  assert.deepEqual(data.plugins[0].actions.map((a) => a.risk), ["low", "disruptive"]);
  assert.deepEqual(data.plugins[0].actions.map((a) => [a.id, a.asks_first]), [["dim", false], ["off", true]]);
  assert.equal(data.plugins[1].reason, "does not describe itself to ChatGPT");
  assert.match(data.plugins[2].reason, /not running \(failed\)/);
  assert.match(text, /Desk lamp \(lamp\): The lamp on the desk\./);
  assert.match(text, /off \[asks first\]/);
  assert.deepEqual(client.calls.map((c) => c.slice(0, 2)), [["lamp", "meta.describe"], ["voice", "meta.describe"]], "only running plugins are asked");
});

test("plugin_read reads the main status by a spoken name, trimmed, and lists the actions", async () => {
  const client = fakeClient(installed());
  const { text, data } = await pluginReadOn(client, { plugin: "лампа" });
  assert.deepEqual(data.result, { on: true, level: 50 });
  assert.equal(data.operation, "state");
  assert.deepEqual(data.actions.map((a) => a.id), ["dim", "off"]);
  assert.doesNotMatch(text, /s3cr3t|wiring/);
  assert.match(text, /Actions \(plugin_action\): dim \(level: 10 \| 50 \| 100 \(required\)\); off \[asks first\]/);
  assert.deepEqual(client.calls.at(-1), ["lamp", "lamp.get", {}]);
});

test("an exact plugin id asks that plugin alone", async () => {
  const client = fakeClient(installed());
  await pluginReadOn(client, { plugin: "lamp", operation: "history", args: { days: 2 } });
  assert.deepEqual(client.calls.map((c) => c.slice(0, 2)), [["lamp", "meta.describe"], ["lamp", "lamp.history"]]);
});

test("plugin_read refuses actions, unknown plugins and plugins with nothing to offer, without calling them", async () => {
  const client = fakeClient(installed());
  assert.match((await pluginReadOn(client, { plugin: "lamp", operation: "off" })).invalid, /off is an action of Desk lamp: use plugin_action/);
  const unknown = await pluginReadOn(client, { plugin: "toaster" });
  assert.equal(unknown.data.needs_clarification.kind, "plugin");
  assert.match(unknown.text, /No plugin matches "toaster"\. Plugins ChatGPT can use: Desk lamp \(lamp\)/);
  const silent = await pluginReadOn(client, { plugin: "voice" });
  assert.match(silent.text, /voice is installed but offers nothing to ChatGPT/);
  assert.ok(!client.calls.some(([, method]) => method === "lamp.set"));
});

test("a low-risk action runs at once with its fixed arguments and says it is done", async () => {
  const client = fakeClient(installed());
  const { text, data } = await pluginActionOn(client, { plugin: "lamp", operation: "dim", args: { level: 10 }, secret: SECRET, now: NOW });
  assert.deepEqual(client.calls.at(-1), ["lamp", "lamp.set", { level: 10, mode: "level" }]);
  assert.equal(data.outcome, "done");
  assert.equal(data.delivered, true);
  assert.deepEqual(data.result, { on: true, level: 10 });
  assert.match(text, /^Done: Desk lamp · Dim the lamp\. It ran once; never repeat it/);
});

test("an action that asks first runs only with its confirmation, and only for the same arguments", async () => {
  const client = fakeClient(installed());
  const first = await pluginActionOn(client, { plugin: "lamp", operation: "off", secret: SECRET, now: NOW });
  assert.equal(first.data.outcome, "needs_confirmation");
  assert.equal(first.data.delivered, false);
  assert.equal(first.data.confirm_text, "Turn the lamp off: the room goes dark.");
  assert.match(first.text, /Tell the user: "Turn the lamp off: the room goes dark\." Only after they say yes/);
  assert.ok(!client.calls.some(([, method]) => method === "lamp.set"), "nothing ran yet");

  const forged = await pluginActionOn(client, { plugin: "lamp", operation: "off", confirmation: "1.forged", secret: SECRET, now: NOW });
  assert.equal(forged.data.outcome, "needs_confirmation");
  assert.match(forged.text, /^That confirmation was for something else/);

  const late = await pluginActionOn(client, { plugin: "lamp", operation: "off", confirmation: first.data.confirmation, secret: SECRET, now: NOW + CONFIRMATION_TTL_MS + 1 });
  assert.match(late.text, /^That confirmation expired/);
  assert.ok(!client.calls.some(([, method]) => method === "lamp.set"));

  const done = await pluginActionOn(client, { plugin: "lamp", operation: "off", confirmation: first.data.confirmation, secret: SECRET, now: NOW + 5_000 });
  assert.equal(done.data.outcome, "done");
  assert.deepEqual(client.calls.at(-1), ["lamp", "lamp.set", { mode: "off" }]);
});

test("a confirmation for one action does not unlock another", async () => {
  const client = fakeClient(installed());
  const raw = lamp();
  raw.operations.push({ id: "party", kind: "action", method: "lamp.set", fixed: { mode: "party" }, title: "Party mode", risk: "outward" });
  client.listPlugins = async () => [{ id: "lamp", status: "running" }];
  const rpc = { "meta.describe": () => raw, "lamp.set": (input) => input };
  client.invokePluginRpc = async (id, method, input) => {
    client.calls.push([id, method, input]);
    return rpc[method](input);
  };
  const off = await pluginActionOn(client, { plugin: "lamp", operation: "off", secret: SECRET, now: NOW });
  const party = await pluginActionOn(client, { plugin: "lamp", operation: "party", confirmation: off.data.confirmation, secret: SECRET, now: NOW });
  assert.equal(party.data.outcome, "needs_confirmation");
  assert.equal(party.data.confirm_text, "Desk lamp: Party mode.", "without a confirmText the title is what is asked");
  assert.ok(!client.calls.some(([, method]) => method === "lamp.set"));
});

test("plugin_action refuses reads and bad arguments before calling anything", async () => {
  const client = fakeClient(installed());
  assert.match((await pluginActionOn(client, { plugin: "lamp", operation: "state", secret: SECRET })).invalid, /state is a read of Desk lamp: use plugin_read/);
  assert.match((await pluginActionOn(client, { plugin: "lamp", operation: "dim", args: { level: 30 }, secret: SECRET })).invalid, /level must be 10 \| 50 \| 100/);
  const which = await pluginActionOn(client, { plugin: "lamp", operation: "blink", secret: SECRET });
  assert.equal(which.data.needs_clarification.kind, "operation");
  assert.ok(!client.calls.some(([, method]) => method === "lamp.set"));
});

test("a plugin whose description breaks or hangs is reported, and the others still work", async () => {
  const client = fakeClient([
    { id: "lamp", rpc: { "meta.describe": () => lamp(), "lamp.get": () => ({ on: false, level: 0 }) } },
    { id: "odd", rpc: { "meta.describe": () => ({ schema: "paseo.capabilities/1", title: "Odd", operations: [] }) } },
    {
      id: "broken",
      rpc: {
        "meta.describe": () => {
          throw new Error("Request failed: boom");
        },
      },
    },
  ]);
  const { data } = await pluginReadOn(client, {});
  const byId = Object.fromEntries(data.plugins.map((p) => [p.id, p]));
  assert.equal(byId.lamp.available, true);
  assert.match(byId.odd.reason, /meta.describe is not usable: no usable operations/);
  assert.match(byId.broken.reason, /boom/);
});

test("a long id or method is refused, never cut into another name, and the limit counts usable operations", () => {
  const raw = lamp();
  raw.operations.unshift({ id: "long", kind: "read", method: `lamp.${"x".repeat(120)}`, title: "Long" });
  for (let i = 0; i < 40; i += 1) raw.operations.push({ id: `extra_${i}`, kind: "read", method: "lamp.get", title: `Extra ${i}` });
  const { capabilities } = parseCapabilities(raw);
  assert.equal(capabilities.operations.length, 40);
  assert.deepEqual(capabilities.skipped[0], { id: "long", reason: "method is not an RPC name" });
  assert.deepEqual(
    capabilities.skipped.slice(1).map((s) => s.id),
    ["extra_36", "extra_37", "extra_38", "extra_39"],
    "the lamp's four plus 36 extras fit; the rest are listed, not lost",
  );
  assert.match(capabilities.skipped.at(-1).reason, /over the limit of 40 operations/);
});

test("an argument a nested object does not name is refused, as at the top", () => {
  const op = parseCapabilities({
    ...lamp(),
    operations: [{ id: "scene", kind: "action", method: "lamp.set", title: "Scene", risk: "low", input: { type: "object", properties: { opts: { type: "object", properties: { level: { type: "number" } } } } } }],
  }).capabilities.operations[0];
  assert.deepEqual(prepareArgs(op, { opts: { level: 1 } }), { args: { opts: { level: 1 } } });
  assert.match(prepareArgs(op, { opts: { level: 1, colour: "red" } }).invalid, /args\.opts\.colour is not an argument/);
});

test("only text is a secret: a count or a flag under a secret-sounding name stays", () => {
  const history = described().operations.find((op) => op.id === "history");
  assert.deepEqual(projectResult(history, { tokenCount: 3, hasToken: true, token: "t0k", nested: { maxTokens: 10, secret: "s" } }), {
    tokenCount: 3,
    hasToken: true,
    token: "[redacted]",
    nested: { maxTokens: 10, secret: "[redacted]" },
  });
});

test("what the user hears names every argument they chose: in the plugin's text or after it", () => {
  const caps = described();
  const op = (extra) => ({ id: "x", title: "Send", fixed: { mode: "send" }, confirmText: "", ...extra });
  assert.equal(confirmationText(caps, op({ confirmText: "Send «{text}» to {to}." }), { text: "on my way", to: "Oleg", mode: "send" }), "Send «on my way» to Oleg.");
  assert.equal(confirmationText(caps, op({ confirmText: "Send «{text}»." }), { text: "on my way", urgent: true, mode: "send" }), "Send «on my way». (urgent: true)");
  assert.equal(confirmationText(caps, op({ confirmText: "Send {missing} now." }), { mode: "send" }), "Send {missing} now.", "an unknown name stays as written");
  assert.equal(confirmationText(caps, op({}), { level: 10, mode: "send" }), "Desk lamp: Send. (level: 10)");
});

test("a plugin with no main read answers with what it offers, and shows what was dropped", async () => {
  const raw = lamp();
  raw.operations = raw.operations.filter((op) => op.kind === "action");
  raw.operations.push({ id: "Broken", kind: "read", method: "lamp.get", title: "x" });
  const client = fakeClient([{ id: "lamp", rpc: { "meta.describe": () => raw } }]);
  const { text, data } = await pluginReadOn(client, { plugin: "lamp" });
  assert.deepEqual(data.plugins[0].reads, []);
  assert.deepEqual(data.plugins[0].actions.map((a) => a.id), ["dim", "off"]);
  assert.deepEqual(data.plugins[0].skipped, [{ id: "Broken", reason: "id must be lower case letters, digits and _, at most 64" }]);
  assert.match(text, /Dropped from its description: Broken \(id must be/);
  assert.ok(!client.calls.some(([, method]) => method === "lamp.set"));
});

test("a read says what it reports, as the plugin describes it", async () => {
  const { text, data } = await pluginReadOn(fakeClient(installed()), { plugin: "lamp" });
  assert.equal(data.about, "On or off, and how bright.");
  assert.match(text, /^Desk lamp · Lamp state\nOn or off, and how bright\.\n/);
});

// ---- v1.1: outcome, target, untrusted -----------------------------------------------------------
// Another made-up plugin, a help desk: a read by id that is an action's target, actions that say
// when they were not done, and a read of other people's words. Its tickets can change between two
// calls, the way real ones do between a confirmation and its yes.

function desk() {
  return {
    schema: "paseo.capabilities/1",
    title: "Help desk",
    summary: "Tickets people filed.",
    operations: [
      {
        id: "ticket",
        kind: "read",
        method: "desk.ticket",
        title: "One ticket",
        input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        output: { fields: ["id", "title", "owner", "status"] },
        outcome: { error: "error" },
      },
      { id: "inbox", kind: "read", method: "desk.inbox", title: "New tickets", default: true, untrusted: true, input: { type: "object", properties: {} } },
      {
        id: "close",
        kind: "action",
        method: "desk.close",
        title: "Close a ticket",
        risk: "destructive",
        input: { type: "object", properties: { ticket: { type: "string" }, note: { type: "string" } }, required: ["ticket"] },
        target: { read: "ticket", args: { id: "ticket" }, show: ["title", "owner"] },
        confirmText: "Close «{target.title}» filed by {target.owner}?",
        outcome: { ok: "ok", error: "error" },
      },
      {
        id: "tag",
        kind: "action",
        method: "desk.tag",
        title: "Tag a ticket",
        risk: "low",
        input: { type: "object", properties: { ticket: { type: "string" }, tag: { type: "string" } }, required: ["ticket", "tag"] },
        outcome: { ok: "ok", error: ["code", "error"] },
      },
    ],
  };
}

function deskClient({ tickets, close = () => ({ ok: true, error: "" }), tag = () => ({ ok: true, code: "", error: "" }), describe = desk } = {}) {
  return fakeClient([
    {
      id: "desk",
      rpc: {
        "meta.describe": () => describe(),
        "desk.ticket": ({ id }) => (tickets[id] ? { ...tickets[id], error: "" } : { error: `no ticket ${id}` }),
        "desk.inbox": () => ({ tickets: Object.values(tickets).map((t) => ({ id: t.id, title: t.title })) }),
        "desk.close": (input) => close(input),
        "desk.tag": (input) => tag(input),
      },
    },
  ]);
}

const printer = () => ({ t1: { id: "t1", title: "Printer jams", owner: "Ann", status: "open", secret: "x" } });
const rpcs = (client, method) => client.calls.filter(([, m]) => m === method);

test("v1.1 keys are read, and an action whose target cannot work is dropped with the reason", () => {
  const ops = Object.fromEntries(parseCapabilities(desk()).capabilities.operations.map((op) => [op.id, op]));
  assert.deepEqual(ops.close.target, { read: "ticket", args: { id: "ticket" }, show: ["title", "owner"] });
  assert.deepEqual(ops.close.outcome, { ok: "ok", error: ["error"] });
  assert.deepEqual(ops.tag.outcome, { ok: "ok", error: ["code", "error"] });
  assert.equal(ops.inbox.untrusted, true);
  assert.equal(ops.ticket.untrusted, false);

  const broken = (change) => {
    const raw = desk();
    change(raw.operations.find((op) => op.id === "close"));
    const { capabilities } = parseCapabilities(raw);
    assert.ok(!capabilities.operations.some((op) => op.id === "close"), "close is not offered");
    return capabilities.skipped.find((s) => s.id === "close").reason;
  };
  assert.match(broken((op) => (op.target.read = "inbox_typo")), /target.read "inbox_typo" is not a read of this plugin/);
  assert.match(broken((op) => (op.target.read = "tag")), /is not a read of this plugin/);
  assert.match(broken((op) => (op.target.args = { id: "missing" })), /reads "missing", which is not an argument of close/);
  assert.match(broken((op) => (op.target.args = { colour: "ticket" })), /fills "colour", which is not an argument of ticket/);
  assert.match(broken((op) => (op.target.args = { id: "ticket" }, (op.target.show = []))), /target.show must name 1 to 8 fields/);
  assert.match(broken((op) => (op.target = "ticket")), /target must name read, args and show/);
  assert.match(broken((op) => (op.outcome = { ok: 3 })), /outcome must name fields of the answer/);
  assert.match(broken((op) => (op.outcome = {})), /outcome names no field/);

  const raw = desk();
  raw.operations[0].input.properties.lang = { type: "string" };
  raw.operations[0].input.required.push("lang");
  const reason = parseCapabilities(raw).capabilities.skipped.find((s) => s.id === "close").reason;
  assert.match(reason, /target.args leaves lang of ticket unset/);
});

test("an answer says done or refused only through the fields the operation names", () => {
  const ops = Object.fromEntries(parseCapabilities(desk()).capabilities.operations.map((op) => [op.id, op]));
  assert.deepEqual(judgeOutcome(ops.close, { ok: true, error: "" }), { refused: false });
  assert.deepEqual(judgeOutcome(ops.close, { ok: false, error: "" }), { refused: true, reason: "the plugin reported it was not done" });
  assert.deepEqual(judgeOutcome(ops.close, { ok: false, error: "already closed" }), { refused: true, reason: "already closed" });
  assert.deepEqual(judgeOutcome(ops.tag, { ok: true, code: "locked", error: "by Bob" }), { refused: true, reason: "locked: by Bob" });
  assert.deepEqual(judgeOutcome(ops.close, ["not", "an", "object"]), { refused: false });
  assert.deepEqual(judgeOutcome(ops.inbox, { error: "anything" }), { refused: false }, "no outcome: any answer is done, as in v1");
});

test("target facts are plain one-line text, secrets out, and a missing field means no confirmation", () => {
  const target = { read: "ticket", args: { id: "ticket" }, show: ["title", "owner", "api_key"] };
  const { facts } = targetFacts(target, { title: "Printer\njams\u0007 again", owner: { name: "Ann" }, api_key: "k-123" });
  assert.deepEqual(facts, { title: "Printer jams again", owner: '{"name":"Ann"}', api_key: "[redacted]" });
  assert.equal(targetFacts({ ...target, show: ["title"] }, { title: "x".repeat(500) }).facts.title.length <= 202, true);
  assert.match(targetFacts(target, { title: "Printer" }).missing, /has no owner, api_key/);
  assert.match(targetFacts(target, "Printer").missing, /did not answer with an object/);
});

test("the confirmation fills target facts in, names every one it left out, and says the target's id through them", () => {
  const caps = parseCapabilities(desk()).capabilities;
  const close = caps.operations.find((op) => op.id === "close");
  assert.equal(confirmationText(caps, close, { ticket: "t1" }, { title: "Printer jams", owner: "Ann" }), "Close «Printer jams» filed by Ann?");
  assert.equal(confirmationText(caps, close, { ticket: "t1", note: "fixed" }, { title: "Printer jams", owner: "Ann" }), "Close «Printer jams» filed by Ann? (note: fixed)");
  const plain = { ...close, confirmText: "" };
  assert.equal(confirmationText(caps, plain, { ticket: "t1" }, { title: "Printer jams", owner: "Ann" }), "Help desk: Close a ticket. [target: title: Printer jams; owner: Ann]");
});

test("a token covers the facts the user heard: other facts are 'changed', a token without them never runs", async () => {
  const subject = { plugin: "desk", operation: "close", method: "desk.close", args: { ticket: "t1" } };
  const facts = { title: "Printer jams", owner: "Ann" };
  const { token } = await issueConfirmation(SECRET, subject, NOW, facts);
  assert.equal(token.split(".").length, 3);
  assert.equal(await checkConfirmation(SECRET, token, subject, NOW + 1000, facts), "ok");
  assert.equal(await checkConfirmation(SECRET, token, subject, NOW + 1000, { ...facts, owner: "Bob" }), "changed");
  assert.equal(await checkConfirmation(SECRET, token, { ...subject, args: { ticket: "t2" } }, NOW + 1000, facts), "mismatch");
  assert.equal(await checkConfirmation(SECRET, token, subject, NOW + CONFIRMATION_TTL_MS + 1, facts), "expired");
  const { token: withoutFacts } = await issueConfirmation(SECRET, subject, NOW);
  assert.equal(await checkConfirmation(SECRET, withoutFacts, subject, NOW + 1000, facts), "mismatch");
  assert.equal(await checkConfirmation(SECRET, withoutFacts, subject, NOW + 1000), "ok", "actions without a target keep two-part tokens");
});

test("a read the plugin refuses says so, and an untrusted read carries the note", async () => {
  const client = deskClient({ tickets: printer() });
  const missing = await pluginReadOn(client, { plugin: "desk", operation: "ticket", args: { id: "t9" } });
  assert.equal(missing.data.refused, true);
  assert.equal(missing.data.reason, "no ticket t9");
  assert.match(missing.text, /^Help desk · One ticket: could not read it\. no ticket t9/);
  const found = await pluginReadOn(client, { plugin: "desk", operation: "ticket", args: { id: "t1" } });
  assert.equal(found.data.refused, undefined);
  assert.deepEqual(found.data.result, { id: "t1", title: "Printer jams", owner: "Ann", status: "open" });
  const inbox = await pluginReadOn(client, { plugin: "desk" });
  assert.equal(inbox.data.untrusted, true);
  assert.ok(inbox.text.includes(UNTRUSTED_NOTE));
  assert.equal(found.data.untrusted, undefined, "only marked reads carry it");
});

test("an action with a target is confirmed from the plugin's own data, and runs only if that data still holds", async () => {
  const tickets = printer();
  const client = deskClient({ tickets });
  const first = await pluginActionOn(client, { plugin: "desk", operation: "close", args: { ticket: "t1" }, secret: SECRET, now: NOW });
  assert.equal(first.data.outcome, "needs_confirmation");
  assert.deepEqual(first.data.target, { title: "Printer jams", owner: "Ann" });
  assert.equal(first.data.confirm_text, "Close «Printer jams» filed by Ann?");
  assert.deepEqual(rpcs(client, "desk.ticket").map((c) => c[2]), [{ id: "t1" }]);
  assert.equal(rpcs(client, "desk.close").length, 0);

  const done = await pluginActionOn(client, { plugin: "desk", operation: "close", args: { ticket: "t1" }, confirmation: first.data.confirmation, secret: SECRET, now: NOW + 5000 });
  assert.equal(done.data.outcome, "done");
  assert.equal(rpcs(client, "desk.ticket").length, 2, "read again right before running");
  assert.deepEqual(rpcs(client, "desk.close").map((c) => c[2]), [{ ticket: "t1" }]);
});

test("a target that changed after the yes is asked about again, and nothing runs", async () => {
  const tickets = printer();
  const client = deskClient({ tickets });
  const first = await pluginActionOn(client, { plugin: "desk", operation: "close", args: { ticket: "t1" }, secret: SECRET, now: NOW });
  tickets.t1 = { ...tickets.t1, owner: "Bob" };
  const again = await pluginActionOn(client, { plugin: "desk", operation: "close", args: { ticket: "t1" }, confirmation: first.data.confirmation, secret: SECRET, now: NOW + 5000 });
  assert.equal(again.data.outcome, "needs_confirmation");
  assert.equal(again.data.target_changed, true);
  assert.deepEqual(again.data.target, { title: "Printer jams", owner: "Bob" });
  assert.match(again.text, /^The target changed since the user confirmed/);
  assert.equal(rpcs(client, "desk.close").length, 0);

  const confirmedAgain = await pluginActionOn(client, { plugin: "desk", operation: "close", args: { ticket: "t1" }, confirmation: again.data.confirmation, secret: SECRET, now: NOW + 9000 });
  assert.equal(confirmedAgain.data.outcome, "done");
});

test("a target that cannot be read refuses the action before and after the yes", async () => {
  const tickets = printer();
  const client = deskClient({ tickets });
  const unknown = await pluginActionOn(client, { plugin: "desk", operation: "close", args: { ticket: "t9" }, secret: SECRET, now: NOW });
  assert.equal(unknown.data.outcome, "refused");
  assert.equal(unknown.data.delivered, false);
  assert.match(unknown.data.reason, /its target could not be read: no ticket t9/);
  assert.equal(unknown.data.confirmation, undefined, "no token for a target nobody saw");

  const first = await pluginActionOn(client, { plugin: "desk", operation: "close", args: { ticket: "t1" }, secret: SECRET, now: NOW });
  delete tickets.t1;
  const gone = await pluginActionOn(client, { plugin: "desk", operation: "close", args: { ticket: "t1" }, confirmation: first.data.confirmation, secret: SECRET, now: NOW + 5000 });
  assert.equal(gone.data.outcome, "refused");
  assert.equal(rpcs(client, "desk.close").length, 0);
});

test("an action the plugin refuses reads as not done, with its reason; one without outcome stays done", async () => {
  const client = deskClient({ tickets: printer(), close: () => ({ ok: false, error: "already closed" }), tag: () => ({ ok: true, code: "locked", error: "" }) });
  const first = await pluginActionOn(client, { plugin: "desk", operation: "close", args: { ticket: "t1" }, secret: SECRET, now: NOW });
  const refused = await pluginActionOn(client, { plugin: "desk", operation: "close", args: { ticket: "t1" }, confirmation: first.data.confirmation, secret: SECRET, now: NOW + 5000 });
  assert.equal(refused.data.outcome, "refused");
  assert.equal(refused.data.delivered, false);
  assert.equal(refused.data.reason, "already closed");
  assert.match(refused.text, /^Not done: Help desk · Close a ticket\. already closed\. Nothing happened/);
  const tagged = await pluginActionOn(client, { plugin: "desk", operation: "tag", args: { ticket: "t1", tag: "urgent" }, secret: SECRET, now: NOW });
  assert.equal(tagged.data.outcome, "refused");
  assert.equal(tagged.data.reason, "locked");

  // v1 behaviour is kept for operations that do not name outcome fields.
  const lampClient = fakeClient([{ id: "lamp", rpc: { "meta.describe": () => lamp(), "lamp.set": () => ({ on: false, ok: false, error: "fuse" }) } }]);
  const dimmed = await pluginActionOn(lampClient, { plugin: "lamp", operation: "dim", args: { level: 10 }, secret: SECRET, now: NOW });
  assert.equal(dimmed.data.outcome, "done");
});
