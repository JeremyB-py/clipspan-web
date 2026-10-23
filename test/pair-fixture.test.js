// The cases ClipSpan's Android parser also tests. Copy of clipspan's
// shared/test-fixtures/pair-app-links.json: update both together.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePairFragment } from "../public/assets/pair.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/pair-app-links.json", import.meta.url), "utf8"),
);

test("the website and the app agree on every pairing link", () => {
  assert.ok(fixture.cases.length > 10);
  for (const c of fixture.cases) {
    const parsed = parsePairFragment(c.fragment);
    const why = c.why ?? c.fragment;
    assert.equal(parsed !== null, c.valid, why);
    if (parsed) {
      assert.equal(parsed.host, c.host, why);
      assert.equal(parsed.port, c.port, why);
    }
  }
});
