// Where God Mode keeps its own state. The host gives a plugin no data directory and its install path
// changes on every update, so everything lives under Paseo's home, readable only by this user.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const dataDir = () => join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "god-mode");
/** The Site's own git checkout: its history lives in Sites, God Mode commits releases on top. */
export const siteCheckoutDir = () => join(dataDir(), "site");
export const jobsDir = () => join(dataDir(), "jobs");
export const siteFile = () => join(dataDir(), "site.json");

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Atomic and private: a temporary file renamed into place, mode 0600 in a 0700 directory. */
export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

export interface SiteRecord {
  projectId: string;
  title: string;
  url: string | null;
  connectedAt: string;
}

export const readSite = () => readJson<SiteRecord | null>(siteFile(), null);
export const writeSite = (site: SiteRecord) => writeJson(siteFile(), site);
