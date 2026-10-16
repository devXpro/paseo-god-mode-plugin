// Which God Mode version each Sites version is. Sites numbers versions per Site and knows nothing of
// product versions, so every finished job is written down here; a rollback or a redeploy names its
// product version by looking up the release that first put that Sites version out.
import { join } from "node:path";
import type { JobView } from "../../shared/contracts.ts";
import { dataDir, readJson, writeJson } from "../store.ts";
import type { ReleaseResult } from "./pipeline.ts";

const KEEP = 500;
const file = () => join(dataDir(), "ledger.json");

export interface LedgerEntry {
  at: string;
  action: JobView["action"];
  outcome: ReleaseResult["outcome"];
  /** The product version now live, when known. */
  product: string | null;
  sitesVersion: number | null;
  siteCommit: string | null;
  /** The plugin source it was built from, as git describe. */
  source: string | null;
}

export const readLedger = () => readJson<LedgerEntry[]>(file(), []);

export function productOf(entries: LedgerEntry[], sitesVersion: number | null): string | null {
  if (sitesVersion == null) return null;
  return entries.find((e) => e.sitesVersion === sitesVersion && e.outcome === "published")?.product ?? null;
}

export async function recordRelease(
  action: JobView["action"],
  result: ReleaseResult,
  built: { product: string; source: string | null },
): Promise<LedgerEntry> {
  const entries = await readLedger();
  const published = result.outcome === "published";
  const entry: LedgerEntry = {
    at: new Date().toISOString(),
    action,
    outcome: result.outcome,
    product: published ? built.product : productOf(entries, result.versionNumber),
    sitesVersion: result.versionNumber,
    siteCommit: result.commit,
    source: published ? built.source : null,
  };
  await writeJson(file(), [...entries, entry].slice(-KEEP));
  return entry;
}
