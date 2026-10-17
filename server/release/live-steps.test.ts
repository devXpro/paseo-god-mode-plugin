import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { AppServer } from "../codex/app-server.ts";
import type { Credential } from "../sites/sites.ts";
import { liveSteps } from "./live-steps.ts";

const gitOut = (args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

/** The Site source a plugin checkout ships, as small as staging allows. */
async function siteSource(): Promise<string> {
  const source = await mkdtemp(join(tmpdir(), "god-mode-src-"));
  execFileSync("git", ["init", "-q", source]);
  await mkdir(join(source, "core"), { recursive: true });
  await mkdir(join(source, ".openai"), { recursive: true });
  await writeFile(join(source, ".gitignore"), "/.openai/hosting.json\n");
  await writeFile(join(source, "core", "mcp.mjs"), "export const TOOLS = [];\n");
  await writeFile(join(source, ".openai", "hosting.template.json"), JSON.stringify({ d1: "DB", capabilities: ["mcp"] }));
  return source;
}

/** A clean install and a new Site: Paseo's home has no god-mode/site checkout yet, and the Site's
 *  repository has no commits and no branches, which is what sites.create_site leaves. */
async function newSite(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "god-mode-home-"));
  const repository = join(home, "site.git");
  execFileSync("git", ["init", "-q", "--bare", repository]);
  const credential: Credential = { remote_url: repository, branch: "main", token: "short-lived", auth_mode: "http_extra_header" };
  const sites = { callTool: async () => ({ isError: false, text: "", structured: { ...credential } }) };
  const source = await siteSource();
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
  });
  /** One release job's steps; the git half of a release is prepare() then push(). */
  const release = () =>
    liveSteps({
      server: sites as unknown as AppServer,
      codex: "codex",
      projectId: "appgprj_new",
      sourceDir: source,
      identity: { source: "v0.7.0", commit: "abc1234" },
      workDir: join(home, "job"),
      ctx: { id: "job", log: () => {}, step: () => {} },
    });
  return { repository, source, release };
}

test("the first release of a new Site pushes its first commit to the Site's empty repository", async (t) => {
  const site = await newSite(t);
  const job = site.release();

  const commit = await job.prepare();
  await job.push();

  assert.equal(gitOut(["--git-dir", site.repository, "rev-parse", "refs/heads/main"]), commit, "the push created the branch Sites builds from");
  const files = gitOut(["--git-dir", site.repository, "ls-tree", "-r", "--name-only", "main"]).split("\n");
  assert.ok(files.includes("core/mcp.mjs"), "the Site source is in the first commit");
  assert.ok(files.includes(".openai/hosting.json"), "the hosting file is in the first commit");
});

test("the release after the first one builds on the commit the first one pushed", async (t) => {
  const site = await newSite(t);
  const first = site.release();
  const firstCommit = await first.prepare();
  await first.push();

  await writeFile(join(site.source, "core", "mcp.mjs"), 'export const TOOLS = [{ name: "overview" }];\n');
  const second = site.release();
  const secondCommit = await second.prepare();
  await second.push();

  assert.notEqual(secondCommit, firstCommit);
  assert.equal(gitOut(["--git-dir", site.repository, "rev-parse", "refs/heads/main"]), secondCommit);
  assert.equal(gitOut(["--git-dir", site.repository, "rev-parse", `${secondCommit}^`]), firstCommit, "a fast-forward of the first release");
});
