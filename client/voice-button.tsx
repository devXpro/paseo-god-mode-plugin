// The voice button wherever the user put it: a pill in every chat, a button in every workspace
// header, a sidebar row, a Command Center item and a slash command. Settings live on the daemon;
// this module keeps the latest copy so the settings section can apply a change at once.
import type { PluginButton, PluginButtonRegistration, PluginClientContext, PluginCommandCapabilities, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useSyncExternalStore } from "react";
import { Linking, Platform } from "react-native";
import { type VoiceButtonLaunch, type VoiceButtonSettings, getVoiceButtonRpc, voiceButtonLaunchRpc, voiceSlashName } from "../shared/voice-button.ts";

const ICON = "AudioLines";

let current: VoiceButtonSettings | null = null;
const listeners = new Set<() => void>();

/** Publishes saved settings to every surface of this client. */
export function publishVoiceButton(settings: VoiceButtonSettings) {
  current = settings;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const useVoiceButton = () => useSyncExternalStore(subscribe, () => current);

type Launch = (input: { client: "ios" | "android" | "web" }) => Promise<VoiceButtonLaunch>;

/** iOS runs the Shortcut on the phone; Mac, browser and Electron ask the daemon's Mac. */
export async function launchVoice(launch: Launch): Promise<VoiceButtonLaunch> {
  const client = Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "web";
  const result = await launch({ client });
  if (result.outcome === "unsupported") throw new Error(result.message);
  if (result.url) await Linking.openURL(result.url);
  return result;
}

const rpcLaunch = (rpc: PluginCommandCapabilities["rpc"]): Launch => (input) => rpc(voiceButtonLaunchRpc, input);

export function VoiceButtonSidebarItem(_props: PluginSidebarItemProps) {
  const settings = useVoiceButton();
  const launch = useRpc(voiceButtonLaunchRpc);
  const toast = useToast();
  if (!settings?.enabled || !settings.placements.sidebar) return null;
  return (
    <SidebarRow
      icon={ICON}
      label={settings.name}
      onPress={() => {
        launchVoice(launch)
          .then((r) => toast.show(r.message, { variant: r.needsOneTap ? "info" : "success" }))
          .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)));
      }}
    />
  );
}

export function contributeVoiceButton(client: PluginClientContext): () => void {
  const lifetime = new AbortController();
  const agents = new Map<string, string>();
  const workspaces = new Set<string>();
  const pills = new Map<string, PluginButtonRegistration>();
  const headers = new Map<string, PluginButtonRegistration>();
  let commands: (() => void)[] = [];

  const shown = (place: keyof VoiceButtonSettings["placements"]) => !lifetime.signal.aborted && !!current?.enabled && current.placements[place];
  const button = (): PluginButton => ({
    title: `${current?.name}: ChatGPT voice`,
    icon: ICON,
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
    if (workspaceId && shown("chats")) pills.set(agentId, client.addComposerPill({ id: "voice", workspaceId, agentId, button: button() }));
  };
  const syncHeader = (workspaceId: string) => {
    headers.get(workspaceId)?.remove();
    headers.delete(workspaceId);
    if (workspaces.has(workspaceId) && shown("header")) headers.set(workspaceId, client.addHeaderButton({ id: "voice", workspaceId, button: button() }));
  };
  const syncCommands = () => {
    for (const remove of commands) remove();
    commands = [];
    if (shown("commandCenter")) {
      commands.push(
        client.addCommandCenterItem({
          id: "voice",
          title: `${current?.name}: ChatGPT voice`,
          icon: ICON,
          keywords: ["voice", "chatgpt", "talk"],
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
          name: voiceSlashName(current.name),
          description: `${current.name}: talk to ChatGPT`,
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
    if (!lifetime.signal.aborted) console.error(`[god-mode] voice button: ${what} failed`, error);
  };

  void client
    .rpc(getVoiceButtonRpc, {})
    .then(({ settings }) => publishVoiceButton(settings))
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
