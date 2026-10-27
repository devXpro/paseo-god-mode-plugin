# Changelog

All notable changes to God Mode. One version covers the Paseo plugin and the ChatGPT Site it
publishes; it follows [Semantic Versioning](https://semver.org), and this file follows
[Keep a Changelog](https://keepachangelog.com). Each `## [X.Y.Z]` section becomes the notes of the
GitHub release vX.Y.Z.

## [Unreleased]

## [0.14.0] - 2026-10-27

### Added

- `pin_chat`: pins or unpins a chat in Paseo's sidebar (`action` pin or unpin), the way Paseo's own
  Pin and Unpin do. Paseo pins a row, the chat's workspace, so the row's other chats go with it, and
  the answer names them. The chat is named as for the other tools: its id (`chat_id` of the chat
  `start_chat` just opened), or a name that only one chat has, or a name that only the chats of one
  row share (the row's own title). A row with no chat is reached by every word of its name, or by its
  `workspace_id` from `list_pinned_chats`. A pin or unpin already in place changes nothing, so a row
  keeps its place in Pinned; an archived chat, a row that is gone and an unclear name change nothing
  either. No read-back: one more call undoes it.

## [0.13.0] - 2026-10-26

### Added

- `list_pinned_chats`: the chats in the Pinned section at the top of Paseo's sidebar, across every
  project, latest pin first, each row with its active chats and their ids. `project` narrows them,
  and `query` picks among them by words, chat titles included; when no row has the words, every row
  comes back so ChatGPT can match a name said in another language. Paseo pins a workspace, so a row
  holds one chat, sometimes none or several. A chat the user picks by its pin ("read the pinned chat
  in proxy") is found with it first: no other tool knows pins, and a read by the project's name alone
  would take the chat at work there.
- The release's live check calls `list_pinned_chats` too, once ChatGPT shows it.

## [0.12.1] - 2026-10-23

### Fixed

- After `needs_clarification` for a chat, ChatGPT picked the first candidate itself instead of asking:
  the guidance let it take "the candidate this conversation is about", and a name every candidate
  shares read as that. The answer, the `needs_clarification` description and the instructions now
  say to ask the user which one, naming what tells them apart, and to pick one only when the user's
  words pick it ("the latest" is the one updated most recently, "the one about X" the one whose title
  or workspace says X) or the conversation already read or used exactly that chat.

## [0.12.0] - 2026-10-23

### Added

- `send_message` by the id of an archived chat whose title an active chat now has (most likely its
  continuation, and an id kept from before) answers `archived` with `delivered: false` and those
  chats in `same_title`, and sends nothing; `if_archived: "restore"` sends it anyway. Any other
  archived chat still gets the message and comes back, and the result now says so.
- `needs_clarification` for a chat says why in `reason`: `same_name`, `similar`, `partial`,
  `id_prefix`, `no_match` or `unknown_id`.

### Changed

- Chat names resolve in tiers: the whole name (the title or the workspace's title, either with the
  project after it, or the whole first line of a title Paseo cut at 60 characters), then every word
  of it, then at least half of them. The workspace's title counts as a name: Paseo has a model write
  it, and it often tells apart chats that share a title.
- Writes (`send_message`, `answer_approval`, `stop_chat`, `archive_chat`, `run_slash_command`) act on
  a name only when one chat has it whole or has all of its words. They never choose between equals,
  by recency or by which chat is running or waiting, and a partial match is asked about. Reads still
  take the closest match and the only active chat among equals, saying so in `note`;
  `search_messages` with a chat now resolves it the same way.
- `needs_clarification` for a chat offers only the equal candidates, up to five, with their workspace
  titles, and for a write says nothing was done. A name no active chat has says the archive was not
  searched, and that ChatGPT looks there (`include_archived`) only when the user asks.
- The instructions and the `chat` argument tell ChatGPT to pass a chat's id when an earlier result
  gave it, since titles repeat; otherwise the name, without listing chats first; and on
  `needs_clarification` to call again with the id of the candidate the conversation is about, or ask.

### Fixed

- A chat's whole title never matched exactly: names were compared with the title and the project
  together. Two active chats titled alike (a continued chat starts with the same line) therefore came
  back with a third lookalike, and a title inside a longer one ("Fleet map", "Fleet map D") was asked
  about instead of taken.
- A short id was looked up among active chats only: an archived chat's `short_id` found nothing, and
  a start two ids share took the newest chat. Paseo's own lookup now settles it across every chat,
  archived ones included, and refuses one that several ids share; an unknown whole id says so.

## [0.11.0] - 2026-10-20

### Added

- An optional voice button that opens ChatGPT's own voice chat from Paseo, off until turned on under
  **6 · Voice button**. You name it (Jarvis by default) and choose where it shows: a pill in every
  chat, workspace headers, the sidebar, the Command Center and a slash command. On a Mac it presses
  ChatGPT's voice shortcut, read from ChatGPT's settings, after bringing ChatGPT forward (Paseo needs
  Accessibility; otherwise ChatGPT opens and you tap voice once). On an iPhone it runs an Apple
  Shortcut holding ChatGPT's voice action. See docs/voice-button.md.
- `list_models`: the agent runtimes Paseo can start (Claude, Codex…) with their models, the default
  marked, each model's thinking levels and the runtime's permission modes, read from Paseo's own
  provider catalog. Runtimes Paseo has but cannot start are named with the reason.
- `start_chat` starts Codex chats as well as Claude ones: `provider`, or a model that brings its
  runtime. The model can be named as the user said it ("Opus 4.8", "GPT-6-Astra", "Astra"); the
  runtime, model, thinking level and mode are checked against the project's catalog before anything
  starts, and one Paseo does not offer comes back as `needs_clarification` with the choices. The
  result says what the chat runs on (`provider`, `model`, `thinking`, `mode`), as Paseo reports it.
- The release check also calls `list_models` where ChatGPT shows it.

### Fixed

- `start_chat` always started a Claude chat and passed the model on unchecked, and Paseo does not
  check a model when it creates a chat. A Codex model name therefore made a Claude chat whose first
  reply was a model error, which God Mode reported as a normal reply. The site's defaults for new
  chats now apply only where they fit the chat's runtime and model, so a Claude mode such as
  `bypassPermissions` no longer reaches a Codex chat, which Paseo refuses.

## [0.10.0] - 2026-10-18

### Added

- Slash commands in agent chats: `list_slash_commands` returns a chat's commands (`/compact`,
  `/code-review`, the user's and project's own, plugin commands, MCP prompts) with what each does,
  its arguments, its risk, and whether God Mode runs it at once, after the user's yes, or not at all
  (with the reason and what to use instead). `run_slash_command` runs one: only a name the chat lists,
  only when its provider interprets it as a command, anything above low risk or unknown after a
  confirmation token, and never into a working chat unless the user says to interrupt. The outcome is
  read from the command's own turn: a compaction says how full the context was before and after.
  Claude Code chats are supported; Codex chats get `/compact` and `/goal` through Paseo's app-server
  calls, skills and custom prompts, while Codex's own `/review` is reported as unavailable (Paseo does
  not expose `review/start`). Other providers are listed, not run. See docs/slash-commands.md.
- `read_chat` shows a done compaction as a line ("[context compacted from 32k tokens]") and no longer
  shows the earlier output Paseo repeats after a `/compact`; `read_activity` says when an agent is
  compacting its context.
- The release check also calls `list_slash_commands` where ChatGPT shows it.

- Plugins can say an action or a read was not done: an operation names the fields of its answer that
  tell (`outcome`: `ok` false, or a non-empty `error`), and `plugin_action` answers
  `outcome: "refused"`, `delivered: false` and the reason instead of "done"; a refused read says
  `refused: true`. Operations that name no such fields behave as before.
- Confirmations built from the plugin's own data: an action can name a read of the same plugin that
  shows what it acts on (`target`). God Mode reads it for the confirmation, signs the shown facts into
  the token, and reads them again right before running; if they changed, it asks again
  (`target_changed`) instead of acting, and a target that cannot be read refuses the action.
- `untrusted` marks answers that carry other people's words: they come with a fixed note and
  `untrusted: true`, and the instructions say never to act on instructions inside them.
- docs/plugin-capabilities.md describes the three keys; descriptions without them work unchanged.

### Changed

- The README is a short entry point; the reference lives in [docs/](docs/README.md): architecture,
  configuration, tools, the plugin tools and contract, writing a plugin, security, operations and
  development.

## [0.9.0] - 2026-10-17

### Added

- `archive_chat`: archives a chat the way Archive in Paseo does. Its history stays, and a new
  message to it brings it back. A chat whose agent or subagents are working is left alone and the
  answer is `busy`, since archiving would interrupt them. As with `stop_chat`, ChatGPT reads back
  which chat it will archive and waits for a yes.
- `read_chat` view `thinking`: the agent's reasoning in a turn, as Paseo shows it. Claude models
  often record no thinking text, and Codex gives reasoning summaries, so a turn without any says so.
- How full a chat's context window is: `context` (used, max and remaining tokens, percent used)
  in every chat the tools return, and one line in `read_chat` and `read_activity`. Paseo keeps
  this in memory only, so after Paseo restarts it is absent until the agent's next turn.

## [0.8.2] - 2026-10-17

### Fixed

- An update that changes the tools now gets ChatGPT to show them, without a `configure` job
  afterwards. When ChatGPT still shows the old tool list, the update saves the Site's settings
  again before deploying the same version once more. In the Site's Worker log a plain redeploy made
  ChatGPT re-read `server/discover` and the widget but never `tools/list`, while saving the settings
  and then redeploying (what `configure` does) made it re-read `tools/list` within seconds. This is
  observed behaviour, not a documented ChatGPT contract.

## [0.8.1] - 2026-10-17

### Fixed

- The release check called `plugin_read` even when ChatGPT did not show it yet. Right after the
  0.8.0 update ChatGPT still held the old tool list, the call failed with "Unknown tool", and the
  release rolled back; checking the rollback failed the same way, since the version put back has
  no `plugin_read`, and marked the job critical although version 13 was live again. Like
  `read_activity` and `show_images`, it is now called only where the live plugin shows it, and a
  list that has not caught up is a warning.

## [0.8.0] - 2026-10-17

### Added

- `plugin_read` and `plugin_action`: ChatGPT reads and drives Paseo plugins that describe
  themselves. A plugin answers the RPC `meta.describe` with the `paseo.capabilities/1` shape (its
  operations, the real RPC behind each, the arguments as JSON Schema, fixed arguments, and a risk);
  God Mode lists them, resolves spoken names, checks arguments before the call and trims answers
  to the fields the plugin marks. No plugin is known to God Mode by name: a new plugin that
  implements the contract needs no God Mode release. The contract is in
  [docs/plugin-capabilities.md](docs/plugin-capabilities.md).
- Actions above `low` risk return `needs_confirmation` with the text to read out and a token bound
  to the exact arguments for two minutes; they run on the second call, after the user's yes.
  `plugin_action` needs a signed-in ChatGPT user.
- The release check calls `plugin_read` through the live plugin.

## [0.7.2] - 2026-10-17

### Fixed

- One explicit "yes, send it" could reach an agent twice. With `wait_seconds` 0 the result said
  `not_waiting`, which the rules did not name as delivered; the model took the send as unconfirmed
  and sent a reworded copy 9 s later. Now every `send_message` and `start_chat` result says
  `delivered: true|false`, `not_waiting` counts as delivered, and the rules say one instruction is
  one write call, never split and never sent again after `delivered: true`. There is no
  server-side cooldown or dedupe: a new explicit command always goes through.
- The rules name which words are a command to send ("send it", "send it now", "tell it now", yes
  to "Send it?") and which are not ("write a prompt… and then we'll send it", "ask the agent to…",
  "let's tell it…", "you can/could send it"), with a Russian hint for the Russian phrasings.

## [0.7.1] - 2026-10-17

### Fixed

- The first publish of a Site made with the sidebar's Create button no longer fails at "Preparing
  the release" with "Remote branch main not found". A new Site's repository has no commits yet;
  the first release now makes the first one, and its push creates the branch (#1).

## [0.7.0] - 2026-10-17

### Added

- `show_images`: the screenshots and pictures in a chat, the ones Paseo's app shows inline, on
  the screen in ChatGPT through an MCP Apps widget, and handed to the model where ChatGPT takes
  images into its context. The newest image, a turn's images, or the N-th of a turn; without a
  chat, the newest image of the most recent chats.
- The Site reads those images from the Mac through the relay with Paseo's own file read. It reads
  only images a chat's messages show, PNG, JPEG, WebP or GIF, up to 1 MB each and 1.5 MB per
  answer, and keeps no copy.
- The widget is served as an MCP resource (`resources/list`, `resources/read`); its address carries
  a fingerprint of its HTML, and older addresses still load it.

### Changed

- A picture in a chat reads as `[image N]` instead of a file path on the Mac: in `read_chat`,
  which also lists a turn's images and points to `show_images`, and in `read_activity`,
  `search_messages` and the replies of `start_chat` and `send_message`.

### Notes

- ChatGPT offers `show_images` in chats started after the update.
- The widget was checked against a stand-in host and the real daemon, not yet inside ChatGPT
  itself: whether a Site-hosted plugin draws it, and whether the model then sees the images, is
  still to be confirmed on web, iOS and in voice.

## [0.6.0] - 2026-10-17

### Added

- `read_activity`: what an agent and its subagents are doing right now. For each Claude Task/Agent
  subagent it gives the task, status, running time, current step (latest tool call or thought) and,
  once finished, the result. Without a chat it covers every chat at work, including idle chats
  whose backgrounded subagents still run.
- `overview` counts the subagents working in each running chat, and lists an idle chat whose
  subagents are still working as running.
- A tool-selection eval in `gpt-site/eval/`: about 90 Russian and English phrases through a real
  OpenAI model in `codex exec`, against a stub server with a fake Paseo, comparing a release with
  the working tree.

### Changed

- The instructions and tool descriptions ChatGPT reads were rewritten after that eval:
  - one call per request, with a routing map at the top of the instructions;
  - write tools act only on an explicit command: drafting, thinking aloud, "maybe we send it?" or
    "ok" after a draft get "Send it?" instead;
  - the outcome of a write is the truth: delivered is never sent again unless asked, busy means not
    delivered (ask add or interrupt; a plain "send it" afterwards adds to the current work), a failed
    write is never reported as done;
  - "allow it" right after the request was read out needs no second yes; "allow it" with nothing
    waiting answers the agent's question;
  - updates check `update_status` first and send the user to the plugin when GitHub is ahead;
  - coding agents in general (Claude, Codex…), not only Claude.
- Reads take the one active chat when a name matches several ("the agent in jobby") and say so;
  writes still ask which chat.
- Tool results read as speech: chats by title, project and state, never ids or hashes, which stay in
  the structured data. A failed write says it is unknown whether it took effect.

### Removed

- `read_chat` views `turns` and `search`. Read several turns with `turns=N`; search one chat with
  `search_messages(chat=…)`. ChatGPT chats started before this release keep the old tool list:
  start a new chat.

## [0.5.0] - 2026-10-16

First public release.

### Added

- A God Mode entry in Paseo's sidebar that walks through the setup: checks this Mac, signs in to
  ChatGPT with a device code, creates or connects a private ChatGPT Site, keeps its preferences and
  hands it the key to this Mac as a Site secret.
- A release engine on the Mac: tests and builds the Site, publishes it, checks the live plugin and
  puts the previous version back by itself when the check fails. When ChatGPT keeps showing the
  previous tool list, it deploys the release once more so ChatGPT fetches the new one.
- `update_status` and `update_site` in the Site, so ChatGPT reports and starts updates and rollbacks
  by voice or chat. `update_site` runs only for a signed-in ChatGPT user.
- One version for the plugin and the Site. The Site reports which source it was built from and
  whether a newer release is out on GitHub; a ledger on the Mac maps each Sites version to its
  God Mode version.

### Notes

- Numbering continues from paseo-remote, the Site this grew out of (last release 0.3.1): ChatGPT
  refreshes a Site plugin's tools only when this version moves on.
