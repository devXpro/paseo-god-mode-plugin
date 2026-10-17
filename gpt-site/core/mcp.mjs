// The MCP side of God Mode: configuration, the instructions and tool
// metadata ChatGPT reads, and JSON-RPC dispatch. Kept free of Worker APIs so it
// runs under node --test; app/mcp/route.ts only wires in env, the operations
// and the call log.
import { PaseoOffline } from "./paseo.mjs";
import { BUILD } from "./build.mjs";
import { VERSION } from "./version.mjs";
import { truncate } from "./text.mjs";
import { IMAGES_WIDGET_HTML } from "./widget.mjs";

const MODES = ["default", "acceptEdits", "auto", "bypassPermissions", "plan"];
const READ_VIEWS = ["text", "commands", "thinking"];
// Tools that act on agents or plugins: when one fails, nobody knows whether it took effect.
const WRITES = new Set(["start_chat", "send_message", "answer_approval", "stop_chat", "archive_chat", "update_site", "plugin_action"]);
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

// Which words of a given language send and which only discuss: English examples do not carry
// over to every phrasing (in Russian, "можешь закинуть" was read as an order).
const COMMAND_HINTS = {
  ru: 'In Russian, sending needs a direct command: «отправь», «отправляй», «закидывай», «скажи ему сейчас», or «да» to your «Отправить?». Not commands, ask «Отправить?» first: «можешь закинуть», «попроси агента …», «давай ему скажем …», «надо бы ему сказать …», «напиши промпт … и потом закинем».',
};

// Server-level guidance. OpenAI: keep the essentials in the first 512
// characters and do not repeat the tool descriptions.
export function buildInstructions(config) {
  const lines = [
    "Paseo runs the user's coding agents (Claude, Codex…) on their computer. A chat is one agent conversation in a project; subagents are helpers its agent started.",
    "One call per request: news or what needs the user → overview; what an agent or its subagents are doing now → read_activity; what a chat said or ran → read_chat; a picture or screenshot from a chat → show_images; where something was said → search_messages. Paseo plugins (beyond agent chats) → plugin_read.",
    'Write tools act on real agents: call one only when the user\'s latest words tell you to act now ("send it", "send it now", "tell it now: …", "start a chat in X …", "allow it", "stop it", "archive it"), or are "yes" to your own "Send it?". Not commands, so ask "Send it?" and wait: "write/draft a prompt" (also "…and then we\'ll send it"), "ask the agent to …", "let\'s tell it …", "you can/could send it", "we should tell it…", "I think it should…", "maybe we send it?", "ok" after a draft you did not ask about.',
    "One instruction from the user is one write call: never split it into several messages, never send it again or a reworded copy, not even after you described or planned what happens next.",
    '"It", "the agent", "this chat" mean the chat being discussed; keep it until the user names another. Reuse ids from earlier results instead of listing again. Names work too: the tools resolve what the user said and offer candidates when unsure.',
    "A write result is the truth: delivered=true (replied, still_working, not_waiting) means it arrived, so never send it again unless the user asks for another message; busy = not delivered: ask whether to add it to the current work or interrupt, and after that question a plain \"send it\" means add it (if_busy steer); an error = not confirmed, never say it was sent.",
    "If an agent is still working, say so and offer to check later; do not poll.",
    "Name chats by their title; never read ids, hashes or links aloud.",
    config.confirmRisky
      ? 'Before allowing a request, stopping or archiving a chat or updating God Mode, the user must have heard exactly what will happen and said yes; "allow it" right after you read the request out is that yes.'
      : "Act on approvals, stops and archiving as soon as the user asks; no read-back needed.",
    config.language
      ? `Speak to the user in ${languageName(config.language)}. Keep answers to one or two sentences unless they ask for more.`
      : "Answer in the user's language, in one or two sentences unless they ask for more.",
    COMMAND_HINTS[config.language],
    DICTATION_HINTS[config.language],
  ];
  return lines.filter(Boolean).join("\n");
}

// ---- Input pieces -----------------------------------------------------------

const CHAT = {
  type: "string",
  description:
    "The chat: its id from earlier results in this conversation when you have it, or else the name the user said. Keep the chat being discussed until the user names another. Ids are for calls only; to the user, say the chat's title.",
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
    subagents_running: { type: "integer", description: "Subagents of this chat working now; given by overview and read_activity." },
    context: {
      type: "object",
      description: "How full the agent's context window is, as Paseo's context meter shows it. Absent when Paseo does not know yet: after a restart of Paseo, until the agent's next turn.",
      properties: {
        used_tokens: { type: "integer" },
        max_tokens: { type: "integer" },
        percent_used: { type: "integer" },
        remaining_tokens: { type: "integer" },
      },
    },
  },
  required: ["id", "short_id", "title", "project", "status", "updated_at"],
};

const CLARIFY_OUT = {
  type: "object",
  description: "Set instead of a result when the reference was ambiguous or unknown: ask the user, then call again.",
  properties: { kind: { type: "string" }, query: { type: "string" }, candidates: { type: "array", items: {} } },
};

const IMAGE_REF = {
  type: "object",
  properties: {
    n: { type: "integer", description: "N of [image N] in the turn's text." },
    name: { type: "string", description: 'The agent\'s alt text, or "image N".' },
    viewable: { type: "boolean", description: "show_images can show it: a file on the Mac, not a web link." },
  },
};

const TURN_OUT = {
  type: "object",
  properties: {
    turn: { type: "integer", description: "Counted from the latest: 1 = latest." },
    position: { type: "integer", description: "Counted from the start of the chat: 1 = first." },
    started_at: time,
    ended_at: time,
    user_text: { type: "string" },
    agent_text: { type: "string", description: "Final message first; earlier ones dropped to fit. Images read as [image N]." },
    omitted_messages: { type: "integer" },
    errors: { type: "array", items: { type: "string" } },
    images: { type: "array", items: IMAGE_REF, description: "The images in this turn; show_images with this turn shows them." },
    total_tool_calls: { type: "integer" },
    tool_calls: {
      type: "array",
      items: { type: "object", properties: { kind: { type: "string" }, name: { type: "string" }, status: { type: "string" }, text: { type: "string" } } },
    },
    thinking: { type: "string", description: "view thinking: the agent's reasoning in this turn, latest kept first; empty when the model shared none." },
    omitted_thoughts: { type: "integer" },
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
    delivered: { type: "boolean", description: "true: it reached the agent, never send it again. false: nothing was sent (busy)." },
    reply: { type: "string" },
    images: { type: "integer", description: "Images in the reply; show_images shows them." },
    approval: { type: "string" },
    error: { type: "string" },
    needs_clarification: CLARIFY_OUT,
  },
};

const SUBAGENT_OUT = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string", description: "The subagent's name or type, e.g. Explore." },
    task: { type: "string" },
    status: { type: "string", enum: ["running", "completed", "failed", "canceled"] },
    started_at: time,
    updated_at: time,
    elapsed: { type: "string", description: 'How long it has run, or ran, e.g. "4 min".' },
    current_step: { ...nullableString, description: "Its latest tool call or thought, while running." },
    result: { ...nullableString, description: "Its final message, once finished." },
    tokens: nullableString,
  },
};

const ACTIVITY_OUT = {
  type: "object",
  properties: {
    chat: CHAT_OUT,
    working: { type: "boolean", description: "The agent or one of its subagents is working now." },
    turn_started_at: time,
    turn_elapsed: nullableString,
    current_step: { ...nullableString, description: "The agent's latest tool call or message in this turn." },
    subagents_running: { type: "integer" },
    subagents_done: { type: "integer" },
    subagents: { type: "array", items: SUBAGENT_OUT, description: "Running ones first, then the ones finished in the latest turn." },
  },
};

const NOTE = { type: "string", description: "Why this chat was read when the name matched several." };

const SHOWN_IMAGE = {
  type: "object",
  properties: { n: { type: "integer" }, turn: { type: "integer" }, name: { type: "string" }, mime: { type: "string" }, bytes: { type: "integer" } },
};

const SKIPPED_IMAGE = {
  type: "object",
  properties: {
    n: { type: "integer" },
    turn: { type: "integer" },
    name: { type: "string" },
    reason: { type: "string", enum: ["missing", "too_large", "too_much_at_once", "link", "unsupported", "refused", "error"] },
  },
};

const object = (properties) => ({ type: "object", properties: { ...properties, needs_clarification: CLARIFY_OUT } });

const PLUGIN_RISK = { type: "string", enum: ["low", "outward", "disruptive", "destructive"], description: "low: local and undone with one more call; outward: reaches people or services; disruptive: interrupts work or cuts the computer off; destructive: loses something for good." };

const PLUGIN_ACTION_OUT = {
  type: "object",
  properties: {
    id: { type: "string", description: "The operation to pass to plugin_action." },
    title: { type: "string" },
    description: { type: "string" },
    args: { type: "string", description: 'What it takes, e.g. "minutes: 30 | 60 (required)", or "no arguments".' },
    risk: PLUGIN_RISK,
    asks_first: { type: "boolean", description: "It returns needs_confirmation first; it runs after the user's yes." },
  },
};

const PLUGIN_READ_OUT = {
  type: "object",
  properties: {
    id: { type: "string", description: "The operation to pass to plugin_read." },
    title: { type: "string" },
    description: { type: "string" },
    args: { type: "string" },
    main: { type: "boolean", description: "What plugin_read does when no operation is given." },
  },
};

const PLUGIN_OUT = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    summary: { type: "string" },
    available: { type: "boolean", description: "false: installed, but it offers nothing to ChatGPT (see reason)." },
    reason: { type: "string" },
    reads: { type: "array", items: PLUGIN_READ_OUT },
    actions: { type: "array", items: PLUGIN_ACTION_OUT },
    skipped: {
      type: "array",
      description: "Operations its description offered that God Mode could not use, with the reason; for the plugin's author.",
      items: { type: "object", properties: { id: { type: "string" }, reason: { type: "string" } } },
    },
  },
};

const PLUGIN_RESULT = { type: "object", description: "The plugin's answer, trimmed to the fields it marked worth reading; a list or a bare value comes as value." };

// ---- The show_images widget (MCP Apps) ----------------------------------------------------------
// The URI carries a fingerprint of the HTML: ChatGPT caches a template by its URI for up to an hour.
// Any older fingerprint still reads the current HTML, so a result earlier in a conversation keeps
// its view after an update.

const WIDGET_MIME = "text/html;profile=mcp-app";
const WIDGET_URI = `ui://god-mode/images-${fingerprint(IMAGES_WIDGET_HTML)}.html`;
const WIDGET_URI_PATTERN = /^ui:\/\/god-mode\/images(-[0-9a-f]{8})?\.html$/;
const WIDGET = {
  uri: WIDGET_URI,
  name: "images",
  title: "Images from a Paseo chat",
  description: "Shows the images show_images returns and hands them to the model where the host allows.",
  mimeType: WIDGET_MIME,
};
const WIDGET_META = {
  ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
  "openai/widgetPrefersBorder": true,
  "openai/widgetDescription": "The images from the Paseo chat, shown to the user.",
};

// ---- Tools ------------------------------------------------------------------

export const TOOLS = [
  {
    name: "overview",
    description:
      "Use this when the user asks what is going on in Paseo, what is new, what needs them or what is running (\"what's up?\", \"anything new?\"). One call returns chats waiting for an approval, running chats with how many subagents work in each, chats with a new reply, and the projects; every chat comes with an id for later calls, so do not list chats afterwards. Not for reading one chat: use read_chat or read_activity.",
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
      "Use this only to find chats by title, project or state when they are not in this conversation yet (\"which chats are in sends?\", \"which ones are running?\"). If you already have the chat, skip this: the other tools take its id or its name directly. query uses Paseo's own search over chat title, workspace, branch and project. For what was said inside chats use search_messages.",
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
      'Use this to tell the user what a chat said or did, in one call, with the id you already have or the name the user said. Default: the latest turn, the agent\'s final message first; turns=N reads the last N turns at once (turns=5 sums up a whole short chat), never turn by turn. view "commands": the commands and tool calls it ran, only when asked what it ran; view "thinking": the agent\'s reasoning, only when asked how it thought (models often share none). It also tells how full the chat\'s context window is. Images read as [image N]: to show one or say what is on it, use show_images. For what it is doing right now, or its subagents, use read_activity; to find where something was said, search_messages.',
    inputSchema: {
      type: "object",
      properties: {
        chat: CHAT,
        view: { type: "string", enum: READ_VIEWS, description: "text (default): what was said. commands: what it ran. thinking: how it reasoned." },
        turn: { type: "integer", minimum: 1, description: "The newest turn to read, counted from the latest: 1 = latest." },
        turns: { type: "integer", minimum: 1, maximum: 10, description: "How many turns to read, going back from turn. Default 1." },
        max_chars: { type: "integer", minimum: 200, maximum: 6000, description: "Budget for the whole answer. Default 1500 for one turn, 800 per turn for several." },
      },
      required: ["chat"],
    },
    outputSchema: object({
      chat: CHAT_OUT,
      note: NOTE,
      total_turns: { type: "integer" },
      turns: { type: "array", items: TURN_OUT },
    }),
    annotations: readOnly,
  },
  {
    name: "read_activity",
    description:
      'Use this when the user asks what an agent is doing right now, how far it got, or what its subagents are doing ("what is it doing?", "what are the subagents up to?"). One call returns the chat\'s state, current step and how full its context window is, and each subagent\'s task, status, current step and running time; finished subagents come with their result. Leave chat empty to cover every chat where an agent or a subagent is working now. Not for what was said earlier: use read_chat.',
    inputSchema: {
      type: "object",
      properties: {
        chat: { ...CHAT, description: `${CHAT.description} Leave empty for every chat that is working now.` },
        max_chars: { type: "integer", minimum: 200, maximum: 6000, description: "Budget for the whole answer. Default 1500." },
      },
    },
    outputSchema: object({ summary: { type: "string" }, note: NOTE, chats: { type: "array", items: ACTIVITY_OUT } }),
    annotations: readOnly,
  },
  {
    name: "show_images",
    description:
      'Use this when the user wants to see a picture, photo or screenshot from a chat, or asks what is on one ("show me the screenshot", "what\'s in the picture?"). Call it directly, as the first and only tool of the turn, with the chat being discussed; no read_chat or list_chats first. It shows the images on the user\'s screen and, where ChatGPT allows, gives them to you. [image N] in a read_chat result: pass its turn and N. Without a chat it shows the newest image of the most recent chats. Never describe an image you cannot see.',
    inputSchema: {
      type: "object",
      properties: {
        chat: { ...CHAT, description: `${CHAT.description} Leave empty for the newest image in the most recent chats.` },
        turn: { type: "integer", minimum: 1, description: "The turn the images are in, counted from the latest: 1 = latest. Unset: the newest images." },
        image: { type: "integer", minimum: 1, description: "Which image of that turn: the N of [image N]." },
        count: { type: "integer", minimum: 1, maximum: 4, description: "How many images. Default 1, or every image of the turn (up to 4) when turn is set." },
      },
    },
    outputSchema: object({
      chat: CHAT_OUT,
      note: NOTE,
      total_images: { type: "integer", description: "Images found in the turns looked at." },
      images: { type: "array", items: SHOWN_IMAGE, description: "The images on the user's screen now." },
      skipped: { type: "array", items: SKIPPED_IMAGE },
    }),
    annotations: readOnly,
    _meta: {
      ui: { resourceUri: WIDGET_URI },
      "openai/outputTemplate": WIDGET_URI,
      "openai/toolInvocation/invoking": "Getting the images…",
      "openai/toolInvocation/invoked": "Images shown",
    },
  },
  {
    name: "search_messages",
    description:
      "Use this to find where something was said or done (\"find where we discussed X\"), across chats or inside one: one call searches the messages of the most recent chats in parallel and returns the chat, the turn and a snippet; pass chat to search a single chat, project to narrow it. Do not read chats one by one to look for something. To read a match, call read_chat with its chat id and turn.",
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
      "Use this to start one new chat (a new agent) in a project when the user's latest words tell you to start it now, with their task as its first message, like New chat in Paseo. One instruction = one chat: never start it twice, not even reworded. Drafting or discussing a task is not a command: prepare the text and ask \"Start it?\". To continue or answer an existing chat, use send_message instead. delivered=true means the chat started and got the task — tell the user and offer to check later; do not poll. Set model, thinking or mode only when the user asks for them.",
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
      "Use this to send one message to an existing chat when the user's latest words tell you to send now: \"send it\", \"send it now\", \"tell it now: …\", \"continue\", their answer to the agent's question, or \"yes\" to your own \"Send it?\". One instruction = one call: never split it into several messages, never send it again or a reworded copy. Not commands, so ask \"Send it?\" first: \"write/draft a prompt\" (also \"…and then we'll send it\"), \"ask the agent to …\", \"let's tell it …\", \"you can/could send it\", \"I think it should…\", \"maybe we send it?\", \"ok\" after a draft you did not ask about. Use the chat being discussed unless the user names another. The result is the truth: delivered=true (replied, still_working, not_waiting) means it arrived — say so and stop; busy means NOT delivered: ask whether to add it to the current work or interrupt, then call again with if_busy; an error is not confirmed, never say it was sent. If the agent is still working, offer to check later; do not poll.",
    inputSchema: {
      type: "object",
      properties: {
        chat: CHAT,
        text: { type: "string", description: "The message, in the user's words." },
        if_busy: {
          type: "string",
          enum: ["steer", "interrupt"],
          description: 'Only after a busy result and the user\'s answer. steer = add to its current work (also what a plain "send it" means); interrupt = stop it and start on this, only when the user says to interrupt.',
        },
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
      "Use this when a chat is waiting for an approval and the user tells you to allow or deny it. Allowing runs what the agent asked for: if the user has not just heard exactly what that is, say it in one sentence and wait for their yes first; \"allow it\" right after you read it out is that yes. Use the chat id from earlier results. done=false means nothing was answered; never say it was. If nothing is waiting but the agent asked a question in its text (\"translate it?\"), \"allow it\" or \"yes\" answers that question: use send_message.",
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
    description:
      "Use this only when the user tells you to stop or cancel what a chat is doing right now. Unless the user has just confirmed which chat and that it should stop, say it in one sentence and wait for their yes. done=false means nothing was stopped.",
    inputSchema: { type: "object", properties: { chat: CHAT }, required: ["chat"] },
    outputSchema: object({ chat_id: { type: "string" }, done: { type: "boolean" } }),
    annotations: { ...write, destructiveHint: true },
  },
  {
    name: "archive_chat",
    description:
      "Use this only when the user tells you to archive a chat: Paseo hides it from the chat list and keeps its history, and a new message to it brings it back. Unless the user has just confirmed which chat and that it should be archived, say it in one sentence and wait for their yes. busy means nothing was archived because the chat is working now: tell the user, and stop it only if they ask. done=false means nothing was archived.",
    inputSchema: { type: "object", properties: { chat: CHAT }, required: ["chat"] },
    outputSchema: object({
      chat_id: { type: "string" },
      short_id: { type: "string" },
      outcome: { type: "string", enum: ["archived", "busy", "already_archived"] },
      done: { type: "boolean" },
      archived_at: time,
    }),
    annotations: { ...write, destructiveHint: true },
  },
  {
    name: "plugin_read",
    description:
      "Use this for what the user's Paseo plugins know or can do, beyond agent chats. Without plugin: the plugins that offer something to ChatGPT, each with its reads and actions. With a plugin (its id, or the name the user said) and no operation: its main status; or pass a read from that list, with args when it takes any. One call answers, and it also lists the plugin's actions with their arguments, so plugin_action needs no lookup first.",
    inputSchema: {
      type: "object",
      properties: {
        plugin: { type: "string", description: "The plugin: its id from earlier results, or the name the user said. Leave empty to list the plugins." },
        operation: { type: "string", description: "A read of that plugin, by id; leave empty for its main status." },
        args: { type: "object", description: "The read's arguments, when it takes any." },
      },
    },
    outputSchema: object({
      plugins: { type: "array", items: PLUGIN_OUT, description: "Without plugin: every installed plugin, the ones ChatGPT cannot use with the reason." },
      plugin: { type: "string" },
      title: { type: "string" },
      operation: { type: "string" },
      about: { type: "string", description: "What the read reports, as the plugin describes it: how to read result." },
      result: PLUGIN_RESULT,
      actions: { type: "array", items: PLUGIN_ACTION_OUT },
    }),
    annotations: readOnly,
  },
  {
    name: "plugin_action",
    description:
      "Use this only when the user's latest words tell a plugin to do something now. Pass plugin, operation and args as plugin_read lists them. An action that asks first returns needs_confirmation: say confirm_text to the user and, only after their yes, call again with the same plugin, operation and args plus confirmation. outcome done (delivered=true) means it ran: never call it again for that request.",
    inputSchema: {
      type: "object",
      properties: {
        plugin: { type: "string", description: "The plugin: its id from plugin_read, or the name the user said." },
        operation: { type: "string", description: "The action's id from plugin_read." },
        args: { type: "object", description: "The action's arguments as plugin_read lists them; the ones the action fixes itself are left out." },
        confirmation: { type: "string", description: "From needs_confirmation, and only after the user said yes to its confirm_text." },
      },
      required: ["plugin", "operation"],
    },
    outputSchema: object({
      plugin: { type: "string" },
      title: { type: "string" },
      operation: { type: "string" },
      outcome: { type: "string", enum: ["done", "needs_confirmation"] },
      delivered: { type: "boolean", description: "true: the action ran, never repeat it. false: nothing happened yet." },
      risk: PLUGIN_RISK,
      confirm_text: { type: "string", description: "What to tell the user before they say yes." },
      confirmation: { type: "string", description: "Pass back with the same arguments after the user's yes." },
      expires_at: time,
      result: PLUGIN_RESULT,
    }),
    // A plugin action can reach anything the plugin reaches, people included.
    annotations: { ...write, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "update_status",
    description:
      "Use this when the user asks which version of God Mode (this plugin) is live, whether there is an update, or how an update or rollback is going; and once before update_site. One call; it also tells how the last one ended.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: object({
      site_version: { type: "string" },
      build: { ...nullableString, description: "The source this Site was built from, as git describe: a tag such as v0.5.0, or the commits after one." },
      installed_version: nullableString,
      update_available: { type: ["boolean", "null"] },
      latest_release: { ...nullableString, description: "The newest God Mode release on GitHub." },
      latest_is_newer: { type: ["boolean", "null"], description: "That release is newer than the plugin installed on the Mac." },
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
      "Use this only when the user asks to update God Mode or roll it back, after one update_status call. It publishes the version installed in Paseo on the user's Mac. If update_status says it is up to date, do not call this; if it says a newer release is on GitHub, tell the user to update the God Mode plugin in Paseo first. Say in one sentence what will happen and wait for the user's yes before calling. It runs on the Mac for a few minutes and puts the previous version back by itself if its check fails; afterwards offer to check with update_status.",
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
// resources: the show_images widget.
const CAPABILITIES = { tools: {}, resources: {} };

function requireStrings(args, names) {
  const missing = names.filter((n) => typeof args[n] !== "string" || !args[n].trim());
  return missing.length ? `Missing ${missing.join(", ")}.` : null;
}

const isArgs = (value) => value === undefined || (value !== null && typeof value === "object" && !Array.isArray(value));

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
      if (need("chat")) return { invalid: need("chat") };
      if (args.view !== undefined && !READ_VIEWS.includes(args.view)) return { invalid: `view must be one of ${READ_VIEWS.join(", ")}.` };
      return ops.readChat(url, { chat: args.chat, view: args.view ?? "text", turn: args.turn ?? 1, turns: args.turns ?? 1, maxChars: args.max_chars });
    case "read_activity":
      return ops.readActivity(url, { chat: args.chat || undefined, maxChars: args.max_chars });
    case "show_images":
      for (const key of ["turn", "image", "count"]) {
        if (args[key] !== undefined && !(Number.isInteger(args[key]) && args[key] >= 1)) return { invalid: `${key} must be a whole number from 1.` };
      }
      return ops.showImages(url, { chat: args.chat || undefined, turn: args.turn, image: args.image, count: args.count });
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
    case "archive_chat":
      return (need("chat") && { invalid: need("chat") }) || ops.archiveChat(url, { chat: args.chat });
    case "plugin_read":
      if (!isArgs(args.args)) return { invalid: "args must be an object." };
      return ops.pluginRead(url, { plugin: args.plugin || undefined, operation: args.operation || undefined, args: args.args });
    case "plugin_action":
      if (need("plugin", "operation")) return { invalid: need("plugin", "operation") };
      if (!isArgs(args.args)) return { invalid: "args must be an object." };
      // Like update_site: Sites marks a signed-in ChatGPT user, and service access carries no one.
      if (!caller?.identified) return { error: "plugin_action needs a signed-in ChatGPT user; it is not available to service access." };
      return ops.pluginAction(url, { plugin: args.plugin, operation: args.operation, args: args.args, confirmation: args.confirmation || undefined });
    case "update_status":
      return ops.releaseStatus(url, { siteVersion: VERSION, build: BUILD.source });
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
      const write = WRITES.has(name);
      return error instanceof PaseoOffline
        ? { error: `Paseo is offline: the computer running it is probably asleep or disconnected.${write ? " Nothing was sent." : ""}`, detail: message }
        : { error: `Paseo request failed: ${truncate(message, 200)}${write ? " Unknown whether it took effect: never say it did." : ""}`, detail: message };
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
        return reply({ supportedVersions: ["2026-07-28"], capabilities: CAPABILITIES, serverInfo, instructions });
      case "initialize": {
        const asked = rpc.params?.protocolVersion;
        const protocolVersion = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[1];
        return reply({ protocolVersion, capabilities: CAPABILITIES, serverInfo, instructions });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "resources/list":
        return reply({ resources: [WIDGET] });
      case "resources/templates/list":
        return reply({ resourceTemplates: [] });
      case "resources/read": {
        const uri = rpc.params?.uri;
        if (typeof uri !== "string" || !WIDGET_URI_PATTERN.test(uri)) {
          return { jsonrpc: "2.0", id, error: { code: -32602, message: "Resource not found", data: { uri: uri ?? null } } };
        }
        return reply({ contents: [{ uri, mimeType: WIDGET_MIME, text: IMAGES_WIDGET_HTML, _meta: WIDGET_META }] });
      }
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
          // For the widget only: hidden from the model, and never logged (the log keeps the text).
          ...(outcome.meta ? { _meta: outcome.meta } : {}),
        });
      }
      default:
        return fail(-32601, "Method not found");
    }
  };
}
