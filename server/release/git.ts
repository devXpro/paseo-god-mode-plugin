// Git for the Site's own repository in Sites. The short-lived token reaches git through an
// environment variable that --config-env names, so it is never in argv, a URL or a config file.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { run, runOrThrow } from "../process.ts";
import type { Credential } from "../sites/sites.ts";

const IDENTITY = ["-c", "user.name=God Mode", "-c", "user.email=god-mode@users.noreply.github.com"];

function auth(credential: Credential) {
  return {
    env: { ...process.env, SITES_GIT_AUTHORIZATION: `Authorization: Bearer ${credential.token}` },
    config: [
      "-c", "credential.helper=",
      "-c", "http.extraHeader=",
      "-c", "http.followRedirects=false",
      `--config-env=http.${credential.remote_url}.extraHeader=SITES_GIT_AUTHORIZATION`,
    ],
  };
}

export const git = (dir: string, args: string[]) => runOrThrow("git", ["-C", dir, ...args], { timeoutMs: 2 * 60_000 });

/** Brings the private checkout to exactly what Sites has. Nobody edits this checkout by hand, so
 *  local leftovers from a failed release are discarded rather than merged. */
export async function syncCheckout(dir: string, credential: Credential): Promise<void> {
  const { env, config } = auth(credential);
  if (!existsSync(join(dir, ".git"))) {
    await runOrThrow("git", [...config, "clone", "--quiet", "--branch", credential.branch, credential.remote_url, dir], { env, timeoutMs: 5 * 60_000 });
    return;
  }
  await runOrThrow("git", ["-C", dir, ...config, "fetch", "--quiet", "--no-tags", credential.remote_url, `refs/heads/${credential.branch}`], { env, timeoutMs: 5 * 60_000 });
  await git(dir, ["checkout", "--quiet", "--force", "-B", credential.branch, "FETCH_HEAD"]);
}

/** Commits the staged tree as one release, or returns null when it matches HEAD exactly. */
export async function commitRelease(dir: string, message: string): Promise<string | null> {
  await git(dir, ["add", "--all"]);
  // .openai/hosting.json is ignored for development but must be in every commit Sites builds from.
  await git(dir, ["add", "--force", ".openai/hosting.json"]);
  const staged = await run("git", ["-C", dir, "diff", "--cached", "--quiet"]);
  if (staged.ok) return null;
  const identity = (await run("git", ["-C", dir, "var", "GIT_AUTHOR_IDENT"])).ok ? [] : IDENTITY;
  await runOrThrow("git", ["-C", dir, ...identity, "commit", "--quiet", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

export async function pushHead(dir: string, credential: Credential): Promise<string> {
  const { env, config } = auth(credential);
  const sha = await git(dir, ["rev-parse", "HEAD"]);
  await runOrThrow("git", ["-C", dir, ...config, "push", "--quiet", credential.remote_url, `${sha}:refs/heads/${credential.branch}`], { env, timeoutMs: 5 * 60_000 });
  return sha;
}
