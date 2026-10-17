// The live Site as ChatGPT sees it: its plugin's tools, their metadata, and real read-only calls whose
// structured results must match the declared schemas. Each attempt uses a fresh app-server, because a
// running one may hold the tool list from before the release.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AppServer } from "../codex/app-server.ts";
import { validate } from "../safety.ts";

interface SiteTool {
  name: string;
  description: string;
  outputSchema?: unknown;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** ChatGPT names a Site plugin's tools "<plugin>.<tool>"; the plugin is the prefix that carries the
 *  most of this Site's tools. */
export function sitePrefix(visible: string[], tools: string[]): string | null {
  const counts = new Map<string, number>();
  for (const name of visible) {
    const dot = name.lastIndexOf(".");
    if (dot > 0 && tools.includes(name.slice(dot + 1))) counts.set(name.slice(0, dot), (counts.get(name.slice(0, dot)) ?? 0) + 1);
  }
  const [best] = [...counts].sort((a, b) => b[1] - a[1]);
  return best && best[1] >= Math.ceil(tools.length / 2) ? best[0] : null;
}

export interface SmokeOptions {
  codex: string;
  checkoutDir: string;
  log: (line: string) => void;
  retries?: number;
  /** Off after a rollback: the checkout may describe newer tools than the version put back. */
  metadata?: boolean;
}

export interface SmokeResult {
  /** Calls that failed or returned results that break their schema: the release is broken. */
  failures: string[];
  /** ChatGPT still showing the previous tool list: the release works, ChatGPT has not caught up. */
  warnings: string[];
}

export async function smokeTest({ codex, checkoutDir, log, retries = 4, metadata = true }: SmokeOptions): Promise<SmokeResult> {
  const { TOOLS } = (await import(pathToFileURL(join(checkoutDir, "core", "mcp.mjs")).href)) as { TOOLS: SiteTool[] };
  const names = TOOLS.map((t) => t.name);
  let problems: string[] = [];
  let stale: string[] = [];
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    problems = [];
    stale = [];
    const server = await AppServer.start(codex, { cwd: checkoutDir });
    try {
      const visible = await server.listTools();
      const prefix = sitePrefix(Object.keys(visible), names);
      if (!prefix) {
        // A brand-new Site's plugin needs Install or Connect in ChatGPT first; nothing can be called yet.
        stale.push("ChatGPT does not show this Site's plugin yet; install or connect it in ChatGPT (Plugins, Created by you).");
      } else {
        if (metadata) {
          for (const tool of TOOLS) {
            const seen = visible[`${prefix}.${tool.name}`];
            if (!seen) stale.push(`ChatGPT does not show the new tool ${tool.name} yet`);
            else if (!String(seen.description ?? "").includes(tool.description)) stale.push(`ChatGPT still shows the old description of ${tool.name}`);
          }
        }
        const schemaOf = (name: string) => TOOLS.find((t) => t.name === name)?.outputSchema as Parameters<typeof validate>[0];
        const check = async (name: string, args: Record<string, unknown>) => {
          if (!names.includes(name)) return null;
          const r = await server.callTool(`${prefix}.${name}`, args);
          if (r.isError) problems.push(`${name}: ${r.text.slice(0, 200)}`);
          else if (!r.structured) problems.push(`${name}: no structured result`);
          else problems.push(...validate(schemaOf(name), r.structured).map((e) => `${name}: ${e}`));
          return r.structured;
        };
        const listing = await check("list_chats", { limit: 2 });
        await check("overview", { hours: 1 });
        // Only where the live plugin has it: a rollback can put back a version from before 0.6.0.
        if (visible[`${prefix}.read_activity`]) await check("read_activity", {});
        const chat = (listing as { chats?: { id?: string }[] } | null)?.chats?.[0]?.id;
        if (chat) await check("read_chat", { chat, turns: 2 });
        // Only where the live plugin has it. The chat's newest image, or word that it has none: a valid result either way.
        if (chat && visible[`${prefix}.show_images`]) await check("show_images", { chat });
        await check("search_messages", { query: "test", limit: 1, scan: 5 });
      }
    } finally {
      server.close();
    }
    if (problems.length === 0 && stale.length === 0) return { failures: [], warnings: [] };
    if (problems.length === 0 && attempt === retries) break;
    if (attempt < retries) {
      log(problems.length
        ? `live check: ${problems.length} failing call(s), checking again in 15 s (${attempt}/${retries})`
        : `the release works; waiting for ChatGPT to show its new tool list (${attempt}/${retries})`);
      await sleep(15_000);
    }
  }
  return { failures: problems, warnings: stale };
}
