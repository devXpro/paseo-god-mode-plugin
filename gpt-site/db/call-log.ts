import { and, desc, eq, type SQL } from "drizzle-orm";
import { getDb } from "./index";
import { callLog } from "./schema";

export type CallLogEntry = {
  tool: string;
  args: string;
  ok: boolean;
  durationMs: number;
  output: string;
  error: string | null;
};

// The call log behind core/mcp.mjs: record() after every tool call, recent()
// for get_logs, newest first.
export function createCallLog() {
  const db = getDb();
  return {
    async record(entry: CallLogEntry) {
      await db.insert(callLog).values(entry);
    },
    async recent({ limit, errorsOnly, tool }: { limit: number; errorsOnly: boolean; tool?: string }) {
      const filters: SQL[] = [];
      if (errorsOnly) filters.push(eq(callLog.ok, false));
      if (tool) filters.push(eq(callLog.tool, tool));
      const rows = await db
        .select()
        .from(callLog)
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(callLog.id))
        .limit(limit);
      if (rows.length === 0) return "No calls logged yet.";
      return rows
        .map((r) => `${r.at} UTC ${r.tool} ${r.ok ? "ok" : "FAILED"} ${r.durationMs} ms ${r.args}\n  -> ${r.error ?? r.output}`)
        .join("\n");
    },
  };
}
