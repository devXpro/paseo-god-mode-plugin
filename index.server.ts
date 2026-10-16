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
import { LoginManager } from "./server/codex/login.ts";
import { checkEnvironment } from "./server/environment.ts";
import { ReleaseService } from "./server/release/service.ts";

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

  server.handle(releaseStatusRpc, ({ log }) => releases.status(log));
  server.handle(releaseStartRpc, async ({ action, version }) => ({ job: await releases.start(action, version) }));

  return () => logins.close();
}
