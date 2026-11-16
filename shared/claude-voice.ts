// The Claude voice button: one tap in Paseo starts Claude's own voice mode, so the conversation keeps
// the user's claude.ai account, memory and the God Mode connector. Settings stay on the daemon's Mac.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_CLAUDE_VOICE_NAME = "Claude";

export const claudeVoiceSchema = z.object({
  enabled: z.boolean().default(false),
  /** The button's label, Command Center title and, when it is a plain word, slash command. */
  name: z.string().trim().min(1).max(24).default(DEFAULT_CLAUDE_VOICE_NAME),
  placements: z
    .object({
      chats: z.boolean().default(false),
      header: z.boolean().default(true),
      sidebar: z.boolean().default(false),
      commandCenter: z.boolean().default(true),
      slashCommand: z.boolean().default(true),
    })
    .prefault({}),
  /** auto: bring Claude forward and press its voice mode button through Accessibility; open: only bring it forward. */
  macMode: z.enum(["auto", "open"]).default("auto"),
  /**
   * Which Claude desktop instance: empty is the one started without --user-data-dir; a name such as
   * "evo" is the profile whose data lives in ~/.claude-evo-data.
   */
  profile: z
    .string()
    .trim()
    .max(40)
    .regex(/^[A-Za-z0-9_-]*$/)
    .default(""),
  /** The iPhone shortcut to run instead of opening a new Claude chat. Empty: open https://claude.ai/new. */
  iosShortcutName: z.string().trim().max(80).default(""),
});
export type ClaudeVoiceSettings = z.output<typeof claudeVoiceSchema>;

export const defaultClaudeVoiceSettings = (): ClaudeVoiceSettings => claudeVoiceSchema.parse({});

/** A universal link the Claude app claims (apple-app-site-association lists /new); opens a new chat. */
export const CLAUDE_NEW_CHAT_URL = "https://claude.ai/new";

export const getClaudeVoiceRpc = defineRpc({
  name: "god-mode.claude-voice.get",
  input: z.object({}),
  output: z.object({ settings: claudeVoiceSchema }),
});

export const setClaudeVoiceRpc = defineRpc({
  name: "god-mode.claude-voice.set",
  input: z.object({ settings: claudeVoiceSchema }),
  output: z.object({ settings: claudeVoiceSchema }),
});

export const claudeVoiceStatusRpc = defineRpc({
  name: "god-mode.claude-voice.status",
  input: z.object({}),
  output: z.object({
    platform: z.string(),
    claude: z.object({ bundleId: z.string(), path: z.string(), version: z.string() }).nullable(),
    /** Whether Paseo may read and press Claude's controls: System Settings → Privacy & Security → Accessibility. */
    accessibilityTrusted: z.boolean().nullable(),
    /** Profiles found in ~/.claude-<name>-data, for the profile setting. */
    profiles: z.array(z.string()),
    /** Running instances: "" is the default one. */
    running: z.array(z.string()),
  }),
});

/** iOS opens the returned URL on the phone; every other client starts Claude on the daemon's Mac. */
export const claudeVoiceLaunchRpc = defineRpc({
  name: "god-mode.claude-voice.launch",
  input: z.object({ client: z.enum(["ios", "android", "web"]) }),
  output: z.object({
    outcome: z.enum(["voice-started", "voice-requested", "already-on", "app-opened", "open-url", "unsupported"]),
    via: z.enum(["accessibility", "open", "url", "shortcut", "none"]),
    /** True when the user still has to tap Claude's voice button. */
    needsOneTap: z.boolean(),
    url: z.string().nullable(),
    message: z.string(),
  }),
});
export type ClaudeVoiceLaunch = z.output<typeof claudeVoiceLaunchRpc.output>;
