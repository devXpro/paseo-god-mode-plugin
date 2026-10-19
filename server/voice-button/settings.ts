// The voice button's settings, on this Mac only: nothing here reaches the Site.
import { join } from "node:path";
import { type VoiceButtonSettings, defaultVoiceButtonSettings, voiceButtonSchema } from "../../shared/voice-button.ts";
import { dataDir, readJson, writeJson } from "../store.ts";

const file = () => join(dataDir(), "voice-button.json");

export async function readVoiceButton(): Promise<VoiceButtonSettings> {
  const stored = await readJson<unknown>(file(), null);
  const parsed = voiceButtonSchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : defaultVoiceButtonSettings();
}

export async function writeVoiceButton(settings: VoiceButtonSettings): Promise<VoiceButtonSettings> {
  const parsed = voiceButtonSchema.parse(settings);
  await writeJson(file(), parsed);
  return parsed;
}
