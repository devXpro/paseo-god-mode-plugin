import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeVoiceSchema, defaultClaudeVoiceSettings } from "./claude-voice.ts";

test("the Claude button is off by default, named Claude, pressing voice mode on the default instance", () => {
  const settings = defaultClaudeVoiceSettings();
  assert.equal(settings.enabled, false);
  assert.equal(settings.name, "Claude");
  assert.equal(settings.macMode, "auto");
  assert.equal(settings.profile, "");
  assert.equal(settings.placements.header, true);
});

test("a profile is a plain directory word, never a path", () => {
  assert.equal(claudeVoiceSchema.parse({ profile: " evo " }).profile, "evo");
  assert.equal(claudeVoiceSchema.safeParse({ profile: "../x" }).success, false);
  assert.equal(claudeVoiceSchema.safeParse({ profile: "a b" }).success, false);
});
