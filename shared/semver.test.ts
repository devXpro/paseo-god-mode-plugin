import assert from "node:assert/strict";
import { test } from "node:test";
import { compareVersions, parse } from "./semver.ts";

test("releases are ordered by SemVer, not as text", () => {
  const sorted = ["0.10.0", "0.4.1", "0.5.0-rc.1", "0.5.0", "0.5.0-rc.2", "1.0.0", "0.4.10", "0.5.0-beta"].sort(compareVersions);
  assert.deepEqual(sorted, ["0.4.1", "0.4.10", "0.5.0-beta", "0.5.0-rc.1", "0.5.0-rc.2", "0.5.0", "0.10.0", "1.0.0"]);
});

test("tags and build metadata parse; anything else does not", () => {
  assert.deepEqual(parse("v0.5.0")?.core, [0, 5, 0]);
  assert.equal(compareVersions("0.5.0+3f2a9c1d", "0.5.0"), 0);
  assert.equal(parse("0.5"), null);
  assert.ok(compareVersions("garbage", "0.0.1") < 0);
});
