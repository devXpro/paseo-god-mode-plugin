import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// One row per tool call, read back through the get_logs tool when
// troubleshooting. Arguments and output are already cut to a few hundred
// characters; the pairing URL never reaches this table.
export const callLog = sqliteTable("call_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: text("at").notNull().default(sql`CURRENT_TIMESTAMP`),
  tool: text("tool").notNull(),
  args: text("args").notNull(),
  ok: integer("ok", { mode: "boolean" }).notNull(),
  durationMs: integer("duration_ms").notNull(),
  output: text("output").notNull(),
  error: text("error"),
});
