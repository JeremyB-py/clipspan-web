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

    return json({ error: "Not found." }, 404);
  },
};
