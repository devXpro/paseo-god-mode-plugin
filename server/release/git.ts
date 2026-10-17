// Git for the Site's own repository in Sites. The short-lived token reaches git through an
// environment variable that --config-env names, so it is never in argv, a URL or a config file.
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { run, runOrThrow, tail } from "../process.ts";
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

/** Whether the Site's repository has the branch releases go to. A Site from sites.create_site starts
 *  with an empty repository, no commits and no branches, until its first release pushes one.
 *  `ls-remote --exit-code` exits 2 when no ref matches; any other failure is an error. */
async function hasBranch(credential: Credential): Promise<boolean> {
  const { env, config } = auth(credential);
  const result = await run("git", [...config, "ls-remote", "--exit-code", credential.remote_url, `refs/heads/${credential.branch}`], { env, timeoutMs: 2 * 60_000 });
  if (result.ok) return true;
  if (result.code === 2) return false;
  throw new Error(`git ls-remote failed (${result.code}):\n${tail(result)}`);
}

/** Brings the private checkout to exactly what Sites has. Nobody edits this checkout by hand, so
 *  local leftovers from a failed release are discarded rather than merged. When Sites has no history
 *  yet, neither does the checkout: the release commits on an unborn branch and its push creates it. */
export async function syncCheckout(dir: string, credential: Credential): Promise<void> {
  const { env, config } = auth(credential);
  if (!(await hasBranch(credential))) {
    await rm(join(dir, ".git"), { recursive: true, force: true });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await git(dir, ["init", "--quiet"]);
    await git(dir, ["symbolic-ref", "HEAD", `refs/heads/${credential.branch}`]);
    return;
  }
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
