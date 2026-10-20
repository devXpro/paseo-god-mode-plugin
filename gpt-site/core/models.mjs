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
