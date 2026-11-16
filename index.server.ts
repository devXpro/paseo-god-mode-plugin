import type { PluginServerContext } from "@getpaseo/plugin/server";
import { CLAUDE_NEW_CHAT_URL, claudeVoiceLaunchRpc, claudeVoiceStatusRpc, getClaudeVoiceRpc, setClaudeVoiceRpc } from "./shared/claude-voice.ts";
import { connectRpc, disconnectRpc, statusRpc, tunnelSetupRpc } from "./shared/contracts.ts";
import { VERSION } from "./shared/version.ts";
import {
  getVoiceButtonRpc,
  setVoiceButtonRpc,
  shortcutRunUrl,
  voiceButtonLaunchRpc,
  voiceButtonStatusRpc,
} from "./shared/voice-button.ts";
import { Gateway } from "./server/gateway/service.ts";
import { Tunnel } from "./server/tunnel/cloudflared.ts";
import { findClaude, launchClaudeOnMac, listInstances, listProfiles } from "./server/voice-button/claude-mac.ts";
import { readClaudeVoice, writeClaudeVoice } from "./server/voice-button/claude-settings.ts";
import { detectVoiceHotkey, findChatGpt, isAccessibilityTrusted, launchOnMac, listShortcuts } from "./server/voice-button/mac.ts";
import { readVoiceButton, writeVoiceButton } from "./server/voice-button/settings.ts";

export default function contribute(server: PluginServerContext) {
  const gateway = new Gateway();
  const tunnel = new Tunnel(gateway.port, (url) => gateway.setPublicUrl(url));
  // Both start in the background; a failure is kept and shown on the screen.
  const started = gateway
    .start()
    .then(() => tunnel.start())
    .catch((error) => console.log(`[god-mode] did not start: ${error?.message ?? error}`));

  server.handle(statusRpc, async () => {
    await started;
    const t = tunnel.status();
    const setup = t.setup;
    return {
      version: VERSION,
      ...gateway.status(),
      tunnel: {
        hostname: t.record?.hostname ?? null,
        url: t.record?.url ?? null,
        running: t.running,
        connected: t.connected,
        setup: {
          step: setup.step,
          ...("loginUrl" in setup ? { loginUrl: setup.loginUrl, expiresAt: setup.expiresAt } : {}),
          ...("url" in setup ? { url: setup.url } : {}),
          ...("error" in setup ? { error: setup.error } : {}),
        },
      },
    };
  });
  server.handle(tunnelSetupRpc, async () => {
    await started;
    const setup = await tunnel.beginSetup();
    return {
      step: setup.step,
      ...("loginUrl" in setup ? { loginUrl: setup.loginUrl, expiresAt: setup.expiresAt } : {}),
      ...("url" in setup ? { url: setup.url } : {}),
      ...("error" in setup ? { error: setup.error } : {}),
    };
  });
  server.handle(connectRpc, async () => {
    await started;
    return gateway.connect();
  });
  server.handle(disconnectRpc, async ({ id }) => {
    await started;
    return { connections: gateway.disconnect(id) };
  });

  server.handle(getVoiceButtonRpc, async () => ({ settings: await readVoiceButton() }));
  server.handle(setVoiceButtonRpc, async ({ settings }) => ({ settings: await writeVoiceButton(settings) }));
  server.handle(voiceButtonStatusRpc, async () => {
    const mac = process.platform === "darwin";
    return {
      platform: process.platform,
      chatgpt: mac ? await findChatGpt() : null,
      accessibilityTrusted: mac ? await isAccessibilityTrusted() : null,
      detectedHotkey: mac ? detectVoiceHotkey() : null,
      shortcuts: mac ? await listShortcuts() : [],
    };
  });
  server.handle(voiceButtonLaunchRpc, async ({ client }) => {
    const settings = await readVoiceButton();
    if (client === "ios") {
      const name = settings.iosShortcutName || settings.name;
      return { outcome: "open-url" as const, via: "url" as const, needsOneTap: false, url: shortcutRunUrl(name), message: `Running the shortcut "${name}".` };
    }
    if (client === "android") {
      return { outcome: "unsupported" as const, via: "none" as const, needsOneTap: false, url: null, message: "The voice button works on Mac and iPhone." };
    }
    return launchOnMac(settings);
  });

  server.handle(getClaudeVoiceRpc, async () => ({ settings: await readClaudeVoice() }));
  server.handle(setClaudeVoiceRpc, async ({ settings }) => ({ settings: await writeClaudeVoice(settings) }));
  server.handle(claudeVoiceStatusRpc, async () => {
    const mac = process.platform === "darwin";
    const claude = mac ? await findClaude() : null;
    return {
      platform: process.platform,
      claude,
      accessibilityTrusted: mac ? await isAccessibilityTrusted() : null,
      profiles: mac ? listProfiles() : [],
      running: claude ? (await listInstances(claude)).map((i) => i.profile) : [],
    };
  });
  server.handle(claudeVoiceLaunchRpc, async ({ client }) => {
    const settings = await readClaudeVoice();
    if (client === "ios") {
      const name = settings.iosShortcutName;
      return name
        ? { outcome: "open-url" as const, via: "shortcut" as const, needsOneTap: false, url: shortcutRunUrl(name), message: `Running the shortcut "${name}".` }
        : { outcome: "open-url" as const, via: "url" as const, needsOneTap: true, url: CLAUDE_NEW_CHAT_URL, message: "Claude is open: tap its voice button." };
    }
    if (client === "android") {
      return { outcome: "open-url" as const, via: "url" as const, needsOneTap: true, url: CLAUDE_NEW_CHAT_URL, message: "Claude is open: tap its voice button." };
    }
    return launchClaudeOnMac(settings);
  });


  return () => {
    void tunnel.stop();
    void gateway.stop();
  };
}
