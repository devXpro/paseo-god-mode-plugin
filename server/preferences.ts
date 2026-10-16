// What the Site does for the user (language, new-chat defaults, confirmations), kept on this Mac and
// written to the Site's runtime variables, which is where gpt-site/core/mcp.mjs reads them.
import { join } from "node:path";
import { type Preferences, preferencesSchema } from "../shared/contracts.ts";
import type { EnvEntry } from "./sites/sites.ts";
import { PAIRING_KEY } from "./sites/sites.ts";
import { dataDir, readJson, writeJson } from "./store.ts";

const file = () => join(dataDir(), "preferences.json");

export async function readPreferences(): Promise<Preferences | null> {
  const stored = await readJson<unknown>(file(), null);
  return stored ? preferencesSchema.parse(stored) : null;
}

export const writePreferences = (preferences: Preferences) => writeJson(file(), preferencesSchema.parse(preferences));

const flag = (value: string | null | undefined, fallback: boolean) =>
  value == null || value === "" ? fallback : !["off", "false", "0", "no"].includes(value.toLowerCase());

/** The Site's current settings, so connecting to an existing Site keeps what it already does. */
export function fromEnvironment(entries: EnvEntry[]): Preferences {
  const get = (key: string) => entries.find((e) => e.key === key)?.value ?? "";
  const wait = Number(get("PASEO_WAIT_SECONDS"));
  return preferencesSchema.parse({
    language: get("PASEO_LANGUAGE"),
    newChatModel: get("PASEO_NEW_CHAT_MODEL"),
    newChatThinking: get("PASEO_NEW_CHAT_THINKING"),
    newChatMode: preferencesSchema.shape.newChatMode.safeParse(get("PASEO_NEW_CHAT_MODE")).data ?? "",
    waitSeconds: Number.isFinite(wait) && get("PASEO_WAIT_SECONDS") !== "" ? Math.min(25, Math.max(0, Math.round(wait))) : 15,
    confirmRisky: flag(get("PASEO_CONFIRM_RISKY"), true),
    log: flag(get("PASEO_LOG"), true),
  });
}

/** The runtime variables for these preferences. Empty values are removed rather than set empty, and
 *  only keys the Site has can be removed. */
export function toEnvironment(preferences: Preferences, pairingUrl: string, existing: EnvEntry[]) {
  const values: Record<string, string> = {
    PASEO_LANGUAGE: preferences.language,
    PASEO_NEW_CHAT_MODEL: preferences.newChatModel,
    PASEO_NEW_CHAT_THINKING: preferences.newChatThinking,
    PASEO_NEW_CHAT_MODE: preferences.newChatMode,
    PASEO_WAIT_SECONDS: String(preferences.waitSeconds),
    PASEO_CONFIRM_RISKY: preferences.confirmRisky ? "on" : "off",
    PASEO_LOG: preferences.log ? "on" : "off",
  };
  const has = new Set(existing.map((e) => e.key));
  const set = Object.entries(values)
    .filter(([, value]) => value !== "")
    .map(([key, value]) => ({ key, value, is_secret: false }));
  set.push({ key: PAIRING_KEY, value: pairingUrl, is_secret: true });
  const remove = Object.entries(values)
    .filter(([key, value]) => value === "" && has.has(key))
    .map(([key]) => key);
  return { set, remove };
}
