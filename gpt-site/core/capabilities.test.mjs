// Run with: node --test core/
// Plugins that describe themselves through meta.describe, against a made-up plugin and a fake
// daemon client: the point is that nothing in God Mode knows any real plugin. No network.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonical,
  checkConfirmation,
  CONFIRMATION_TTL_MS,
  issueConfirmation,
  parseCapabilities,
  pickOperation,
  pickPlugin,
  prepareArgs,
  projectResult,
  signature,
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
  assert.deepEqual(data.plugins[0].reads, ["state", "history"]);
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
