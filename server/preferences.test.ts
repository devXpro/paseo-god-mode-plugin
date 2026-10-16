import assert from "node:assert/strict";
import { test } from "node:test";
import { fromEnvironment, toEnvironment } from "./preferences.ts";
import type { EnvEntry } from "./sites/sites.ts";

const env = (pairs: Record<string, string | null>, secret: string[] = []): EnvEntry[] =>
  Object.entries(pairs).map(([key, value]) => ({ key, value, is_secret: secret.includes(key) }));

test("an existing Site's settings become the preferences", () => {
  const prefs = fromEnvironment(env({ PASEO_LANGUAGE: "ru", PASEO_WAIT_SECONDS: "20", PASEO_CONFIRM_RISKY: "off", PASEO_NEW_CHAT_MODE: "plan", PASEO_PAIRING_URL: null }));
  assert.deepEqual(prefs, { language: "ru", newChatModel: "", newChatThinking: "", newChatMode: "plan", waitSeconds: 20, confirmRisky: false, log: true });
});

test("unknown or out-of-range values fall back to the defaults", () => {
  const prefs = fromEnvironment(env({ PASEO_NEW_CHAT_MODE: "yolo", PASEO_WAIT_SECONDS: "999" }));
  assert.equal(prefs.newChatMode, "");
  assert.equal(prefs.waitSeconds, 25);
  assert.equal(fromEnvironment([]).waitSeconds, 15);
});

test("preferences become variables, the pairing link always as a secret", () => {
  const prefs = fromEnvironment(env({ PASEO_LANGUAGE: "en" }));
  const { set, remove } = toEnvironment({ ...prefs, newChatModel: "" }, "https://app.paseo.sh/#offer=x", env({ PASEO_NEW_CHAT_MODEL: "old-model", PASEO_LANGUAGE: "en" }));
  assert.deepEqual(set.find((e) => e.key === "PASEO_PAIRING_URL"), { key: "PASEO_PAIRING_URL", value: "https://app.paseo.sh/#offer=x", is_secret: true });
  assert.equal(set.find((e) => e.key === "PASEO_CONFIRM_RISKY")?.value, "on");
  assert.ok(set.every((e) => e.key === "PASEO_PAIRING_URL" || !e.is_secret));
  assert.ok(!set.some((e) => e.key === "PASEO_NEW_CHAT_MODEL"));
  assert.deepEqual(remove, ["PASEO_NEW_CHAT_MODEL"], "only keys the Site has are removed");
});
