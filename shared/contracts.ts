// RPC contracts shared by the sidebar UI, the plugin server and the God Mode Site, which calls the
// release ones through the relay.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const PLUGIN_ID = "god-mode";

const check = z.object({
  id: z.enum(["paseo", "codex", "chatgpt", "node", "git"]),
  ok: z.boolean(),
  /** What was found, or what to do about it. */
  detail: z.string(),
});
export type Check = z.output<typeof check>;

/** Whether this Mac can publish the Site: the tools a release needs and a ChatGPT login with Sites. */
export const environmentRpc = defineRpc({
  name: "god-mode.environment",
  input: z.object({}),
  output: z.object({ version: z.string(), checks: z.array(check) }),
});

const site = z.object({ projectId: z.string(), title: z.string(), url: z.string().nullable() });

/** The user's own Sites, to pick the one God Mode manages. */
export const listSitesRpc = defineRpc({
  name: "god-mode.sites.list",
  input: z.object({}),
  output: z.object({
    sites: z.array(site.extend({ slug: z.string(), latestVersion: z.number() })),
  }),
});

/** A free, valid address for a new Site. */
export const checkSlugRpc = defineRpc({
  name: "god-mode.site.check-slug",
  input: z.object({ slug: z.string().min(1) }),
  output: z.object({ slug: z.string(), status: z.enum(["available", "invalid", "taken"]) }),
});

/** Creates a new private Site in the user's ChatGPT account and makes it God Mode's. */
export const createSiteRpc = defineRpc({
  name: "god-mode.site.create",
  input: z.object({ title: z.string().min(1).max(80), slug: z.string().min(1).max(63) }),
  output: z.object({ site }),
});

/** Makes an existing Site the one God Mode publishes to. */
export const connectSiteRpc = defineRpc({
  name: "god-mode.site.connect",
  input: z.object({ projectId: z.string().min(1) }),
  output: z.object({ site }),
});

const result = z.object({
  outcome: z.enum(["published", "redeployed", "already-live", "rolled-back"]),
  versionNumber: z.number().nullable(),
  commit: z.string().nullable(),
  url: z.string().nullable(),
  message: z.string(),
});

const job = z.object({
  id: z.string(),
  action: z.enum(["update", "rollback", "configure"]),
  state: z.enum(["running", "succeeded", "failed", "interrupted"]),
  step: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  result: result.nullable(),
  error: z.string().nullable(),
  /** Production may have changed and could not be put back. */
  critical: z.boolean(),
  log: z.array(z.string()),
});
export type JobView = z.output<typeof job>;

const versionRef = z.object({ versionNumber: z.number(), commit: z.string() });

/** What is live, what this plugin would publish, and the current or last release job. */
export const releaseStatusRpc = defineRpc({
  name: "god-mode.release.status",
  input: z.object({ log: z.boolean().default(false) }),
  output: z.object({
    installed: z.string(),
    site: site.nullable(),
    live: versionRef.nullable(),
    newest: versionRef.nullable(),
    releases: z.array(z.number()),
    /** Whether the Site holds the key to this Mac, and whether Sites keeps it as a secret. */
    pairing: z.enum(["secret", "plain", "missing", "unknown"]),
    job: job.nullable(),
  }),
});

/** Starts a job and returns at once: an update to this plugin's Site source, a rollback, or
 *  "configure", which writes the preferences and the key to this Mac to the Site and redeploys it. */
export const releaseStartRpc = defineRpc({
  name: "god-mode.release.start",
  input: z.object({
    action: z.enum(["update", "rollback", "configure"]),
    /** Rollback only: a released version number; omitted means the release before the newest. */
    version: z.number().int().positive().optional(),
  }),
  output: z.object({ job }),
});

export const preferencesSchema = z.object({
  /** A language code such as "en"; empty follows whatever language the user speaks. */
  language: z.string().max(16).default(""),
  newChatModel: z.string().max(80).default(""),
  newChatThinking: z.string().max(40).default(""),
  newChatMode: z.enum(["", "plan", "default", "acceptEdits", "auto", "bypassPermissions"]).default(""),
  waitSeconds: z.number().int().min(0).max(25).default(15),
  /** Say what will happen and wait for a yes before approvals, stops, updates and rollbacks. */
  confirmRisky: z.boolean().default(true),
  /** Keep a call log in the Site's own database. */
  log: z.boolean().default(true),
});
export type Preferences = z.output<typeof preferencesSchema>;

export const getPreferencesRpc = defineRpc({
  name: "god-mode.preferences.get",
  input: z.object({}),
  output: z.object({ preferences: preferencesSchema }),
});

/** Saves on this Mac only; a "configure" job writes them to the Site. */
export const setPreferencesRpc = defineRpc({
  name: "god-mode.preferences.set",
  input: z.object({ preferences: preferencesSchema }),
  output: z.object({ preferences: preferencesSchema }),
});

export const loginStartRpc = defineRpc({
  name: "god-mode.login.start",
  input: z.object({}),
  output: z.object({ loginId: z.string(), verificationUrl: z.string(), userCode: z.string() }),
});

export const loginStatusRpc = defineRpc({
  name: "god-mode.login.status",
  input: z.object({ loginId: z.string() }),
  output: z.object({ state: z.enum(["pending", "done", "failed", "unknown"]), error: z.string().nullable() }),
});
