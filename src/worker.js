import {
  hashesEqual,
  isAuthorized,
  json,
  sessionCookie,
  signSession,
} from "./auth.js";
import { classifyAsset, githubAsset, githubJson, repoName } from "./github.js";

function safeFilename(name) {
  return String(name || "download").replace(/[^A-Za-z0-9._+-]/g, "_");
}

async function handleAuth(request, env) {
  const expected = String(env.DOWNLOADS_PASSWORD || "").trim();
  if (!expected) {
    return json({ error: "Downloads are not configured yet." }, 503);
  }

  let password = "";
  try {
    const body = await request.json();
    password = typeof body.password === "string" ? body.password.trim() : "";
  } catch {
    return json({ error: "Send the password as JSON." }, 400);
  }

  if (!(await hashesEqual(password, expected))) {
    return json({ error: "That password is not correct." }, 401);
  }

  const token = await signSession(expected);
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token, request.url) });
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

  let upstream;
  try {
    upstream = await githubAsset(env, id);
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
  return new Response("Tester password required.\n", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="ClipSpan testers"',
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

async function handleApt(request, env) {
  const pathname = aptAssetPathname(new URL(request.url));
  if (!aptPathIsPublic(pathname)) {
    if (!String(env.DOWNLOADS_PASSWORD || "").trim()) {
      return new Response("Downloads are not configured yet.\n", {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
    }
    if (!(await isAuthorized(request, env))) {
      return aptUnauthorized(request);
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
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/auth" && request.method === "POST") {
      return handleAuth(request, env);
    }

    if (url.pathname === "/api/releases" && request.method === "GET") {
      if (!(await isAuthorized(request, env))) {
        return json({ error: "Sign in with the tester password." }, 401);
      }
      return handleReleases(env);
    }

    if (url.pathname === "/api/download" && request.method === "GET") {
      if (!(await isAuthorized(request, env))) {
        return json({ error: "Sign in with the tester password." }, 401);
      }
      return handleDownload(request, env);
    }

    // apt.clipspan.com serves public/apt at the URL root. www /apt is the
    // same tree. GitHub Pages cannot host this: clipspan is a private repo.
    if (isAptRequest(url)) {
      return handleApt(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};
