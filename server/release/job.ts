// Releases run in the background of the plugin process: an RPC is cut off at 30 s and a release
// takes minutes. One at a time; every step is written to disk, so a status survives a reload and a
// job the process did not live to finish is reported as interrupted instead of running forever.
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { JobView } from "../../shared/contracts.ts";
import { scrubText } from "../safety.ts";
import { readJson, writeJson } from "../store.ts";
import { ReleaseError, type ReleaseResult } from "./pipeline.ts";

const LOG_LINES = 200;

export class BusyError extends Error {}

export interface JobContext {
  id: string;
  log(line: string): void;
  step(name: string): void;
}

export class JobRunner {
  private readonly dir: string;
  private latest: JobView | null = null;
  private running = false;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Loads the newest job; one left "running" by an earlier process is marked interrupted. */
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const files = (await readdir(this.dir)).filter((f) => f.endsWith(".json")).sort();
    const newest = files.at(-1);
    if (!newest) return;
    const job = await readJson<JobView | null>(join(this.dir, newest), null);
    if (job?.state === "running") {
      job.state = "interrupted";
      job.error = "The plugin stopped while this ran. Check the live version before trying again.";
      job.finishedAt = new Date().toISOString();
      await writeJson(join(this.dir, newest), job);
    }
    this.latest = job;
  }

  status(): JobView | null {
    return this.latest;
  }

  start(action: JobView["action"], work: (ctx: JobContext) => Promise<ReleaseResult>): JobView {
    if (this.running) throw new BusyError(`A ${this.latest?.action ?? "release"} is already running.`);
    this.running = true;
    const startedAt = new Date().toISOString();
    const id = `${startedAt.replace(/[:.]/g, "-")}-${action}`;
    const job: JobView = { id, action, state: "running", step: "Starting", startedAt, finishedAt: null, result: null, error: null, critical: false, log: [] };
    this.latest = job;
    const file = join(this.dir, `${id}.json`);
    // One write at a time, in order: overlapping writes share writeJson's temporary file, and the
    // record could end up on an earlier state than the job's last.
    let saving = Promise.resolve();
    const save = () => (saving = saving.then(() => writeJson(file, job)).catch(() => {}));
    const ctx: JobContext = {
      id,
      log: (line) => {
        job.log.push(`${new Date().toISOString().slice(11, 19)} ${scrubText(line)}`);
        if (job.log.length > LOG_LINES) job.log.splice(0, job.log.length - LOG_LINES);
        void save();
      },
      step: (name) => {
        job.step = name;
        ctx.log(`— ${name}`);
      },
    };
    void save();
    work(ctx)
      .then((result) => {
        job.state = "succeeded";
        job.result = result;
        ctx.log(result.message);
      })
      .catch((error: unknown) => {
        job.state = "failed";
        job.error = scrubText((error as Error).message);
        job.critical = error instanceof ReleaseError && error.critical;
        ctx.log(`failed: ${job.error.split("\n")[0]}`);
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
        this.running = false;
        void save();
      });
    return job;
  }
}
