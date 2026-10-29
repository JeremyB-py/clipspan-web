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
    // A browser navigation gets the statement too, never a redirect.
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
  assert.equal(await response.text(), "asset /apt/pair");
  assert.equal(response.headers.get("Content-Security-Policy"), null);
  assert.deepEqual(calls, [{ method: "GET", host: "apt.clipspan.com", pathname: "/apt/pair" }]);
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

test("apt files are served from public/apt", async () => {
  const { env, calls } = fakeEnv();
  const response = await call("https://apt.clipspan.com/dists/stable/Release", {}, env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(calls, [
    { method: "GET", host: "apt.clipspan.com", pathname: "/apt/dists/stable/Release" },
  ]);
});

test("the apt install script needs no code, and an old tester code is ignored", async () => {
  for (const headers of [{}, { Authorization: `Basic ${btoa("clipspan:OLD-CODE")}` }]) {
    const { env, calls } = fakeEnv();
    const response = await call("https://apt.clipspan.com/install.sh", { headers }, env);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "asset /apt/install.sh");
    assert.deepEqual(calls, [{ method: "GET", host: "apt.clipspan.com", pathname: "/apt/install.sh" }]);
  }
});

const RELEASE = {
  tag_name: "v0.23.1",
  name: "ClipSpan 0.23.1",
  published_at: "2026-10-27T12:00:00Z",
  body: "Release notes",
  assets: [
    { id: 1, name: "ClipSpan_0.23.1_x64-setup.exe", size: 100 },
    { id: 2, name: "ClipSpan_0.23.1_x64_en-US.msi", size: 200 },
    { id: 3, name: "clipspan-0.23.1-release.apk", size: 300 },
    { id: 4, name: "latest.json", size: 10 },
  ],
};

// Stands in for GitHub's API and the Workers cache while `run` goes. Passes `run` the
// GitHub paths requested so far.
async function withGitHub(run) {
  const requests = [];
  const cached = new Map();
  const saved = { fetch: globalThis.fetch, caches: globalThis.caches };
  globalThis.fetch = async (input) => {
    const { pathname } = new URL(input);
    requests.push(pathname);
    if (pathname.endsWith("/releases/latest")) {
      return Response.json(RELEASE);
    }
    const asset = /\/releases\/assets\/(\d+)$/.exec(pathname);
    return asset
      ? new Response(`file ${asset[1]}`, { headers: { "Content-Type": "application/octet-stream" } })
      : new Response("Not Found", { status: 404 });
  };
  globalThis.caches = {
    default: {
      async match(request) {
        return cached.get(request.url)?.clone();
      },
      async put(request, response) {
        cached.set(request.url, response);
      },
    },
  };
  try {
    await run(requests);
  } finally {
    globalThis.fetch = saved.fetch;
    globalThis.caches = saved.caches;
  }
}

function githubEnv({ allowDownload = true } = {}) {
  return fakeEnv({
    GITHUB_TOKEN: "test-token",
    DOWNLOAD_LIMITER: { limit: async () => ({ success: allowDownload }) },
  }).env;
}

test("the releases API is public, lists desktop files only, and is cached", async () => {
  await withGitHub(async (requests) => {
    const env = githubEnv();
    const response = await call("https://www.clipspan.com/api/releases", {}, env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=60");
    const body = await response.json();
    assert.equal(body.tag, "v0.23.1");
    assert.deepEqual(
      body.assets.map((asset) => [asset.id, asset.platform]),
      [
        [1, "windows-exe"],
        [2, "windows-msi"],
      ],
    );

    // Another query string still uses the one cache entry.
    const again = await call("https://www.clipspan.com/api/releases?fresh=1", {}, env);
    assert.deepEqual(await again.json(), body);
    assert.deepEqual(requests, ["/repos/JeremyB-py/clipspan/releases/latest"]);
  });
});

test("a listed file downloads without a code", async () => {
  await withGitHub(async () => {
    const response = await call("https://www.clipspan.com/api/download?id=2", {}, githubEnv());
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("Content-Disposition"),
      'attachment; filename="ClipSpan_0.23.1_x64_en-US.msi"',
    );
    assert.equal(await response.text(), "file 2");
  });
});

test("an APK in the release is not served, so Android stays on Google Play's test", async () => {
  await withGitHub(async (requests) => {
    const response = await call("https://www.clipspan.com/api/download?id=3", {}, githubEnv());
    assert.equal(response.status, 404);
    assert.deepEqual(requests, ["/repos/JeremyB-py/clipspan/releases/latest"]);
  });
});

test("downloads are rate limited before GitHub is asked", async () => {
  await withGitHub(async (requests) => {
    const env = githubEnv({ allowDownload: false });
    const response = await call("https://www.clipspan.com/api/download?id=1", {}, env);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "60");
    assert.deepEqual(requests, []);
  });
});
