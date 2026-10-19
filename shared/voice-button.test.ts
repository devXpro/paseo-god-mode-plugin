import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultVoiceButtonSettings, shortcutRunUrl, voiceButtonSchema, voiceSlashName } from "./voice-button.ts";

test("the button is off by default and, once on, shows everywhere as Jarvis", () => {
  const settings = defaultVoiceButtonSettings();
  assert.equal(settings.enabled, false);
  assert.equal(settings.name, "Jarvis");
  assert.equal(settings.macMode, "auto");
  assert.ok(Object.values(settings.placements).every(Boolean));
});

test("names are trimmed, and empty or long ones refused", () => {
  assert.equal(voiceButtonSchema.parse({ name: "  Дуся " }).name, "Дуся");
  assert.equal(voiceButtonSchema.safeParse({ name: "   " }).success, false);
  assert.equal(voiceButtonSchema.safeParse({ name: "x".repeat(25) }).success, false);
});

test("a partial placements object keeps the other defaults", () => {
  assert.deepEqual(voiceButtonSchema.parse({ placements: { sidebar: false } }).placements, {
    chats: true,
    header: true,
    sidebar: false,
    commandCenter: true,
    slashCommand: true,
  });
});

test("the slash command is the name when it is one plain word", () => {
  assert.equal(voiceSlashName("Jarvis"), "jarvis");
  assert.equal(voiceSlashName("Дуся"), "voice-chat");
  assert.equal(voiceSlashName("Voice Bot"), "voice-chat");
});

test("the Shortcuts URL encodes the name", () => {
  assert.equal(shortcutRunUrl("Дуся голос"), "shortcuts://run-shortcut?name=%D0%94%D1%83%D1%81%D1%8F%20%D0%B3%D0%BE%D0%BB%D0%BE%D1%81");
});
