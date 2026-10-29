import { classifyAsset, githubAsset, githubJson, repoName } from "./github.js";

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

// Keyed by client IP. Limits live in wrangler.toml.
async function rateLimited(request, limiter) {
  const key = request.headers.get("CF-Connecting-IP") || "unknown";
  const { success } = await limiter.limit({ key });
  return !success;
}

function safeFilename(name) {
  return String(name || "download").replace(/[^A-Za-z0-9._+-]/g, "_");
}

// The /downloads listing. Public, so it is cached to keep page views from spending GitHub
// API quota. Download links name asset ids that handleDownload checks against the latest
// release, so for up to this long after a release a cached listing's links can 404.
const RELEASES_MAX_AGE = 60;

async function handleReleases(request, env, ctx) {
  // One cache entry, whatever query string a request adds.
  const cacheKey = new Request(new URL("/api/releases", request.url));
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }

  let release;
  try {
    release = await githubJson(env, `/repos/${repoName(env)}/releases/latest`);
  } catch (error) {
    const status = error.status === 404 ? 404 : 502;
    return json(
      {
        error:
          status === 404
            ? "No GitHub release is published yet."
            : "Could not load the latest release.",
      },
      status,
    );
  }

  const assets = (release.assets || [])
    .map((asset) => {
      const classified = classifyAsset(asset.name);
      if (!classified) {
        return null;
      }
      return {
        id: asset.id,
        name: asset.name,
        size: asset.size,
        platform: classified.platform,
        label: classified.label,
      };
    })
    .filter(Boolean);

  const response = json(
    {
      tag: release.tag_name || "",
      name: release.name || release.tag_name || "Latest release",
      publishedAt: release.published_at || "",
      notes: release.body || "",
      assets,
    },
    200,
    { "Cache-Control": `public, max-age=${RELEASES_MAX_AGE}` },
  );
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

async function handleDownload(request, env) {
  const url = new URL(request.url);
  const id = Number(url.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return json({ error: "Missing download id." }, 400);
  }

  let release;
  try {
    release = await githubJson(env, `/repos/${repoName(env)}/releases/latest`);
  } catch {
    return json({ error: "Could not load the latest release." }, 502);
  }

  const asset = (release.assets || []).find((item) => item.id === id);
  if (!asset || !classifyAsset(asset.name)) {
    return json({ error: "That file is not available." }, 404);
  }

  return streamAsset(env, asset);
}

async function streamAsset(env, asset) {
  let upstream;
  try {
    upstream = await githubAsset(env, asset.id);
  } catch {
    return json({ error: "Could not fetch that file." }, 502);
  }

  if (!upstream.ok || !upstream.body) {
    return json({ error: "GitHub did not return the file." }, 502);
  }

  const headers = new Headers();
  headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/octet-stream");
  headers.set("Content-Disposition", `attachment; filename="${safeFilename(asset.name)}"`);
  headers.set("Cache-Control", "no-store");
  const length = upstream.headers.get("Content-Length");
  if (length) {
    headers.set("Content-Length", length);
  }

  return new Response(upstream.body, { status: 200, headers });
}

// In-app desktop updater (Tauri). Installed apps verify every file against the
// minisign pubkey they ship with. Only updater bundles are served here.
const UPDATES_PREFIX = "/updates/";
const UPDATER_TAG = /^v\d+\.\d+\.\d+[a-z]?$/;
const UPDATER_FILE = /^[A-Za-z0-9._+-]+(\.AppImage|\.msi|-setup\.exe)$/;
const MANIFEST_MAX_AGE = 300;
// Per-IP limits live in wrangler.toml: the manifest is loose (apps check on
// launch), and updater bundles and /downloads files are tight (each one costs
// GitHub API calls and a large download).
const RATE_LIMIT_PERIOD = 60;

async function handleUpdateManifest(request, env, ctx) {
  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }

  let release;
  try {
    release = await githubJson(env, `/repos/${repoName(env)}/releases/latest`);
  } catch {
    return json({ error: "Could not load the latest release." }, 502);
  }
  const asset = (release.assets || []).find((item) => item.name === "latest.json");
  if (!asset) {
    return json({ error: "The latest release has no updater manifest." }, 404);
  }

  let upstream;
  try {
    upstream = await githubAsset(env, asset.id);
  } catch {
    return json({ error: "Could not fetch the updater manifest." }, 502);
  }
  if (!upstream.ok) {
    return json({ error: "GitHub did not return the updater manifest." }, 502);
  }

  // Cached so every app launch does not spend GitHub API quota.
  const response = new Response(await upstream.text(), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${MANIFEST_MAX_AGE}`,
    },
  });
  ctx.waitUntil(cache.put(request, response.clone()));
  return response;
}

// /updates/<tag>/<file>: latest.json names the tag, so a manifest cached just
// before a new release still resolves to its own files.
async function handleUpdateFile(url, env) {
  const [tag, name, ...rest] = url.pathname.slice(UPDATES_PREFIX.length).split("/");
  if (rest.length || !UPDATER_TAG.test(tag || "") || !UPDATER_FILE.test(name || "")) {
    return json({ error: "That file is not available." }, 404);
  }

  let release;
  try {
    release = await githubJson(env, `/repos/${repoName(env)}/releases/tags/${tag}`);
  } catch (error) {
    return error.status === 404
      ? json({ error: "That release does not exist." }, 404)
      : json({ error: "Could not load that release." }, 502);
  }
  const asset = (release.assets || []).find((item) => item.name === name);
  if (!asset) {
    return json({ error: "That file is not available." }, 404);
  }
  return streamAsset(env, asset);
}

function isAptHost(hostname) {
  return hostname === "apt.clipspan.com";
}

function isAptRequest(url) {
  return isAptHost(url.hostname) || url.pathname === "/apt" || url.pathname.startsWith("/apt/");
}

function aptAssetPathname(url) {
  if (isAptHost(url.hostname)) {
    return url.pathname === "/" ? "/apt/" : `/apt${url.pathname}`;
  }
  return url.pathname;
}

function aptAssetRequest(request) {
  const url = new URL(request.url);
  if (!isAptHost(url.hostname)) {
    return request;
  }
  return new Request(new URL(aptAssetPathname(url) + url.search, url.origin), request);
}

async function handleApt(request, env) {
  const upstream = await env.ASSETS.fetch(aptAssetRequest(request));
  const headers = new Headers(upstream.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function methodNotAllowed() {
  return new Response("Method not allowed.\n", {
    status: 405,
    headers: {
      Allow: "GET, HEAD",
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

// Android App Links. com.clipspan.app has an autoVerify intent filter for
// https://www.clipspan.com/pair (pairing QR codes from ClipSpan 0.23.1), and Android only
// lets the app open those links after it reads this statement from www.clipspan.com. The
// check fails on anything but a 200 with application/json, and Android follows no
// redirects, so this route runs before apt and the asset fallthrough on every host.
// The apex clipspan.com redirects to www in the Cloudflare dashboard, which is why the App
// Link host is www.
const ASSET_LINKS_PATH = "/.well-known/assetlinks.json";
const ASSET_LINKS = [
  {
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: "com.clipspan.app",
      // SHA-256 fingerprints of every certificate a release install can be signed with.
      sha256_cert_fingerprints: [
        // Google Play app signing key: Google Play re-signs every install it delivers.
        "D6:EE:3C:09:73:02:EF:A1:98:F4:CB:D9:F9:B8:79:43:46:73:96:1C:7B:24:76:49:0A:67:E6:62:5F:72:0E:3F",
        // Upload key: signs release builds before Google Play re-signs them, so a release
        // APK installed outside Google Play verifies too.
        "A7:AE:6E:E0:74:7F:FC:9F:A3:F1:EF:1C:1E:0B:BD:91:E0:D5:CC:06:49:47:65:2B:6C:45:12:8E:A7:71:29:7B",
      ],
    },
  },
];
const ASSET_LINKS_BODY = JSON.stringify(ASSET_LINKS);
const ASSET_LINKS_LENGTH = String(new TextEncoder().encode(ASSET_LINKS_BODY).byteLength);
const ASSET_LINKS_MAX_AGE = 300;

function handleAssetLinks(request) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed();
  }
  return new Response(request.method === "HEAD" ? null : ASSET_LINKS_BODY, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": ASSET_LINKS_LENGTH,
      "Cache-Control": `public, max-age=${ASSET_LINKS_MAX_AGE}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// /pair is where a camera scan of a pairing QR code lands when ClipSpan isn't installed
// or is older than 0.23.1. The QR code puts the pairing token after the #, which browsers
// never send here, and public/assets/pair.js turns it into a link older apps can paste.
// These headers keep that token on the page: no Referer, no caching, only the site's own
// scripts and styles, no framing, and no-transform so Cloudflare doesn't inject scripts
// (email obfuscation and similar features skip no-transform responses).
const PAIR_PAGE = "/pair";
const PAIR_PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");
const PAIR_PAGE_HEADERS = {
  "Content-Security-Policy": PAIR_PAGE_CSP,
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store, no-transform",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
};

// The paths the asset server answers with pair.html or a redirect to it (/pair, /pair/,
// /pair.html) all come through here, so no copy of the page goes out without
// PAIR_PAGE_HEADERS. Percent-encoding and doubled slashes are undone first in case the asset
// server undoes them too. Returns "page", "redirect", or null.
function pairRoute(pathname) {
  let path = pathname;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    // Malformed escapes: match the raw path.
  }
  path = path.replace(/\/{2,}/g, "/");
  if (path === PAIR_PAGE || path === `${PAIR_PAGE}/`) {
    return "page";
  }
  if (path === `${PAIR_PAGE}.html`) {
    return "redirect";
  }
  return null;
}

async function handlePairPage(request, env, route) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed();
  }
  const url = new URL(request.url);
  if (route === "redirect") {
    // The browser keeps the #fragment across the redirect, since Location has none.
    return new Response(null, {
      status: 307,
      headers: {
        Location: new URL(PAIR_PAGE + url.search, url.origin).href,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  }
  // Always ask for /pair: with html_handling = "auto-trailing-slash" the asset server
  // serves pair.html there and answers /pair/ and /pair.html with a redirect.
  const upstream = await env.ASSETS.fetch(
    new Request(new URL(PAIR_PAGE, url.origin), {
      method: request.method,
      headers: request.headers,
    }),
  );
  const headers = new Headers(upstream.headers);
  for (const [name, value] of Object.entries(PAIR_PAGE_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

const MEDIA_FILE = /^\/assets\/[^/]+\.(mp4|webm)$/;

// Returns { start, end } (inclusive), "unsatisfiable", or null to send the whole file.
function parseByteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) {
    return null;
  }
  if (match[1] === "") {
    const suffix = Number(match[2]);
    return suffix === 0 ? "unsatisfiable" : { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  return start >= size || start > end ? "unsatisfiable" : { start, end };
}

// Static assets answer Range requests with the whole file, and Safari will not
// play a <video> without 206 responses, so video files are sliced here.
async function handleMedia(request, env) {
  const upstream = await env.ASSETS.fetch(request);
  const rangeHeader = request.headers.get("Range");
  if (!rangeHeader || request.method !== "GET" || upstream.status !== 200) {
    const response = new Response(upstream.body, upstream);
    response.headers.set("Accept-Ranges", "bytes");
    return response;
  }

  const body = await upstream.arrayBuffer();
  const size = body.byteLength;
  const range = parseByteRange(rangeHeader, size);
  const headers = new Headers(upstream.headers);
  headers.set("Accept-Ranges", "bytes");
  headers.delete("Content-Encoding");

  if (range === null) {
    headers.set("Content-Length", String(size));
    return new Response(body, { status: 200, headers });
  }
  if (range === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${size}`);
    headers.delete("Content-Length");
    return new Response(null, { status: 416, headers });
  }
  headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
  headers.set("Content-Length", String(range.end - range.start + 1));
  return new Response(body.slice(range.start, range.end + 1), { status: 206, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // First, on every host: Android's App Link check takes nothing but a plain 200.
    if (url.pathname === ASSET_LINKS_PATH) {
      return handleAssetLinks(request);
    }

    // apt.clipspan.com serves only public/apt, so /pair there stays an apt path.
    const pair = isAptHost(url.hostname) ? null : pairRoute(url.pathname);
    if (pair) {
      return handlePairPage(request, env, pair);
    }

    if (url.pathname.startsWith(UPDATES_PREFIX) && request.method === "GET") {
      const isManifest = url.pathname === `${UPDATES_PREFIX}latest.json`;
      const limiter = isManifest ? env.UPDATES_MANIFEST_LIMITER : env.UPDATES_FILE_LIMITER;
      if (await rateLimited(request, limiter)) {
        return json({ error: "Too many update requests. Try again shortly." }, 429, {
          "Retry-After": String(RATE_LIMIT_PERIOD),
        });
      }
      return isManifest ? handleUpdateManifest(request, env, ctx) : handleUpdateFile(url, env);
    }

    if (url.pathname === "/api/releases" && request.method === "GET") {
      return handleReleases(request, env, ctx);
    }

    if (url.pathname === "/api/download" && request.method === "GET") {
      if (await rateLimited(request, env.DOWNLOAD_LIMITER)) {
        return json({ error: "Too many downloads. Try again in a minute." }, 429, {
          "Retry-After": String(RATE_LIMIT_PERIOD),
        });
      }
      return handleDownload(request, env);
    }

    // apt.clipspan.com serves public/apt at the URL root. www /apt is the
    // same tree. GitHub Pages cannot host this: clipspan is a private repo.
    if (isAptRequest(url)) {
      return handleApt(request, env);
    }

    if (MEDIA_FILE.test(url.pathname) && (request.method === "GET" || request.method === "HEAD")) {
      return handleMedia(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};
