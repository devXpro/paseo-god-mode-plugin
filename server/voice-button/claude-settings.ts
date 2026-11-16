// The Claude voice button's settings, on this Mac only: nothing here reaches Claude.
import { join } from "node:path";
import { type ClaudeVoiceSettings, claudeVoiceSchema, defaultClaudeVoiceSettings } from "../../shared/claude-voice.ts";
import { dataDir, readJson, writeJson } from "../store.ts";

const file = () => join(dataDir(), "claude-voice.json");

export async function readClaudeVoice(): Promise<ClaudeVoiceSettings> {
  const stored = await readJson<unknown>(file(), null);
  const parsed = claudeVoiceSchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : defaultClaudeVoiceSettings();
}

export async function writeClaudeVoice(settings: ClaudeVoiceSettings): Promise<ClaudeVoiceSettings> {
  const parsed = claudeVoiceSchema.parse(settings);
  await writeJson(file(), parsed);
  return parsed;
}
