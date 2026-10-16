#!/usr/bin/env node
// Local admin page for tester download codes: list, add, and revoke.
//
//   node scripts/tester-admin.mjs [--local] [--port 8790] [--no-open]
//
// Serves only on 127.0.0.1 and changes the live site like tester-codes.mjs (needs
// `npx wrangler login`). API calls must carry the token from the printed URL, so other
// websites open in the same browser can't drive it.
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { TesterError, createStore, namespaceConfigured } from "./lib/tester-store.mjs";

const args = process.argv.slice(2);
const local = args.includes("--local");
const portIndex = args.indexOf("--port");
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 8790;
const MAX_BODY_BYTES = 16 * 1024;

if (!Number.isInteger(port) || port <= 0) {
  console.error("Usage: node scripts/tester-admin.mjs [--local] [--port <n>] [--no-open]");
  process.exit(1);
}
if (!local && !namespaceConfigured()) {
  console.error("Set the TESTER_CODES namespace id in wrangler.toml first (see README).");
  process.exit(1);
}

const store = createStore({ local });
const token = Buffer.from(randomBytes(24).toString("base64url"));
const page = readFileSync(new URL("./tester-admin.html", import.meta.url));
// Rejecting other Host values stops DNS rebinding from reaching the API.
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
  });
  res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}

function tokenMatches(req) {
  const given = Buffer.from(String(req.headers["x-admin-token"] || ""));
  return given.length === token.length && timingSafeEqual(given, token);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new TesterError("Request too large.");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new TesterError("Send JSON.");
  }
}

async function handleApi(req, res, path) {
  // A custom header also forces a CORS preflight, which this server never approves.
  if (!tokenMatches(req)) {
    return send(res, 403, { error: "Open the URL printed in the terminal." });
  }
  if (path === "/api/testers" && req.method === "GET") {
    return send(res, 200, { local, testers: await store.list() });
  }
  if (path === "/api/testers" && req.method === "POST") {
    const body = await readJson(req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const existing = typeof body.code === "string" && body.code.trim() ? body.code : undefined;
    const code = await store.add(name, existing);
    return send(res, 200, { name, code });
  }
  if (path === "/api/testers/revoke" && req.method === "POST") {
    const body = await readJson(req);
    await store.revoke(typeof body.name === "string" ? body.name : "");
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: "Not found." });
}

const server = http.createServer(async (req, res) => {
  if (!allowedHosts.has(req.headers.host || "")) {
    return send(res, 403, "Forbidden.\n", "text/plain; charset=utf-8");
  }
  const path = new URL(req.url, `http://${req.headers.host}`).pathname;
  try {
    if (path === "/" && req.method === "GET") {
      return send(res, 200, page, "text/html; charset=utf-8");
    }
    return await handleApi(req, res, path);
  } catch (error) {
    const status = error instanceof TesterError ? 400 : 502;
    if (status === 502) {
      console.error(error.message);
    }
    return send(res, status, { error: error.message });
  }
});

server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}/#token=${token}`;
  console.log(`Tester codes admin (${local ? "local wrangler dev codes" : "LIVE site codes"}):`);
  console.log(`  ${url}`);
  console.log("Press Ctrl-C to stop.");
  if (!args.includes("--no-open")) {
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    spawn(opener, [url], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
  }
});
