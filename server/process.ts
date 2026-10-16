import { execFile } from "node:child_process";
import { scrubText } from "./safety.ts";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface RunResult {
  ok: boolean;
  code: number | string | null;
  stdout: string;
  stderr: string;
}

/** Runs a command without a shell and never rejects; the caller decides what a failure means.
 *  Stdin is closed at once: `codex exec` with a prompt still waits for piped stdin to end. */
export function run(cmd: string, args: string[], { cwd, env, timeoutMs = 10 * 60_000 }: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd, env: env ?? process.env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? ((error as NodeJS.ErrnoException & { code?: number | string }).code ?? null) : 0;
      resolve({ ok: !error, code, stdout: String(stdout), stderr: String(stderr) });
    });
    child.stdin?.end();
  });
}

/** The last lines of a failed command, scrubbed, for an error message or a log. */
export function tail(result: RunResult, lines = 15): string {
  return scrubText(`${result.stdout}\n${result.stderr}`.trim()).split("\n").slice(-lines).join("\n");
}

export async function runOrThrow(cmd: string, args: string[], options: RunOptions = {}): Promise<string> {
  const result = await run(cmd, args, options);
  if (!result.ok) throw new Error(scrubText(`${[cmd.split("/").pop(), ...args.slice(0, 2)].join(" ")} failed (${result.code}):\n${tail(result)}`));
  return result.stdout.trim();
}
