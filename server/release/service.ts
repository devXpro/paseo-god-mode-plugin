// What the RPC handlers call: the release status, starting a job, choosing or creating the Site, and
// the preferences the Site runs with.
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type JobView, type Preferences, preferencesSchema } from "../../shared/contracts.ts";
import { VERSION } from "../../shared/version.ts";
import { AppServer } from "../codex/app-server.ts";
import { findCodex } from "../codex/locate.ts";
import { fromEnvironment, readPreferences, writePreferences } from "../preferences.ts";
import { siteSourceDir } from "../self.ts";
import { PAIRING_KEY, checkSlug, createSite, getEnvironment, listSites, listVersions, readReleases } from "../sites/sites.ts";
import { type SiteRecord, jobsDir, readSite, writeSite } from "../store.ts";
import { JobRunner } from "./job.ts";
import { liveSteps } from "./live-steps.ts";
import { runConfigure, runRollback, runUpdate } from "./pipeline.ts";

const NO_CODEX = "No Codex CLI found. Install the ChatGPT desktop app or the Codex CLI.";

async function withSites<T>(fn: (server: AppServer) => Promise<T>, timeoutMs = 25_000): Promise<T> {
  const codex = await findCodex();
  if (!codex) throw new Error(NO_CODEX);
  const server = await AppServer.start(codex, { cwd: homedir(), timeoutMs });
  try {
    return await fn(server);
  } finally {
    server.close();
  }
}

const view = (site: SiteRecord) => ({ projectId: site.projectId, title: site.title, url: site.url });

export class ReleaseService {
  private readonly jobs = new JobRunner(jobsDir());
  private readonly ready = this.jobs.init();

  async status(withLog: boolean) {
    await this.ready;
    const site = await readSite();
    const remote = site
      ? await withSites(async (server) => {
          const [versions, environment] = await Promise.all([
            listVersions(server, site.projectId),
            getEnvironment(server, site.projectId).catch(() => null),
          ]);
          const { releases, live } = await readReleases(server, site.projectId, versions);
          const pairing = environment?.find((e) => e.key === PAIRING_KEY);
          return {
            live: live && { versionNumber: live.version.version_number, commit: live.version.source.commit_sha },
            newest: versions[0] ? { versionNumber: versions[0].version_number, commit: versions[0].source.commit_sha } : null,
            releases: releases.map((r) => r.version.version_number),
            pairing: !environment ? ("unknown" as const) : !pairing ? ("missing" as const) : pairing.is_secret ? ("secret" as const) : ("plain" as const),
          };
        })
      : { live: null, newest: null, releases: [], pairing: "unknown" as const };
    const job = this.jobs.status();
    return {
      installed: VERSION,
      site: site && view(site),
      ...remote,
      job: job && (withLog ? job : { ...job, log: job.log.slice(-5) }),
    };
  }

  async start(action: JobView["action"], version?: number): Promise<JobView> {
    await this.ready;
    const site = await readSite();
    if (!site) throw new Error("No Site is connected yet. Open God Mode in Paseo's sidebar to set one up.");
    const codex = await findCodex();
    if (!codex) throw new Error(NO_CODEX);
    const sourceDir = await siteSourceDir();
    return this.jobs.start(action, async (ctx) => {
      const workDir = join(jobsDir(), ctx.id);
      await mkdir(workDir, { recursive: true, mode: 0o700 });
      const server = await AppServer.start(codex, { cwd: homedir(), timeoutMs: 120_000 });
      try {
        const steps = liveSteps({ server, codex, projectId: site.projectId, sourceDir, workDir, ctx });
        if (action === "update") return await runUpdate(steps);
        if (action === "configure") return await runConfigure(steps);
        return await runRollback(steps, version ?? "previous");
      } finally {
        server.close();
        await rm(workDir, { recursive: true, force: true });
      }
    });
  }

  listSites() {
    return withSites((server) => listSites(server));
  }

  checkSlug(slug: string) {
    return withSites((server) => checkSlug(server, slug));
  }

  /** Connecting keeps what an existing Site already does: its settings become the preferences. */
  async connect(projectId: string) {
    return withSites(async (server) => {
      const site = (await listSites(server)).find((s) => s.id === projectId);
      if (!site) throw new Error("That Site is not among the Sites this ChatGPT account owns.");
      const record: SiteRecord = { projectId: site.id, title: site.title, url: site.current_live_url, connectedAt: new Date().toISOString() };
      if (!(await readPreferences())) await writePreferences(fromEnvironment(await getEnvironment(server, projectId)));
      await writeSite(record);
      return view(record);
    });
  }

  async create(title: string, slug: string) {
    return withSites(async (server) => {
      const available = await checkSlug(server, slug);
      if (available.status !== "available") throw new Error(`The address "${available.slug}" is ${available.status}.`);
      const site = await createSite(server, title, available.slug, "Voice and chat control of Paseo from ChatGPT, published by the God Mode plugin.");
      const record: SiteRecord = { projectId: site.id, title: site.title, url: site.current_live_url, connectedAt: new Date().toISOString() };
      await writeSite(record);
      return view(record);
    }, 60_000);
  }

  async getPreferences(): Promise<Preferences> {
    const stored = await readPreferences();
    if (stored) return stored;
    const site = await readSite();
    if (!site) return preferencesSchema.parse({});
    return withSites(async (server) => fromEnvironment(await getEnvironment(server, site.projectId)));
  }

  async setPreferences(preferences: Preferences): Promise<Preferences> {
    await writePreferences(preferences);
    return preferencesSchema.parse(preferences);
  }
}
