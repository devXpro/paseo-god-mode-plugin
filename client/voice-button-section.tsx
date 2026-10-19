// The voice button's settings: whether it shows, what it is called, where it appears and how it
// starts ChatGPT's voice chat on a Mac and an iPhone.
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import {
  type VoiceButtonMacMode,
  type VoiceButtonPlacement,
  type VoiceButtonSettings,
  getVoiceButtonRpc,
  setVoiceButtonRpc,
  voiceButtonLaunchRpc,
  voiceButtonSchema,
  voiceButtonStatusRpc,
  voiceSlashName,
} from "../shared/voice-button.ts";
import { launchVoice, publishVoiceButton } from "./voice-button.tsx";

const TITLE = "6 · Voice button";
const SETTINGS_KEY = ["god-mode", "voice-button"];
const STATUS_KEY = ["god-mode", "voice-button", "status"];

const MAC_MODES: { label: string; value: VoiceButtonMacMode }[] = [
  { label: "Press ChatGPT's voice shortcut", value: "auto" },
  { label: "Press this shortcut", value: "hotkey" },
  { label: "Open ChatGPT, tap voice yourself", value: "open" },
  { label: "Run an Apple Shortcut", value: "shortcut" },
];

const PLACES: { place: VoiceButtonPlacement; label: string; hint: string }[] = [
  { place: "chats", label: "In every chat", hint: "A pill beside the message box." },
  { place: "header", label: "In workspace headers", hint: "Also covers a new chat, which has no pill yet." },
  { place: "sidebar", label: "In the sidebar", hint: "At the bottom, on every screen." },
  { place: "commandCenter", label: "In the Command Center", hint: "⌘K, then its name." },
  { place: "slashCommand", label: "As a slash command", hint: "" },
];

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function VoiceButtonStep({ theme }: { theme: PluginTheme }) {
  const get = useRpc(getVoiceButtonRpc);
  const set = useRpc(setVoiceButtonRpc);
  const status = useRpc(voiceButtonStatusRpc);
  const launch = useRpc(voiceButtonLaunchRpc);
  const toast = useToast();
  const queryClient = useQueryClient();
  const loaded = useQuery({ queryKey: SETTINGS_KEY, queryFn: () => get({}) });
  const mac = useQuery({ queryKey: STATUS_KEY, queryFn: () => status({}) });
  const [draft, setDraft] = useState<VoiceButtonSettings | null>(null);
  useEffect(() => {
    if (loaded.data) setDraft(loaded.data.settings);
  }, [loaded.data]);
  const save = useMutation({
    mutationFn: (settings: VoiceButtonSettings) => set({ settings }),
    onSuccess: ({ settings }) => {
      publishVoiceButton(settings);
      void queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
    },
  });
  const muted = { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18, paddingHorizontal: 4 };
  const value = { color: theme.colors.foreground };

  if (!draft) {
    return (
      <SettingsSection title={TITLE}>
        <SettingsCard>
          {loaded.isError ? <SettingsRow label="Could not load" error={errorText(loaded.error)} /> : <View style={{ padding: 16, alignItems: "center" }}><ActivityIndicator color={theme.colors.accent} /></View>}
        </SettingsCard>
      </SettingsSection>
    );
  }
  const patch = (change: Partial<VoiceButtonSettings>) => setDraft({ ...draft, ...change });
  const valid = voiceButtonSchema.safeParse(draft).success;
  const dirty = JSON.stringify(draft) !== JSON.stringify(loaded.data?.settings);
  const info = mac.data;
  const detected = info?.detectedHotkey;

  return (
    <SettingsSection title={TITLE}>
      <SettingsCard>
        <SettingsSwitch
          label="Show the voice button"
          hint="One tap opens ChatGPT's own voice chat, with your account, memory and God Mode."
          value={draft.enabled}
          onValueChange={(enabled) => patch({ enabled })}
        />
        <SettingsInput
          label="Name"
          hint={`Up to 24 characters. Slash command: /${voiceSlashName(draft.name)}`}
          initialValue={draft.name}
          error={draft.name.trim() ? null : "Give it a name"}
          onChangeText={(name) => patch({ name })}
        />
      </SettingsCard>

      {draft.enabled ? (
        <SettingsCard>
          {PLACES.map(({ place, label, hint }) => (
            <SettingsSwitch
              key={place}
              label={label}
              hint={hint || undefined}
              value={draft.placements[place]}
              onValueChange={(on) => patch({ placements: { ...draft.placements, [place]: on } })}
            />
          ))}
        </SettingsCard>
      ) : null}

      {draft.enabled ? (
        <SettingsCard>
          <SettingsSelect label="On a Mac" value={draft.macMode} options={MAC_MODES} onValueChange={(macMode) => patch({ macMode })} />
          {draft.macMode === "auto" || draft.macMode === "hotkey" ? (
            <SettingsInput
              label="Shortcut"
              hint={
                draft.macMode === "auto"
                  ? `Empty: ChatGPT's own${detected ? `, now ${detected.key}` : ""}. Set "Voice chat shortcut" in ChatGPT → Settings → General to start voice from anywhere.`
                  : 'Such as "ctrl+shift+v": cmd, shift, ctrl, option and a key.'
              }
              placeholder={detected?.key ?? "ctrl+shift+v"}
              initialValue={draft.macHotkey}
              onChangeText={(macHotkey) => patch({ macHotkey: macHotkey.trim() })}
            />
          ) : null}
          {draft.macMode === "shortcut" ? (
            <SettingsInput label="Mac shortcut" hint="Empty: the button's name." initialValue={draft.macShortcutName} onChangeText={(macShortcutName) => patch({ macShortcutName })} />
          ) : null}
          <SettingsInput
            label="iPhone shortcut"
            hint={`Empty: "${draft.name}". In Shortcuts, make one with ChatGPT's voice conversation action and this name.`}
            initialValue={draft.iosShortcutName}
            onChangeText={(iosShortcutName) => patch({ iosShortcutName })}
          />
        </SettingsCard>
      ) : null}

      {draft.enabled && info ? (
        <SettingsCard>
          <SettingsRow label="ChatGPT on this Mac" error={info.platform === "darwin" && !info.chatgpt ? "Not installed" : undefined}>
            <Text style={value}>{info.chatgpt ? info.chatgpt.version : info.platform === "darwin" ? "" : "Not a Mac"}</Text>
          </SettingsRow>
          <SettingsRow
            label="Paseo may press keys"
            hint={info.accessibilityTrusted ? undefined : "System Settings → Privacy & Security → Accessibility → Paseo. Without it the button opens ChatGPT and you tap voice."}
          >
            <Text style={value}>{info.accessibilityTrusted ? "Yes" : "No"}</Text>
          </SettingsRow>
          {detected ? (
            <SettingsRow label="ChatGPT's voice shortcut" hint={detected.command === "realtimeVoice" ? "Starts voice from anywhere." : "Toggles voice in the open ChatGPT chat."}>
              <Text style={value}>{detected.key}</Text>
            </SettingsRow>
          ) : null}
          <SettingsAction
            label="Try it"
            actionLabel="Talk"
            disabled={dirty}
            hint={dirty ? "Save first." : undefined}
            onPress={() => {
              launchVoice(launch)
                .then((r) => toast.show(r.message, { variant: r.needsOneTap ? "info" : "success" }))
                .catch((error: unknown) => toast.error(errorText(error)));
            }}
          />
          <SettingsAction label="Check again" actionLabel={mac.isFetching ? "Checking…" : "Run"} disabled={mac.isFetching} onPress={() => void mac.refetch()} />
        </SettingsCard>
      ) : null}

      <SettingsCard>
        <SettingsAction
          label={dirty ? "Unsaved changes" : "Saved on this Mac"}
          actionLabel={save.isPending ? "Saving…" : "Save"}
          disabled={!dirty || !valid || save.isPending}
          onPress={() => save.mutate(voiceButtonSchema.parse(draft))}
        />
      </SettingsCard>
      <Text style={muted}>OpenAI offers no link that opens ChatGPT voice, so on a Mac the button presses ChatGPT's own shortcut. Other devices see changes the next time Paseo loads.</Text>
      {save.isError ? <Text style={{ ...muted, color: theme.colors.statusDanger }}>{errorText(save.error)}</Text> : null}
    </SettingsSection>
  );
}
