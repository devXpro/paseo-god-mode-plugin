# The tools ChatGPT gets

God Mode's Site is an MCP server; these are its tools, as `tools/list` returns them. Each answer is
text for ChatGPT to read or speak, plus the same facts as `structuredContent` matching the tool's
`outputSchema`. The model-facing details live in each tool's description in
[`gpt-site/core/mcp.mjs`](../gpt-site/core/mcp.mjs).

## Reference

Kind is taken from the tool's annotations. `*` marks a required argument.

| Tool | Kind | Arguments | What it is for |
| --- | --- | --- | --- |
| `overview` | read | `hours` | What is going on: chats waiting for an approval, running chats with their running subagents, chats with a new reply, and the projects. |
| `list_chats` | read | `project`, `status` (running, waiting, new, all), `query`, `include_archived`, `limit` | Find chats by title, project or state that are not in the conversation yet. |
| `list_pinned_chats` | read | `project`, `query` | The chats in the Pinned section at the top of Paseo's sidebar, across every project, latest pin first; also the way to a chat the user picks by its pin. |
| `read_chat` | read | `chat`*, `view` (text, commands, thinking), `turn`, `turns`, `max_chars`, `offset` (commands) | What a chat said (the latest turn, or the last N at once), the commands it ran, or the agent's reasoning. A digest: it says what it cut and points to `read_message`; view commands pages a turn's earlier calls by `offset`. |
| `read_message` | read | `chat`*, `role` (user, agent), `turn`, `message`, `mode` (head, tail, full), `size`, `offset`, `message_id` | The exact text of one message: all of it, only its start (`head`) or only its end (`tail`), in pages when it is long. See [Reading one message](#conventions). |
| `read_activity` | read | `chat`, `max_chars` | What an agent and its subagents are doing now, and how full its context window is; each subagent with its model and thinking effort, as Paseo observed them (null when it has not reported them). Naming a chat lists all of its subagents; without `chat`, every chat at work, the first six subagents of each. A finished subagent's result is cut at 300 characters; its `result_id` reads the whole final message with `read_message`. |
| `show_images` | read | `chat`, `turn`, `image`, `count` | The pictures and screenshots in a chat, shown on the user's screen in a widget and, where ChatGPT allows, given to the model. |
| `search_messages` | read | `query`*, `project`, `chat`, `include_archived`, `scan`, `limit`, `offset` | Where something was said, across the most recent chats or in one, newest first (`offset` reads one chat's older matches); each match with the `message_id` that `read_message` reads it whole by. |
| `list_models` | read | `provider` | The agent runtimes Paseo can start (Claude, Codex…), each with its models, their thinking levels and its permission modes, from Paseo's own catalog. |
| `start_chat` | write | `prompt`*, `project`, `workspace`, `wait_seconds`, `provider`, `model`, `thinking`, `mode` | Start one new chat with the task as its first message, like New chat, in a project (with a workspace of its own) or as another tab of a workspace that exists, on the runtime and model asked for, checked against Paseo's catalog first. A project or a workspace is given. |
| `send_message` | write | `chat`*, `text`*, `if_busy` (steer, interrupt), `if_archived` (restore), `wait_seconds` | Send one message to an existing chat. |
| `read_approval` | read | `chat`* | Everything a chat waits on, in full: a request that asks questions comes with every question and its numbered options, the recommended one marked. A plan, or a command longer than its line, comes whole (`text`), up to 6000 characters. |
| `answer_approval` | write | `chat`*, `decision`* (allow, deny), `request` | Allow or deny what a chat is waiting for; a request that asks questions takes `answer_questions`. |
| `answer_questions` | write | `chat`*, `request`*, `answers`* (`question`, `options`, `text`), `wait_seconds` | Send the user's answers to the questions a chat asks (Claude's AskUserQuestion, Codex's questions), the way Paseo's question form does. |
| `stop_chat` | write, destructive | `chat`* | Stop what a chat is doing now. |
| `archive_chat` | write, destructive | `chat`* | Archive a chat that is not working; a new message brings it back. |
| `pin_chat` | write, idempotent | `action`* (pin, unpin), `chat`, `workspace_id` | Pin or unpin a chat's row in Paseo's sidebar; a row with no chat by its name or `workspace_id`. |
| `rename_chat` | write, idempotent | `chat`*, `new_name`* | Rename a chat: its tab and its name in the chat lists. Not the label of its sidebar row, which is the workspace's name. |
| `rename_workspace` | write, idempotent | `workspace`*, `new_name`* | Rename a workspace, a row of Paseo's sidebar, by its `workspace_id` or its name: the label in the Pinned section changes, the pin stays, and its chats stay with their own names. |
| `set_chat_model` | write, idempotent | `chat`*, `model`, `thinking` | Change the model and the thinking level (effort) of a chat that exists, in that chat: its history stays and no new chat starts. |
| `list_slash_commands` | read | `chat`*, `query`, `limit` | A chat's slash commands, each with what it does and whether God Mode runs it at once, after a yes, or not at all. See [slash-commands.md](slash-commands.md). |
| `run_slash_command` | write, destructive, open world | `chat`*, `command`*, `args`, `if_busy` (interrupt), `confirmation`, `wait_seconds` | Run one of a chat's slash commands (`/compact`, `/code-review`, your own); anything above low risk asks first, a working chat waits for the user's word. See [slash-commands.md](slash-commands.md). |
| `plugin_read` | read | `plugin`, `operation`, `args` | What the user's Paseo plugins offer, and one of their reads. See [plugin-tools.md](plugin-tools.md). |
| `plugin_action` | write, destructive, open world | `plugin`*, `operation`*, `args`, `confirmation` | One action of a plugin; anything above low risk asks first. See [plugin-tools.md](plugin-tools.md). |
| `update_status` | read | none | Which God Mode version is live, whether there is an update, how the last update or rollback ended. |
| `update_site` | write, destructive | `action`* (update, rollback) | Update God Mode's Site to the version installed on the Mac, or roll it back. See [operations.md](operations.md). |
| `get_logs` | read | `limit`, `errors_only`, `tool` | God Mode's own call log, for troubleshooting; works without the pairing link. |

## Conventions

- **Names or ids.** Tools that take a `chat` accept its id from earlier results (the whole id, its
  `short_id` or `#short_id`) or the name the user said, resolved in the same call, so no `list_chats`
  first. Paseo titles a chat with the first line of its first message cut at 60 characters, so a chat
  that continues another one usually has the same title: an id is the surer reference. A name is
  matched against the chat's title, its workspace's title (what Paseo's sidebar shows) and its
  project, with or without the project after it (`Fleet map (proxy)`), in tiers: the whole name
  (also the whole first line of a cut title), then every word of it, then at least half of them.
  One chat at the best tier is used. A write never takes a partial match and never picks between
  equals, by recency or by state; a read takes the closest match and, among equals, the only chat
  at work, and says so in `note`. Otherwise the answer is `needs_clarification` with `reason`
  (`same_name`, `similar`, `partial`, `id_prefix`, `no_match`, `unknown_id`) and up to five
  candidates with their ids, workspace, state and age, and nothing was done; ChatGPT then asks which
  one, unless the user's words pick it ("the latest", "the one about X") or the conversation already
  read or used exactly that chat. Names resolve among
  active chats only: the archive is searched only when the user asks (`include_archived` of
  `list_chats` and `search_messages`), and an archived chat is then reached by its id. Projects are
  matched by name too, and a project that matches nothing lists all of them.
- **Reading one message.** `read_chat` is a digest: it cuts the user's own message at 300 characters
  (200 when several turns are read), fits the agent's reply to `max_chars` (6000 at most; ChatGPT
  refuses a larger value before the call reaches the Site) and says what it cut:
  `user_text_truncated`, `agent_text_truncated` and `omitted_messages`, with the whole lengths in
  `user_chars` and `agent_chars`, and a `Cut:` line in the text that names the cut message by its id
  and points to `read_message`. Each turn carries `user_message_id` and `agent_message_id` (the agent's
  last message; null before it replies), and each `search_messages` match the `message_id` of the
  message it was found in. `read_message` gives the exact text of one message, in three modes. `head`
  and `tail` return `size` characters from the start or the end of it (1500 by default). `full`, the
  default, returns the message from `offset` in pages of 6000 characters at most, the longest answer
  `read_chat` has always given: ChatGPT cuts a tool's answer that goes over a budget it does not
  publish, so a page stays within a size known to reach the model whole. Whatever is left is never
  dropped quietly: `truncated` is true, `remaining_chars` counts what follows the text and `next_offset`
  is where to read on, and `previous_offset` is where the part just before it begins; the text says the
  same before the page itself, so a client that cuts the answer short still leaves the way on. A message
  is the user's (`role: user`, the one that starts a turn) or one of the agent's (`role: agent`;
  `message` counts the turn's agent messages from the last, so 1 is the final one). `turn` counts from the
  latest, as in `read_chat` and in the matches of `search_messages`. Counts and offsets are in characters
  (Unicode code points), so an emoji is never split between two pages. Every answer carries `message_id`
  (`user-166`, `agent-1117`: where the message sits in the chat's timeline). To read on, pass it with
  `offset` and leave `role`, `turn` and `message` out: the next page then comes from the same message
  even when the chat has moved on, which "the turn counted from the latest" would not survive. The user's
  message is found by its place in the timeline, so a turn of any length gives it whole; an agent's images
  read as `[image N]`, numbered through the turn as in `read_chat`. A turn or a message that does not
  exist comes back as `missing`, and an offset past the end as an empty `text` with the message's length,
  never as a shorter text passed off as the whole.
- **Long texts and lists.** Nothing long is cut without saying so, and every cut text has an id that
  `read_message` reads whole, in the same pages of 6000 characters: a message (`agent_message_id`,
  `user_message_id`, a search match's `message_id`), a turn's thinking (`thinking_id`, with
  `thinking_chars` and `thinking_truncated`, in view thinking), a tool call (`id`, `chars`, `truncated`
  per call in view commands: a shell command and its output, an MCP tool's input and output, a plan,
  a subagent's task), and a subagent's final message (`result_id`, in `read_activity` and on a subagent's
  call in view commands; it reads a subagent of any turn). Files an agent read or wrote stay paths. The
  reply of `start_chat`, `send_message`, `answer_questions` and `run_slash_command` is cut at 1500
  characters with `reply_chars` and `reply_truncated`; `read_message` (turn 1) reads it whole. Lists
  page where a list hid content: `read_chat` gives `next_turn` to read a long chat further back; view commands shows a turn's last 8 calls and `offset`/`next_offset`
  the earlier ones; `search_messages` shows the newest matches first, follows Paseo's pages of 200 to
  count them all, and `offset`/`next_offset` reads one chat's older ones. Paseo itself keeps at most
  64 KiB of a shell output or tool text, the start of it. Every turn in every view says whether it has
  thinking (`thinking_id`, `thinking_chars`) and tool calls (`total_tool_calls`), and view thinking of a
  turn without any names the turns that have it (`thinking_elsewhere`, from the chat's latest 400
  entries). The model is told to read on by itself only when the question needs the cut part, and not
  for a gist or a count; budgets and limits above what is used (`max_chars` 6000, `limit` 30) are
  accepted and cut to it, since ChatGPT refuses a number above the schema's maximum before the call.
- **Pinned chats.** Paseo pins a workspace, not a chat: each row of its Pinned section is a
  workspace with its chats, usually one, sometimes none (its chat was archived, or it holds only
  terminals) or several. `list_pinned_chats` returns every row with its active chats, latest pin
  first; an order dragged by hand stays on that device and never reaches God Mode, and the
  sidebar's project and label filters do not apply. "Pinned" is not a name, so a chat the user picks
  by its pin ("read the pinned chat in proxy") is found with `list_pinned_chats` first and then
  reached by its id. `query` takes the rows with every word of it among their names, branches,
  projects and chat titles, else those with at least half; when no row has them, every row comes
  back with `query_match: "none"`, so ChatGPT can match a name said in another language itself.
- **Pinning.** `pin_chat` pins or unpins the row of a chat with Paseo's own pin request, so its other
  chats go with it and the answer names them (`chats`). The chat is named as for the other tools; a
  name that only the chats of one row share, such as the row's title, names that row, since there is
  nothing to choose. A row with no chat (its chat was archived, or it holds only terminals) is reached
  by every word of its name when no chat has the name and only that row has the words, or by its
  `workspace_id` from `list_pinned_chats`; exactly one of `chat` and `workspace_id` is given. A pin or unpin already
  in place answers `already_pinned` or `not_pinned` and changes nothing: pinning again would move the
  row to the top of Pinned. An archived chat (`archived`), a chat with no row (`no_row`), an unclear
  name and an unknown `workspace_id` change nothing either. No read-back: one more call undoes it.
  Which chat is open on a screen is not known to God Mode (Paseo keeps it for its notifications and
  gives it to no client), so "the chat I have open" needs its name.
- **Questions an agent asks.** Claude's AskUserQuestion and Codex's questions (request_user_input,
  and its asynchronous ones) wait in Paseo as a request of kind `question`, and such a chat reads as
  "waiting for an answer". `read_approval` gives the request's id and every question: its number and
  header, its text, whether several options can be chosen (`multi_select`) or the user may answer in
  their own words (`own_words`), and its numbered options, the one the agent recommends marked
  `recommended`. `answer_questions` takes that id and one entry per question, `{question, options,
  text}`: the question by number or header, the options by number or label (a label also without
  its "(Recommended)"), own words in `text`. As in Paseo's form, every question needs its answer,
  one option unless several are allowed, and own words only where they are taken; then it sends
  allow with the request's input and the answers keyed by header, labels joined with ", ", and waits
  for the agent's reply. Anything missing, unknown or twice comes back as `invalid_answers` with the
  problems and the questions, and nothing is sent; so do a request that is gone (`gone`), one that
  asks no questions (`not_questions`), and one God Mode cannot fill (`unsupported`: a secret, an
  unreadable form, two questions with one header). `answer_approval` sends nothing for allow on a
  question request; deny dismisses it. The rules for ChatGPT: read the questions and their options to
  the user, send only what they chose, never the recommended option on their behalf.
- **Models.** `start_chat` takes a model by its id or by its name as the user said it ("Opus 4.8",
  "GPT-6-Astra", or "Astra" alone), and the model brings its runtime. A model, thinking level or mode
  the project's runtime does not offer returns `needs_clarification` with the choices, and nothing
  starts. The site's defaults for new chats apply only where they fit: a Claude mode never reaches
  a Codex chat.
- **Renames.** A chat's name and a sidebar row's name are two names: a row, the Pinned section included,
  shows its workspace's name, so `rename_workspace` changes that label and `rename_chat` only the chat's
  own tab and listing. They send the requests of Paseo's own Rename (`update_agent`, `workspace.title.set`)
  and then read the name back from Paseo: `done: true` and `new_name` come only from what Paseo shows
  afterwards, because a name it accepted can still be dropped. `rename_workspace` also reads back the
  row's pin and chats (`pinned`, `pinned_at`, `chats`); the request changes neither. Both resolve their
  target like every write: one clear match or `needs_clarification`, active chats and live rows only,
  and an archived chat's id answers `archived`. `error` says why it did not happen, `current_name` what
  Paseo shows instead; a blank `new_name` is refused before anything runs.
- **A chat's model and thinking level.** `set_chat_model` changes them in the chat itself with Paseo's own
  request for it, in one request (the model first, since a level means something only against the model
  that offers it). The chat keeps its history and its runtime, and a chat that is working is changed
  too: Paseo applies a thinking level from the chat's next turn, a Codex model likewise, a Claude model
  from the agent's next call to it, and the answer says so (`busy`, `notice`). `model` and `thinking`
  are checked like `start_chat`'s, against the catalog of the chat's folder, because Paseo takes any string
  here: a model or level it does not list, a level the new model lacks that the chat runs at, and a model of
  another runtime (a Claude chat cannot move to Codex; `other_runtime`, and a chat on that model is a new
  one with `start_chat`) change nothing and come back with the choices. A model with no levels at all drops
  the chat's level. What the chat runs on afterwards (`after`) is read back from Paseo; `partial` and
  `error` say what it still runs on. Only Claude and Codex chats: other runtimes answer `unavailable`.
  The site's defaults for new chats never apply here. `/model` and `/effort` stay out of
  `run_slash_command`; their reason names this tool.
- **Another tab in a workspace.** `start_chat` with `workspace` opens the chat in a workspace that exists,
  in its folder, instead of making one. A workspace is its `workspace_id` (chats in the answers carry it;
  so does `start_chat`'s own answer, for a second chat beside the first) or its name as the sidebar shows
  it, or the title of a chat in it, with or without the project after it. Like a chat's name it must be
  whole, or every word of it, and fit one workspace: twins, a partial name and no match change nothing and
  come back with the most recent workspaces, told apart by their chats. Without `workspace`, the chat gets
  a workspace of its own, as before.
- **Speech, not ids.** Text answers name chats by their title; ids travel in `structuredContent`.
- **Writes say whether they arrived.** `start_chat`, `send_message` and `run_slash_command` answer
  `delivered: true` when the message reached the agent (replied, still working, or not waited for);
  `send_message` and `run_slash_command` answer `busy` with `delivered: false` when the chat was
  working and nothing was sent. `send_message` to an archived chat whose title an active chat now
  has (most likely its continuation, and the id kept from before) answers `archived` with
  `delivered: false` and the active chats in `same_title`; `if_archived: "restore"` sends it anyway
  and brings the archived chat back. Any other archived chat gets the message, which restores it.
- **Waiting.** `start_chat`, `send_message` and `run_slash_command` wait up to `wait_seconds` (at most
  25; the default is the `PASEO_WAIT_SECONDS` setting, 15) for the agent's reply, and say "still
  working" otherwise.
- **Errors.** See [Errors and outcomes](security.md#errors-and-outcomes).

## Settings that change what the tools do

`PASEO_LANGUAGE`, the defaults for new chats, `PASEO_WAIT_SECONDS`, `PASEO_CONFIRM_RISKY` and
`PASEO_LOG`: see [configuration.md](configuration.md).

Everything else, from the architecture to plugins, security and operations: [the documentation](README.md).
