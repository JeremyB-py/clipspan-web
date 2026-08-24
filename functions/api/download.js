import { json } from "../_lib/auth.js";
import { classifyAsset, githubAsset, githubJson, repoName } from "../_lib/github.js";

function safeFilename(name) {
  return String(name || "download").replace(/[^A-Za-z0-9._+-]/g, "_");
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const id = Number(url.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return json({ error: "Missing download id." }, 400);
  }

  let release;
  try {
    release = await githubJson(
      context.env,
      `/repos/${repoName(context.env)}/releases/latest`,
    );
  } catch {
    return json({ error: "Could not load the latest release." }, 502);
  }

  const asset = (release.assets || []).find((item) => item.id === id);
  if (!asset || !classifyAsset(asset.name)) {
    return json({ error: "That file is not available." }, 404);
  }

  let upstream;
  try {
    upstream = await githubAsset(context.env, id);
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
