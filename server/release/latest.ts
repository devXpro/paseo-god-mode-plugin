// The newest God Mode release on GitHub, for "is there an update?". Unauthenticated GitHub API
// calls are limited to 60 an hour, so the answer is kept for 15 minutes; a failed check keeps
// the last answer rather than reporting nothing.
import { compareVersions } from "../../shared/semver.ts";
import { REPOSITORY } from "../../shared/version.ts";

const CACHE_MS = 15 * 60_000;

export interface LatestRelease {
  version: string;
  url: string;
  /** Newer than the plugin installed here. */
  newer: boolean;
}

interface Found {
  version: string;
  url: string;
}

/** releases/latest already skips drafts and pre-releases. */
export function parseRelease(body: unknown): Found | null {
  const release = body as { tag_name?: unknown; html_url?: unknown } | null;
  if (typeof release?.tag_name !== "string" || typeof release.html_url !== "string") return null;
  return { version: release.tag_name.replace(/^v/, ""), url: release.html_url };
}

let cached: { at: number; found: Found | null } | null = null;

export async function latestRelease(installed: string, fetchImpl: typeof fetch = fetch): Promise<LatestRelease | null> {
  if (!cached || Date.now() - cached.at > CACHE_MS) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 5_000);
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "paseo-god-mode" },
        signal: abort.signal,
      });
      if (response.ok || response.status === 404) {
        cached = { at: Date.now(), found: response.ok ? parseRelease(await response.json()) : null };
      }
    } catch {
      // offline or rate-limited: keep whatever was known
    } finally {
      clearTimeout(timer);
    }
  }
  const found = cached?.found;
  return found ? { ...found, newer: compareVersions(found.version, installed) > 0 } : null;
}

export function resetLatestCache() {
  cached = null;
}
