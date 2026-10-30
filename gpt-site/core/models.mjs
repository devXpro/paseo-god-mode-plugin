// The agent runtimes a new chat can run on, as Paseo's catalog lists them: each provider (Claude,
// Codex…) with its models, each model's thinking levels, and the provider's permission modes, the
// same lists Paseo's own New chat offers. And the matching of what the user said against them.
// Pure, so it is unit-tested in core/models.test.mjs; paseo.mjs fetches the catalog.
import { normalize, resolve, truncate } from "./text.mjs";

// The runtime a new chat gets when nothing names one, as before the catalog existed.
const DEFAULT_PROVIDER = "claude";

// Compared without case, spaces or punctuation: "GPT 6.1 Sol" is gpt-6.1-sol, "extra high" is xhigh.
const squash = (value) => normalize(value).replaceAll(" ", "");

const clarify = (kind, query, text, candidates) => ({
  ask: { text, data: { needs_clarification: { kind, query: String(query ?? ""), candidates } } },
});

// One provider of the catalog, from its entry in Paseo's providers snapshot and what Paseo listed
// for it: { models } or { error }. A provider Paseo cannot start has no models, and says why.
export function catalogEntry(entry, listedModels = {}, listedModes = {}) {
  const available = Array.isArray(listedModels.models) && !listedModels.error;
  return {
    id: entry.provider,
    label: entry.label || entry.provider,
    available,
    error: available ? null : String(listedModels.error || entry.error || "not installed or not set up"),
    models: available ? listedModels.models : [],
    modes: available ? (listedModes.modes ?? entry.modes ?? []) : [],
  };
}

// The model a chat of this provider gets when none is named, as Paseo marks it.
const defaultModel = (provider) => provider.models.find((m) => m.isDefault) ?? provider.models[0];

// The thinking level a model runs at when none is named.
const defaultLevel = (model) => model.defaultThinkingOptionId ?? model.thinkingOptions?.find((o) => o.isDefault)?.id ?? null;

// An option (a thinking level, a mode) by its id or its name: "xhigh" or "Extra High".
const findOption = (options, query) => options.find((o) => squash(o.id) === squash(query) || squash(o.label) === squash(query));

const modelLine = (provider, model) => `${model.label} (${model.id}), ${provider.label}`;

// A provider the user named, by its id ("codex"), its name, or a phrase holding either ("Claude
// Code", "OpenAI Codex"): word overlap alone would read "code" as Codex.
export function pickProvider(catalog, query) {
  const raw = String(query ?? "").trim();
  const said = normalize(raw).split(" ");
  const exact = catalog.filter((p) => p.id === raw.toLowerCase() || squash(p.label) === squash(raw));
  const named = exact.length ? exact : catalog.filter((p) => said.includes(p.id) || said.includes(squash(p.label)));
  const found = named.length === 1 ? named[0] : resolve(catalog, raw, { id: () => "", text: (p) => p.label }).match;
  const available = catalog.filter((p) => p.available);
  const names = available.map((p) => `${p.label} (${p.id})`).join(", ") || "none";
  if (!found) return clarify("provider", raw, `No agent runtime in Paseo matches "${raw}". Paseo can start: ${names}.`, available.map((p) => p.id));
  if (!found.available) {
    return clarify("provider", raw, `${found.label} is not available in Paseo: ${truncate(found.error, 150)}. Paseo can start: ${names}.`, available.map((p) => p.id));
  }
  return { provider: found };
}

// A model the user named, among the given providers' models: its id or alias, its name as listed
// ("Opus 4.8", "GPT-6-Astra"), or words that are all in one model's name ("Astra"). Ids are matched
// whole, never by prefix: "claude-opus-5" is Opus 5, not Opus 5.5. A name that fits several models
// ("Sonnet") or none comes back as a question, with the models to choose from.
export function pickModel(providers, query) {
  const raw = String(query ?? "").trim();
  const items = providers.flatMap((provider) => provider.models.map((model) => ({ provider, model })));
  const ids = (i) => [i.model.id, ...(i.model.aliases ?? [])];
  const said = normalize(raw).split(" ").filter(Boolean);
  const words = (i) => normalize(`${i.model.label} ${ids(i).join(" ")}`).split(" ");
  const byId = items.filter((i) => ids(i).some((n) => n.toLowerCase() === raw.toLowerCase()));
  const byName = items.filter((i) => [...ids(i), i.model.label].some((n) => squash(n) === squash(raw)));
  // Every word said, numbers included: plain word overlap took "Sonnet 5.5" for GPT-5.6-Luna.
  const byWords = items.filter((i) => said.length > 0 && said.every((w) => words(i).includes(w)));
  const found = [byId, byName, byWords].find((list) => list.length > 0) ?? [];
  if (found.length === 1) return found[0];
  if (found.length > 1) {
    return clarify(
      "model",
      raw,
      [`Several models could match "${raw}". Ask the user which one, then call again with its id:`, ...found.map((i) => `- ${modelLine(i.provider, i.model)}`)].join("\n"),
      found.map((i) => i.model.id),
    );
  }
  // No match: the whole list, so a spoken name can be mapped to its spelling without asking.
  return clarify(
    "model",
    raw,
    [`No model matches "${raw}". Call again with one of these ids, or ask the user:`, ...items.map((i) => `- ${modelLine(i.provider, i.model)}`)].join("\n"),
    items.map((i) => i.model.id),
  );
}

// A thinking level the model offers, by its id or name.
export function pickThinking(model, query) {
  const raw = String(query ?? "").trim();
  const options = model.thinkingOptions ?? [];
  const found = findOption(options, raw);
  if (found) return { thinking: found.id };
  if (options.length === 0) {
    return clarify("thinking", raw, `${model.label} offers no thinking levels. Ask the user whether to start it without one, then call again without thinking.`, []);
  }
  return clarify("thinking", raw, `${model.label} has no thinking level "${raw}". Its levels: ${options.map((o) => o.id).join(", ")}. Ask the user which one, then call again.`, options.map((o) => o.id));
}

// A permission mode the provider has, by its id or name.
export function pickMode(provider, query) {
  const raw = String(query ?? "").trim();
  const found = findOption(provider.modes, raw);
  if (found) return { mode: found.id };
  const modes = provider.modes.map((m) => `${m.id} (${m.label})`).join(", ") || "none";
  return clarify("mode", raw, `${provider.label} has no mode "${raw}". Its modes: ${modes}. Ask the user which one, then call again.`, provider.modes.map((m) => m.id));
}

// What a new chat runs on: the runtime, model, thinking level and mode the user asked for, checked
// against the project's catalog, plus the site's defaults where they fit. Returns { choice } or
// { ask }: something Paseo does not offer comes back to the user, and nothing starts. A default
// that does not fit (a Claude mode for a Codex chat, a model of another runtime) is left out, so the
// runtime's own default applies. The runtime: the one named, else the model's, else Claude.
export function chooseStart(catalog, requested = {}, defaults = {}) {
  const available = catalog.filter((p) => p.available);
  let provider = null;
  if (requested.provider) {
    const picked = pickProvider(catalog, requested.provider);
    if (picked.ask) return picked;
    provider = picked.provider;
  }
  const scope = provider ? [provider] : available;
  let model = null;
  if (requested.model) {
    const picked = pickModel(scope, requested.model);
    if (picked.ask) return picked;
    ({ provider, model } = picked);
  } else if (defaults.model) {
    const picked = pickModel(scope, defaults.model);
    if (!picked.ask) ({ provider, model } = picked);
  }
  provider ??= available.find((p) => p.id === DEFAULT_PROVIDER) ?? available[0];
  if (!provider) {
    const why = catalog.map((p) => `${p.label}: ${truncate(p.error, 100)}`).join("; ");
    return clarify("provider", "", `Paseo cannot start any agent now (${why || "no runtime installed"}). Tell the user.`, []);
  }
  // Paseo checks a level against the model the chat will run: the named one, else the default.
  const target = model ?? defaultModel(provider) ?? { label: provider.label };
  let thinking;
  if (requested.thinking) {
    const picked = pickThinking(target, requested.thinking);
    if (picked.ask) return picked;
    thinking = picked.thinking;
  } else if (defaults.thinking) {
    thinking = pickThinking(target, defaults.thinking).thinking;
  }
  let mode;
  if (requested.mode) {
    const picked = pickMode(provider, requested.mode);
    if (picked.ask) return picked;
    mode = picked.mode;
  } else if (defaults.mode) {
    mode = pickMode(provider, defaults.mode).mode;
  }
  return { choice: { provider, model, thinking, mode } };
}

// The new chat's runtime as Paseo reports it on the created agent, which is the truth, named for
// the user: { text: "Codex, GPT-6.1-Sol, thinking max, mode Auto-review", data }.
export function runtimeOf(choice, agent = {}) {
  const { provider } = choice;
  const modelId = agent.model ?? choice.model?.id ?? null;
  const model = provider.models.find((m) => m.id === modelId || m.aliases?.includes(modelId));
  const thinkingId = agent.effectiveThinkingOptionId ?? agent.thinkingOptionId ?? choice.thinking ?? null;
  const thinking = (model ?? choice.model ?? defaultModel(provider))?.thinkingOptions?.find((o) => o.id === thinkingId);
  const modeId = agent.currentModeId ?? choice.mode ?? null;
  const mode = provider.modes.find((m) => m.id === modeId);
  const parts = [
    provider.label,
    model?.label ?? modelId ?? "its default model",
    thinkingId && `thinking ${thinking?.label ?? thinkingId}`,
    modeId && `mode ${mode?.label ?? modeId}`,
  ];
  return {
    text: parts.filter(Boolean).join(", "),
    data: { provider: provider.id, model: modelId, thinking: thinkingId, mode: modeId },
  };
}

// list_models: what each runtime offers, for ChatGPT to read and to pass back to start_chat.
export function modelsData(providers) {
  return providers.map((p) => ({
    id: p.id,
    name: p.label,
    available: p.available,
    ...(p.available ? {} : { reason: p.error }),
    models: p.models.map((m) => ({
      id: m.id,
      name: m.label,
      ...(m.description ? { description: m.description } : {}),
      default: m === defaultModel(p),
      thinking: (m.thinkingOptions ?? []).map((o) => o.id),
      default_thinking: defaultLevel(m),
    })),
    modes: p.modes.map((m) => ({ id: m.id, name: m.label, ...(m.description ? { description: m.description } : {}) })),
  }));
}

// ---- A chat that already runs -------------------------------------------------------------------
// set_chat_model changes the model and thinking level of an existing chat. The checks are start_chat's,
// since Paseo's own setters accept any string, and the chat keeps its runtime: no Paseo request changes
// it.

// The runtimes whose model and thinking setters God Mode has read in Paseo's code. The others differ
// (OpenCode drops a thinking variant its new model lacks), so they stay out until someone reads them.
export const CHANGEABLE = ["claude", "codex"];

// The catalog's model a chat runs on, from the id Paseo reports: null when the catalog does not list it
// (a retired or custom model). A chat with no model of its own runs the runtime's default.
function currentModel(provider, modelId) {
  const listed = provider.models.find((m) => m.id === modelId || m.aliases?.includes(modelId));
  return listed ?? (modelId ? null : (defaultModel(provider) ?? null));
}

// What a change of a chat's model and thinking level comes to: the model and level asked for, checked
// against the chat's own runtime, and the level it keeps. chat is { provider, model, thinking } as Paseo
// reports it. Returns { change: { provider, model, thinking, after } }, where model is the model to set
// (null: it stays) and thinking the level (undefined: it stays, null: it is cleared), after is the model
// the chat runs on then; or { ask } for something Paseo does not offer, or { other } for a model of
// another runtime.
export function chooseChange(catalog, chat, requested = {}) {
  const own = catalog.find((p) => p.id === chat.provider);
  const current = currentModel(own, chat.model);
  let model = null;
  if (requested.model) {
    const picked = pickModel([own], requested.model);
    if (picked.ask) {
      const elsewhere = pickModel(catalog.filter((p) => p.available && p !== own), requested.model);
      return elsewhere.ask ? picked : { other: { provider: elsewhere.provider, model: elsewhere.model } };
    }
    if (picked.model.id !== current?.id) model = picked.model;
  }
  // A level is checked against the model the chat runs on after this one.
  const after = model ?? current ?? defaultModel(own);
  const name = after?.label ?? own.label;
  const levels = after?.thinkingOptions ?? [];
  let thinking;
  if (requested.thinking) {
    if (levels.length === 0) return clarify("thinking", requested.thinking, `${name} offers no thinking levels, so none can be set. Tell the user.`, []);
    const picked = pickThinking(after, requested.thinking);
    if (picked.ask) return picked;
    if (picked.thinking !== chat.thinking) thinking = picked.thinking;
  } else if (model && chat.thinking && !levels.some((o) => o.id === chat.thinking)) {
    // Paseo would keep a level the new model does not have. One with no levels at all drops it.
    if (levels.length === 0) thinking = null;
    else {
      const ids = levels.map((o) => o.id);
      return clarify("thinking", chat.thinking, `${name} has no thinking level "${chat.thinking}", which this chat runs at. Its levels: ${ids.join(", ")}. Nothing was changed: ask the user which level, then call again with the model and that level.`, ids);
    }
  }
  return { change: { provider: own, model, thinking, after } };
}

// A chat's model and thinking level in words: "Sonnet 5.5, thinking Max".
function runsOn(provider, { model, thinking }) {
  const listed = provider?.models.find((m) => m.id === model || m.aliases?.includes(model));
  const level = listed?.thinkingOptions?.find((o) => o.id === thinking);
  return [listed?.label ?? model ?? "its default model", thinking && `thinking ${level?.label ?? thinking}`].filter(Boolean).join(", ");
}

// When a change reaches a chat that is working: Paseo applies a thinking level from the next turn, a
// Codex model likewise, and a Claude model from the agent's next call to it.
function appliesLater(providerId, { model, thinking }) {
  const parts = [];
  if (model) parts.push(providerId === "claude" ? "the model applies from the agent's next call to it (a reply being written finishes on the old one)" : "the model applies from its next turn");
  if (thinking !== undefined) parts.push(thinking === null ? "the thinking level is dropped from its next turn" : "the thinking level applies from its next turn");
  return parts.join(" and ");
}

// set_chat_model's answer. outcome: changed, partial (only some of it applied), unchanged (already so),
// archived, other_runtime, unavailable or error. before and after are { model, thinking } ids as Paseo
// reports them; after is read back from Paseo, never the request echoed. change is what chooseChange
// settled on, busy whether the chat was working, notice Paseo's own note on the change.
export function changeResult({ outcome, chat, provider = null, before, after = before, change = null, busy = false, notice = null, error = null, other = null }) {
  const named = `${truncate(chat.title, 70)} (${chat.project})`;
  const runtime = provider?.label ?? chat.provider ?? "this runtime";
  const runs = runsOn(provider, after);
  const kept = "Its history is kept and no new chat was started.";
  const later = busy && change ? ` It is working now, so ${appliesLater(provider?.id, change)}.` : " The next message runs on it.";
  const text = {
    changed: `Changed ${named}: it runs on ${runs} now, it was ${runsOn(provider, before)}. ${kept}${later}`,
    partial: `Partly changed ${named}: it runs on ${runs} now, but not all of what was asked: ${error}. ${kept}`,
    unchanged: `${named} already runs on ${runs}; nothing changed.`,
    archived: `Nothing changed: ${named} is archived. Tell the user.`,
    other_runtime: other
      ? `Nothing changed: ${other.model.label} is a ${other.provider.label} model, and a ${runtime} chat cannot change its runtime, so ${named} stays on ${runs}. A chat on ${other.model.label} is a new one, start_chat, without this chat's history: ask the user.`
      : "",
    unavailable: `Nothing changed: ${error}`,
    error: `Not changed: ${error}. ${named} runs on ${runs}.`,
  }[outcome];
  return {
    text,
    data: {
      chat_id: chat.id,
      short_id: chat.id.slice(0, 7),
      project: chat.project,
      provider: provider?.id ?? chat.provider ?? "",
      outcome,
      done: outcome === "changed" || outcome === "partial",
      before: { model: before.model ?? null, thinking: before.thinking ?? null },
      after: { model: after.model ?? null, thinking: after.thinking ?? null },
      busy,
      ...(notice ? { notice } : {}),
      ...(error ? { error } : {}),
    },
  };
}

export function modelsText(providers) {
  const usable = providers.filter((p) => p.available);
  const lines = [
    usable.length
      ? `Paseo can start ${usable.map((p) => p.label).join(", ")} chats. Pass a model's id or name to start_chat; * marks a model's default thinking level.`
      : "Paseo cannot start any agent now.",
  ];
  for (const p of usable) {
    lines.push(`${p.label} (${p.id}), modes: ${p.modes.map((m) => m.id).join(", ") || "none"}.`);
    for (const m of p.models) {
      const levels = (m.thinkingOptions ?? []).map((o) => (o.id === defaultLevel(m) ? `${o.id}*` : o.id)).join(", ");
      lines.push(`- ${m.label} (${m.id})${m === defaultModel(p) ? ", default" : ""}${levels ? `; thinking ${levels}` : ""}`);
    }
  }
  const others = providers.filter((p) => !p.available);
  if (others.length) lines.push(`Not available: ${others.map((p) => `${p.label} (${truncate(p.error, 80)})`).join(", ")}.`);
  return lines.join("\n");
}
