import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { latestRelease, parseRelease, resetLatestCache } from "./latest.ts";
import { productOf, readLedger, recordRelease } from "./ledger.ts";

const response = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

test("the latest GitHub release is read, compared with the installed version and cached", async () => {
  resetLatestCache();
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return response(200, { tag_name: "v0.6.0", html_url: "https://github.com/x/y/releases/tag/v0.6.0" });
  }) as unknown as typeof fetch;
  assert.deepEqual(await latestRelease("0.5.0", fetchImpl), { version: "0.6.0", url: "https://github.com/x/y/releases/tag/v0.6.0", newer: true });
  assert.equal((await latestRelease("0.6.0", fetchImpl))?.newer, false);
  assert.equal(calls, 1, "a second question within 15 minutes does not call GitHub");
});

test("no release yet, or no network, is not an error", async () => {
  resetLatestCache();
  assert.equal(await latestRelease("0.5.0", (async () => response(404, {})) as unknown as typeof fetch), null);
  resetLatestCache();
  assert.equal(await latestRelease("0.5.0", (async () => { throw new Error("offline"); }) as unknown as typeof fetch), null);
  assert.equal(parseRelease({ message: "Not Found" }), null);
});

test("the ledger names the product version of a rollback from the release that published it", async () => {
  process.env.PASEO_HOME = await mkdtemp(join(tmpdir(), "god-mode-ledger-"));
  const published = (versionNumber: number) => ({ outcome: "published" as const, versionNumber, commit: `c${versionNumber}`, url: null, message: "" });
  await recordRelease("update", published(8), { product: "0.4.0", source: "v0.4.0" });
  await recordRelease("update", published(9), { product: "0.4.1", source: "v0.4.1" });
  const back = await recordRelease("rollback", { outcome: "rolled-back", versionNumber: 8, commit: "c8", url: null, message: "" }, { product: "0.4.1", source: "v0.4.1" });
  assert.equal(back.product, "0.4.0");
  assert.equal(back.source, null);
  const entries = await readLedger();
  assert.equal(entries.length, 3);
  assert.equal(productOf(entries, 9), "0.4.1");
  assert.equal(productOf(entries, 99), null);
  const raw = await readFile(join(process.env.PASEO_HOME, "god-mode", "ledger.json"), "utf8");
  assert.ok(raw.includes('"sitesVersion": 9'));
});
