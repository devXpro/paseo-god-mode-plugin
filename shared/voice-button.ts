// The voice button: one tap in Paseo opens ChatGPT's own voice chat, so the conversation keeps the
// user's ChatGPT account, memory and God Mode tools. Settings stay on the daemon's Mac.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_VOICE_BUTTON_NAME = "Jarvis";

export const voiceButtonPlacements = ["chats", "header", "sidebar", "commandCenter", "slashCommand"] as const;
export type VoiceButtonPlacement = (typeof voiceButtonPlacements)[number];

export const voiceButtonSchema = z.object({
  enabled: z.boolean().default(false),
  /** The button's label, Command Center title and, when it is a plain word, slash command. */
  name: z.string().trim().min(1).max(24).default(DEFAULT_VOICE_BUTTON_NAME),
  placements: z
    .object({
      /** A pill in the composer of every chat that has an agent. */
      chats: z.boolean().default(true),
      /** A button in every workspace header, which a new chat's composer lacks a pill for. */
      header: z.boolean().default(true),
      sidebar: z.boolean().default(true),
      commandCenter: z.boolean().default(true),
      slashCommand: z.boolean().default(true),
    })
    .prefault({}),
  /**
   * auto: press ChatGPT's voice shortcut read from its settings (~/.codex/keybindings.json);
   * open: bring ChatGPT forward, the user taps its voice button; hotkey: press `macHotkey`;
   * shortcut: run the Apple Shortcut `macShortcutName`.
   */
  macMode: z.enum(["auto", "open", "hotkey", "shortcut"]).default("auto"),
  /** An accelerator such as "ctrl+shift+v". Empty in auto mode: ChatGPT's own. */
  macHotkey: z.string().trim().max(60).default(""),
  /** Empty: the button's name. */
  macShortcutName: z.string().trim().max(80).default(""),
  /** The iPhone shortcut that holds ChatGPT's voice action. Empty: the button's name. */
  iosShortcutName: z.string().trim().max(80).default(""),
});
export type VoiceButtonSettings = z.output<typeof voiceButtonSchema>;
export type VoiceButtonMacMode = VoiceButtonSettings["macMode"];

export const defaultVoiceButtonSettings = (): VoiceButtonSettings => voiceButtonSchema.parse({});

/** The slash command for a name: the name itself when it is one plain word, else "voice-chat". */
export function voiceSlashName(name: string): string {
  const word = name.trim().toLowerCase();
  return /^[a-z][a-z0-9-]{0,23}$/.test(word) ? word : "voice-chat";
}

/** Apple's documented Shortcuts URL scheme:
 *  https://support.apple.com/guide/shortcuts/run-a-shortcut-from-a-url-apd624386f42/ios */
export function shortcutRunUrl(name: string): string {
  return `shortcuts://run-shortcut?name=${encodeURIComponent(name)}`;
}

export const getVoiceButtonRpc = defineRpc({
  name: "god-mode.voice-button.get",
  input: z.object({}),
  output: z.object({ settings: voiceButtonSchema }),
});

export const setVoiceButtonRpc = defineRpc({
  name: "god-mode.voice-button.set",
  input: z.object({ settings: voiceButtonSchema }),
  output: z.object({ settings: voiceButtonSchema }),
});

const hotkeySchema = z.object({ command: z.string(), key: z.string() });

export const voiceButtonStatusRpc = defineRpc({
  name: "god-mode.voice-button.status",
  input: z.object({}),
  output: z.object({
    platform: z.string(),
    chatgpt: z.object({ bundleId: z.string(), path: z.string(), version: z.string() }).nullable(),
    /** Whether Paseo may press keys: System Settings → Privacy & Security → Accessibility. */
    accessibilityTrusted: z.boolean().nullable(),
    /** ChatGPT's voice shortcut as auto mode would press it. */
    detectedHotkey: hotkeySchema.nullable(),
    shortcuts: z.array(z.string()),
  }),
});

/** iOS opens the returned Shortcuts URL on the phone; every other client starts ChatGPT on the daemon's Mac. */
export const voiceButtonLaunchRpc = defineRpc({
  name: "god-mode.voice-button.launch",
  input: z.object({ client: z.enum(["ios", "android", "web"]) }),
  output: z.object({
    outcome: z.enum(["voice-requested", "app-opened", "open-url", "unsupported"]),
    via: z.enum(["hotkey", "shortcut", "open", "url", "none"]),
    /** True when the user still has to tap the voice button in ChatGPT. */
    needsOneTap: z.boolean(),
    url: z.string().nullable(),
    message: z.string(),
  }),
});
export type VoiceButtonLaunch = z.output<typeof voiceButtonLaunchRpc.output>;
