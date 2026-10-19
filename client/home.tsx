import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { Text, View } from "react-native";
import { ChatGPTStep, MacStep, PreferencesStep, ReleaseStep, SiteStep } from "./sections.tsx";
import { VoiceButtonStep } from "./voice-button-section.tsx";

/** The God Mode screen behind the sidebar row: set up once, then update and roll back from here. */
export function HomeScreen({ theme }: PluginSurfaceProps) {
  return (
    <ScrollView contentContainerStyle={{ padding: 20, gap: 22 }}>
      <View style={{ gap: 4 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 30, fontWeight: "800", letterSpacing: -0.6 }}>God Mode</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 15 }}>Talk to ChatGPT. Every Paseo agent obeys.</Text>
      </View>
      <MacStep theme={theme} />
      <SiteStep theme={theme} />
      <PreferencesStep theme={theme} />
      <ReleaseStep theme={theme} />
      <ChatGPTStep theme={theme} />
      <VoiceButtonStep theme={theme} />
    </ScrollView>
  );
}
