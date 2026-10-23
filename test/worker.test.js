import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import worker from "../src/worker.js";

const PAIR_HTML = await readFile(new URL("../public/pair.html", import.meta.url), "utf8");

const ASSET_LINKS = JSON.stringify([
  {
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: "com.clipspan.app",
      sha256_cert_fingerprints: [
        "D6:EE:3C:09:73:02:EF:A1:98:F4:CB:D9:F9:B8:79:43:46:73:96:1C:7B:24:76:49:0A:67:E6:62:5F:72:0E:3F",
        "A7:AE:6E:E0:74:7F:FC:9F:A3:F1:EF:1C:1E:0B:BD:91:E0:D5:CC:06:49:47:65:2B:6C:45:12:8E:A7:71:29:7B",
      ],
    },
  },
]);

const PAIR_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; " +
  "connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

// Stands in for the ASSETS binding with wrangler.toml's html_handling = "auto-trailing-slash":
// /pair serves pair.html, and /pair.html and /pair/ redirect to /pair, as the asset server does.
function fakeEnv(extra = {}) {
  const calls = [];
  const ASSETS = {
    async fetch(input) {
      const request = input instanceof Request ? input : new Request(input);
      const url = new URL(request.url);
      calls.push({ method: request.method, host: url.hostname, pathname: url.pathname });
      if (url.pathname === "/pair") {
        return new Response(request.method === "HEAD" ? null : PAIR_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8", ETag: '"pair"' },
        });
      }
      if (url.pathname === "/pair.html" || url.pathname === "/pair/") {
        return new Response(null, { status: 307, headers: { Location: "/pair" } });
      }
      return new Response(`asset ${url.pathname}`, {
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public" },
      });
    },
  };
  return { env: { ASSETS, ...extra }, calls };
}

const ctx = { waitUntil() {}, passThroughOnException() {} };

function call(url, init = {}, env = fakeEnv().env) {
  return worker.fetch(new Request(url, init), env, ctx);
}

for (const host of ["www.clipspan.com", "clipspan.com", "apt.clipspan.com"]) {
  test(`assetlinks.json is a plain 200 JSON statement list on ${host}`, async () => {
    const { env, calls } = fakeEnv();
    // A browser navigation with no tester cookie must not be sent to sign in.
    const response = await call(
      `https://${host}/.well-known/assetlinks.json`,
      { headers: { "Sec-Fetch-Mode": "navigate", Accept: "text/html" } },
      env,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "application/json");
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=300");
    assert.equal(response.headers.get("Location"), null);
    assert.equal(response.redirected, false);
    const body = await response.text();
    assert.equal(body, ASSET_LINKS);
    assert.equal(response.headers.get("Content-Length"), String(body.length));
    assert.deepEqual(calls, []);
  });
}

test("assetlinks.json answers HEAD with the same headers and no body", async () => {
  const response = await call("https://www.clipspan.com/.well-known/assetlinks.json", {
    method: "HEAD",
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/json");
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=300");
  assert.equal(response.headers.get("Content-Length"), String(ASSET_LINKS.length));
  assert.equal(response.headers.get("Location"), null);
  assert.equal(await response.text(), "");
});

test("assetlinks.json refuses other methods", async () => {
  for (const method of ["POST", "PUT", "DELETE"]) {
    const response = await call("https://www.clipspan.com/.well-known/assetlinks.json", {
      method,
    });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("Allow"), "GET, HEAD");
  }
});

function assertPairHeaders(response) {
  assert.equal(response.headers.get("Content-Security-Policy"), PAIR_CSP);
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(response.headers.get("Cache-Control"), "no-store, no-transform");
  assert.match(response.headers.get("X-Robots-Tag"), /\bnoindex\b/);
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
}

for (const path of ["/pair", "/pair/", "//pair", "/p%61ir"]) {
  test(`${path} serves the pair page with its security headers`, async () => {
    const { env, calls } = fakeEnv();
    const response = await call(`https://www.clipspan.com${path}`, {}, env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
    assertPairHeaders(response);
    assert.equal(await response.text(), PAIR_HTML);
    assert.deepEqual(calls, [{ method: "GET", host: "www.clipspan.com", pathname: "/pair" }]);
  });
}

test("/pair answers HEAD with the page headers", async () => {
  const { env, calls } = fakeEnv();
  const response = await call("https://www.clipspan.com/pair", { method: "HEAD" }, env);
  assert.equal(response.status, 200);
  assertPairHeaders(response);
  assert.equal(calls[0].method, "HEAD");
});

test("/pair refuses other methods", async () => {
  const response = await call("https://www.clipspan.com/pair", { method: "POST", body: "x" });
  assert.equal(response.status, 405);
});

for (const path of ["/pair.html", "/p%61ir.html"]) {
  test(`${path} redirects to /pair without serving the page`, async () => {
    const { env, calls } = fakeEnv();
    const response = await call(`https://www.clipspan.com${path}`, {}, env);
    assert.equal(response.status, 307);
    assert.equal(response.headers.get("Location"), "https://www.clipspan.com/pair");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(await response.text(), "");
    assert.deepEqual(calls, []);
  });
}

test("pair.html loads only same-origin files, with no inline scripts or styles", () => {
  const scripts = [...PAIR_HTML.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0);
  for (const [, attrs, body] of scripts) {
    assert.match(attrs, /\bsrc="\/assets\/[^"]+"/);
    assert.equal(body.trim(), "");
  }
  assert.doesNotMatch(PAIR_HTML, /<style\b/i);
  assert.doesNotMatch(PAIR_HTML, /\sstyle=/i);
  assert.doesNotMatch(PAIR_HTML, /\son[a-z]+=/i);
  for (const [, attr, value] of PAIR_HTML.matchAll(/<(?:script|link|img)\b[^>]*?\b(src|href)="([^"]*)"/gi)) {
    assert.ok(value.startsWith("/") && !value.startsWith("//"), `${attr}="${value}"`);
  }
  // The meta policy covers a copy served without the header. frame-ancestors only works
  // as a header.
  const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(PAIR_HTML);
  assert.ok(meta);
  assert.equal(meta[1], PAIR_CSP.replace("; frame-ancestors 'none'", ""));
});

test("apt.clipspan.com/pair stays in the apt tree", async () => {
  const { env, calls } = fakeEnv();
  const response = await call("https://apt.clipspan.com/pair", {}, env);
  // Not a public apt path, and downloads aren't configured in this env.
  assert.equal(response.status, 503);
  assert.deepEqual(calls, []);
});

test("other pages still fall through to static assets unchanged", async () => {
  const { env, calls } = fakeEnv();
  const response = await call("https://www.clipspan.com/privacy.html", {}, env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "asset /privacy.html");
  assert.equal(response.headers.get("Cache-Control"), "public");
  assert.equal(response.headers.get("Content-Security-Policy"), null);
  assert.deepEqual(calls, [{ method: "GET", host: "www.clipspan.com", pathname: "/privacy.html" }]);
});

test("public apt files are still served from public/apt without a tester code", async () => {
  const { env, calls } = fakeEnv();
  const response = await call("https://apt.clipspan.com/dists/stable/Release", {}, env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(calls, [
    { method: "GET", host: "apt.clipspan.com", pathname: "/apt/dists/stable/Release" },
  ]);
});

test("the releases API still needs a tester code", async () => {
  const limiter = { limit: async () => ({ success: true }) };
  const { env } = fakeEnv({
    DOWNLOADS_SESSION_KEY: "test-key",
    TESTER_CODES: { get: async () => null },
    AUTH_LIMITER: limiter,
  });
  const response = await call("https://www.clipspan.com/api/releases", {}, env);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Enter your tester code." });
});
