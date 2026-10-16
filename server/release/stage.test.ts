import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { packageWorker } from "./package.ts";
import { stageSource, writeBuildInfo, writeHosting } from "./stage.ts";

test("staging copies what git would publish and replaces whatever was there", async () => {
  const source = await mkdtemp(join(tmpdir(), "god-mode-src-"));
  execFileSync("git", ["init", "-q", source]);
  await mkdir(join(source, "core"), { recursive: true });
  await mkdir(join(source, ".openai"), { recursive: true });
  await writeFile(join(source, ".gitignore"), "/node_modules\n/dist/\n/.openai/hosting.json\n");
  await writeFile(join(source, "core", "mcp.mjs"), "export const TOOLS = [];\n");
  await writeFile(join(source, ".openai", "hosting.template.json"), JSON.stringify({ d1: "DB", capabilities: ["mcp"] }));
  await writeFile(join(source, ".openai", "hosting.json"), JSON.stringify({ project_id: "someone-elses" }));
  await mkdir(join(source, "dist"), { recursive: true });
  await writeFile(join(source, "dist", "built.js"), "");
  execFileSync("git", ["-C", source, "add", ".gitignore", "core/mcp.mjs"]);
  await writeFile(join(source, "untracked.md"), "new file, not committed yet\n");

  const checkout = await mkdtemp(join(tmpdir(), "god-mode-checkout-"));
  await mkdir(join(checkout, ".git"));
  await mkdir(join(checkout, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(checkout, "stale.txt"), "from an older release");

  const count = await stageSource(source, checkout);
  assert.equal(count, 4);
  assert.ok(existsSync(join(checkout, "core", "mcp.mjs")));
  assert.ok(existsSync(join(checkout, "untracked.md")));
  assert.ok(existsSync(join(checkout, "node_modules", "pkg")), "installed packages are kept");
  assert.ok(existsSync(join(checkout, ".git")), "history is kept");
  assert.ok(!existsSync(join(checkout, "stale.txt")), "files gone from the source are gone");
  assert.ok(!existsSync(join(checkout, "dist")), "ignored build output is not copied");
  assert.ok(!existsSync(join(checkout, ".openai", "hosting.json")), "another install's hosting file is not copied");

  await writeHosting(checkout, "appgprj_mine");
  assert.deepEqual(JSON.parse(await readFile(join(checkout, ".openai", "hosting.json"), "utf8")), { d1: "DB", capabilities: ["mcp"], project_id: "appgprj_mine" });
});

test("the archive holds dist with the hosting file and the migrations", async () => {
  const checkout = await mkdtemp(join(tmpdir(), "god-mode-pkg-"));
  await mkdir(join(checkout, "dist", "server"), { recursive: true });
  await mkdir(join(checkout, "dist", "client"), { recursive: true });
  await mkdir(join(checkout, "dist", ".openai"), { recursive: true });
  await mkdir(join(checkout, ".openai"), { recursive: true });
  await mkdir(join(checkout, "drizzle"), { recursive: true });
  await writeFile(join(checkout, "dist", "server", "index.js"), "export default {}\n");
  await writeFile(join(checkout, "dist", "client", "app.js"), "");
  await writeFile(join(checkout, "dist", ".openai", "hosting.json"), JSON.stringify({ artifact_metadata: { by: "build" } }));
  await writeFile(join(checkout, ".openai", "hosting.json"), JSON.stringify({ d1: "DB", project_id: "p" }));
  await writeFile(join(checkout, "drizzle", "0000_init.sql"), "create table t (id integer);\n");

  const archive = join(checkout, "out", "site.tgz");
  const { entries } = await packageWorker(checkout, archive);
  assert.ok(entries > 0);
  const listing = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).split("\n");
  for (const entry of ["dist/server/index.js", "dist/client/app.js", "dist/.openai/hosting.json", "dist/.openai/drizzle/0000_init.sql"]) {
    assert.ok(listing.includes(entry), `missing ${entry}`);
  }
  const hosting = JSON.parse(execFileSync("tar", ["-xzOf", archive, "dist/.openai/hosting.json"], { encoding: "utf8" }));
  assert.deepEqual(hosting, { d1: "DB", project_id: "p", artifact_metadata: { by: "build" } });
});

test("packaging refuses a build without a worker entry", async () => {
  const checkout = await mkdtemp(join(tmpdir(), "god-mode-pkg-"));
  await mkdir(join(checkout, ".openai"), { recursive: true });
  await writeFile(join(checkout, ".openai", "hosting.json"), "{}");
  await assert.rejects(packageWorker(checkout, join(checkout, "site.tgz")), /dist\/server\/index\.js/);
});

test("the build file records the plugin source and stays an importable module", async () => {
  const checkout = await mkdtemp(join(tmpdir(), "god-mode-build-"));
  await mkdir(join(checkout, "core"), { recursive: true });
  await writeBuildInfo(checkout, { source: "v0.5.0-2-gabc1234", commit: "abc1234def" });
  const { BUILD } = await import(join(checkout, "core", "build.mjs"));
  assert.deepEqual(BUILD, { source: "v0.5.0-2-gabc1234", commit: "abc1234def" });
});
