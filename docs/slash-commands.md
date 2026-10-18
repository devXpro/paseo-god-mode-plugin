# Slash commands

`list_slash_commands` and `run_slash_command`: the commands of a chat's agent (`/compact`,
`/code-review`, your own), what each one does, and running one safely. Since 0.10.0.

## What Paseo gives God Mode

Read from Paseo 0.11.4's code and checked on live chats (2026-10-18):

- **A list per chat.** Paseo's `list_commands` returns a chat's commands as name, description and
  argument hint, from the agent's runtime: Claude Code's own list, or what Paseo's Codex provider
  assembles. Nothing says where a command comes from or what it risks, and Paseo drops Claude Code's
  aliases (`/review` is listed only as `/code-review`). God Mode's provider adapters
  (`gpt-site/core/slash.mjs`) add that.
- **No command API.** A command runs when the chat receives the message `/name args` and the provider
  behind it interprets it. Anything else reaches the model as an ordinary message: Claude Code
  2.1.274 and later answer an unknown `/name` with a model turn. So God Mode sends only a name the chat
  lists, and only when its adapter knows how that provider runs it.
- **A working chat loses its turn.** A command sent to a chat that is working replaces the turn in
  progress, even with `steer` (Paseo interrupts when the provider will not steer a command; seen live:
  a reply cut off mid-sentence). So God Mode holds a command until the user says to interrupt.

## list_slash_commands

| Argument | |
| --- | --- |
| `chat` | Required. The chat's id from earlier results, or the name the user said. |
| `query` | Words to find commands by name, description or effect, e.g. `review`. |
| `limit` | 1–100, default 60. |

Each command comes with `name`, `usage`, `source` (`built_in`, `custom`, `plugin`, `mcp_prompt`,
`skill`, `custom_prompt`, `internal`, `unclassified`), the agent's `description`, God Mode's `effect`,
`args`, `runs_model` (a model turn costs tokens), `risk`, `asks_first`, `available` with a `reason`
when it is not, and `when_busy`. Runnable ones come first, then the ones that ask first, then the ones
God Mode does not run. The answer also says which runtime the chat is (`provider`, `runtime`) and
whether God Mode runs its commands at all (`runs_commands`). An archived chat lists nothing (Paseo
lists active chats only); a chat Paseo cannot start says why (`error`).

Listing a chat that Paseo has not started since its own restart starts its agent first, as Paseo's
command menu does: a few seconds, no model call.

## run_slash_command

| Argument | |
| --- | --- |
| `chat` | Required, as above. |
| `command` | Required. The name as the chat lists it, with or without the slash: `compact`, `/code-review`. An alias works (`review`). |
| `args` | What follows the name, in the user's words. One line, at most 2000 characters, never starting with `/`. |
| `if_busy` | `interrupt` only: after a `busy` answer and the user's explicit yes, stops the chat's work and runs the command. |
| `confirmation` | From `needs_confirmation`, after the user's yes. |
| `wait_seconds` | 0–25; default `PASEO_WAIT_SECONDS`. |

What one call does, in order:

1. Finds the chat; an archived one, or a provider God Mode does not run, is `unavailable`.
2. Lists the chat's commands and finds the one meant. An unknown or unclear name answers
   `needs_clarification` with candidates (or the chat's runnable commands), and nothing is sent.
3. A command God Mode does not run is `unavailable`, with the reason and what to use instead.
4. A chat that is working (or waiting for an approval) answers `busy`, unless the command runs beside
   the turn (Codex's `/goal`) or `if_busy` is `interrupt`.
5. A command above low risk answers `needs_confirmation` with `confirm_text`: the command, the chat,
   what it does, what this run adds (`--fix edits files`), that permissions are bypassed in the chat,
   and that it stops the current work when it does. Only the same chat, the same command text and the
   same interrupt decision run with that confirmation.
6. Sends the message, then reads what the command's own turn did:

| `outcome` | Meaning | `delivered` |
| --- | --- | --- |
| `done` | It did what it does: a compaction, with `context.before_tokens` and `after_tokens`. | true |
| `replied` | Its output is in `reply` (a review, `/context`'s report, a custom command's answer). | true |
| `refused` | The agent got it and declined, nothing changed: "Not enough messages to compact." | true |
| `still_working` | Still running when the wait ended (a long compaction); check later with `read_chat`. | true |
| `not_waiting` | Sent with `wait_seconds` 0. | true |
| `waiting_for_approval` | It needs an approval first (`approval` says what). | true |
| `error` | It ended with an error. | true |
| `busy`, `unavailable`, `needs_confirmation` | Nothing was sent. | false |

The result comes from the timeline items after God Mode's own message, never from "the last thing the
agent said": after `/compact` Paseo's last message is the previous turn's, and on Claude it even
repeats the previous output after a done compaction.

## Support by provider

### Claude Code

Checked live on Claude Code 2.1.296 through Paseo 0.11.4: a chat listed 56 commands.

| Command | God Mode | Notes |
| --- | --- | --- |
| `/compact [instructions]` | After a yes (disruptive) | Claude Code compacts; the answer gives the context before and after (live: 32k → 2k tokens in 5 s). A chat with too little to compact gets `refused`. |
| `/context`, `/usage` (`/cost`, `/stats`) | At once | No model call; the report comes back as `reply`. |
| `/code-review` (`/review`) | At once; `--fix` or `--comment` after a yes | Reads and reports unless `--fix` (edits files) or `--comment` (posts on the pull request). Live: found a planted bug in 6 s. |
| `/security-review`, `/recap`, `/insights`, `/debug`, `/deep-research`, `/verify`, `/run`, `/skill-doctor`, `/list-agents`, `/reload-skills`, `/reload-plugins`, `/team-onboarding`, reference skills (`/claude-api`, `/dataviz`, `/workflow-authoring`) | At once | |
| `/init`, `/simplify`, `/batch`, `/goal`, `/loop`, `/subtask`, `/update-config`, `/fewer-permission-prompts`, `/doctor`, `/plugin-authoring`, `/run-skill-generator` | After a yes (disruptive) | They change files, settings, or keep the agent working on its own. |
| `/schedule`, `/design-sync` | After a yes (outward) | They reach Anthropic's cloud. |
| Your own and your project's commands, plugin commands (`plugin:name`), MCP prompts (`mcp__server__prompt`), commands God Mode does not know | After a yes (risk unknown) | God Mode sees only their description. A project command that shadows a built-in name counts as the project's. |
| `/clear` | Not from ChatGPT | It starts a new Claude session inside the chat, which Paseo does not follow. Use `archive_chat` and `start_chat`. |
| `/rewind` | Not from ChatGPT | Rolls files and the conversation back to a message id God Mode does not have. |
| `/model`, `/effort`, `/fast`, `/advisor` | Not from ChatGPT | Would change the chat's model behind Paseo's back. |
| Session settings (`/config`, `/mcp`, `/rename`, `/add-dir`, `/output-style`, …), terminal screens, account and billing, other sessions (`/fork`, `/resume`, …), `/heapdump`, `/bug`, `/feedback`, `/export`, removed and internal commands | Not from ChatGPT | Each with its reason in the list. |

### Codex

Checked against Paseo 0.11.4's Codex provider and covered by tests with a fake daemon; **not run live**
(no Codex CLI is set up for Paseo on the Mac it was built on).

| Command | God Mode | How it runs |
| --- | --- | --- |
| `/compact` | After a yes (disruptive); no arguments | Paseo calls Codex's `thread/compact/start` outside any turn. Codex stops a turn in progress, so a working chat is `busy` first. The result is read from the timeline as it arrives. |
| `/goal [<objective>\|pause\|resume\|clear]` | After a yes; runs beside a working turn | Paseo calls Codex's `thread/goal/*`. Listed only when Paseo runs Codex with goals. |
| Skills | After a yes | Paseo sends Codex a native skill input. |
| Custom prompts (`prompts:name`) | After a yes | Paseo fills in `~/.codex/prompts/name.md` (`$1`…`$9`, `$ARGUMENTS`, `NAME=value`) and sends the text, as Codex's own terminal app does. |
| `/review` | **Not available** | Codex has a native review (`review/start`: uncommitted changes, a base branch, a commit or custom instructions), but Paseo 0.11.4 does not expose it, and `/review` as text would reach the model as an ordinary message. Ask the agent to review the changes instead. |
| `/init`, `/model`, `/new`, `/diff`, `/status`, `/fork`, `/undo` and Codex's other terminal commands | Not available | Each with its reason. |

### Other providers

OpenCode, the ACP agents, Pi, OMP and plugin providers: their commands are listed as Paseo gives them,
and `run_slash_command` answers `unavailable`. How each of them turns `/name` into a command through
Paseo has not been verified, and God Mode does not send what it cannot vouch for.

## What it does not guarantee

- **That the user said yes.** The confirmation proves what was put to the user; asking is ChatGPT's
  part. See [security.md](security.md#slash-commands).
- **What a custom command does.** God Mode sees its description, not its file; a command can run shell
  commands of its own before the model sees it.
- **That a command asks before acting.** Commands run inside the chat: its folder, its conversation
  and its permission mode. With permissions bypassed in a chat, nothing asks; the confirmation says so.

Running Codex's `/review` for real, and telling commands apart without God Mode's own table, need
Paseo to map `/review` to Codex's `review/start` and to pass on each command's source and aliases.
