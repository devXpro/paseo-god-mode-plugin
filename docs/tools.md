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
| `read_chat` | read | `chat`*, `view` (text, commands, thinking), `turn`, `turns`, `max_chars` | What a chat said (the latest turn, or the last N at once), the commands it ran, or the agent's reasoning. |
| `read_activity` | read | `chat`, `max_chars` | What an agent and its subagents are doing now, and how full its context window is; without `chat`, every chat at work. |
| `show_images` | read | `chat`, `turn`, `image`, `count` | The pictures and screenshots in a chat, shown on the user's screen in a widget and, where ChatGPT allows, given to the model. |
| `search_messages` | read | `query`*, `project`, `chat`, `include_archived`, `scan`, `limit` | Where something was said, across the most recent chats or in one. |
| `start_chat` | write | `project`*, `prompt`*, `wait_seconds`, `model`, `thinking`, `mode` | Start one new chat in a project with the task as its first message, like New chat. |
| `send_message` | write | `chat`*, `text`*, `if_busy` (steer, interrupt), `wait_seconds` | Send one message to an existing chat. |
| `answer_approval` | write | `chat`*, `decision`* (allow, deny), `request` | Allow or deny what a chat is waiting for. |
| `stop_chat` | write, destructive | `chat`* | Stop what a chat is doing now. |
| `archive_chat` | write, destructive | `chat`* | Archive a chat that is not working; a new message brings it back. |
| `plugin_read` | read | `plugin`, `operation`, `args` | What the user's Paseo plugins offer, and one of their reads. See [plugin-tools.md](plugin-tools.md). |
| `plugin_action` | write, destructive, open world | `plugin`*, `operation`*, `args`, `confirmation` | One action of a plugin; anything above low risk asks first. See [plugin-tools.md](plugin-tools.md). |
| `update_status` | read | none | Which God Mode version is live, whether there is an update, how the last update or rollback ended. |
| `update_site` | write, destructive | `action`* (update, rollback) | Update God Mode's Site to the version installed on the Mac, or roll it back. See [operations.md](operations.md). |
| `get_logs` | read | `limit`, `errors_only`, `tool` | God Mode's own call log, for troubleshooting; works without the pairing link. |

## Conventions

- **Names or ids.** Tools that take a `chat` accept its id from earlier results or the name the user
  said; a name that matches several chats returns `needs_clarification` with candidates. Projects are
  matched the same way, and a project that matches nothing lists all of them.
- **Speech, not ids.** Text answers name chats by their title; ids travel in `structuredContent`.
- **Writes say whether they arrived.** `start_chat` and `send_message` answer `delivered: true` when the
  message reached the agent (replied, still working, or not waited for); `send_message` answers
  `busy` with `delivered: false` when the chat was working and nothing was sent.
- **Waiting.** `start_chat` and `send_message` wait up to `wait_seconds` (at most 25; the default is
  the `PASEO_WAIT_SECONDS` setting, 15) for the agent's reply, and say "still working" otherwise.
- **Errors.** See [Errors and outcomes](security.md#errors-and-outcomes).

## Settings that change what the tools do

`PASEO_LANGUAGE`, the defaults for new chats, `PASEO_WAIT_SECONDS`, `PASEO_CONFIRM_RISKY` and
`PASEO_LOG`: see [configuration.md](configuration.md).

Everything else, from the architecture to plugins, security and operations: [the documentation](README.md).
