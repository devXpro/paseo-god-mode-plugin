// Run with: node --test core/
// set_chat_model: what a change of a chat's model and thinking level comes to (chooseChange, changeResult),
// then the whole call against a fake daemon that answers as Paseo 0.14 does: the chats' own model and level
// in its list, one agent.config.apply request that changes the live chat, a notice for a level that waits for
// the next turn. No network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogEntry, changeResult, chooseChange } from "./models.mjs";
import { setChatModelOn } from "./paseo.mjs";

const levels = (ids, preferred) => ids.map((id) => ({ id, label: id === "xhigh" ? "Extra High" : id[0].toUpperCase() + id.slice(1), ...(id === preferred ? { isDefault: true } : {}) }));
const modelOf = (provider, id, label, ids, preferred, extra = {}) => ({ provider, id, label, thinkingOptions: levels(ids, preferred), defaultThinkingOptionId: preferred, ...extra });
const FULL = ["low", "medium", "high", "xhigh", "max", "ultracode"];
// An older Claude model: no xhigh, and thinking can be turned off.
const OLDER = ["off", "low", "medium", "high", "max"];
const CODEX = ["low", "medium", "high", "xhigh", "max", "ultra"];

const CLAUDE_MODELS = [
  modelOf("claude", "claude-opus-5-5", "Opus 5.5", FULL, "medium", { isDefault: true }),
  modelOf("claude", "claude-sonnet-5-5", "Sonnet 5.5", FULL, "medium"),
  modelOf("claude", "claude-sonnet-4-6", "Sonnet 4.6", OLDER, "high"),
  { provider: "claude", id: "claude-haiku-4-5", label: "Haiku 4.5" },
];
const CODEX_MODELS = [modelOf("codex", "gpt-6.1-sol", "GPT-6.1-Sol", CODEX, "low", { isDefault: true }), modelOf("codex", "gpt-6-luna", "GPT-6-Luna", CODEX.slice(0, 5), "medium")];
const SNAPSHOT = [
  { provider: "claude", label: "Claude", status: "ready", enabled: true, modes: [] },
  { provider: "codex", label: "Codex", status: "ready", enabled: true, modes: [] },
  { provider: "opencode", label: "OpenCode", status: "ready", enabled: true, modes: [] },
];
const LISTED = { claude: CLAUDE_MODELS, codex: CODEX_MODELS, opencode: [{ provider: "opencode", id: "opencode/big", label: "Big" }] };
const CATALOG = [
  catalogEntry(SNAPSHOT[0], { models: CLAUDE_MODELS }, { modes: [] }),
  catalogEntry(SNAPSHOT[1], { models: CODEX_MODELS }, { modes: [] }),
];
const asked = (result) => result.ask?.data.needs_clarification;
const claudeChat = (model, thinking) => ({ provider: "claude", model, thinking });

// ---- The choice -------------------------------------------------------------------------------

test("chooseChange: a new model keeps the level when it offers it, and a level alone is checked against the chat's own model", () => {
  const switched = chooseChange(CATALOG, claudeChat("claude-opus-5-5", "max"), { model: "Sonnet 5.5" }).change;
  assert.deepEqual([switched.model.id, switched.thinking, switched.after.id], ["claude-sonnet-5-5", undefined, "claude-sonnet-5-5"], "max is still on offer, so it stays");
  const level = chooseChange(CATALOG, claudeChat("claude-opus-5-5", "medium"), { thinking: "max" }).change;
  assert.deepEqual([level.model, level.thinking, level.after.id], [null, "max", "claude-opus-5-5"]);
  const both = chooseChange(CATALOG, claudeChat("claude-opus-5-5", "medium"), { model: "claude-sonnet-5-5", thinking: "extra high" }).change;
  assert.deepEqual([both.model.id, both.thinking], ["claude-sonnet-5-5", "xhigh"]);
});

test("chooseChange: what the chat already has is not a change, and a chat with no model of its own runs the default", () => {
  const same = chooseChange(CATALOG, claudeChat("claude-opus-5-5", "max"), { model: "Opus 5.5", thinking: "max" }).change;
  assert.deepEqual([same.model, same.thinking], [null, undefined]);
  const byDefault = chooseChange(CATALOG, claudeChat(null, null), { model: "Opus 5.5" }).change;
  assert.equal(byDefault.model, null, "Opus 5.5 is the default, so a chat with no model of its own already runs it");
  const aliased = chooseChange(catalogWith({ aliases: ["claude-opus-5-5[1m]"] }), claudeChat("claude-opus-5-5[1m]", "max"), { model: "Opus 5.5" }).change;
  assert.equal(aliased.model, null, "an alias of the model is the model");
  const unlisted = chooseChange(CATALOG, claudeChat("claude-retired-1", "max"), { model: "Opus 5.5" }).change;
  assert.equal(unlisted.model.id, "claude-opus-5-5", "a model the catalog does not list is changed");
});

function catalogWith(extra) {
  const models = CLAUDE_MODELS.map((m, i) => (i === 0 ? { ...m, ...extra } : m));
  return [catalogEntry(SNAPSHOT[0], { models }, { modes: [] }), CATALOG[1]];
}

test("chooseChange: a level the new model lacks is asked about, and a model with no levels drops it", () => {
  const older = chooseChange(CATALOG, claudeChat("claude-opus-5-5", "xhigh"), { model: "Sonnet 4.6" });
  assert.equal(asked(older).kind, "thinking");
  assert.deepEqual(asked(older).candidates, OLDER);
  assert.match(older.ask.text, /Sonnet 4\.6 has no thinking level "xhigh", which this chat runs at\. Its levels: off, low, medium, high, max\. Nothing was changed: ask the user which level, then call again with the model and that level\./);
  assert.equal(chooseChange(CATALOG, claudeChat("claude-opus-5-5", "xhigh"), { model: "Sonnet 4.6", thinking: "high" }).change.thinking, "high", "named with the model, it passes");
  const haiku = chooseChange(CATALOG, claudeChat("claude-opus-5-5", "max"), { model: "Haiku 4.5" }).change;
  assert.deepEqual([haiku.model.id, haiku.thinking], ["claude-haiku-4-5", null], "Haiku 4.5 has no levels, so the one the chat had goes");
  assert.equal(chooseChange(CATALOG, claudeChat("claude-opus-5-5", null), { model: "Haiku 4.5" }).change.thinking, undefined, "none to drop");
  assert.equal(chooseChange(CATALOG, claudeChat("claude-opus-5-5", "max"), { model: "Sonnet 4.6", thinking: "off" }).change.thinking, "off");
});

test("chooseChange: what Paseo does not offer comes back as a question, and nothing changes", () => {
  assert.equal(asked(chooseChange(CATALOG, claudeChat("claude-opus-5-5", "max"), { model: "Gemini 3" })).kind, "model");
  assert.equal(asked(chooseChange(CATALOG, claudeChat("claude-opus-5-5", "max"), { thinking: "ultra" })).kind, "thinking", "ultra is Codex's");
  assert.deepEqual(asked(chooseChange(CATALOG, claudeChat("claude-opus-5-5", "max"), { thinking: "ultra" })).candidates, FULL);
  const none = chooseChange(CATALOG, claudeChat("claude-haiku-4-5", null), { thinking: "max" });
  assert.deepEqual([asked(none).kind, asked(none).candidates], ["thinking", []]);
  assert.match(none.ask.text, /Haiku 4\.5 offers no thinking levels, so none can be set\./);
  const sonnet = chooseChange(CATALOG, claudeChat("claude-opus-5-5", "max"), { model: "sonnet" });
  assert.deepEqual(asked(sonnet).candidates, ["claude-sonnet-5-5", "claude-sonnet-4-6"], "only this chat's own runtime is searched");
});

test("chooseChange: a model of another runtime is not offered as a choice, it is named", () => {
  const codex = chooseChange(CATALOG, claudeChat("claude-opus-5-5", "max"), { model: "GPT-6.1-Sol" });
  assert.deepEqual([codex.other.provider.id, codex.other.model.id], ["codex", "gpt-6.1-sol"]);
  const claude = chooseChange(CATALOG, { provider: "codex", model: "gpt-6.1-sol", thinking: "max" }, { model: "Opus 5.5" });
  assert.deepEqual([claude.other.provider.id, claude.other.model.id], ["claude", "claude-opus-5-5"]);
  const inside = chooseChange(CATALOG, { provider: "codex", model: "gpt-6.1-sol", thinking: "low" }, { model: "luna", thinking: "xhigh" }).change;
  assert.deepEqual([inside.model.id, inside.thinking], ["gpt-6-luna", "xhigh"]);
  assert.equal(asked(chooseChange(CATALOG, { provider: "codex", model: "gpt-6.1-sol", thinking: "ultra" }, { model: "luna" })).kind, "thinking", "ultra is not on GPT-6-Luna");
});

// ---- The words ---------------------------------------------------------------------------------

const FLEET = { id: "a2252400-0000-4000-8000-000000000001", title: "Fleet map", project: "proxy", provider: "claude" };
const was = { model: "claude-opus-5-5", thinking: "medium" };
const nowOn = { model: "claude-sonnet-5-5", thinking: "max" };

test("changeResult: every way a change can end says what the chat runs on and whether anything changed", () => {
  const sonnet = CLAUDE_MODELS[1];
  const changed = changeResult({ outcome: "changed", chat: FLEET, provider: CATALOG[0], before: was, after: nowOn, change: { model: sonnet, thinking: "max", after: sonnet } });
  assert.equal(changed.text, "Changed Fleet map (proxy): it runs on Sonnet 5.5, thinking Max now, it was Opus 5.5, thinking Medium. Its history is kept and no new chat was started. The next message runs on it.");
  assert.deepEqual(changed.data, {
    chat_id: FLEET.id,
    short_id: "a225240",
    project: "proxy",
    provider: "claude",
    outcome: "changed",
    done: true,
    before: was,
    after: nowOn,
    busy: false,
  });
  const busy = changeResult({ outcome: "changed", chat: FLEET, provider: CATALOG[0], before: was, after: nowOn, change: { model: sonnet, thinking: "max", after: sonnet }, busy: true, notice: "Thinking level applies next turn" });
  assert.match(busy.text, /It is working now, so the model applies from the agent's next call to it \(a reply being written finishes on the old one\) and the thinking level applies from its next turn\.$/);
  assert.deepEqual([busy.data.busy, busy.data.notice], [true, "Thinking level applies next turn"]);
  const levelOnly = changeResult({ outcome: "changed", chat: FLEET, provider: CATALOG[0], before: was, after: { ...was, thinking: "max" }, change: { model: null, thinking: "max", after: CLAUDE_MODELS[0] }, busy: true });
  assert.match(levelOnly.text, /It is working now, so the thinking level applies from its next turn\.$/);
  const codex = changeResult({ outcome: "changed", chat: { ...FLEET, provider: "codex" }, provider: CATALOG[1], before: { model: "gpt-6.1-sol", thinking: "low" }, after: { model: "gpt-6-luna", thinking: "low" }, change: { model: CODEX_MODELS[1], thinking: undefined, after: CODEX_MODELS[1] }, busy: true });
  assert.match(codex.text, /so the model applies from its next turn\.$/, "Codex reads the model at each turn");
  const dropped = changeResult({ outcome: "changed", chat: FLEET, provider: CATALOG[0], before: was, after: { model: "claude-haiku-4-5", thinking: null }, change: { model: CLAUDE_MODELS[3], thinking: null, after: CLAUDE_MODELS[3] } });
  assert.match(dropped.text, /it runs on Haiku 4\.5 now, it was Opus 5\.5, thinking Medium\./);
  assert.equal(dropped.data.after.thinking, null);
});

test("changeResult: nothing changed says so, and a refusal says what the chat still runs on", () => {
  const same = changeResult({ outcome: "unchanged", chat: FLEET, provider: CATALOG[0], before: nowOn });
  assert.equal(same.text, "Fleet map (proxy) already runs on Sonnet 5.5, thinking Max; nothing changed.");
  assert.equal(same.data.done, false);
  assert.equal(changeResult({ outcome: "archived", chat: FLEET, provider: CATALOG[0], before: was }).text, "Nothing changed: Fleet map (proxy) is archived. Tell the user.");
  const other = changeResult({ outcome: "other_runtime", chat: FLEET, provider: CATALOG[0], before: was, other: { provider: CATALOG[1], model: CODEX_MODELS[0] } });
  assert.match(other.text, /^Nothing changed: GPT-6\.1-Sol is a Codex model, and a Claude chat cannot change its runtime, so Fleet map \(proxy\) stays on Opus 5\.5, thinking Medium\. A chat on GPT-6\.1-Sol is a new one, start_chat, without this chat's history: ask the user\.$/);
  const failed = changeResult({ outcome: "error", chat: FLEET, provider: CATALOG[0], before: was, error: "Paseo refused it: Failed to apply agent config" });
  assert.equal(failed.text, "Not changed: Paseo refused it: Failed to apply agent config. Fleet map (proxy) runs on Opus 5.5, thinking Medium.");
  assert.deepEqual([failed.data.done, failed.data.error], [false, "Paseo refused it: Failed to apply agent config"]);
  const partial = changeResult({ outcome: "partial", chat: FLEET, provider: CATALOG[0], before: was, after: { model: "claude-sonnet-5-5", thinking: "medium" }, error: "Paseo refused it: no such level" });
  assert.match(partial.text, /^Partly changed Fleet map \(proxy\): it runs on Sonnet 5\.5, thinking Medium now, but not all of what was asked: Paseo refused it: no such level\./);
  assert.equal(partial.data.done, true, "something did change");
});

// ---- The call, against a fake daemon -----------------------------------------------------------

const FLEET_ID = "a2252400-0000-4000-8000-000000000001";
const NOTES_ID = "b7c1d2e3-0000-4000-8000-000000000002";
const CODEX_ID = "c3d4e5f6-0000-4000-8000-000000000003";
const OPEN_ID = "d4e5f607-0000-4000-8000-000000000004";
const OLD_ID = "e5f60718-0000-4000-8000-000000000005";
const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

// A chat as fetch_agents gives it: the model and level it runs on, from Paseo's own record.
const chat = (id, title, fields = {}) => ({
  agent: {
    id,
    title,
    workspaceId: `wks_${id.slice(0, 4)}`,
    status: "idle",
    pendingPermissions: [],
    updatedAt: at(5),
    createdAt: at(60),
    archivedAt: null,
    cwd: "/Users/r/lab",
    provider: "claude",
    currentModeId: "default",
    model: "claude-opus-5-5",
    thinkingOptionId: "medium",
    effectiveThinkingOptionId: "medium",
    ...fields,
  },
  project: { projectName: "lab", workspaceName: title },
});

function daemon({ chats = [], refuse = null, silent = false, readFails = false } = {}) {
  const calls = [];
  const byId = new Map(chats.map((c) => [c.agent.id, c]));
  return {
    calls,
    async fetchAgents() {
      return { entries: [...byId.values()].filter((c) => !c.agent.archivedAt) };
    },
    async fetchAgent(identifier) {
      if (readFails && calls.some((c) => c[0] === "apply")) throw new Error("relay closed");
      const found = [...byId.values()].filter((c) => c.agent.id.startsWith(identifier));
      return found.length === 1 ? found[0] : null;
    },
    async getProvidersSnapshot(options) {
      calls.push(["snapshot", options]);
      return { entries: SNAPSHOT };
    },
    async listProviderModels(provider) {
      return { provider, models: LISTED[provider], error: null };
    },
    async listProviderModes(provider) {
      return { provider, modes: [], error: null };
    },
    // Paseo's agent.config.apply: the model first, then the level; it is not a transaction.
    async applyAgentConfig(id, config) {
      calls.push(["apply", id, config]);
      const a = byId.get(id).agent;
      if (silent) return null;
      if (config.modelId !== undefined) {
        a.model = config.modelId;
        a.runtimeInfo = { provider: a.provider, sessionId: "s-1", model: config.modelId };
      }
      if (refuse && config.thinkingOptionId !== undefined) throw new Error(refuse);
      if (config.thinkingOptionId !== undefined) {
        a.thinkingOptionId = config.thinkingOptionId;
        a.effectiveThinkingOptionId = config.thinkingOptionId;
        if (["running", "initializing"].includes(a.status)) return { type: "warning", message: "Thinking level applies next turn" };
      }
      return null;
    },
  };
}

const WORLD = () => [
  chat(FLEET_ID, "Fleet map"),
  chat(NOTES_ID, "Release notes", { status: "running" }),
  chat(CODEX_ID, "Codex review", { provider: "codex", model: "gpt-6.1-sol", thinkingOptionId: "low", effectiveThinkingOptionId: "low" }),
  chat(OPEN_ID, "OpenCode try", { provider: "opencode", model: "opencode/big", thinkingOptionId: null, effectiveThinkingOptionId: null }),
  chat(OLD_ID, "Old story", { archivedAt: at(500) }),
];

test("setChatModelOn: the model and the level change in one request, and the answer is what Paseo reports afterwards", async () => {
  const paseo = daemon({ chats: WORLD() });
  const { text, data } = await setChatModelOn(paseo, { chat: "Fleet map", model: "Sonnet 5.5", thinking: "max" });
  assert.deepEqual(paseo.calls.find((c) => c[0] === "snapshot")[1], { cwd: "/Users/r/lab" }, "the chat's own folder's catalog");
  assert.deepEqual(paseo.calls.filter((c) => c[0] === "apply"), [["apply", FLEET_ID, { modelId: "claude-sonnet-5-5", thinkingOptionId: "max" }]], "one request");
  assert.equal(text, "Changed Fleet map (lab): it runs on Sonnet 5.5, thinking Max now, it was Opus 5.5, thinking Medium. Its history is kept and no new chat was started. The next message runs on it.");
  assert.deepEqual(
    { outcome: data.outcome, done: data.done, provider: data.provider, before: data.before, after: data.after, busy: data.busy },
    { outcome: "changed", done: true, provider: "claude", before: { model: "claude-opus-5-5", thinking: "medium" }, after: { model: "claude-sonnet-5-5", thinking: "max" }, busy: false },
  );
});

test("setChatModelOn: a level alone or a model alone sends only that", async () => {
  const level = daemon({ chats: WORLD() });
  const effort = await setChatModelOn(level, { chat: "Fleet map", thinking: "max" });
  assert.deepEqual(level.calls.filter((c) => c[0] === "apply"), [["apply", FLEET_ID, { thinkingOptionId: "max" }]]);
  assert.deepEqual([effort.data.before.model, effort.data.after.model, effort.data.after.thinking], ["claude-opus-5-5", "claude-opus-5-5", "max"]);
  const model = daemon({ chats: WORLD() });
  await setChatModelOn(model, { chat: "Fleet map", model: "claude-sonnet-5-5" });
  assert.deepEqual(model.calls.filter((c) => c[0] === "apply"), [["apply", FLEET_ID, { modelId: "claude-sonnet-5-5" }]], "the level it has is on offer there, so it stays");
});

test("setChatModelOn: a chat that is working is changed too, and Paseo's note reaches the answer", async () => {
  const paseo = daemon({ chats: WORLD() });
  const { text, data } = await setChatModelOn(paseo, { chat: "Release notes", thinking: "max" });
  assert.equal(paseo.calls.filter((c) => c[0] === "apply").length, 1, "no refusal for a busy chat");
  assert.deepEqual([data.outcome, data.busy, data.notice], ["changed", true, "Thinking level applies next turn"]);
  assert.match(text, /It is working now, so the thinking level applies from its next turn\.$/);
});

test("setChatModelOn: a Codex chat changes inside Codex", async () => {
  const paseo = daemon({ chats: WORLD() });
  const { data } = await setChatModelOn(paseo, { chat: "Codex review", model: "GPT-6-Luna", thinking: "xhigh" });
  assert.deepEqual(paseo.calls.filter((c) => c[0] === "apply"), [["apply", CODEX_ID, { modelId: "gpt-6-luna", thinkingOptionId: "xhigh" }]]);
  assert.deepEqual([data.provider, data.after.model, data.after.thinking], ["codex", "gpt-6-luna", "xhigh"]);
});

test("setChatModelOn: what is already so sends nothing", async () => {
  const paseo = daemon({ chats: WORLD() });
  const { text, data } = await setChatModelOn(paseo, { chat: "Fleet map", model: "Opus 5.5", thinking: "medium" });
  assert.equal(paseo.calls.filter((c) => c[0] === "apply").length, 0);
  assert.deepEqual([data.outcome, data.done], ["unchanged", false]);
  assert.match(text, /already runs on Opus 5\.5, thinking Medium; nothing changed\./);
});

test("setChatModelOn: an archived chat, a runtime God Mode has not read and a model of another runtime change nothing", async () => {
  const archived = daemon({ chats: WORLD() });
  assert.equal((await setChatModelOn(archived, { chat: OLD_ID, model: "Sonnet 5.5" })).data.outcome, "archived", "reached by its id");
  assert.equal(archived.calls.filter((c) => ["apply", "snapshot"].includes(c[0])).length, 0, "nothing asked of Paseo");
  const opencode = daemon({ chats: WORLD() });
  const other = await setChatModelOn(opencode, { chat: "OpenCode try", model: "Big" });
  assert.deepEqual([other.data.outcome, other.data.provider], ["unavailable", "opencode"]);
  assert.match(other.text, /^Nothing changed: God Mode changes the model and thinking level only of Claude and Codex chats, and this one runs on opencode\. The user can change it in Paseo on the computer\./);
  assert.equal(opencode.calls.filter((c) => c[0] === "apply").length, 0);
  const codex = daemon({ chats: WORLD() });
  const moved = await setChatModelOn(codex, { chat: "Fleet map", model: "GPT-6.1-Sol" });
  assert.equal(moved.data.outcome, "other_runtime");
  assert.match(moved.text, /GPT-6\.1-Sol is a Codex model, and a Claude chat cannot change its runtime/);
  assert.equal(codex.calls.filter((c) => c[0] === "apply").length, 0);
});

test("setChatModelOn: a model or level Paseo does not offer, and a chat that does not settle, change nothing", async () => {
  const paseo = daemon({ chats: WORLD() });
  assert.equal((await setChatModelOn(paseo, { chat: "Fleet map", model: "Gemini 3" })).data.needs_clarification.kind, "model");
  assert.equal((await setChatModelOn(paseo, { chat: "Fleet map", thinking: "ultra" })).data.needs_clarification.kind, "thinking", "ultra is Codex's");
  assert.equal((await setChatModelOn(paseo, { chat: "No such chat", model: "Sonnet 5.5" })).data.needs_clarification.kind, "chat");
  const xhigh = daemon({ chats: [chat(FLEET_ID, "Fleet map", { thinkingOptionId: "xhigh", effectiveThinkingOptionId: "xhigh" })] });
  const older = await setChatModelOn(xhigh, { chat: "Fleet map", model: "Sonnet 4.6" });
  assert.equal(older.data.needs_clarification.kind, "thinking", "xhigh is not on Sonnet 4.6's list");
  assert.equal(xhigh.calls.filter((c) => c[0] === "apply").length, 0);
  assert.equal(paseo.calls.filter((c) => c[0] === "apply").length, 0, "nothing was changed by any of them");
  const fits = daemon({ chats: WORLD() });
  assert.equal((await setChatModelOn(fits, { chat: "Fleet map", model: "Sonnet 4.6" })).data.outcome, "changed", "the level it has (medium) is on Sonnet 4.6's list too");
});

test("setChatModelOn: a level the new model cannot hold goes with a model that has none", async () => {
  const paseo = daemon({ chats: [chat(FLEET_ID, "Fleet map", { thinkingOptionId: "max", effectiveThinkingOptionId: "max" })] });
  const { data } = await setChatModelOn(paseo, { chat: "Fleet map", model: "Haiku 4.5" });
  assert.deepEqual(paseo.calls.filter((c) => c[0] === "apply"), [["apply", FLEET_ID, { modelId: "claude-haiku-4-5", thinkingOptionId: null }]]);
  assert.deepEqual([data.outcome, data.after.model, data.after.thinking], ["changed", "claude-haiku-4-5", null]);
});

test("setChatModelOn: when Paseo refuses part of it, the answer says what applied and what the chat runs on", async () => {
  const partial = daemon({ chats: WORLD(), refuse: "Failed to apply agent config: Thinking option 'ultracode' is not available for model 'claude-sonnet-5-5'" });
  const half = await setChatModelOn(partial, { chat: "Fleet map", model: "Sonnet 5.5", thinking: "ultracode" });
  assert.deepEqual([half.data.outcome, half.data.done, half.data.after.model, half.data.after.thinking], ["partial", true, "claude-sonnet-5-5", "medium"]);
  assert.match(half.text, /^Partly changed Fleet map \(lab\): it runs on Sonnet 5\.5, thinking Medium now, but not all of what was asked: Paseo refused it: Failed to apply agent config/);
  const none = daemon({ chats: WORLD(), refuse: "Failed to apply agent config: no" });
  const refused = await setChatModelOn(none, { chat: "Fleet map", thinking: "max" });
  assert.deepEqual([refused.data.outcome, refused.data.done, refused.data.after.thinking], ["error", false, "medium"]);
  assert.match(refused.text, /^Not changed: Paseo refused it: Failed to apply agent config: no\. Fleet map \(lab\) runs on Opus 5\.5, thinking Medium\.$/);
});

test("setChatModelOn: an answer Paseo accepts but does not show is not reported as done", async () => {
  const paseo = daemon({ chats: WORLD(), silent: true });
  const { data, text } = await setChatModelOn(paseo, { chat: "Fleet map", model: "Sonnet 5.5" });
  assert.deepEqual([data.outcome, data.done], ["error", false]);
  assert.match(text, /Paseo accepted it but still reports part of the old settings on the chat/);
  const blind = daemon({ chats: WORLD(), readFails: true });
  const ok = await setChatModelOn(blind, { chat: "Fleet map", model: "Sonnet 5.5" });
  assert.deepEqual([ok.data.outcome, ok.data.after.model], ["changed", "claude-sonnet-5-5"], "no read-back to contradict a request Paseo accepted");
  const blindRefused = daemon({ chats: WORLD(), readFails: true, refuse: "no" });
  const unknown = await setChatModelOn(blindRefused, { chat: "Fleet map", thinking: "max" });
  assert.equal(unknown.data.outcome, "error");
  assert.match(unknown.text, /it could not be read back, so it is unknown whether part of it applied/);
});
