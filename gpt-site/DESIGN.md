# paseo-remote: design

Drive Paseo's coding agents from ChatGPT, voice first. Version 0.7: thirteen tools; `show_images`
and its widget show the pictures in a chat (§10). 0.6 tuned the guidance against a measured eval
(`eval/`) and added `read_activity` for what agents and their subagents are doing
now. 0.3 brought structured results, batch reads and two kinds of search; 0.2 the call log and
per-site settings; the 0.1 prototype (`list_projects`, `start_agent`) proved the path on 2026-10-16.

## 0. What 0.6 changed, and why this way

Every change below was measured first: about 90 phrases in Russian and English through a real
model, the 0.5.0 metadata against the new one (`eval/README.md`, `eval/results/report.md`).

- **Guidance.** OpenAI's Apps SDK docs say ChatGPT and Codex read the server `instructions` next to
  the tool metadata, with the essentials in the first 512 characters, and that a tool description
  starts with "Use this when…" and says when not to. The instructions now open with a routing map
  (one call per request); the rules that decide a call are repeated in the tool or parameter they
  govern (the chat being discussed, ids never spoken, the read-back before allowing or stopping).
- **Write tools act only on an explicit command.** Drafting, thinking aloud, "maybe we send it?" or
  "ok" after a draft nobody asked about get "Send it?" instead. With looser wording the model sent
  in 15% of such cases; with this wording, none, and explicit commands still send exactly once.
- **The outcome of a write is the truth:** replied or still_working = delivered and never sent
  again unless asked; busy = not delivered, ask add-or-interrupt (after that, a plain "send it"
  steers); an error = not confirmed. Failed write calls say "Unknown whether it took effect".
- **`read_activity`** reads Paseo's provider subagents (`listProviderSubagents`,
  `fetchProviderSubagentTimeline`): each Task/Agent subagent's task, status, running time, current
  step and result. A separate tool, not a `read_chat` view: OpenAI recommends one tool per action,
  and in the eval the view answered "what are the subagents doing?" without context 1 time in 4
  against 4 in 4. Without a chat it covers every chat at work, including idle chats whose
  backgrounded subagents still run; `overview` counts subagents too.
- **Reads take the one active chat** when a name matches several ("the agent in jobby"): with a
  candidate list the model asked "which one?" every time. Writes still ask.
- **`read_chat` has three views,** `text`, `commands` and `thinking` (0.9). The `turns` view clashed
  with the `turns` count and was mixed up with it; `search` duplicated `search_messages(chat=…)` and
  went unused. `thinking` is the `reasoning` items of the same timeline pages: Claude's thinking
  when the model shares it (often it records an empty block, and Paseo drops those) or Codex's
  reasoning summaries.
- **Context window (0.9)** comes from the agent snapshot's `lastUsage`, the numbers Paseo's own
  context meter shows. The daemon keeps it in memory only: after a restart it is unknown until the
  agent's next turn, so `context` is then absent rather than guessed.
- **`archive_chat` (0.9)** calls Paseo's `archiveAgent`, which would interrupt a working agent and
  its subagents; a chat that is running or has running subagents returns `busy` and is left alone.
  Paseo has no unarchive request: a new message to the chat restores it. Confirmation is the
  read-back rule, as for `stop_chat`, not a token.
- **Text for speech:** chats by title, project and state, no ids or hashes; ids stay in
  `structuredContent`, which the model also sees.
- **One instruction, one message (0.7.2).** After a send with `wait_seconds` 0 the model read
  `not_waiting` as unconfirmed and sent a reworded copy. Results now say `delivered`, `not_waiting`
  counts as delivered, and the rules forbid sending again after `delivered: true`. There is on
  purpose no server-side cooldown or dedupe (decided 2026-10-17): a time window blocked a second,
  different command, and ChatGPT passes no id of the user's instruction to build idempotency on.

## 0.3: what changed, and why this way

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
- (0.6 removed `read_chat view=turns` and `view=search`; see above.)
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
| MCP server `instructions` (`initialize` and `server/discover`) | The routing map (one call per request) in the first 512 characters, then the write-command rule, the chat being discussed, the outcome of a write, no polling, no ids aloud, the read-back, language, dictation hints. | Deploy, and the site settings |
| Tool and parameter descriptions, annotations | "Use this when…" and when not; the rules that decide that tool's call, repeated there (the `chat` parameter carries the focus and the no-ids rule for every tool that takes it). | Deploy |
| Hint lines inside tool results | Whether a write arrived, the next step when it is not obvious (busy, still working, which chat), and that a failed write is not confirmed. | Deploy |
| ChatGPT project instructions | Style and routing only. | By hand, rarely |

Model-facing text is English. The language spoken to the user is the `PASEO_LANGUAGE` setting;
unset means "the user's language". Per-language hints (how dictation mangles "Paseo") are in
`DICTATION_HINTS` in `core/mcp.mjs` and only appear for their language.

## 3. Tools

| Tool | Kind | Notes |
| --- | --- | --- |
| `overview` | read | Waiting for the user, running, new replies and errors in the last `hours`, projects with chat counts. |
| `list_chats` | read | `project`, `status` (running, waiting, new, all), `query`, `limit`. |
| `list_pinned_chats` | read | The Pinned section at the top of Paseo's sidebar. Paseo pins a workspace, not a chat: every pinned one across projects, latest pin first (a hand-dragged order stays on the device), each with its active chats, usually one. `project` narrows them; `query` takes the rows with every word, then half, of their name, branch, project and chat titles, and with no match all of them come back. The way to a chat the user picks by its pin: pinned is no name the other tools could resolve. |
| `read_chat` | read | `view`: `text` (default; the turn's visible text, final message first, earlier ones dropped to fit `max_chars`) `commands` (the last 8 tool calls of the turn with output, plus the total) or `thinking` (the agent's reasoning, latest kept first). Every view gives the chat's context window when known. `turn` counts back from the latest, `turns` reads several at once. |
| `read_activity` | read | What a chat's agent and its subagents are doing now: state, current step, each subagent's task, status, running time, current step or result (up to 6, running first). Without `chat`: every chat at work, idle ones with running backgrounded subagents included. |
| `show_images` | read | The images in a chat on the user's screen (a widget) and, where ChatGPT allows, in the model's context: the newest, a turn's (`turn`) or one of them (`image` = N of `[image N]`), up to `count` 4. Without `chat`: the newest image of the 8 most recent chats. See §10. |
| `list_models` | read | Paseo's runtime catalog: each provider it can start (Claude, Codex…) with its models (default marked), their thinking levels and its modes; the ones it cannot start with the reason. `provider` narrows it. |
| `start_chat` | write | New workspace and agent in a project, like New chat. Waits up to `wait_seconds` for the reply. `provider`, `model`, `thinking`, `mode` override the site defaults for this chat; all are checked against the project's catalog first (a model named as said brings its runtime), and the site defaults are kept only where they fit. |
| `send_message` | write | To an existing chat. If the chat is busy it asks first; `if_busy` = `steer` (add to the current work) or `interrupt`. |
| `answer_approval` | write | Allow or deny a pending request, pressing the same action the app shows ("Implement", "Reject"). Requests are described as what will happen: "plan: …", "run: …", "edit …". |
| `stop_chat` | write, destructive | Cancels the running turn. |
| `archive_chat` | write, destructive | Archives a chat that is not working (outcome `archived`); a working one is `busy`, an archived one `already_archived`. Reversible by a new message. |
| `list_slash_commands` | read | A chat's slash commands from Paseo's `list_commands`, judged by the provider adapters in `core/slash.mjs` (§12): what each does, risk, whether it runs at once, after a yes, or not at all and why. |
| `run_slash_command` | write, destructive, open world | One command as the message `/name args`, only when the chat lists it and its provider interprets it; risky and unknown ones need a confirmation token, a working chat answers `busy` unless `if_busy: "interrupt"`. The outcome is read from the command's own turn. |
| `plugin_read` | read | What Paseo plugins offer, for plugins that answer `meta.describe` (§11). Without `plugin`: every installed plugin with its reads and actions, or why it has none. With `plugin` (id, title, alias or spoken words) and no `operation`: its main read. Answers are trimmed to the fields the plugin marks, secret-looking keys redacted. |
| `plugin_action` | write, destructive, open world | One action a plugin describes. A `low`-risk one runs at once; anything else returns `needs_confirmation` with the text to read out and a token bound to the exact arguments, and runs on the second call with it. `done` comes with `delivered: true`. |
| `get_logs` | read | The call log; works without the pairing link. |

Not exposed: terminals, files, git, schedules, plugin management, daemon control. The pairing
link can do all of it; the Site never will. The one file read is an image a chat already shows
(§10), and plugins are reached only through the operations they describe themselves (§11).

Results are text for speech next to `structuredContent`; chats read `<title> (<project>): <state>, <age>`,
never with ids, which travel in the data.

### Name resolution

An id comes first: the whole id of any chat, archived ones included, or its start of 6+ characters
(`short_id`, `#a1b2c3d`), which Paseo's own lookup settles across every chat it keeps and refuses
when several ids share it; an unknown id says so. A name is matched among active chats against the
title, the workspace's title (Paseo has a model name it, and its sidebar shows it) and the project,
in tiers: the whole name, alone or with the project after it ("Fleet map (proxy)"), or the whole
first line of a title Paseo cut at 60 characters; then every word of the name (words match when
equal, when one prefixes the other, or when they share four letters, which absorbs Russian endings);
then at least half of them. One chat at the best tier is used. Writes take no partial match and
never choose between equals; reads take the closest match and, among equals, the only chat at work
(running, waiting for approval, or with subagents at work), and say so in `note`. Everything else is
`needs_clarification` with a `reason` and up to five candidates, told apart by workspace, state and
age. Names never reach into the archive: it is listed only when the user asks (`include_archived`),
and an archived chat is then reached by its id; a name no active chat has says the archive was not
searched. A project that matches nothing returns the whole project list, so ChatGPT can turn
"прокси" into "proxy" and retry without asking.

Why this way (2026-10-23). Paseo titles a chat with the first line of its first message cut at 60
characters, so a chat that continues another one gets the same title. Two active chats titled so
made `send_message` by name ask, and the exact tier then compared the name with title and project
together, so no title matched exactly and three lookalikes came back. Recency would have picked the
right chat that time, but a forgotten chat with the same title is exactly what recency cannot tell
apart, so writes ask, with the workspace titles that do tell them apart. What saves the extra call
is the id: results carry it and the rules say to pass it. After `needs_clarification` the model asks
the user (0.12.1): told to take "the candidate this conversation is about", it took the first of two
chats a shared name fitted, as the call log showed. It picks one itself only when the user's words
pick it ("the latest", "the one about X") or the conversation already read or used exactly that chat. A partial match no longer drives a write,
since a word that fits no chat may mean one that is archived or gone. `send_message` by the id of an
archived chat whose title an active chat has answers `archived`: that id most likely dates from before
the work moved to the new chat.

A server-side "chat being discussed" was considered and left out. A global one breaks with two
conversations at once (the phone and the desktop). ChatGPT documents `_meta["openai/session"]`, an
anonymized conversation id on each tool call, which could key one in D1; it is unverified for a Site
plugin and in voice, Codex sends none, and the model already holds the ids such a binding would keep.

## 4. Settings

`PASEO_PAIRING_URL` (required), `PASEO_LANGUAGE`, `PASEO_NEW_CHAT_MODEL`,
`PASEO_NEW_CHAT_THINKING`, `PASEO_NEW_CHAT_MODE`, `PASEO_WAIT_SECONDS` (default 15, max 25),
`PASEO_CONFIRM_RISKY` (default on), `PASEO_LOG` (default on). Parsed in `readConfig`.
Variables reach the Worker only after a deploy.

Permissions have three independent layers:
1. ChatGPT's approval card for plugin actions: "Always allow" once, per account.
2. The read-back before `answer_approval`, `stop_chat` and `archive_chat`: `PASEO_CONFIRM_RISKY`.
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
core/paseo.mjs       relay connection and the Paseo operations
core/capabilities.mjs pure: plugins' meta.describe checked, names resolved, arguments checked, answers trimmed, confirmation tokens
core/widget.mjs      the show_images widget (MCP Apps), one self-contained HTML string
eval/                the tool-selection eval: cases, stub server, runner, judge, report
core/mcp.mjs         settings, instructions, tool metadata, JSON-RPC dispatch, logging hooks
core/probe.mjs       runs the operations locally against the real daemon
core/*.test.mjs      node --test, no network (images.test.mjs drives the operations with a fake daemon client)
app/mcp/route.ts     wires env, core and the D1 log into the Worker
db/                  call_log schema and access
app/page.tsx         the Site's own page: tools and settings
```

The Site source must stay self-contained: Sites packages this folder only.

## 9. Tuning

`eval/` holds the measured version of this: about 90 labelled requests, a stub MCP server with a
fake Paseo, and a runner over `codex exec` that compares the released metadata with the working
tree. Change one description at a time, run it, and read `eval/results/report.md`; Live voice on
the phone is the final check.

## 10. Images

**Where they come from.** A picture in a Paseo chat is markdown in an agent's message. The daemon
writes an image a tool returned (a Playwright screenshot, an image file the agent read) to
`$TMPDIR/paseo-attachments-<random>/<sha256>.<ext>` and records `![Image](file:///…)`; agents also
link files themselves, relative to their working directory, or link the web. Paseo's app shows
them by reading the file through the relay (`readFile`: a `file_explorer_request` answered in binary
frames). Until this, the Site passed that markdown on as text, so ChatGPT got a path on the Mac.
Images the user sends from Paseo's composer never reach the daemon's timeline (only the sending
device keeps them), so no client can show them.

**Text.** Every place that reads agent text turns images into `[image N]`, numbered through a turn:
`read_chat` (with `images` per turn and a line pointing to `show_images`), `read_activity`,
`search_messages` snippets and the replies of `start_chat` and `send_message`.

**Bytes.** `show_images` reads only sources found in that chat's timeline in the same call, never a
path from its arguments: the file's directory as `cwd` and its name as `path`, so the daemon's own
check keeps the read inside that directory, or the agent's `cwd` for a relative path. PNG, JPEG,
WebP and GIF only (models take no SVG; Paseo serves BMP, TIFF and HEIC as plain bytes), `maxBytes`
1 MB per image, 1.5 MB per answer, up to 4 images. Web links are never fetched. A daemon restart
writes provider images to a new temporary directory, so paths are always taken from a fresh read;
a file macOS has cleaned up reads as "no longer on the Mac".

**Delivery.** ChatGPT does not treat an MCP `image` content block as vision input (OpenAI support,
April 2026: the model may see `{}`) and does not render markdown images from tool URLs, and a
private Site cannot serve a public link. So the bytes travel in the result's `_meta` (hidden from
the model, never logged) to an MCP Apps widget: `_meta.ui.resourceUri` (and `openai/outputTemplate`)
points at `ui://god-mode/images-<fingerprint>.html`, served by `resources/read` with
`text/html;profile=mcp-app` and an empty CSP (the default allows `data:` images and no network).
The widget shows them and, unless the host says it takes no images into the model's context (web),
sends them with `ui/update-model-context`; the host may hold that until the next user message. The
result's text tells the model to answer only from what it can see.

**Voice.** "Show the screenshot", "what's in the picture?" route to `show_images` as the first and
only call of the turn: ChatGPT's iOS app drew no widget for a tool chained after another one in the
same turn (developer reports, July 2026), so the tool resolves the chat by name itself.

**Still to verify live:** that a Site-hosted plugin renders the widget at all (no document says so),
on web, iOS text and iOS Live voice, and whether the model sees the images in the same turn, the next
one, or not at all. If Live never sees them, the fallback is a description made on the Site with the
Responses API (`input_image`), which needs an `OPENAI_API_KEY` Site secret.

## 11. Plugins

Paseo gives a remote client plugin ids and a blind `invokePluginRpc`: no method list, no schemas,
nothing that says which call reads and which one acts. So a plugin opts in by answering the RPC
`meta.describe` with the `paseo.capabilities/1` shape, specified for plugin authors in
[docs/plugin-capabilities.md](../docs/plugin-capabilities.md). The Site knows no plugin by name.

- **Discovery, per call.** `plugin.list`, then `meta.describe` on every running plugin at once,
  4 s each; a plugin that has no such RPC is reported as offering nothing to ChatGPT. An exact
  plugin id asks that plugin alone. No cache: it adds about 0.3 s to the relay connection, and a
  plugin updated a minute ago is described as it is now (measured live: the catalog in 0.97 s,
  a read in 1.1 s).
- **Checked, not trusted blindly.** `core/capabilities.mjs` drops a broken operation with its
  reason and keeps the rest; `meta.*` is never an operation; a fixed argument may not also be
  offered. An action without a known risk counts as destructive, and only `low` may skip asking.
- **Arguments.** The schema each operation advertises is checked before the call (type, const,
  enum, anyOf, bounds, required); unknown arguments are refused with what the operation takes,
  and `fixed` ones are merged in and cannot be changed. The plugin's own zod contract checks again.
- **Confirmation.** `needs_confirmation` carries `confirm_text` (the plugin's, else its title)
  and a token: HMAC-SHA256 over plugin, operation, method and canonical arguments, keyed from the
  pairing link, valid two minutes. It proves what was put to the user; their yes is ChatGPT's
  part. It is not spent on use: `done` says `delivered: true`, and the rules say never repeat it.
- **Who.** `plugin_action` needs a signed-in ChatGPT user, like `update_site`.
- **Not done (`outcome`).** An operation may name the fields that say it was not done (`ok` false, or
  a non-empty `error`); God Mode then answers `outcome: "refused"`, `delivered: false` and the reason
  instead of "done". Without it any answer is done; a thrown error stays "unknown".
- **Confirmed against the plugin's data (`target`).** An action may name a read of the same plugin
  that shows what it acts on, its arguments filled from the action's. God Mode reads it for the
  confirmation (`confirm_text` and `target`) and signs those facts into a third part of the token;
  before running it reads them again, and different facts mean a new confirmation
  (`target_changed`), not a run. A target that cannot be read refuses the action. There is no name
  search here: finding a chat or a thing stays with the tools and reads that list them.
- **Other people's words (`untrusted`).** Marked answers carry a fixed note and `untrusted: true`;
  the instructions repeat the rule.

## 12. Slash commands

Paseo lists a chat's commands (`list_commands`: name, description, argument hint) but has no command
RPC: `/name args` is a message, and only the provider behind the chat decides whether it is a command.
Anything it does not take as one reaches the model as text (Claude Code 2.1.274+ spends a model turn
on an unknown name). So `core/slash.mjs` has one adapter per provider, and God Mode sends nothing an
adapter does not vouch for. The provider matrix is in [docs/slash-commands.md](../docs/slash-commands.md).

- **Claude Code** expands commands itself. Its adapter knows the built-ins (risk, effect, model or
  not) and refuses the ones that act behind Paseo's back (`/clear`, `/model`, `/rewind`, session
  settings) or leak (`/heapdump`). A description that ends in `(project)` or `(user)` marks the user's
  own command, even under a built-in name; Paseo drops aliases, so `/review` maps to the listed
  `/code-review`.
- **Codex** through Paseo: `/compact` and `/goal` are app-server calls Paseo makes outside any turn,
  skills are native skill inputs, custom prompts are filled in by Paseo. Codex's own `/review`
  (`review/start`) is not exposed by Paseo 0.11.4, so it is `unavailable` rather than sent as text.
- **Other providers** are listed, not run: unverified.
- **Busy.** Paseo replaces a running turn with a command even on `steer` (seen live), so a working
  chat answers `busy`; `if_busy: "interrupt"` runs it, and the confirmation of a risky command covers
  the interruption.
- **Confirmation.** As for plugin actions (§11): an HMAC token over the chat, the exact command text
  and the interrupt decision, two minutes, not single use. Everything above low and every unknown
  command asks first.
- **Results.** God Mode tags its message with a client message id and reads the items after it:
  `waitForFinish`'s last message is the previous turn's after `/compact`, and Paseo repeats the
  previous output after a done manual compaction (observed 2026-10-18), so neither is used. A Codex
  compaction has no turn to wait for; its items are polled until the wait ends.
