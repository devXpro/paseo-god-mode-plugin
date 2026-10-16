# paseo-remote: design

Drive Paseo's Claude agents from ChatGPT, voice first. Version 0.3: nine tools with
structured results, batch reads and two kinds of search; 0.2 added the call log and per-site
settings; the 0.1 prototype (`list_projects`, `start_agent`) proved the path on 2026-10-16.

## 0. What 0.3 changed, and why this way

- **Batch reads** extend `read_chat` (`turns`, 1-10, going back from `turn`) instead of a new
  tool: one call per catch-up. One turn stays the default, with the old text layout.
- **Absolute time** lives in the structured data (`updated_at`, `started_at`, ISO 8601 UTC, as
  Paseo stores it); the text keeps "8 min ago" for speech.
- **Search by name** is `list_chats(query)` switched to Paseo's own history search (title,
  workspace, branch, project), with `include_archived`. Paseo's history returns archived chats
  regardless of its filter, so they are dropped unless asked for. Spoken inflections Paseo
  misses fall back to our own word matching.
- **Search by content** is the one new tool, `search_messages`: Paseo searches one chat at a
  time, so the Site searches the most recent chats (`scan`, default 20, max 50) eight at a time
  and returns chat, turn, role, time and a snippet. `read_chat view=search` stays for
  compatibility and now carries snippets too.
- **Structure**: `structuredContent` next to the text, matching each tool's `outputSchema`.
  All top-level fields are optional because an ambiguous name returns only
  `needs_clarification`. `initialize` now negotiates the protocol version (structured output
  needs 2025-06-18 or later).
- **Stale tool lists**: a tool name the Site no longer has returns a readable error telling
  ChatGPT to start a new chat, instead of a bare JSON-RPC error. After the 0.2 deploy, ChatGPT
  kept calling 0.1's `list_projects` from an old conversation.
- Archived chats can be read by their full id (search results carry it).
- **Call rules**, stated three times on purpose: in the server instructions (inside the first
  512 characters), in the descriptions of the tools they concern, and as a one-line hint under
  every `list_chats` result. Reuse a #id already in the conversation; `list_chats` only to find
  or filter unknown chats; no `view="turns"` before reading the latest turn; one `turns=N` read
  for a range; one `search_messages` for content. A Site plugin cannot carry a separate skill on
  Plus (personal skills are Business/Enterprise), so the server instructions are the
  plugin-level channel; the ChatGPT project instructions repeat the essentials for voice.

## 1. Path of one request

```
ChatGPT Live voice (phone) or text
  -> ChatGPT picks a tool of the paseo-remote plugin
  -> Site (Cloudflare Worker, stateless JSON-RPC POST /mcp)
  -> wss to the Paseo relay, E2EE with the daemon key from PASEO_PAIRING_URL
  -> Paseo daemon -> Claude agents
  <- compact text back the same way; ChatGPT speaks it
```

Measured through the relay: a read is 1.0-1.3 s, `start_chat` with a short reply 3.7-4 s,
`send_message` with a short reply 2.9 s. The rest is ChatGPT's own model time per tool step,
so speed comes from **fewer tool calls per intent**: every tool takes spoken names, so no
lookup call is needed first.

## 2. Where guidance lives

| Layer | Content | Changes with |
| --- | --- | --- |
| MCP server `instructions` (`initialize` and `server/discover`) | Domain, names vs ids, current-chat rule, read-back rule, read_chat views, language, dictation hints. Essentials in the first 512 characters. | Deploy, and the site settings |
| Tool and parameter descriptions, annotations | "Use this when…", accepted inputs, honest hints. | Deploy |
| Hint lines inside tool results | The next step: ask which chat, still working, chat busy. | Deploy |
| ChatGPT project instructions | Style and routing only. | By hand, rarely |

Model-facing text is English. The language spoken to the user is the `PASEO_LANGUAGE` setting;
unset means "the user's language". Per-language hints (how dictation mangles "Paseo") are in
`DICTATION_HINTS` in `core/mcp.mjs` and only appear for their language.

## 3. Tools

| Tool | Kind | Notes |
| --- | --- | --- |
| `overview` | read | Waiting for the user, running, new replies and errors in the last `hours`, projects with chat counts. |
| `list_chats` | read | `project`, `status` (running, waiting, new, all), `query`, `limit`. |
| `read_chat` | read | `view`: `text` (default; the turn's visible text, final message first, earlier ones dropped to fit `max_chars`), `commands` (the last 8 tool calls of the turn with output, plus the total), `turns` (latest first), `search` (turn numbers of matches). `turn` counts back from the latest. |
| `start_chat` | write | New workspace and agent in a project, like New chat. Waits up to `wait_seconds` for the reply. `model`, `thinking`, `mode` override the site defaults for this chat. |
| `send_message` | write | To an existing chat. If the chat is busy it asks first; `if_busy` = `steer` (add to the current work) or `interrupt`. |
| `answer_approval` | write | Allow or deny a pending request, pressing the same action the app shows ("Implement", "Reject"). Requests are described as what will happen: "plan: …", "run: …", "edit …". |
| `stop_chat` | write, destructive | Cancels the running turn. |
| `get_logs` | read | The call log; works without the pairing link. |

Not exposed: terminals, files, git, schedules, plugins, daemon control. The pairing link can do
all of it; the Site never will.

Results are plain text; chats always read `#<shortId> <title> - <project> - <state>, <age>`.

### Name resolution

Full id or a 6+ character id prefix, then an exact title, then word overlap on title and
project. Words match when equal, when one prefixes the other, or when they share four letters,
which absorbs Russian endings. Recency breaks ties. One clear winner is used; otherwise up to
three candidates come back. A project that matches nothing returns the whole project list, so
ChatGPT can turn "прокси" into "proxy" and retry without asking.

## 4. Settings

`PASEO_PAIRING_URL` (required), `PASEO_LANGUAGE`, `PASEO_NEW_CHAT_MODEL`,
`PASEO_NEW_CHAT_THINKING`, `PASEO_NEW_CHAT_MODE`, `PASEO_WAIT_SECONDS` (default 15, max 25),
`PASEO_CONFIRM_RISKY` (default on), `PASEO_LOG` (default on). Parsed in `readConfig`.
Variables reach the Worker only after a deploy.

Permissions have three independent layers:
1. ChatGPT's approval card for plugin actions: "Always allow" once, per account.
2. The read-back before `answer_approval` and `stop_chat`: `PASEO_CONFIRM_RISKY`.
3. Claude's own prompts inside Paseo: `PASEO_NEW_CHAT_MODE` for chats started from ChatGPT;
   `bypassPermissions` skips them all.

## 5. Timing and limits

- One relay connection per call; a Worker cannot keep a socket between requests.
- Relay connect 8 s; each call has a 45 s deadline; waiting for a reply is capped at 25 s.
  ChatGPT cuts tool calls at about 60 s (developer reports).
- Text views default to 1500 characters, cap 6000: ChatGPT truncates long tool results at an
  undisclosed budget.
- Worker memory is 128 MB; chats are read a turn at a time (≤ 400 timeline entries).

## 6. Log

D1 table `call_log` (`db/schema.ts`, migration in `drizzle/`): time, tool, arguments cut to
300 characters, ok, duration, output or error cut to 500. The pairing URL never reaches it:
`core/paseo.mjs` scrubs the server id and key from errors, `core/mcp.mjs` scrubs the whole URL.
No pruning yet: at a few hundred bytes a row, D1's 10 GB lasts for years.

## 7. Reliability

- `@getpaseo/client` and `@getpaseo/protocol` pinned to 0.11.4; the relay path imports
  `@getpaseo/client/internal/daemon-client`, which their README calls unsupported.
- A fresh `clientId` per connection.
- An unreachable relay or daemon becomes "Paseo is offline: the computer running it is probably
  asleep or disconnected."
- Still to verify in real use: messaging a chat that is open on the phone at the same moment
  (Paseo's single-writer handoff had a bug in 0.11.2).

## 8. Layout

```
core/text.mjs        pure: name matching, truncation, lines for chats, tool calls, permissions
core/paseo.mjs       relay connection and the seven Paseo operations
core/mcp.mjs         settings, instructions, tool metadata, JSON-RPC dispatch, logging hooks
core/probe.mjs       runs the operations locally against the real daemon
core/*.test.mjs      node --test, no network
app/mcp/route.ts     wires env, core and the D1 log into the Worker
db/                  call_log schema and access
app/page.tsx         the Site's own page: tools and settings
```

The Site source must stay self-contained: Sites packages this folder only.

## 9. Tuning

A labelled set of about 20 spoken requests in Russian and English, each with the expected tool
and arguments: direct ("что в чате про карту флота"), indirect ("чё там с тестами"), negative
("какая погода" must not touch Paseo). Run them in Live, read `get_logs`, change one
description at a time.
