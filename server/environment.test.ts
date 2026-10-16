import assert from "node:assert/strict";
import { test } from "node:test";
import { atLeast, parseVersion, relayOf } from "./environment.ts";

test("versions are read from tool output", () => {
  assert.deepEqual(parseVersion("v25.3.0"), [25, 3, 0]);
  assert.deepEqual(parseVersion("git version 2.50.1 (Apple Git-155)"), [2, 50, 1]);
  assert.deepEqual(parseVersion("codex-cli 0.162.0-alpha.17.2"), [0, 162, 0]);
  assert.equal(parseVersion("no version here"), null);
});

test("version comparison goes part by part", () => {
  assert.ok(atLeast([22, 13, 0], [22, 13, 0]));
  assert.ok(atLeast([23, 0, 0], [22, 13, 0]));
  assert.ok(!atLeast([22, 12, 9], [22, 13, 0]));
  assert.ok(!atLeast([20, 99, 99], [22, 13, 0]));
});

test("the relay comes out of a pairing offer and nothing else does", () => {
  const offer = { v: 2, serverId: "srv", daemonPublicKeyB64: "key", relay: { endpoint: "relay.example:443", useTls: true } };
  const url = `https://app.paseo.sh/#offer=${Buffer.from(JSON.stringify(offer)).toString("base64url")}`;
  assert.equal(relayOf(url), "relay.example:443");
  assert.equal(relayOf("https://app.paseo.sh/"), null);
  assert.equal(relayOf("not a url"), null);
});
