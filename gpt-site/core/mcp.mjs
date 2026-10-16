// The MCP side of God Mode: configuration, the instructions and tool
// metadata ChatGPT reads, and JSON-RPC dispatch. Kept free of Worker APIs so it
// runs under node --test; app/mcp/route.ts only wires in env, the operations
// and the call log.
import { PaseoOffline } from "./paseo.mjs";
import { VERSION } from "./version.mjs";
import { truncate } from "./text.mjs";

const MODES = ["default", "acceptEdits", "auto", "bypassPermissions", "plan"];
const CALL_DEADLINE_MS = 45_000;
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

// Site settings → Environment variables. Only PASEO_PAIRING_URL is required.
export function readConfig(env = {}) {
  const flag = (value, fallback) => (value === undefined || value === "" ? fallback : !["off", "false", "0", "no"].includes(String(value).toLowerCase()));
  const wait = Number(env.PASEO_WAIT_SECONDS);
  return {
    pairingUrl: typeof env.PASEO_PAIRING_URL === "string" ? env.PASEO_PAIRING_URL : "",
    language: env.PASEO_LANGUAGE || "",
    model: env.PASEO_NEW_CHAT_MODEL || undefined,
    thinking: env.PASEO_NEW_CHAT_THINKING || undefined,
    mode: MODES.includes(env.PASEO_NEW_CHAT_MODE) ? env.PASEO_NEW_CHAT_MODE : undefined,
    waitSeconds: Number.isFinite(wait) && wait >= 0 ? Math.min(wait, 25) : 15,
    confirmRisky: flag(env.PASEO_CONFIRM_RISKY, true),
    log: flag(env.PASEO_LOG, true),
  };
}

function languageName(code) {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

// How speech recognition in a given language tends to mangle the word "Paseo".
const DICTATION_HINTS = {
  ru: 'Speech recognition often writes "Paseo" as "по SEO", "посыл" or "пасео".',
};

// Server-level guidance. OpenAI: keep the essentials in the first 512
// characters and do not repeat the tool descriptions.
export function buildInstructions(config) {
  const lines = [
    "Paseo runs the user's Claude coding agents on their computer. A chat is one agent conversation inside a project.",
    'Call rules: as few calls as possible. A chat #id already in this conversation goes straight to read_chat or send_message, no list_chats. list_chats only finds or filters chats not known yet. Latest turn: one read_chat, no view "turns" first. Several recent turns: one read_chat with turns=N, never turn by turn. Where something was said: one search_messages, not chat by chat.',
    "Names work too: the tools resolve what the user said, return candidates when unsure and list every project when a name does not match, so retry with the right spelling yourself.",
    "Keep using the chat the user chose until they switch.",
    config.confirmRisky
      ? "Before answer_approval, stop_chat or update_site, say in one sentence what will happen and wait for the user's yes."
      : "Act on approvals, stops and updates as soon as the user asks; no read-back needed.",
    'read_chat shows what the agent wrote by default; use view "commands" only when the user asks what the agent ran or did.',
    "When a tool says the agent is still working, tell the user and offer to check later.",
    config.language
      ? `Speak to the user in ${languageName(config.language)}. Keep answers to one or two sentences unless they ask for more.`
      : "Answer in the user's language, in one or two sentences unless they ask for more.",
    DICTATION_HINTS[config.language],
  ];
  return lines.filter(Boolean).join("\n");
}

// ---- Input pieces -----------------------------------------------------------

const CHAT = {
  type: "string",
  description: 'The chat: its #id (short like "#a22524f", or full), reused from earlier results in this conversation when you have it, or else the name the user said.',
};
const PROJECT = { type: "string", description: "The project name as listed, or as the user said it." };
const WAIT = { type: "integer", minimum: 0, maximum: 25, description: "Seconds to wait for the agent's reply. Leave unset for the default." };
const INCLUDE_ARCHIVED = { type: "boolean", description: "Also look in archived chats. Default false." };
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

// ---- Output schemas (structuredContent) -------------------------------------
// Every field is optional at the top level: a call that needs the user to pick
// among candidates returns only needs_clarification.

const nullableString = { type: ["string", "null"] };
const time = { type: ["string", "null"], format: "date-time", description: "ISO 8601, UTC." };

const CHAT_OUT = {
  type: "object",
  properties: {
    id: { type: "string" },
    short_id: { type: "string" },
    title: { type: "string" },
    project: { type: "string" },
    workspace: nullableString,
    status: { type: "string", description: "Paseo lifecycle: initializing, idle, running, error, closed." },
    state: { type: "string", description: "What the chat means for the user: running, waiting for approval: …, new reply, error, idle." },
    pending_approvals: { type: "array", items: { type: "string" } },
    updated_at: time,
    updated_ago: nullableString,
    created_at: time,
    archived: { type: "boolean" },
  },
  required: ["id", "short_id", "title", "project", "status", "updated_at"],
};

const CLARIFY_OUT = {
  type: "object",
  description: "Set instead of a result when the reference was ambiguous or unknown: ask the user, then call again.",
  properties: { kind: { type: "string" }, query: { type: "string" }, candidates: { type: "array", items: {} } },
};

const TURN_OUT = {
  type: "object",
  properties: {
    turn: { type: "integer", description: "Counted from the latest: 1 = latest." },
    position: { type: "integer", description: "Counted from the start of the chat: 1 = first." },
    started_at: time,
    ended_at: time,
    user_text: { type: "string" },
    agent_text: { type: "string", description: "Final message first; earlier ones dropped to fit." },
    omitted_messages: { type: "integer" },
    errors: { type: "array", items: { type: "string" } },
    preview: { type: "string" },
    total_tool_calls: { type: "integer" },
    tool_calls: {
      type: "array",
      items: { type: "object", properties: { kind: { type: "string" }, name: { type: "string" }, status: { type: "string" }, text: { type: "string" } } },
    },
  },
};

const MATCH_OUT = {
  type: "object",
  properties: { turn: { type: "integer" }, role: { type: "string" }, at: time, snippet: { type: "string" } },
};

const OUTCOME_OUT = {
  type: "object",
  properties: {
    chat_id: { type: "string" },
    short_id: { type: "string" },
    project: { type: "string" },
    outcome: { type: "string", enum: ["replied", "waiting_for_approval", "error", "still_working", "not_waiting", "busy"] },
    reply: { type: "string" },
    approval: { type: "string" },
    error: { type: "string" },
    needs_clarification: CLARIFY_OUT,
  },
};

const object = (properties) => ({ type: "object", properties: { ...properties, needs_clarification: CLARIFY_OUT } });

// ---- Tools ------------------------------------------------------------------

export const TOOLS = [
  {
    name: "overview",
    description:
      "Use this when the user asks what is going on in Paseo, what needs them or what is running. Returns chats waiting for an approval, running chats, chats with a new reply, and the projects, each chat with its #id. One call: use those ids directly afterwards, without list_chats.",
    inputSchema: {
      type: "object",
      properties: { hours: { type: "integer", minimum: 1, maximum: 168, description: "How far back to look for new replies. Default 12." } },
    },
    outputSchema: object({
      summary: { type: "string" },
      hours: { type: "integer" },
      waiting: { type: "array", items: CHAT_OUT },
      running: { type: "array", items: CHAT_OUT },
      new: { type: "array", items: CHAT_OUT },
      projects: { type: "array", items: { type: "object", properties: { name: { type: "string" }, chats: { type: "integer" } } } },
    }),
    annotations: readOnly,
  },
  {
    name: "list_chats",
    description:
      "Use this only to find or filter chats not yet known in this conversation. If you already have the chat's #id, skip this and call read_chat or send_message with it; those tools also take names. query uses Paseo's own search over chat title, workspace, branch and project; it can also list one project's chats or chats in one state. For what was said inside chats use search_messages.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT,
        status: { type: "string", enum: ["running", "waiting", "new", "all"], description: "waiting = needs an approval; new = unread reply or error." },
        query: { type: "string", description: "Words from the chat's title, workspace, branch or project." },
        include_archived: INCLUDE_ARCHIVED,
        limit: { type: "integer", minimum: 1, maximum: 30 },
      },
    },
    outputSchema: object({
      scope: { type: "string" },
      query: nullableString,
      include_archived: { type: "boolean" },
      total: { type: "integer" },
      chats: { type: "array", items: CHAT_OUT },
    }),
    annotations: readOnly,
  },
  {
    name: "read_chat",
    description:
      'Use this to tell the user what happened in a chat, in one call. Pass the #id you already have; no lookup first. For the latest turn call it once with no view; do not call view "turns" first. For the last N turns call it once with turns=N (up to 10), e.g. turns=5 to catch up on a whole short chat; never turn by turn. view "text" (default): what was said, the agent\'s final message first. "commands": the shell commands and tool calls with their output, only when the user asks what the agent ran. "turns": the list of turns, latest first, only when the user wants that list. "search": where a phrase occurs in this chat.',
    inputSchema: {
      type: "object",
      properties: {
        chat: CHAT,
        view: { type: "string", enum: ["text", "commands", "turns", "search"] },
        turn: { type: "integer", minimum: 1, description: "The newest turn to read, counted from the latest: 1 = latest." },
        turns: { type: "integer", minimum: 1, maximum: 10, description: "How many turns to read, going back from turn. Default 1." },
        query: { type: "string" },
        max_chars: { type: "integer", minimum: 200, maximum: 6000, description: "Budget for the whole answer. Default 1500 for one turn, 800 per turn for several." },
      },
      required: ["chat"],
    },
    outputSchema: object({
      chat: CHAT_OUT,
      total_turns: { type: "integer" },
      turns: { type: "array", items: TURN_OUT },
      query: { type: "string" },
      total_matches: { type: "integer" },
      matches: { type: "array", items: MATCH_OUT },
    }),
    annotations: readOnly,
  },
  {
    name: "search_messages",
    description:
      "Use this to find where something was said or done: one call searches the message text of many chats at once (the most recent ones, in parallel) and returns the chat #id, the turn and a snippet. Do not read chats one by one to look for something. Narrow it with project, or with chat for a single chat. To read a match, call read_chat with its #id and turn.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "A word or phrase to find in messages." },
        project: PROJECT,
        chat: CHAT,
        include_archived: INCLUDE_ARCHIVED,
        scan: { type: "integer", minimum: 1, maximum: 50, description: "How many of the most recent chats to search. Default 20." },
        limit: { type: "integer", minimum: 1, maximum: 30, description: "Most matches to return. Default 10." },
      },
      required: ["query"],
    },
    outputSchema: object({
      query: { type: "string" },
      searched_chats: { type: "integer" },
      matched_chats: { type: "integer" },
      total_matches: { type: "integer" },
      matches: {
        type: "array",
        items: {
          type: "object",
          properties: {
            chat: {
              type: "object",
              properties: { id: { type: "string" }, short_id: { type: "string" }, title: { type: "string" }, project: { type: "string" }, updated_at: time, archived: { type: "boolean" } },
              required: ["id", "title", "project"],
            },
            ...MATCH_OUT.properties,
          },
        },
      },
    }),
    annotations: readOnly,
  },
  {
    name: "start_chat",
    description:
      "Use this to start a new chat (a new agent) in a project with the user's task as its first message, like New chat in Paseo. Waits briefly for the reply. Set model, thinking or mode only when the user asks for them.",
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT,
        prompt: { type: "string", description: "The task, in the user's words." },
        wait_seconds: WAIT,
        model: { type: "string", description: 'A Claude model id, e.g. "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5".' },
        thinking: { type: "string", enum: ["off", "low", "medium", "high", "xhigh", "max"] },
        mode: { type: "string", enum: MODES, description: "Permission mode; bypassPermissions skips every prompt." },
      },
      required: ["project", "prompt"],
    },
    outputSchema: OUTCOME_OUT,
    annotations: write,
  },
  {
    name: "send_message",
    description:
      "Use this to say something to an existing chat: a follow-up task, or the user's answer when the agent asked a question in its text. Pass the #id you already have; no lookup first. If the chat is busy the tool says so; ask the user whether to interrupt it or add to the current work, then call again with if_busy.",
    inputSchema: {
      type: "object",
      properties: {
        chat: CHAT,
        text: { type: "string", description: "The message, in the user's words." },
        if_busy: { type: "string", enum: ["steer", "interrupt"], description: "steer = add to the current work; interrupt = stop it and start on this." },
        wait_seconds: WAIT,
      },
      required: ["chat", "text"],
    },
    outputSchema: OUTCOME_OUT,
    annotations: write,
  },
  {
    name: "answer_approval",
    description:
      "Use this when a chat is waiting for an approval (overview, list_chats and read_chat show it) and the user says to allow or deny it. Use the #id from that result directly.",
    inputSchema: {
      type: "object",
      properties: {
        chat: CHAT,
        decision: { type: "string", enum: ["allow", "deny"] },
        request: { type: "string", description: "Which request, by number or words, when several are waiting." },
      },
      required: ["chat", "decision"],
    },
    outputSchema: object({ chat_id: { type: "string" }, done: { type: "boolean" }, decision: { type: "string" }, what: nullableString }),
    annotations: write,
  },
  {
    name: "stop_chat",
    description: "Use this only when the user asks to stop or cancel what a chat is doing right now. Use the #id you already have.",
    inputSchema: { type: "object", properties: { chat: CHAT }, required: ["chat"] },
    outputSchema: object({ chat_id: { type: "string" }, done: { type: "boolean" } }),
    annotations: { ...write, destructiveHint: true },
  },
  {
    name: "update_status",
    description:
      "Use this when the user asks which version of God Mode (this plugin) is live, whether there is an update, or how an update or rollback is going. One call; it also tells how the last one ended.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: object({
      site_version: { type: "string" },
      installed_version: nullableString,
      update_available: { type: ["boolean", "null"] },
      live_release: { type: ["integer", "null"] },
      mac_online: { type: "boolean" },
      // Absent when there has been no job. A nullable object type is avoided on purpose: no other
      // tool uses one, and a tool list ChatGPT will not take keeps the plugin on its old tools.
      job: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["update", "rollback", "configure"] },
          state: { type: "string", enum: ["running", "succeeded", "failed", "interrupted"] },
          step: { type: "string" },
          started_at: time,
          finished_at: time,
          message: nullableString,
          error: nullableString,
        },
      },
    }),
    annotations: readOnly,
  },
  {
    name: "update_site",
    description:
      "Use this only when the user asks to update God Mode to the latest version, or to roll it back. It runs on the user's Mac in the background for a few minutes: tests, publishes this Site, checks it, and puts the previous version back by itself if the check fails. Say in one sentence what will happen and wait for the user's yes before calling. Afterwards offer to check with update_status.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["update", "rollback"], description: "update: to the version installed in Paseo on the Mac. rollback: back to the release before the newest." },
      },
      required: ["action"],
    },
    outputSchema: object({ started: { type: "boolean" }, action: { type: "string" }, job_id: nullableString, message: { type: "string" } }),
    annotations: { ...write, destructiveHint: true },
  },
  {
    name: "get_logs",
    description:
      "Use this only when the user asks for God Mode's own log or is troubleshooting this plugin. Returns recent tool calls with timing, outcome and errors.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 20." },
        errors_only: { type: "boolean" },
        tool: { type: "string", description: "Only calls of this tool." },
      },
    },
    annotations: readOnly,
  },
];

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

function requireStrings(args, names) {
  const missing = names.filter((n) => typeof args[n] !== "string" || !args[n].trim());
  return missing.length ? `Missing ${missing.join(", ")}.` : null;
}

// Maps a tool call to its operation. Returns the operation's { text, data },
// or { invalid } for bad arguments.
async function dispatch(name, args, config, ops, log, caller) {
  const url = config.pairingUrl;
  const need = (...names) => requireStrings(args, names);
  switch (name) {
    case "overview":
      return ops.overview(url, { hours: args.hours ?? 12 });
    case "list_chats":
      return ops.listChats(url, {
        project: args.project,
        status: args.status,
        query: args.query,
        includeArchived: Boolean(args.include_archived),
        limit: args.limit ?? 10,
      });
    case "read_chat":
      return (
        (need("chat") && { invalid: need("chat") }) ||
        ops.readChat(url, {
          chat: args.chat,
          view: args.view ?? "text",
          turn: args.turn ?? 1,
          turns: args.turns ?? 1,
          query: args.query,
          maxChars: args.max_chars,
        })
      );
    case "search_messages":
      return (
        (need("query") && { invalid: need("query") }) ||
        ops.searchMessages(url, {
          query: args.query,
          project: args.project,
          chat: args.chat,
          includeArchived: Boolean(args.include_archived),
          scan: args.scan,
          limit: args.limit ?? 10,
        })
      );
    case "start_chat":
      return (
        (need("project", "prompt") && { invalid: need("project", "prompt") }) ||
        ops.startChat(url, {
          project: args.project,
          prompt: args.prompt,
          model: args.model ?? config.model,
          thinking: args.thinking ?? config.thinking,
          mode: args.mode ?? config.mode,
          waitSeconds: args.wait_seconds ?? config.waitSeconds,
        })
      );
    case "send_message":
      return (
        (need("chat", "text") && { invalid: need("chat", "text") }) ||
        ops.sendMessage(url, { chat: args.chat, text: args.text, ifBusy: args.if_busy, waitSeconds: args.wait_seconds ?? config.waitSeconds })
      );
    case "answer_approval":
      return (need("chat", "decision") && { invalid: need("chat", "decision") }) || ops.answerApproval(url, { chat: args.chat, decision: args.decision, request: args.request });
    case "stop_chat":
      return (need("chat") && { invalid: need("chat") }) || ops.stopChat(url, { chat: args.chat });
    case "update_status":
      return ops.releaseStatus(url, { siteVersion: VERSION });
    case "update_site":
      if (!["update", "rollback"].includes(args.action)) return { invalid: 'action must be "update" or "rollback".' };
      // Sites marks requests from a signed-in ChatGPT user; service access carries no identity.
      if (!caller?.identified) return { error: "update_site needs a signed-in ChatGPT user; it is not available to service access." };
      return ops.releaseStart(url, { action: args.action });
    case "get_logs":
      if (!log) return { text: "Logging is off or the database is not available." };
      return { text: await log.recent({ limit: Math.min(args.limit ?? 20, 100), errorsOnly: Boolean(args.errors_only), tool: args.tool }) };
    default:
      return { invalid: `Unknown tool ${name}.` };
  }
}

function withDeadline(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms);
    }),
  ]);
}

// Records arguments without letting a long prompt flood the log.
function loggableArgs(args) {
  return JSON.stringify(args, (_, value) => (typeof value === "string" ? truncate(value, 300) : value));
}

// Operations used to return plain strings; both shapes are accepted.
const normalizeOutcome = (result) => (typeof result === "string" ? { text: result } : result);


// FNV-1a, enough to fingerprint the metadata.
function fingerprint(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// ChatGPT kept the 0.3.0 tool descriptions after a redeploy that changed only
// descriptions, while a deploy that also bumped this version refreshed them.
// So the version carries a fingerprint of everything the model reads.
export function serverVersion(instructions) {
  return `${VERSION}+${fingerprint(JSON.stringify(TOOLS) + instructions)}`;
}

// Returns a JSON-RPC handler: (message) => response object, or null for
// notifications that need no body.
export function createMcpHandler({ config, ops, log, caller }) {
  const instructions = buildInstructions(config);
  // The name the Site's plugin was first registered with; the version is what must move.
  const serverInfo = { name: "paseo-remote", version: serverVersion(instructions) };

  async function callTool(name, args) {
    if (!TOOL_NAMES.has(name)) {
      // Usually ChatGPT holding the tool list of an older version of this Site.
      return {
        error: `There is no tool "${name}": ChatGPT is using an outdated tool list for this plugin. Tell the user to start a new chat so it reloads. Current tools: ${[...TOOL_NAMES].join(", ")}.`,
      };
    }
    if (name !== "get_logs" && !config.pairingUrl) {
      return { error: "Configure the PASEO_PAIRING_URL site secret and redeploy before using these tools." };
    }
    try {
      return normalizeOutcome(await withDeadline(dispatch(name, args, config, ops, log, caller), CALL_DEADLINE_MS));
    } catch (error) {
      // core/ already scrubs the key parts; this also catches the whole URL.
      const message = String(error?.message ?? "unknown error").replaceAll(config.pairingUrl || "\u0000", "[redacted]");
      return error instanceof PaseoOffline
        ? { error: "Paseo is offline: the computer running it is probably asleep or disconnected.", detail: message }
        : { error: `Paseo request failed: ${truncate(message, 200)}`, detail: message };
    }
  }

  async function callAndLog(name, args) {
    const startedAt = Date.now();
    const outcome = await callTool(name, args);
    if (log && name !== "get_logs") {
      await log
        .record({
          tool: String(name),
          args: loggableArgs(args),
          ok: !outcome.error && !outcome.invalid,
          durationMs: Date.now() - startedAt,
          output: truncate(outcome.text ?? outcome.error ?? outcome.invalid ?? "", 500),
          error: outcome.error ? truncate(outcome.detail ?? outcome.error, 500) : outcome.invalid ?? null,
        })
        .catch(() => {});
    }
    return outcome;
  }

  return async function handle(rpc) {
    const id = rpc?.id ?? null;
    const reply = (result) => ({ jsonrpc: "2.0", id, result });
    const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
    if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") return fail(-32600, "Invalid request");
    if (rpc.method.startsWith("notifications/") && rpc.id === undefined) return null;
    switch (rpc.method) {
      case "server/discover":
        return reply({ supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, serverInfo, instructions });
      case "initialize": {
        const asked = rpc.params?.protocolVersion;
        const protocolVersion = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[1];
        return reply({ protocolVersion, capabilities: { tools: {} }, serverInfo, instructions });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call": {
        const name = rpc.params?.name;
        const args = rpc.params?.arguments ?? {};
        if (typeof args !== "object" || Array.isArray(args)) return fail(-32602, "Invalid arguments");
        const outcome = await callAndLog(name, args);
        if (outcome.invalid) return fail(-32602, outcome.invalid);
        if (outcome.error) return reply({ content: [{ type: "text", text: outcome.error }], isError: true });
        return reply({
          content: [{ type: "text", text: outcome.text }],
          ...(outcome.data ? { structuredContent: outcome.data } : {}),
        });
      }
      default:
        return fail(-32601, "Method not found");
    }
  };
}
