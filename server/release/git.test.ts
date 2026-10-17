import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Credential } from "../sites/sites.ts";
import { syncCheckout } from "./git.ts";

const gitOut = (args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

const credentialFor = (repository: string): Credential => ({ remote_url: repository, branch: "main", token: "short-lived", auth_mode: "http_extra_header" });

/** A Site's source repository: empty, like a new Site, or with one commit per message on main. */
async function siteRepository(...messages: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "god-mode-git-"));
  const repository = join(root, "site.git");
  execFileSync("git", ["init", "-q", "--bare", repository]);
  for (const message of messages) await pushCommit(repository, message);
  return repository;
}

/** Another device's release: one more commit on the Site's main. */
async function pushCommit(repository: string, message: string): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), "god-mode-work-"));
  execFileSync("git", ["init", "-q", work]);
  if (gitOut(["--git-dir", repository, "for-each-ref", "refs/heads/main"])) {
    execFileSync("git", ["-C", work, "fetch", "-q", repository, "main"]);
    execFileSync("git", ["-C", work, "checkout", "-q", "-B", "main", "FETCH_HEAD"]);
  }
  await writeFile(join(work, `${message}.txt`), message);
  execFileSync("git", ["-C", work, "add", "--all"]);
  execFileSync("git", ["-C", work, ...IDENTITY, "commit", "-q", "-m", message]);
  execFileSync("git", ["-C", work, "push", "-q", repository, "HEAD:refs/heads/main"]);
  return gitOut(["-C", work, "rev-parse", "HEAD"]);
}

test("a leftover checkout keeps no history when the Site's repository has no branch yet", async () => {
  const repository = await siteRepository();
  // A first release that failed after committing, or the checkout of a Site used before this one.
  const checkout = await mkdtemp(join(tmpdir(), "god-mode-checkout-"));
  execFileSync("git", ["init", "-q", checkout]);
  await writeFile(join(checkout, "old.txt"), "an earlier release");
  execFileSync("git", ["-C", checkout, "add", "--all"]);
  execFileSync("git", ["-C", checkout, ...IDENTITY, "commit", "-q", "-m", "earlier release"]);

  await syncCheckout(checkout, credentialFor(repository));

  assert.equal(gitOut(["-C", checkout, "symbolic-ref", "HEAD"]), "refs/heads/main");
  assert.throws(() => execFileSync("git", ["-C", checkout, "rev-parse", "--verify", "--quiet", "HEAD"]), "no commits, exactly like the Site");
});

test("a Site with releases is cloned, and later releases fetch its newest commit", async () => {
  const repository = await siteRepository("first");
  const checkout = join(await mkdtemp(join(tmpdir(), "god-mode-checkout-")), "site");

  await syncCheckout(checkout, credentialFor(repository));
  assert.equal(gitOut(["-C", checkout, "rev-parse", "HEAD"]), gitOut(["--git-dir", repository, "rev-parse", "main"]));

  const newest = await pushCommit(repository, "second");
  await syncCheckout(checkout, credentialFor(repository));
  assert.equal(gitOut(["-C", checkout, "rev-parse", "HEAD"]), newest);
});

test("a repository that cannot be read is an error, not an empty Site", async () => {
  const missing = join(await mkdtemp(join(tmpdir(), "god-mode-git-")), "no-such-site.git");
  const checkout = join(await mkdtemp(join(tmpdir(), "god-mode-checkout-")), "site");
  await assert.rejects(syncCheckout(checkout, credentialFor(missing)));
});
