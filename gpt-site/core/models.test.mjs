// Run with: node --test core/
// The runtime catalog and the matching of models, thinking levels and modes, then list_models and
// start_chat against a fake daemon client. No network. The catalog is trimmed from what Paseo 0.12.0
// listed on 2026-10-20 (Claude Code and Codex installed, Copilot not, Antigravity broken).
import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogEntry, chooseStart, modelsData, modelsText, pickModel, pickMode, pickProvider, pickThinking, runtimeOf } from "./models.mjs";
import { listModelsOn, startChatOn } from "./paseo.mjs";

const levels = (ids, preferred) => ids.map((id) => ({ id, label: id === "xhigh" ? "Extra High" : id === "ultracode" ? "Ultra Code" : id[0].toUpperCase() + id.slice(1), ...(id === preferred ? { isDefault: true } : {}) }));
const claudeModel = (id, label, ids, preferred, extra = {}) => ({ provider: "claude", id, label, thinkingOptions: levels(ids, preferred), defaultThinkingOptionId: preferred, ...extra });
const codexModel = (id, label, ids, preferred, extra = {}) => ({ provider: "codex", id, label, thinkingOptions: ids.map((o) => ({ id: o, label: o, isDefault: o === preferred })), defaultThinkingOptionId: preferred, ...extra });
const NO_OFF = ["low", "medium", "high", "xhigh", "max", "ultracode"];
const WITH_OFF = ["off", ...NO_OFF];
const CODEX = ["low", "medium", "high", "xhigh", "max", "ultra"];

const CLAUDE_MODELS = [
  claudeModel("claude-opus-5-5", "Opus 5.5", NO_OFF, "medium", { isDefault: true, description: "Opus 5.5 · Latest release" }),
  claudeModel("claude-opus-5", "Opus 5", WITH_OFF, "high"),
  claudeModel("claude-fable-5", "Fable 5", NO_OFF, "high", { aliases: ["claude-fable-5[1m]"] }),
  claudeModel("claude-sonnet-5-5", "Sonnet 5.5", NO_OFF, "medium"),
  claudeModel("claude-sonnet-5", "Sonnet 5", WITH_OFF, "high"),
  claudeModel("claude-sonnet-5[1m]", "Sonnet 5 1M", WITH_OFF, "high"),
  { provider: "claude", id: "claude-haiku-4-5", label: "Haiku 4.5", description: "Haiku 4.5 · Previous release" },
];
const CODEX_MODELS = [
  codexModel("gpt-6.1-sol", "GPT-6.1-Sol", CODEX, "low", { isDefault: true }),
  codexModel("gpt-6-astra", "GPT-6-Astra", CODEX, "low", { isDefault: false }),
  codexModel("gpt-6-luna", "GPT-6-Luna", CODEX.slice(0, 5), "medium", { isDefault: false }),
  codexModel("gpt-5.6-luna", "GPT-5.6-Luna", CODEX.slice(0, 5), "medium", { isDefault: false }),
];
const CLAUDE_MODES = [
  { id: "plan", label: "Plan Mode" },
  { id: "default", label: "Always Ask" },
  { id: "acceptEdits", label: "Accept File Edits" },
  { id: "auto", label: "Auto mode" },
  { id: "bypassPermissions", label: "Bypass" },
];
const CODEX_MODES = [
  { id: "auto", label: "Default Permissions" },
  { id: "auto-review", label: "Auto-review" },
  { id: "full-access", label: "Full Access" },
];
const SNAPSHOT = [
  { provider: "claude", label: "Claude", status: "ready", enabled: true, modes: CLAUDE_MODES },
  { provider: "codex", label: "Codex", status: "ready", enabled: true, modes: CODEX_MODES },
  { provider: "copilot", label: "Copilot", status: "unavailable", enabled: true, modes: [] },
  { provider: "omp", label: "Oh My Pi", status: "unavailable", enabled: false, modes: [] },
  { provider: "antigravity", label: "Antigravity", status: "error", enabled: true, error: "agy not found on PATH", modes: [] },
];
const LISTED = { claude: CLAUDE_MODELS, codex: CODEX_MODELS };

const CATALOG = [
  catalogEntry(SNAPSHOT[0], { models: CLAUDE_MODELS, error: null }, { modes: CLAUDE_MODES }),
  catalogEntry(SNAPSHOT[1], { models: CODEX_MODELS, error: null }, { modes: CODEX_MODES }),
  catalogEntry(SNAPSHOT[2]),
  catalogEntry(SNAPSHOT[4]),
];
const [CLAUDE, CODEX_RUNTIME] = CATALOG;
const asked = (result) => result.ask?.data.needs_clarification;

test("catalogEntry: a provider Paseo can start has its models and modes, the others say why not", () => {
  assert.equal(CLAUDE.available, true);
  assert.equal(CLAUDE.models.length, 7);
  assert.equal(CLAUDE.modes.length, 5);
  assert.deepEqual([CATALOG[2].available, CATALOG[2].error], [false, "not installed or not set up"]);
  assert.deepEqual([CATALOG[3].available, CATALOG[3].error, CATALOG[3].models], [false, "agy not found on PATH", []]);
  const failed = catalogEntry(SNAPSHOT[1], { error: "Failed to list models for codex" });
  assert.deepEqual([failed.available, failed.error], [false, "Failed to list models for codex"]);
});

test("pickModel: ids are matched whole, never by prefix", () => {
  assert.equal(pickModel(CATALOG, "claude-opus-5").model.id, "claude-opus-5", "Opus 5, not Opus 5.5 listed before it");
  assert.equal(pickModel(CATALOG, "claude-opus-5-5").model.id, "claude-opus-5-5");
  assert.equal(pickModel(CATALOG, "claude-sonnet-5[1m]").model.id, "claude-sonnet-5[1m]");
  assert.equal(pickModel(CATALOG, "claude-fable-5[1m]").model.id, "claude-fable-5", "an alias");
  assert.equal(pickModel(CATALOG, "GPT-6.1-SOL").provider.id, "codex");
});

test("pickModel: names as listed or as said, and a word that tells one apart", () => {
  assert.equal(pickModel(CATALOG, "Opus 5.5").model.id, "claude-opus-5-5");
  assert.equal(pickModel(CATALOG, "opus 5").model.id, "claude-opus-5");
  assert.equal(pickModel(CATALOG, "Sonnet 5 1M").model.id, "claude-sonnet-5[1m]");
  assert.equal(pickModel(CATALOG, "gpt 6.1 sol").model.id, "gpt-6.1-sol");
  assert.equal(pickModel(CATALOG, "claude opus 5.5").model.id, "claude-opus-5-5", "the id spoken as words");
  assert.equal(pickModel(CATALOG, "Astra").model.id, "gpt-6-astra");
  assert.equal(pickModel(CATALOG, "haiku").model.id, "claude-haiku-4-5", "the only Haiku here");
});

test("pickModel: a name that fits several, or none, comes back with the choices", () => {
  const sonnet = pickModel(CATALOG, "sonnet");
  assert.deepEqual(asked(sonnet).candidates, ["claude-sonnet-5-5", "claude-sonnet-5", "claude-sonnet-5[1m]"]);
  assert.match(sonnet.ask.text, /Several models could match "sonnet"/);
  assert.match(sonnet.ask.text, /- Sonnet 5\.5 \(claude-sonnet-5-5\), Claude/);
  assert.deepEqual(asked(pickModel(CATALOG, "luna")).candidates, ["gpt-6-luna", "gpt-5.6-luna"]);
  const unknown = pickModel(CATALOG, "gemini 3");
  assert.equal(asked(unknown).kind, "model");
  assert.equal(asked(unknown).candidates.length, 11, "every model, to map a spoken name without asking");
  assert.match(unknown.ask.text, /No model matches "gemini 3"/);
  assert.match(unknown.ask.text, /GPT-6-Astra \(gpt-6-astra\), Codex/);
  assert.equal(asked(pickModel([CLAUDE], "gpt-6.1-sol")).kind, "model", "only the runtime asked for is searched");
});

test("pickModel: the numbers said must match too", () => {
  assert.equal(asked(pickModel([CODEX_RUNTIME], "Sonnet 5.5")).kind, "model", "not GPT-5.6-Luna by its 5 and 5");
  assert.equal(asked(pickModel([CODEX_RUNTIME], "claude-sonnet-5-5")).kind, "model");
  assert.equal(pickModel(CATALOG, "gpt 6.1").model.id, "gpt-6.1-sol");
  assert.equal(pickModel(CATALOG, "luna 5").model.id, "gpt-5.6-luna");
  assert.equal(asked(pickModel(CATALOG, "luna 6")).candidates.length, 2, "GPT-6-Luna and GPT-5.6-Luna both hold a 6");
});

test("pickProvider: an id, a name, or a phrase holding one", () => {
  assert.equal(pickProvider(CATALOG, "codex").provider.id, "codex");
  assert.equal(pickProvider(CATALOG, "Claude").provider.id, "claude");
  assert.equal(pickProvider(CATALOG, "Claude Code").provider.id, "claude", "not Codex, though code ~ codex");
  assert.equal(pickProvider(CATALOG, "OpenAI Codex").provider.id, "codex");
  const copilot = pickProvider(CATALOG, "copilot");
  assert.match(copilot.ask.text, /Copilot is not available in Paseo: not installed or not set up\. Paseo can start: Claude \(claude\), Codex \(codex\)\./);
  assert.deepEqual(asked(copilot).candidates, ["claude", "codex"]);
  assert.match(pickProvider(CATALOG, "antigravity").ask.text, /agy not found on PATH/);
  assert.match(pickProvider(CATALOG, "gemini").ask.text, /No agent runtime in Paseo matches "gemini"/);
});

test("pickThinking and pickMode take ids or names, only what the model or runtime offers", () => {
  const opus = CLAUDE.models[0];
  assert.equal(pickThinking(opus, "Extra High").thinking, "xhigh");
  assert.equal(pickThinking(opus, "ultra code").thinking, "ultracode");
  const off = pickThinking(opus, "off");
  assert.deepEqual(asked(off).candidates, NO_OFF, "Opus 5.5 cannot turn thinking off");
  assert.match(off.ask.text, /Opus 5\.5 has no thinking level "off"\. Its levels: low, medium, high, xhigh, max, ultracode/);
  assert.match(pickThinking(CLAUDE.models.at(-1), "high").ask.text, /Haiku 4\.5 offers no thinking levels/);
  assert.equal(pickThinking(CODEX_RUNTIME.models[0], "ultra").thinking, "ultra");
  assert.equal(pickMode(CODEX_RUNTIME, "Full Access").mode, "full-access");
  assert.equal(pickMode(CODEX_RUNTIME, "auto review").mode, "auto-review");
  assert.equal(pickMode(CLAUDE, "bypass").mode, "bypassPermissions");
  const bypass = pickMode(CODEX_RUNTIME, "bypassPermissions");
  assert.deepEqual(asked(bypass).candidates, ["auto", "auto-review", "full-access"]);
  assert.match(bypass.ask.text, /Codex has no mode "bypassPermissions"\. Its modes: auto \(Default Permissions\), auto-review \(Auto-review\), full-access \(Full Access\)/);
});

test("chooseStart: the runtime is the one named, else the model's, else Claude", () => {
  const plain = chooseStart(CATALOG).choice;
  assert.deepEqual([plain.provider.id, plain.model, plain.thinking, plain.mode], ["claude", null, undefined, undefined]);
  const astra = chooseStart(CATALOG, { model: "GPT-6-Astra", thinking: "high", mode: "full access" }).choice;
  assert.deepEqual([astra.provider.id, astra.model.id, astra.thinking, astra.mode], ["codex", "gpt-6-astra", "high", "full-access"]);
  const codex = chooseStart(CATALOG, { provider: "codex" }).choice;
  assert.deepEqual([codex.provider.id, codex.model], ["codex", null], "the runtime's own default model");
  assert.equal(asked(chooseStart(CATALOG, { provider: "claude", model: "gpt-6.1-sol" })).kind, "model");
  assert.equal(asked(chooseStart(CATALOG, { thinking: "ultra" })).kind, "thinking", "checked against Claude's default model");
  assert.equal(asked(chooseStart(CATALOG, { provider: "codex", mode: "plan" })).kind, "mode");
  const none = chooseStart([CATALOG[2], CATALOG[3]]);
  assert.match(none.ask.text, /Paseo cannot start any agent now \(Copilot: not installed or not set up; Antigravity: agy not found on PATH\)/);
});

test("chooseStart: the site's defaults apply where they fit, and never stop a chat", () => {
  // The settings this Mac had on 2026-10-20: thinking max, mode bypassPermissions.
  const defaults = { thinking: "max", mode: "bypassPermissions" };
  const claude = chooseStart(CATALOG, {}, defaults).choice;
  assert.deepEqual([claude.provider.id, claude.thinking, claude.mode], ["claude", "max", "bypassPermissions"]);
  const codex = chooseStart(CATALOG, { model: "gpt-6.1-sol" }, defaults).choice;
  assert.deepEqual([codex.provider.id, codex.thinking, codex.mode], ["codex", "max", undefined], "a Claude mode is left out of a Codex chat");
  const haiku = chooseStart(CATALOG, { model: "Haiku 4.5" }, defaults).choice;
  assert.deepEqual([haiku.model.id, haiku.thinking], ["claude-haiku-4-5", undefined]);
  const user = chooseStart(CATALOG, { model: "Opus 5", thinking: "off", mode: "plan" }, defaults).choice;
  assert.deepEqual([user.thinking, user.mode], ["off", "plan"], "the user's choices win");
  assert.equal(chooseStart(CATALOG, {}, { model: "gpt-6-luna" }).choice.model.id, "gpt-6-luna", "a default model brings its runtime");
  assert.equal(chooseStart(CATALOG, { provider: "codex" }, { model: "claude-sonnet-5-5" }).choice.model, null, "another runtime's default model is left out");
  assert.equal(chooseStart(CATALOG, {}, { model: "no-such-model", thinking: "nonsense", mode: "yolo" }).choice.provider.id, "claude");
});

test("runtimeOf names what Paseo reports on the created agent", () => {
  const choice = chooseStart(CATALOG, { model: "gpt-6.1-sol" }, { thinking: "max" }).choice;
  const created = runtimeOf(choice, { provider: "codex", model: "gpt-6.1-sol", thinkingOptionId: "max", currentModeId: "auto-review" });
  assert.equal(created.text, "Codex, GPT-6.1-Sol, thinking max, mode Auto-review");
  assert.deepEqual(created.data, { provider: "codex", model: "gpt-6.1-sol", thinking: "max", mode: "auto-review" });
  const plain = runtimeOf(chooseStart(CATALOG).choice, { provider: "claude", model: null, currentModeId: "default" });
  assert.equal(plain.text, "Claude, its default model, mode Always Ask");
  assert.deepEqual(plain.data, { provider: "claude", model: null, thinking: null, mode: "default" });
  assert.equal(runtimeOf(chooseStart(CATALOG, { model: "Opus 5.5", thinking: "xhigh" }).choice, {}).text, "Claude, Opus 5.5, thinking Extra High");
});

test("modelsText and modelsData: models with their levels, the defaults marked, and what is out of reach", () => {
  const text = modelsText(CATALOG);
  assert.match(text, /^Paseo can start Claude, Codex chats\./);
  assert.match(text, /Claude \(claude\), modes: plan, default, acceptEdits, auto, bypassPermissions\./);
  assert.match(text, /- Opus 5\.5 \(claude-opus-5-5\), default; thinking low, medium\*, high, xhigh, max, ultracode/);
  assert.match(text, /- Haiku 4\.5 \(claude-haiku-4-5\)\n/);
  assert.match(text, /- GPT-6\.1-Sol \(gpt-6\.1-sol\), default; thinking low\*, medium, high, xhigh, max, ultra/);
  assert.match(text, /Not available: Copilot \(not installed or not set up\), Antigravity \(agy not found on PATH\)\.$/);
  const [claude, codex, copilot] = modelsData(CATALOG);
  assert.deepEqual(claude.models[0], {
    id: "claude-opus-5-5",
    name: "Opus 5.5",
    description: "Opus 5.5 · Latest release",
    default: true,
    thinking: NO_OFF,
    default_thinking: "medium",
  });
  assert.deepEqual(claude.models.at(-1).thinking, []);
  assert.equal(claude.models.filter((m) => m.default).length, 1);
  assert.deepEqual(codex.modes.map((m) => m.id), ["auto", "auto-review", "full-access"]);
  assert.deepEqual([copilot.available, copilot.reason, copilot.models], [false, "not installed or not set up", []]);
});

// ---- Against a fake daemon client ---------------------------------------------------------------

const PROJECT = { projectDisplayName: "god-mode-models", projectRootPath: "/Users/r/sandbox/god-mode-models" };
const NEW_ID = "7d3f1c2a-9b8e-4f60-a1b2-c3d4e5f60718";

function fakeClient({ created = {} } = {}) {
  const calls = [];
  return {
    calls,
    async listProjects() {
      return { projects: [PROJECT] };
    },
    async getProvidersSnapshot(options) {
      calls.push(["snapshot", options]);
      return { entries: SNAPSHOT };
    },
    async listProviderModels(provider, options) {
      calls.push(["models", provider, options]);
      return { provider, models: LISTED[provider], error: null };
    },
    async listProviderModes(provider) {
      return { provider, modes: SNAPSHOT.find((e) => e.provider === provider).modes, error: null };
    },
    async createAgent(options) {
      calls.push(["create", options]);
      return { id: NEW_ID, provider: options.provider, model: options.model ?? null, thinkingOptionId: options.thinkingOptionId ?? null, currentModeId: options.modeId ?? null, ...created };
    },
    async waitForFinish() {
      return { status: "idle", lastMessage: "OK" };
    },
  };
}

test("startChatOn starts a Codex chat on the model asked for, with the defaults that fit", async () => {
  const client = fakeClient({ created: { currentModeId: "auto-review" } });
  const result = await startChatOn(client, {
    project: "god-mode-models",
    prompt: "Reply OK.",
    model: "GPT-6.1-Sol",
    defaults: { thinking: "max", mode: "bypassPermissions" },
    waitSeconds: 5,
  });
  assert.deepEqual(client.calls.find((c) => c[0] === "snapshot")[1], { cwd: PROJECT.projectRootPath }, "the project's own catalog");
  assert.deepEqual(client.calls.find((c) => c[0] === "create")[1], {
    provider: "codex",
    cwd: PROJECT.projectRootPath,
    initialPrompt: "Reply OK.",
    model: "gpt-6.1-sol",
    thinkingOptionId: "max",
    labels: { source: "god-mode" },
  });
  assert.match(result.text, /^Started a new chat in god-mode-models \(Codex, GPT-6\.1-Sol, thinking max, mode Auto-review\); the task arrived\. Do not start it again\./);
  assert.deepEqual(
    { provider: result.data.provider, model: result.data.model, thinking: result.data.thinking, mode: result.data.mode, outcome: result.data.outcome, delivered: result.data.delivered },
    { provider: "codex", model: "gpt-6.1-sol", thinking: "max", mode: "auto-review", outcome: "replied", delivered: true },
  );
});

test("startChatOn: a model Paseo does not offer starts nothing", async () => {
  const client = fakeClient();
  const result = await startChatOn(client, { project: "god-mode-models", prompt: "Reply OK.", provider: "claude", model: "gpt-6.1-sol" });
  assert.equal(result.data.needs_clarification.kind, "model");
  assert.match(result.text, /No model matches "gpt-6\.1-sol"/);
  assert.equal(client.calls.filter((c) => c[0] === "create").length, 0);
});

test("listModelsOn reads the catalog Paseo offers everywhere, or one runtime's part of it", async () => {
  const client = fakeClient();
  const all = await listModelsOn(client, {});
  assert.deepEqual(client.calls[0], ["snapshot", {}]);
  assert.deepEqual(all.data.providers.map((p) => p.id), ["claude", "codex", "copilot", "antigravity"], "a disabled provider is left out");
  assert.deepEqual(client.calls.filter((c) => c[0] === "models").map((c) => c[1]), ["claude", "codex"], "only what Paseo can start is listed");
  const codex = await listModelsOn(fakeClient(), { provider: "Codex" });
  assert.deepEqual(codex.data.providers.map((p) => p.id), ["codex"]);
  assert.match(codex.text, /^Paseo can start Codex chats\./);
  assert.equal((await listModelsOn(fakeClient(), { provider: "copilot" })).data.needs_clarification.kind, "provider");
});
