// The voice buttons, reduced to one switch each: on, Paseo shows a button that opens ChatGPT's own
// voice chat, or starts Claude's voice mode. Everything else keeps its default: ChatGPT's own shortcut
// on a Mac and on an iPhone the Apple Shortcut named after the button; Claude's voice mode button
// pressed through Accessibility on a Mac and a new Claude chat on a phone.
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsRow, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { claudeVoiceStatusRpc, defaultClaudeVoiceSettings, getClaudeVoiceRpc, setClaudeVoiceRpc } from "../shared/claude-voice.ts";
import { defaultVoiceButtonSettings, getVoiceButtonRpc, setVoiceButtonRpc } from "../shared/voice-button.ts";
import { publishClaudeVoice, publishVoiceButton } from "./voice-button.tsx";

const SETTINGS_KEY = ["god-mode", "voice-button"];
const errorText = (error: unknown) => String((error as Error)?.message ?? error);

export function VoiceButtonStep(_props: { theme: PluginTheme }) {
  const get = useRpc(getVoiceButtonRpc);
  const set = useRpc(setVoiceButtonRpc);
  const queryClient = useQueryClient();
  const loaded = useQuery({ queryKey: SETTINGS_KEY, queryFn: () => get({}) });
  const save = useMutation({
    mutationFn: (enabled: boolean) => set({ settings: { ...(loaded.data?.settings ?? defaultVoiceButtonSettings()), enabled } }),
    onSuccess: ({ settings }) => {
      publishVoiceButton(settings);
      void queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
    },
  });
  return (
    <SettingsSection title="Voice button">
      <SettingsCard>
        <SettingsSwitch
          label="ChatGPT voice in Paseo"
          hint="A button in Paseo that opens ChatGPT's voice chat."
          value={loaded.data?.settings.enabled ?? false}
          disabled={!loaded.data || save.isPending}
          onValueChange={(value) => save.mutate(value)}
          error={loaded.isError ? errorText(loaded.error) : save.isError ? errorText(save.error) : null}
        />
        {loaded.isPending ? <SettingsRow label="Loading…" /> : null}
      </SettingsCard>
      <ClaudeVoiceStep theme={_props.theme} />
    </SettingsSection>
  );
}

const CLAUDE_KEY = ["god-mode", "claude-voice"];
const CLAUDE_STATUS_KEY = ["god-mode", "claude-voice", "status"];

/** One switch: on, Paseo shows a button that starts Claude's voice mode in the Claude app. */
export function ClaudeVoiceStep(_props: { theme: PluginTheme }) {
  const get = useRpc(getClaudeVoiceRpc);
  const set = useRpc(setClaudeVoiceRpc);
  const status = useRpc(claudeVoiceStatusRpc);
  const queryClient = useQueryClient();
  const loaded = useQuery({ queryKey: CLAUDE_KEY, queryFn: () => get({}) });
  const mac = useQuery({ queryKey: CLAUDE_STATUS_KEY, queryFn: () => status({}), enabled: loaded.data?.settings.enabled === true });
  const save = useMutation({
    mutationFn: (enabled: boolean) => set({ settings: { ...(loaded.data?.settings ?? defaultClaudeVoiceSettings()), enabled } }),
    onSuccess: ({ settings }) => {
      publishClaudeVoice(settings);
      void queryClient.invalidateQueries({ queryKey: CLAUDE_KEY });
    },
  });
  const warning =
    mac.data?.platform === "darwin" && !mac.data.claude
      ? "The Claude app is not in Applications."
      : mac.data?.accessibilityTrusted === false
        ? "Allow Paseo in System Settings → Privacy & Security → Accessibility, or you tap Claude's voice button yourself."
        : null;
  return (
    <SettingsCard>
      <SettingsSwitch
        label="Claude voice in Paseo"
        hint="A button in Paseo that starts Claude's voice mode in the Claude app."
        value={loaded.data?.settings.enabled ?? false}
        disabled={!loaded.data || save.isPending}
        onValueChange={(value) => save.mutate(value)}
        error={loaded.isError ? errorText(loaded.error) : save.isError ? errorText(save.error) : null}
      />
      {warning ? <SettingsRow label="Claude voice" error={warning} /> : null}
    </SettingsCard>
  );
}
