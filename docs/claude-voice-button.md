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
2. It reads Claude's windows. `AXManualAccessibility` makes Electron publish the page, about two seconds
   after it is set; it is set once and left alone, since every new set starts that over (set every
   300 ms, a freshly started Claude never showed its page). In JXA it has to be an NSNumber bool:
   `$.kCFBooleanTrue` is refused. The claude.ai page
   sits inside the app's own `file://` page, and Claude Code opens windows of its own, so it takes the
   claude.ai page of the window that is on a chat and raises that window.
3. It picks the voice button by several signals, not only the label: a button of the composer that
   holds the message box, icon-only, labelled "Use voice mode" or a known translation (the Russian
   interface says «Включить голосовой режим»; Ukrainian too), and never one of the known others (send,
   stop, dictation, attachments, model, tools, read aloud). With a label it does not know, it takes the
   icon right after the dictation button, which is where voice mode sits.
4. When nothing matches it recovers, in order: Escape, sent only while that Claude is frontmost, closes
   what covers the chat (settings, a menu, a dialog: Claude hides everything under a modal); then a new
   chat: the sidebar's New chat («Создать»), only on a chat screen since on Claude Code's screen the
   same button starts a Code session, or, when only one Claude instance runs, the link
   `claude://claude.ai/new`. Then it looks again.
5. After the press it checks that voice mode came up (the microphone control, «Выключить микрофон» /
   "Turn off microphone", appears). When voice is already on it says so and does not toggle it off.

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
- A new release of claude.ai can move or rename the button; the label, place and dictation-neighbour
  signals each cover for the others, and the toast says when nothing matched.
- macOS hides every window from Accessibility while the screen is locked: the button then only brings
  Claude forward.
- Measured on 2026-11-17 (Claude 5.11492.5, Russian interface), from the Paseo button to voice on:
  about 2 s with Claude running, 5 to 9 s with Claude closed, about 3 s with settings open over a chat.
