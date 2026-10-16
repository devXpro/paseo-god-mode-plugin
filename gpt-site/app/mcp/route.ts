import { env } from "cloudflare:workers";
import { createMcpHandler, readConfig } from "../../core/mcp.mjs";
import * as ops from "../../core/paseo.mjs";
import { createCallLog } from "../../db/call-log";

// Stateless JSON-RPC endpoint for the Site's MCP server. Everything except
// wiring lives in core/, which runs under node --test.
export async function POST(request: Request) {
  let rpc: unknown;
  try {
    rpc = await request.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  const vars = env as unknown as Record<string, string | undefined> & { DB?: unknown };
  const config = readConfig(vars);
  const log = config.log && vars.DB ? createCallLog() : null;
  // Sites adds the signed-in ChatGPT user's id; service access (a bypass bearer) carries none.
  const caller = { identified: Boolean(request.headers.get("oai-authenticated-user-id")) };
  const response = await createMcpHandler({ config, ops, log, caller })(rpc);
  return response ? Response.json(response) : new Response(null, { status: 202 });
}
