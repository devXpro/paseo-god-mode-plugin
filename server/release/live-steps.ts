// The real ReleaseSteps: Sites through the app-server, git, npm, and the one Codex call.
import { join } from "node:path";
import { VERSION } from "../../shared/version.ts";
import type { AppServer } from "../codex/app-server.ts";
import { readPairingUrl } from "../pairing.ts";
import { fromEnvironment, readPreferences, toEnvironment } from "../preferences.ts";
import { createCredential, getEnvironment, updateEnvironment } from "../sites/sites.ts";
import { siteCheckoutDir } from "../store.ts";
import { buildSite } from "./build.ts";
import { commitRelease, git, pushHead, syncCheckout } from "./git.ts";
import type { JobContext } from "./job.ts";
import { packageWorker } from "./package.ts";
import type { ReleaseSteps } from "./pipeline.ts";
import { publishWithCodex } from "./publish.ts";
import { smokeTest } from "./smoke.ts";
import { stageSource, writeHosting } from "./stage.ts";

export interface LiveStepsInput {
  server: AppServer;
  codex: string;
  projectId: string;
  sourceDir: string;
  workDir: string;
  ctx: JobContext;
}

export function liveSteps({ server, codex, projectId, sourceDir, workDir, ctx }: LiveStepsInput): ReleaseSteps {
  const checkout = siteCheckoutDir();
  return {
    sites: server,
    projectId,
    log: ctx.log,
    step: ctx.step,
    async prepare() {
      await syncCheckout(checkout, await createCredential(server, projectId));
      const files = await stageSource(sourceDir, checkout);
      await writeHosting(checkout, projectId);
      const committed = await commitRelease(checkout, `God Mode ${VERSION}`);
      const sha = committed ?? (await git(checkout, ["rev-parse", "HEAD"]));
      ctx.log(`${files} files staged, ${committed ? `new commit ${sha.slice(0, 7)}` : `unchanged at ${sha.slice(0, 7)}`}`);
      return sha;
    },
    async build() {
      await buildSite(checkout, ctx.log);
      const archive = join(workDir, "site.tgz");
      const { bytes, entries } = await packageWorker(checkout, archive);
      ctx.log(`archive ${(bytes / 1024 / 1024).toFixed(1)} MB, ${entries} entries`);
      return archive;
    },
    async push() {
      // A fresh credential: they are short-lived and the build may have taken minutes.
      const sha = await pushHead(checkout, await createCredential(server, projectId));
      ctx.log(`pushed ${sha.slice(0, 7)}`);
    },
    async configure() {
      const existing = await getEnvironment(server, projectId);
      const preferences = (await readPreferences()) ?? fromEnvironment(existing);
      const { set, remove } = toEnvironment(preferences, await readPairingUrl(), existing);
      const revision = await updateEnvironment(server, projectId, set, remove);
      // Keys only: values, the pairing link above all, never reach a log.
      ctx.log(`settings saved (revision ${revision}): ${set.map((e) => e.key).join(", ")}${remove.length ? `; removed ${remove.join(", ")}` : ""}`);
    },
    async publish(commitSha, archive) {
      const report = await publishWithCodex(codex, checkout, { projectId, commitSha, archive }, ctx.log);
      ctx.log(`Codex: ${report.status}, version ${report.version_number ?? "?"}: ${report.message}`);
      if (report.status !== "deployed") throw new Error(`Publishing failed: ${report.message}`);
    },
    // A new release can take a couple of minutes to show its new tools in ChatGPT.
    smoke: (metadata, attempts) => smokeTest({ codex, checkoutDir: checkout, log: ctx.log, metadata, retries: attempts ?? (metadata ? 8 : 1) }),
  };
}
