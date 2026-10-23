import assert from "node:assert/strict";
import { test } from "node:test";

import { legacyPairLink, parsePairFragment, validHost } from "../public/assets/pair.js";

const TOKEN = "Zm9vYmFyX2Jhei1xdXV4LTEyMw";
const PIN = "mfrggzdfmztwq2lknnwg23tpoa";

function fragment(fields) {
  return (
    "#" +
    Object.entries(fields)
      .map(([key, value]) => `${key}=${value}`)
      .join("&")
  );
}

const VALID = { v: "1", h: "192.168.1.20", p: "47321", t: TOKEN, f: PIN };

test("parses a version 1 pairing fragment", () => {
  assert.deepEqual(parsePairFragment(fragment(VALID)), {
    host: "192.168.1.20",
    port: 47321,
    token: TOKEN,
    pin: PIN,
  });
  // location.hash includes the #, but the parser takes it either way.
  assert.ok(parsePairFragment(fragment(VALID).slice(1)));
});

test("builds the link older ClipSpan apps accept", () => {
  assert.equal(
    legacyPairLink(parsePairFragment(fragment(VALID))),
    `https://192.168.1.20:47321/p?t=${TOKEN}&f=${PIN}`,
  );
  assert.equal(
    legacyPairLink(parsePairFragment(fragment({ ...VALID, h: "jeremy-desktop.local", p: "1" }))),
    `https://jeremy-desktop.local:1/p?t=${TOKEN}&f=${PIN}`,
  );
});

test("field order doesn't matter and unknown fields are ignored", () => {
  const parsed = parsePairFragment(`#f=${PIN}&x=anything&t=${TOKEN}&p=443&h=pc&v=1`);
  assert.deepEqual(parsed, { host: "pc", port: 443, token: TOKEN, pin: PIN });
});

test("rejects a missing or empty fragment", () => {
  for (const hash of [undefined, null, 42, "", "#", "#&", "#v=1"]) {
    assert.equal(parsePairFragment(hash), null, String(hash));
  }
});

test("rejects missing fields", () => {
  for (const key of Object.keys(VALID)) {
    const fields = { ...VALID };
    delete fields[key];
    assert.equal(parsePairFragment(fragment(fields)), null, key);
  }
});

test("rejects other versions", () => {
  for (const v of ["0", "2", "01", "1.0", " 1", ""]) {
    assert.equal(parsePairFragment(fragment({ ...VALID, v })), null, v);
  }
});

test("rejects repeated fields and malformed parts", () => {
  assert.equal(parsePairFragment(`${fragment(VALID)}&t=${TOKEN}`), null);
  assert.equal(parsePairFragment(`${fragment(VALID)}&`), null);
  assert.equal(parsePairFragment(`${fragment(VALID)}&junk`), null);
  assert.equal(parsePairFragment(`${fragment(VALID)}&=1`), null);
  assert.equal(parsePairFragment(fragment(VALID) + "&x=" + "a".repeat(1100)), null);
});

test("accepts IPv4 addresses and DNS names", () => {
  for (const host of [
    "10.0.0.1",
    "255.255.255.255",
    "pc",
    "my-pc",
    "jeremy-desktop.local",
    "Desktop-7.lan",
    "a.b.c.example.com",
    "1pc.lan",
    `${"a".repeat(63)}.local`,
  ]) {
    assert.equal(validHost(host), true, host);
  }
});

test("rejects hosts that aren't plain IPv4 addresses or DNS names", () => {
  for (const host of [
    "",
    "10.0.0.300",
    "10.0.0",
    "01.2.3.4",
    "1.2.3.4.5",
    "pc.0x1f",
    "0x7f000001",
    "2130706433",
    "[::1]",
    "::1",
    "fe80::1",
    "pc:8080",
    "user@pc",
    "evil.com/x",
    "evil.com?x",
    "evil.com#x",
    "evil.com\\x",
    "a b",
    "-pc",
    "pc-",
    "pc..lan",
    ".pc",
    "pc.",
    "p_c",
    "pc%2elan",
    "<script>",
    "javascript:alert(1)",
    "exämple.com",
    `${"a".repeat(64)}.local`,
    `${"a.".repeat(126)}ab`,
  ]) {
    assert.equal(validHost(host), false, host);
    assert.equal(parsePairFragment(fragment({ ...VALID, h: host })), null, host);
  }
  assert.equal(validHost(undefined), false);
});

test("hosts may be up to 253 characters", () => {
  const host = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
  assert.equal(host.length, 253);
  assert.equal(validHost(host), true);
  assert.equal(validHost(`${host}e`), false);
});

test("ports must be whole numbers from 1 to 65535", () => {
  for (const p of ["1", "80", "65535"]) {
    assert.ok(parsePairFragment(fragment({ ...VALID, p })), p);
  }
  for (const p of ["0", "65536", "99999", "080", "-1", "1.5", "8a", "1e3", " 80", "", "123456"]) {
    assert.equal(parsePairFragment(fragment({ ...VALID, p })), null, p);
  }
});

test("tokens are 4 to 128 base64url characters", () => {
  for (const t of ["abcd", "A-_9", "a".repeat(128)]) {
    assert.ok(parsePairFragment(fragment({ ...VALID, t })), t);
  }
  for (const t of ["abc", "a".repeat(129), "ab+c", "ab/c", "abc=", "ab%2Bc", "ab c", "ab.c"]) {
    assert.equal(parsePairFragment(fragment({ ...VALID, t })), null, t);
  }
});

test("pins are the desktop's 26 lowercase base32 characters", () => {
  for (const f of [PIN, "a".repeat(26), "abcdefghijklmnopqrstuvwxyz"]) {
    assert.ok(parsePairFragment(fragment({ ...VALID, f })), f);
  }
  for (const f of [
    "a".repeat(16),
    "a".repeat(25),
    "abcdefghijklmnopqrstuvwxyz234567",
    "a".repeat(128),
    PIN.toUpperCase(),
    `${PIN}0`,
    `${PIN}1`,
    `${PIN}8`,
    `${PIN}=`,
    `${PIN}-`,
  ]) {
    assert.equal(parsePairFragment(fragment({ ...VALID, f })), null, f);
  }
});

test("values are not percent-decoded", () => {
  // %31 is "1": a valid code never needs escaping, so an escaped one is not valid.
  assert.equal(parsePairFragment(fragment({ ...VALID, v: "%31" })), null);
  assert.equal(parsePairFragment(fragment({ ...VALID, h: "192%2E168%2E1%2E20" })), null);
});
