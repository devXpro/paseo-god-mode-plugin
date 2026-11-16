# Claude voice button

An optional button in Paseo that starts Claude's own voice mode in the Claude desktop app, so you talk
to Claude with your claude.ai account, its memory and the God Mode connector. It is the Claude twin of
the [ChatGPT voice button](voice-button.md). It is off until you turn on **Claude voice in Paseo** in
the God Mode screen, under **Voice button**, and it never calls an Anthropic API or sees the
conversation.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Name | Claude | The button's label and Command Center title; a plain one-word name is also its slash command (`/claude`), any other name uses `/claude-voice`. |
| Placements | header, Command Center, slash command | Also possible: a pill in every chat and a sidebar row. |
| On a Mac | Press Claude's voice mode button | `open` only brings Claude forward. |
| Profile | the default instance | A name such as `evo` targets the Claude instance whose data lives in `~/.claude-evo-data`. |
| iPhone shortcut | empty | Runs that Apple Shortcut instead of opening a new Claude chat. |

Settings are kept in `~/.paseo/god-mode/claude-voice.json` on the daemon's Mac.

## On a Mac

Anthropic publishes no link, keyboard shortcut, menu item or Shortcuts action that starts voice mode
in the Claude desktop app (its "Voice shortcut" and "Dictation shortcut" only dictate). What the app
has is the voice mode button in the chat composer, the icon with the aria-label "Use voice mode". The
button presses it through Accessibility:

1. It finds the Claude instance: the one started without `--user-data-dir`, or the chosen profile's
   (started with `open -n` and that profile's data when it is not running), and brings that process
   forward by its pid.
2. It reads Claude's window (`AXManualAccessibility` makes Electron publish it) and picks the voice
   button by several signals, not only the label: a button of the composer that holds the message box,
   icon-only, at the send spot while the box is empty, labelled "Use voice mode" or a known translation
   (Russian and Ukrainian included), and never one of the known others (send, stop, dictation,
   attachments, model, tools). An unknown interface language falls back to the send spot of an empty
   composer.
3. When the window is not on a chat (Claude Code, Cowork, settings) or the box holds a draft, it opens
   a new chat: the sidebar's link to `/new` (found by its address, so in any language), or, when only
   one Claude instance runs, the link `claude://claude.ai/new`. Then it looks again.
4. After the press it checks that voice mode came up (the microphone controls appear). When voice is
   already on it says so and does not toggle it off.

Pressing needs Paseo in System Settings → Privacy & Security → Accessibility, the same permission as
the ChatGPT button. Without it, or when the button is not found, Claude is left in front and you tap
its voice button once. The first voice conversation also asks macOS for Claude's microphone access.

The script can be run by hand without pressing anything:

```sh
node -e 'import("./server/voice-button/claude-ax.ts").then(m => process.stdout.write(m.claudeAxScript()))' > /tmp/claude-ax.js
osascript -l JavaScript /tmp/claude-ax.js <pid of Claude> no 15000 dry
```

## On an iPhone

There is nothing to press from outside: the Claude app has no Shortcuts action, link or intent that
starts voice mode. The button opens `https://claude.ai/new`, a link the app claims, and you tap the
voice button. In a car, Claude's own CarPlay icon starts a voice chat by itself.

## Known limits

- Claude's voice mode currently sees only one tool of each custom connector and asks for every write
  (anthropics/claude-ai-mcp#1316, #1144), which limits what God Mode can do by voice until Anthropic
  fixes it.
- A new release of claude.ai can move or rename the button; the label, position and send-spot signals
  each cover for the others, and the toast says when nothing matched.
