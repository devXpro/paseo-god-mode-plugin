// The voice buttons' settings: for each one a switch, and once it is on a summary row that opens its name
// and where it shows.
// ChatGPT's button opens ChatGPT's own voice chat (its own shortcut on a Mac, on an iPhone the Apple
// Shortcut named after the button); Claude's presses Claude's voice mode button through Accessibility
// on a Mac and opens a new Claude chat on a phone.
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { type ClaudeVoiceSettings, claudeVoiceStatusRpc, getClaudeVoiceRpc, setClaudeVoiceRpc } from "../shared/claude-voice.ts";
import { type VoiceButtonSettings, getVoiceButtonRpc, setVoiceButtonRpc } from "../shared/voice-button.ts";
import { publishClaudeVoice, publishVoiceButton, voiceSlashFor } from "./voice-button.tsx";

const errorText = (error: unknown) => String((error as Error)?.message ?? error);

type Placement = keyof VoiceButtonSettings["placements"];
type ButtonSettings = VoiceButtonSettings | ClaudeVoiceSettings;

const PLACEMENTS: { key: Placement; label: string; hint: string }[] = [
  { key: "header", label: "Workspace header", hint: "A button at the top of every workspace." },
  { key: "chats", label: "Every chat", hint: "A pill above the message box of every chat." },
  { key: "sidebar", label: "Sidebar", hint: "A row at the bottom of the sidebar." },
  { key: "commandCenter", label: "Command Center", hint: "An item in Command Center." },
  { key: "slashCommand", label: "Slash command", hint: "A command typed in a chat." },
];

/** A name a button can take: what the schema allows, so the input never saves one the daemon refuses. */
const nameProblem = (name: string) => (!name.trim() ? "Give the button a name." : name.trim().length > 24 ? "At most 24 characters." : null);

function VoiceButtonCard<S extends ButtonSettings>(props: {
  title: string;
  hint: string;
  settings: S | undefined;
  loadError: unknown;
  save: (settings: S) => void;
  saving: boolean;
  saveError: unknown;
  slashFor: (name: string) => string;
  placeholder: string;
  warning?: string | null;
}) {
  const { settings } = props;
  const [name, setName] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The name is saved after a pause; by then a switch may have changed, so it merges into the latest.
  const latest = useRef(settings);
  latest.current = settings;
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const change = (patch: Partial<S>) => {
    if (latest.current) props.save({ ...latest.current, ...patch });
  };
  // Saved half a second after the last key, so the buttons are not renamed letter by letter.
  const typeName = (text: string) => {
    setName(text);
    if (timer.current) clearTimeout(timer.current);
    if (nameProblem(text)) return;
    timer.current = setTimeout(() => change({ name: text.trim() } as Partial<S>), 500);
  };
  const shownName = name ?? settings?.name ?? "";
  const slash = props.slashFor(shownName);

  return (
    <SettingsCard>
      <SettingsSwitch
        label={props.title}
        hint={props.hint}
        value={settings?.enabled ?? false}
        disabled={!settings || props.saving}
        onValueChange={(enabled) => change({ enabled } as Partial<S>)}
        error={props.loadError ? errorText(props.loadError) : props.saveError ? errorText(props.saveError) : null}
      />
      {!settings && !props.loadError ? <SettingsRow label="Loading…" /> : null}
      {props.warning ? <SettingsRow label="Needs attention" error={props.warning} /> : null}
      {settings?.enabled ? (
        <SettingsAction
          label={shownName.trim() || settings.name}
          hint={PLACEMENTS.filter((p) => settings.placements[p.key]).map((p) => (p.key === "slashCommand" ? `/${slash}` : p.label)).join(", ") || "Shown nowhere"}
          actionLabel={open ? "Done" : "Edit"}
          onPress={() => setOpen(!open)}
        />
      ) : null}
      {settings?.enabled && open ? (
        <>
          <SettingsInput
            label="Name"
            hint="On the button and in Command Center; one plain word is also its slash command."
            initialValue={settings.name}
            placeholder={props.placeholder}
            onChangeText={typeName}
            error={name === null ? null : nameProblem(name)}
          />
          {PLACEMENTS.map((p) => (
            <SettingsSwitch
              key={p.key}
              label={p.key === "slashCommand" ? `Slash command /${slash}` : p.label}
              hint={p.hint}
              value={settings.placements[p.key]}
              disabled={props.saving}
              onValueChange={(value) => change({ placements: { ...settings.placements, [p.key]: value } } as Partial<S>)}
            />
          ))}
        </>
      ) : null}
    </SettingsCard>
  );
}

const CHATGPT_KEY = ["god-mode", "voice-button"];
const CLAUDE_KEY = ["god-mode", "claude-voice"];
const CLAUDE_STATUS_KEY = ["god-mode", "claude-voice", "status"];

function ChatGptVoiceCard() {
  const get = useRpc(getVoiceButtonRpc);
  const set = useRpc(setVoiceButtonRpc);
  const queryClient = useQueryClient();
  const loaded = useQuery({ queryKey: CHATGPT_KEY, queryFn: () => get({}) });
  const save = useMutation({
    mutationFn: (settings: VoiceButtonSettings) => set({ settings }),
    onSuccess: ({ settings }) => {
      publishVoiceButton(settings);
      queryClient.setQueryData(CHATGPT_KEY, { settings });
    },
  });
  return (
    <VoiceButtonCard
      title="ChatGPT voice in Paseo"
      hint="A button in Paseo that opens ChatGPT's voice chat. On an iPhone it runs the Apple Shortcut named after the button."
      settings={loaded.data?.settings}
      loadError={loaded.isError ? loaded.error : null}
      save={(settings) => save.mutate(settings)}
      saving={save.isPending}
      saveError={save.isError ? save.error : null}
      slashFor={voiceSlashFor.chatgpt}
      placeholder="Jarvis"
    />
  );
}

function ClaudeVoiceCard() {
  const get = useRpc(getClaudeVoiceRpc);
  const set = useRpc(setClaudeVoiceRpc);
  const status = useRpc(claudeVoiceStatusRpc);
  const queryClient = useQueryClient();
  const loaded = useQuery({ queryKey: CLAUDE_KEY, queryFn: () => get({}) });
  const mac = useQuery({ queryKey: CLAUDE_STATUS_KEY, queryFn: () => status({}), enabled: loaded.data?.settings.enabled === true });
  const save = useMutation({
    mutationFn: (settings: ClaudeVoiceSettings) => set({ settings }),
    onSuccess: ({ settings }) => {
      publishClaudeVoice(settings);
      queryClient.setQueryData(CLAUDE_KEY, { settings });
    },
  });
  const warning =
    mac.data?.platform === "darwin" && !mac.data.claude
      ? "The Claude app is not in Applications."
      : mac.data?.accessibilityTrusted === false
        ? "Allow Paseo in System Settings → Privacy & Security → Accessibility, or you tap Claude's voice button yourself."
        : null;
  return (
    <VoiceButtonCard
      title="Claude voice in Paseo"
      hint="A button in Paseo that starts Claude's voice mode in the Claude app."
      settings={loaded.data?.settings}
      loadError={loaded.isError ? loaded.error : null}
      save={(settings) => save.mutate(settings)}
      saving={save.isPending}
      saveError={save.isError ? save.error : null}
      slashFor={voiceSlashFor.claude}
      placeholder="Claude"
      warning={warning}
    />
  );
}

export function VoiceButtonStep(_props: { theme: PluginTheme }) {
  return (
    <SettingsSection title="Voice buttons">
      <ChatGptVoiceCard />
      <ClaudeVoiceCard />
    </SettingsSection>
  );
}
