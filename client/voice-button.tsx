// The voice buttons wherever the user put them: a pill in every chat, a button in every workspace
// header, a sidebar row, a Command Center item and a slash command. There are two, one each for
// ChatGPT's and Claude's own voice; they differ only in their settings and the RPC that launches them.
// Settings live on the daemon; each button keeps the latest copy so its settings section can apply a
// change at once.
import type { PluginButton, PluginButtonRegistration, PluginClientContext, PluginCommandCapabilities, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useSyncExternalStore } from "react";
import { Linking, Platform } from "react-native";
import { type ClaudeVoiceSettings, claudeVoiceLaunchRpc, getClaudeVoiceRpc } from "../shared/claude-voice.ts";
import { type VoiceButtonSettings, getVoiceButtonRpc, voiceButtonLaunchRpc, voiceSlashName } from "../shared/voice-button.ts";

type Client = "ios" | "android" | "web";
interface LaunchResult {
  outcome: string;
  needsOneTap: boolean;
  url: string | null;
  message: string;
}
type Launch = (input: { client: Client }) => Promise<LaunchResult>;
type Rpc = PluginCommandCapabilities["rpc"];

/** What every button's settings share. */
interface ButtonSettings {
  enabled: boolean;
  name: string;
  placements: VoiceButtonSettings["placements"];
}

interface VoiceButtonSpec<S extends ButtonSettings> {
  /** The id of its pills, header buttons and Command Center item, unique per button. */
  id: string;
  icon: string;
  /** "ChatGPT" or "Claude": shown after the name. */
  assistant: string;
  keywords: string[];
  /** A slash command name when the button's own name is not one plain word. */
  fallbackSlash: string;
  load: (rpc: Rpc) => Promise<S>;
  launch: (rpc: Rpc, input: { client: Client }) => Promise<LaunchResult>;
  /** The same launch bound by a hook, for the sidebar row. */
  useLaunch: () => Launch;
}

/** iOS opens what the daemon returns on the phone; Mac, browser and Electron ask the daemon's Mac. */
export async function launchVoice(launch: Launch): Promise<LaunchResult> {
  const client = Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "web";
  const result = await launch({ client });
  if (result.outcome === "unsupported") throw new Error(result.message);
  if (result.url) await Linking.openURL(result.url);
  return result;
}

function createVoiceButton<S extends ButtonSettings>(spec: VoiceButtonSpec<S>) {
  let current: S | null = null;
  const listeners = new Set<() => void>();

  /** Publishes saved settings to every surface of this client. */
  const publish = (settings: S) => {
    current = settings;
    for (const listener of listeners) listener();
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };

  const useSettings = () => useSyncExternalStore(subscribe, () => current);
  const slashName = (name: string) => {
    const word = voiceSlashName(name);
    return word === "voice-chat" ? spec.fallbackSlash : word;
  };

  function SidebarItem(_props: PluginSidebarItemProps) {
    const settings = useSettings();
    const launch = spec.useLaunch();
    const toast = useToast();
    if (!settings?.enabled || !settings.placements.sidebar) return null;
    return (
      <SidebarRow
        icon={spec.icon}
        label={settings.name}
        onPress={() => {
          launchVoice(launch)
            .then((r) => toast.show(r.message, { variant: r.needsOneTap ? "info" : "success" }))
            .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)));
        }}
      />
    );
  }

  function contribute(client: PluginClientContext): () => void {
    const lifetime = new AbortController();
    const agents = new Map<string, string>();
    const workspaces = new Set<string>();
    const pills = new Map<string, PluginButtonRegistration>();
    const headers = new Map<string, PluginButtonRegistration>();
    let commands: (() => void)[] = [];

    const shown = (place: keyof ButtonSettings["placements"]) => !lifetime.signal.aborted && !!current?.enabled && current.placements[place];
    const rpcLaunch = (rpc: Rpc): Launch => (input) => spec.launch(rpc, input);
    const button = (): PluginButton => ({
      title: `${current?.name}: ${spec.assistant} voice`,
      icon: spec.icon,
      label: current?.name,
      behavior: {
        kind: "action",
        async onPress() {
          await launchVoice(rpcLaunch(client.rpc));
        },
      },
    });

    const syncPill = (agentId: string) => {
      pills.get(agentId)?.remove();
      pills.delete(agentId);
      const workspaceId = agents.get(agentId);
      if (workspaceId && shown("chats")) pills.set(agentId, client.addComposerPill({ id: spec.id, workspaceId, agentId, button: button() }));
    };
    const syncHeader = (workspaceId: string) => {
      headers.get(workspaceId)?.remove();
      headers.delete(workspaceId);
      if (workspaces.has(workspaceId) && shown("header")) headers.set(workspaceId, client.addHeaderButton({ id: spec.id, workspaceId, button: button() }));
    };
    const syncCommands = () => {
      for (const remove of commands) remove();
      commands = [];
      if (shown("commandCenter")) {
        commands.push(
          client.addCommandCenterItem({
            id: spec.id,
            title: `${current?.name}: ${spec.assistant} voice`,
            icon: spec.icon,
            keywords: spec.keywords,
            context: "global",
            async onSelect({ rpc }) {
              await launchVoice(rpcLaunch(rpc));
            },
          }),
        );
      }
      if (shown("slashCommand") && current) {
        commands.push(
          client.addSlashCommand({
            name: slashName(current.name),
            description: `${current.name}: talk to ${spec.assistant}`,
            argumentHint: "",
            context: "workspace",
            async onSubmit({ rpc }) {
              await launchVoice(rpcLaunch(rpc));
            },
          }),
        );
      }
    };
    const syncAll = () => {
      for (const id of new Set([...agents.keys(), ...pills.keys()])) syncPill(id);
      for (const id of new Set([...workspaces, ...headers.keys()])) syncHeader(id);
      syncCommands();
    };
    const stopListening = subscribe(syncAll);

    const failed = (what: string) => (error: unknown) => {
      if (!lifetime.signal.aborted) console.error(`[god-mode] ${spec.id} button: ${what} failed`, error);
    };

    void spec
      .load(client.rpc)
      .then((settings) => publish(settings))
      .catch(failed("loading settings"));

    void client.paseo.agents
      .list({ subscribe: {}, signal: lifetime.signal })
      .then(({ subscription }) => {
        subscription.subscribe({
          snapshot: ({ entries }) => {
            const before = [...agents.keys()];
            agents.clear();
            for (const { agent } of entries) if (agent.workspaceId) agents.set(agent.id, agent.workspaceId);
            for (const id of new Set([...before, ...agents.keys()])) syncPill(id);
          },
          update: (message) => {
            if (message.type !== "agent_update") return;
            const update = message.payload;
            if (update.kind === "remove") {
              agents.delete(update.agentId);
              syncPill(update.agentId);
            } else if (update.agent.workspaceId && agents.get(update.agent.id) !== update.agent.workspaceId) {
              agents.set(update.agent.id, update.agent.workspaceId);
              syncPill(update.agent.id);
            }
          },
        });
        return undefined;
      })
      .catch(failed("following chats"));

    void client.paseo.workspaces
      .list({ subscribe: {} })
      .then(({ subscription }) => {
        if (lifetime.signal.aborted) return void subscription.release();
        lifetime.signal.addEventListener("abort", () => void subscription.release());
        subscription.subscribe({
          snapshot: ({ entries }) => {
            const before = [...workspaces];
            workspaces.clear();
            for (const workspace of entries) workspaces.add(workspace.id);
            for (const id of new Set([...before, ...workspaces])) syncHeader(id);
          },
          update: (message) => {
            if (message.type !== "workspace_update") return;
            const update = message.payload;
            if (update.kind === "remove") {
              workspaces.delete(update.id);
              syncHeader(update.id);
            } else if (!workspaces.has(update.workspace.id)) {
              workspaces.add(update.workspace.id);
              syncHeader(update.workspace.id);
            }
          },
        });
        return undefined;
      })
      .catch(failed("following workspaces"));

    return () => {
      lifetime.abort();
      stopListening();
      for (const registration of [...pills.values(), ...headers.values()]) registration.remove();
      pills.clear();
      headers.clear();
      for (const remove of commands) remove();
      commands = [];
    };
  }

  return { publish, useSettings, SidebarItem, contribute };
}

const chatgpt = createVoiceButton<VoiceButtonSettings>({
  id: "voice",
  icon: "AudioLines",
  assistant: "ChatGPT",
  keywords: ["voice", "chatgpt", "talk"],
  fallbackSlash: "voice-chat",
  load: async (rpc) => (await rpc(getVoiceButtonRpc, {})).settings,
  launch: (rpc, input) => rpc(voiceButtonLaunchRpc, input),
  useLaunch: () => useRpc(voiceButtonLaunchRpc),
});

const claude = createVoiceButton<ClaudeVoiceSettings>({
  id: "claude-voice",
  icon: "AudioWaveform",
  assistant: "Claude",
  keywords: ["voice", "claude", "talk"],
  fallbackSlash: "claude-voice",
  load: async (rpc) => (await rpc(getClaudeVoiceRpc, {})).settings,
  launch: (rpc, input) => rpc(claudeVoiceLaunchRpc, input),
  useLaunch: () => useRpc(claudeVoiceLaunchRpc),
});

export const publishVoiceButton = chatgpt.publish;
export const useVoiceButton = chatgpt.useSettings;
export const VoiceButtonSidebarItem = chatgpt.SidebarItem;
export const contributeVoiceButton = chatgpt.contribute;

export const publishClaudeVoice = claude.publish;
export const ClaudeVoiceSidebarItem = claude.SidebarItem;
export const contributeClaudeVoice = claude.contribute;
