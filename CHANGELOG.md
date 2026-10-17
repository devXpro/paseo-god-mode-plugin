# Changelog

All notable changes to God Mode. One version covers the Paseo plugin and the ChatGPT Site it
publishes; it follows [Semantic Versioning](https://semver.org), and this file follows
[Keep a Changelog](https://keepachangelog.com). Each `## [X.Y.Z]` section becomes the notes of the
GitHub release vX.Y.Z.

## [Unreleased]

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
