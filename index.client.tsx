import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { HomeScreen } from "./client/home.tsx";
import { VoiceButtonSidebarItem, contributeVoiceButton } from "./client/voice-button.tsx";

function GodModeSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="Zap" active={currentScreen?.screenId === "home"} onPress={() => openScreen({ screenId: "home" })} />;
}

export default function contribute(client: PluginClientContext) {
  const removers = [
    client.addScreen({ id: "home", title: "God Mode", Component: HomeScreen }),
    client.addSidebarHeaderItem({ id: "home", title: "God Mode", Component: GodModeSidebarItem }),
    client.addSidebarFooterItem({ id: "voice", title: "Voice button", Component: VoiceButtonSidebarItem }),
    contributeVoiceButton(client),
  ];
  return () => {
    for (const remove of removers) remove();
  };
}
