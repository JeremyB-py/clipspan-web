import {
  authenticate,
  downloadsConfigured,
  json,
  rateLimited,
  recordUse,
  sessionCookie,
  signSession,
  testerForCode,
} from "./auth.js";
import { classifyAsset, githubAsset, githubJson, repoName } from "./github.js";

function safeFilename(name) {
  return String(name || "download").replace(/[^A-Za-z0-9._+-]/g, "_");
}

function trackUse(env, request, ctx, hash) {
  // Stats only: a failed write must not block the download.
  ctx.waitUntil(recordUse(env, request, hash).catch(() => {}));
}

function tooManyAttempts() {
  return json({ error: "Too many attempts. Try again in a minute." }, 429, {
    "Retry-After": String(RATE_LIMIT_PERIOD),
  });
}

async function handleAuth(request, env, ctx) {
  if (!downloadsConfigured(env)) {
    return json({ error: "Downloads are not configured yet." }, 503);
  }
  if (await rateLimited(request, env.AUTH_LIMITER)) {
    return tooManyAttempts();
  }

  let code = "";
  try {
    const body = await request.json();
    code = typeof body.code === "string" ? body.code : "";
  } catch {
    return json({ error: "Send the code as JSON." }, 400);
  }

  const tester = await testerForCode(env, code);
  if (!tester) {
    return json({ error: "That code is not correct." }, 401);
  }

  trackUse(env, request, ctx, tester.hash);
  const token = await signSession(env, tester.hash);
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token, request.url) });
}

// Gate for the JSON routes. Returns the response to send, or null when allowed.
async function denyApi(request, env, ctx) {
  const auth = await authenticate(request, env);
  if (auth.tester) {
    if (auth.via === "basic") {
      trackUse(env, request, ctx, auth.tester.hash);
    }
    return null;
  }
  if (auth.status === 503) {
    return json({ error: "Downloads are not configured yet." }, 503);
  }
  if (auth.status === 429) {
    return tooManyAttempts();
  }
  return json({ error: "Enter your tester code." }, 401);
}

async function handleReleases(env) {
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

  return json({
    tag: release.tag_name || "",
    name: release.name || release.tag_name || "Latest release",
    publishedAt: release.published_at || "",
    notes: release.body || "",
    assets,
  });
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

// In-app desktop updater (Tauri). Public on purpose: installed apps cannot
// sign in, and the app verifies every file against the minisign pubkey it
// ships with. Only updater bundles are served; APKs, .debs, and the
// /downloads listing stay behind the tester password.
const UPDATES_PREFIX = "/updates/";
const UPDATER_TAG = /^v\d+\.\d+\.\d+[a-z]?$/;
const UPDATER_FILE = /^[A-Za-z0-9._+-]+(\.AppImage|\.msi|-setup\.exe)$/;
const MANIFEST_MAX_AGE = 300;
// Per-IP limits live in wrangler.toml: the manifest is loose (apps check on
// launch), bundles are tight (each one costs a GitHub API call and a large
// download), and tester code attempts are tight (each one costs a KV read).
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

function wantsHtml(request) {
  if (request.headers.get("Sec-Fetch-Mode") === "navigate") {
    return true;
  }
  const accept = request.headers.get("Accept") || "";
  return accept.includes("text/html") && !accept.trim().startsWith("*/*");
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

function aptPathIsPublic(pathname) {
  return (
    pathname === "/apt/clipspan.asc" ||
    pathname === "/apt/clipspan.gpg" ||
    pathname.startsWith("/apt/dists/") ||
    pathname.startsWith("/apt/pool/")
  );
}

function aptUnauthorized(request) {
  if (request.method === "GET" && wantsHtml(request)) {
    const url = new URL(request.url);
    const downloads = isAptHost(url.hostname)
      ? "https://www.clipspan.com/downloads"
      : new URL("/downloads", request.url);
    return Response.redirect(downloads, 302);
  }
  return new Response("Tester code required.\n", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="ClipSpan testers"',
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

function aptText(body, status, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      ...extraHeaders,
    },
  });
}

async function handleApt(request, env, ctx) {
  const pathname = aptAssetPathname(new URL(request.url));
  if (!aptPathIsPublic(pathname)) {
    const auth = await authenticate(request, env);
    if (auth.status === 503) {
      return aptText("Downloads are not configured yet.\n", 503);
    }
    if (auth.status === 429) {
      return aptText("Too many attempts. Try again in a minute.\n", 429, {
        "Retry-After": String(RATE_LIMIT_PERIOD),
      });
    }
    if (!auth.tester) {
      return aptUnauthorized(request);
    }
    if (auth.via === "basic") {
      trackUse(env, request, ctx, auth.tester.hash);
    }
  }
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

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

    if (url.pathname === "/api/auth" && request.method === "POST") {
      return handleAuth(request, env, ctx);
    }

    if (url.pathname === "/api/releases" && request.method === "GET") {
      return (await denyApi(request, env, ctx)) || handleReleases(env);
    }

    if (url.pathname === "/api/download" && request.method === "GET") {
      return (await denyApi(request, env, ctx)) || handleDownload(request, env);
    }

    // apt.clipspan.com serves public/apt at the URL root. www /apt is the
    // same tree. GitHub Pages cannot host this: clipspan is a private repo.
    if (isAptRequest(url)) {
      return handleApt(request, env, ctx);
    }

    return env.ASSETS.fetch(request);
  },
};
