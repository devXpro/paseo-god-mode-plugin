import assert from "node:assert/strict";
import { test } from "node:test";
import { redact, scrubText, validate } from "./safety.ts";

test("secret-looking keys are redacted at any depth", () => {
  const out = redact({
    id: "site",
    siwc_bypass_bearer_token: "abc",
    source_repository_credential: { token: "t", remote_url: "u" },
    items: [{ password: "p", name: "n" }],
  });
  assert.deepEqual(out, {
    id: "site",
    siwc_bypass_bearer_token: "[redacted]",
    source_repository_credential: "[redacted]",
    items: [{ password: "[redacted]", name: "n" }],
  });
});

test("free text loses bearer tokens, pairing offers and token fields", () => {
  const text = 'auth: Bearer abc.DEF-123 link https://app.paseo.sh/#offer=eyJ2IjoyfQ "token": "s3cret"';
  const out = scrubText(text);
  assert.ok(!out.includes("abc.DEF-123"));
  assert.ok(!out.includes("eyJ2IjoyfQ"));
  assert.ok(!out.includes("s3cret"));
  assert.match(out, /Bearer \[redacted\]/);
  assert.match(out, /#offer=\[redacted\]/);
});

test("structured results are checked against their output schema", () => {
  const schema = {
    type: "object",
    required: ["chats"],
    properties: { chats: { type: "array", items: { type: "object", required: ["id"], properties: { id: { type: "string" }, state: { enum: ["idle", "running"] } } } } },
  };
  assert.deepEqual(validate(schema, { chats: [{ id: "a", state: "idle" }] }), []);
  assert.deepEqual(validate(schema, { chats: [{ state: "lost" }] }), ["$.chats[0].id: missing", '$.chats[0].state: "lost" not in enum']);
  assert.deepEqual(validate(schema, []), ["$: expected object, got array"]);
  assert.deepEqual(validate({ type: ["integer", "null"] }, null), []);
});
