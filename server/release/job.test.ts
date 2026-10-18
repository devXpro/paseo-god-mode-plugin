import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BusyError, JobRunner } from "./job.ts";
import { ReleaseError } from "./pipeline.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

// The record is written in the background: waits, up to 2 s, for it to reach a state.
async function savedRecord(dir: string, state: string) {
  for (let i = 0; i < 100; i++) {
    const file = (await readdir(dir)).find((f) => f.endsWith(".json"));
    const saved = file ? JSON.parse(await readFile(join(dir, file), "utf8")) : null;
    if (saved?.state === state) return saved;
    await settle();
  }
  assert.fail(`the record never reached ${state}`);
}

test("a job runs in the background, one at a time, and its record lands on disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "god-mode-jobs-"));
  const jobs = new JobRunner(dir);
  await jobs.init();
  let finish!: () => void;
  const job = jobs.start("update", (ctx) => new Promise((resolve) => {
    ctx.step("Building");
    for (let i = 0; i < 20; i++) ctx.log(`compiling ${i}`);
    finish = () => resolve({ outcome: "published", versionNumber: 6, commit: "abc", url: null, message: "Version 6 is live." });
  }));
  assert.equal(job.state, "running");
  assert.throws(() => jobs.start("rollback", async () => ({ outcome: "already-live", versionNumber: 1, commit: null, url: null, message: "" })), BusyError);
  finish();
  await settle();
  assert.equal(jobs.status()?.state, "succeeded");
  assert.equal(jobs.status()?.result?.versionNumber, 6);
  const saved = await savedRecord(dir, "succeeded");
  assert.ok(saved.log.some((line: string) => line.includes("Building")));
  assert.match(saved.log.at(-1), /Version 6 is live\./);
});

test("a failure keeps its message, scrubbed, and whether production was left broken", async () => {
  const dir = await mkdtemp(join(tmpdir(), "god-mode-jobs-"));
  const jobs = new JobRunner(dir);
  await jobs.init();
  jobs.start("update", async () => {
    throw new ReleaseError("rollback", "push failed: Bearer abc123", true);
  });
  await settle();
  const status = jobs.status();
  assert.equal(status?.state, "failed");
  assert.equal(status?.critical, true);
  assert.ok(!status?.error?.includes("abc123"));
});

test("a job left running by an earlier process is reported as interrupted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "god-mode-jobs-"));
  await writeFile(join(dir, "2026-10-16T10-00-00-000Z-update.json"), JSON.stringify({ id: "x", action: "update", state: "running", step: "Publishing", startedAt: "t", finishedAt: null, result: null, error: null, critical: false, log: [] }));
  const jobs = new JobRunner(dir);
  await jobs.init();
  assert.equal(jobs.status()?.state, "interrupted");
});
