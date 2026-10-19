import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  checkSlugRpc,
  connectSiteRpc,
  createSiteRpc,
  environmentRpc,
  getPreferencesRpc,
  listSitesRpc,
  loginStartRpc,
  loginStatusRpc,
  releaseStartRpc,
  releaseStatusRpc,
  setPreferencesRpc,
} from "./shared/contracts.ts";
import { VERSION } from "./shared/version.ts";
import {
  getVoiceButtonRpc,
  setVoiceButtonRpc,
  shortcutRunUrl,
  voiceButtonLaunchRpc,
  voiceButtonStatusRpc,
} from "./shared/voice-button.ts";
import { LoginManager } from "./server/codex/login.ts";
import { checkEnvironment } from "./server/environment.ts";
import { ReleaseService } from "./server/release/service.ts";
import { detectVoiceHotkey, findChatGpt, isAccessibilityTrusted, launchOnMac, listShortcuts } from "./server/voice-button/mac.ts";
import { readVoiceButton, writeVoiceButton } from "./server/voice-button/settings.ts";

export default function contribute(server: PluginServerContext) {
  const releases = new ReleaseService();
  const logins = new LoginManager();

  server.handle(environmentRpc, async () => ({ version: VERSION, checks: await checkEnvironment() }));
  server.handle(loginStartRpc, () => logins.start());
  server.handle(loginStatusRpc, ({ loginId }) => logins.status(loginId));

  server.handle(listSitesRpc, async () => ({
    sites: (await releases.listSites()).map((s) => ({
      projectId: s.id,
      title: s.title,
      slug: s.slug,
      url: s.current_live_url,
      latestVersion: s.latest_version_number,
    })),
  }));
  server.handle(checkSlugRpc, ({ slug }) => releases.checkSlug(slug));
  server.handle(createSiteRpc, async ({ title, slug }) => ({ site: await releases.create(title, slug) }));
  server.handle(connectSiteRpc, async ({ projectId }) => ({ site: await releases.connect(projectId) }));

  server.handle(getPreferencesRpc, async () => ({ preferences: await releases.getPreferences() }));
  server.handle(setPreferencesRpc, async ({ preferences }) => ({ preferences: await releases.setPreferences(preferences) }));

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

  server.handle(releaseStatusRpc, ({ log }) => releases.status(log));
  server.handle(releaseStartRpc, async ({ action, version }) => ({ job: await releases.start(action, version) }));

  return () => logins.close();
}
