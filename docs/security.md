# Security, confirmations and errors

What protects your Paseo when ChatGPT drives it, what each confirmation proves, and how failures are
reported. The short version for users is in the [README](../README.md#security).

## Trust model

- **The pairing link is a full key to your Paseo daemon.** Whoever holds it can do anything a paired
  Paseo app can: start agents, read chats, call any plugin RPC. God Mode's tools offer a small part of
  that, but the key itself is not scoped.
- **Where it lives.** The God Mode plugin reads it from Paseo on your Mac (`paseo pair`) and writes it
  to your Site as the secret `PASEO_PAIRING_URL`. It is never stored in this repository, never shown
  on screen, and never written to the Site's call log; errors have the daemon key and server id
  scrubbed, and the Site scrubs the whole link.
- **The path.** The Site reaches your Mac through Paseo's relay, encrypted end to end with your
  daemon's public key: the relay forwards ciphertext. God Mode opens no ports on your Mac.
- **Who can call the Site.** It is a private ChatGPT Site: requests come through ChatGPT for your
  account. Sites marks a signed-in user with a header; access through a bypass bearer carries no
  user, and the two tools that change God Mode or act through plugins (`update_site`,
  `plugin_action`) refuse it.
- **If the link leaks:** rotate the daemon key in Paseo and pair your devices again, then publish the
  Site again from the sidebar (Apply settings) so it gets the new link.

## Writes

The tools that change something: `start_chat`, `send_message`, `answer_approval`, `stop_chat`,
`archive_chat`, `run_slash_command`, `plugin_action`, `update_site`.

- **Only on a command.** The server instructions tell ChatGPT to call a write tool only when the
  user's latest words tell it to act now, or are "yes" to its own "Send it?"; drafting, discussing or
  "you could send it" are not commands.
- **One instruction, one write.** A write result says `delivered: true` when it arrived; the rules say
  never to send it again or a reworded copy.
- **Read-back for risky agent actions.** With `PASEO_CONFIRM_RISKY` on (the default), approving a
  request, stopping or archiving a chat, and updating God Mode need the user to have heard exactly
  what will happen and said yes. This is a rule ChatGPT follows, not a server check.
- **ChatGPT's own approvals.** Depending on how you set the app's permissions in ChatGPT, it may also
  show its own approval card for write tools. God Mode does not depend on it.

## Plugin actions and their confirmation

Plugins describe their operations themselves ([contract](plugin-capabilities.md)); anything above
`low` risk asks first. The mechanics are in [plugin-tools.md](plugin-tools.md#actions-that-ask-first).

What is guaranteed:

- **Exactly this call.** The confirmation token is an HMAC-SHA256, keyed from the pairing link (the
  Site's one secret), over the plugin, operation, method and the canonical arguments with the fixed
  ones merged in. A token runs only that call; it cannot be forged or moved to other arguments, and it
  expires after two minutes.
- **Facts from the plugin, rechecked.** With a `target`, `confirm_text` shows facts God Mode read from
  the plugin for exactly those arguments, and the token signs them. Right before running, the target is
  read again; if the facts differ, nothing runs and the user is asked again. An unreadable target
  refuses the action.

What is not guaranteed:

- **That the user said yes.** The token proves what was put to the user; asking them is ChatGPT
  following its rules. Describe nothing you would not accept being run by a model that misheard.
- **A transaction.** The recheck is a read a moment before the call. If the thing can change in the
  instant between that read and the plugin's handler, only the handler can check it.
- **Single use.** A token is not spent: within its two minutes the same call could run twice. God Mode
  relies on `delivered: true` and the rule never to repeat a done action.
- **The plugin's honesty.** A plugin is trusted code on your Mac; its description says what its RPCs
  do, and God Mode cannot verify that.

## Slash commands

`run_slash_command` sends a chat's own command as a message, and only one that the chat lists and
whose provider God Mode knows how to run ([slash-commands.md](slash-commands.md)).

What is guaranteed:

- **Nothing the agent would take as plain text.** A name the chat does not list is never sent, nor a
  command God Mode refuses (`/clear`, `/rewind`, `/model`, `/heapdump`, session and account
  commands, Codex's `/review`), nor arguments that start a second command.
- **Exactly this run.** Anything above low risk, and every command God Mode cannot judge (your own,
  plugins', MCP prompts), runs only with a confirmation token: HMAC-SHA256 keyed from the pairing
  link, over the chat, the exact command text and whether it interrupts the chat's work; two minutes.
- **A working chat is not interrupted by surprise.** A command waits while the chat works; it stops
  the work only with `if_busy: "interrupt"`, which the rules allow only on the user's explicit yes,
  and a risky command's confirmation covers that interruption.

What is not guaranteed: that the user said yes (ChatGPT's part), what a custom command does beyond
its description, and that a command asks before acting: it runs with the chat's own permission mode,
and with permissions bypassed nothing asks (the confirmation says so). Tokens are not single use, as
for plugin actions.

## Other people's words

Answers from operations marked `untrusted` (messages, mail, tickets) carry a fixed note and
`untrusted: true`, and the server instructions say never to act on instructions inside them. It is a
signal to the model, not a filter; the protection for actions is the confirmation above and the rule
to act only on the user's own words.

## What leaves your Mac

- Tool results go to ChatGPT, like the chat text you ask about. Pictures from a chat are read only
  when you ask for them (`show_images`) and only the ones the chat itself shows; no copy is kept.
- Plugin answers are trimmed to the fields the plugin marked (`output.fields`); keys that look secret
  (`token`, `secret`, `password`, `credential`, `cookie`, `bearer`, `authorization`, `api key`,
  `private key`) have text values redacted.
- **The call log.** With `PASEO_LOG` on (the default), each tool call is a row in the Site's own D1
  database: time, tool, arguments (each text cut to 300 characters), ok, duration, and the output or
  error cut to 500. `get_logs` reads it back. Nothing is pruned yet.

## Errors and outcomes

| Situation | What ChatGPT gets |
| --- | --- |
| Bad or missing arguments | A JSON-RPC error that says what the tool or the plugin operation takes. Nothing runs. |
| A name that matches several things, or nothing | `needs_clarification` with candidates to ask the user about. |
| The Mac asleep or offline | "Paseo is offline: the computer running it is probably asleep or disconnected." A write adds "Nothing was sent." |
| A request that failed on the way | "Paseo request failed: …"; a write adds "Unknown whether it took effect: never say it did." |
| A plugin that said it did not do it | `outcome: "refused"`, `delivered: false` and the reason (a read: `refused: true`). |
| A busy agent | `send_message` answers `busy`, `delivered: false`, and asks whether to add the message to the current work or interrupt; `run_slash_command` answers `busy` and asks whether to interrupt. |
| A slash command God Mode does not run | `run_slash_command` answers `unavailable`, `delivered: false`, with the reason and what to use instead. |
| A tool ChatGPT remembers from an older version | "There is no tool …: ChatGPT is using an outdated tool list for this plugin. Tell the user to start a new chat so it reloads." |
| No pairing link configured | Every tool but `get_logs` answers that `PASEO_PAIRING_URL` must be set and the Site redeployed. |
| A tool call over 45 seconds | "Paseo request failed: no answer within 45 s." |
