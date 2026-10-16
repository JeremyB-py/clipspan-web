export const COOKIE_NAME = "clipspan_dl";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

// TESTER_CODES keys. `code:<hash>` holds the tester's name; `use:<hash>` holds login
// stats in its metadata. Only SHA-256 hashes of codes are stored, never the codes.
export const CODE_PREFIX = "code:";
export const USE_PREFIX = "use:";
// Seconds an edge location may cache a code lookup, so a revoked code stops working
// within about a minute. 60 is KV's default.
const CODE_CACHE_TTL = 60;
const MAX_USE_COUNTRIES = 5;

function encoder() {
  return new TextEncoder();
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    encoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function bytesToB64(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64ToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Testers type codes with or without dashes, in any case.
// scripts/tester-codes.mjs hashes through these same two functions.
export function normalizeCode(code) {
  return String(code || "").trim().toUpperCase().replace(/[\s-]+/g, "");
}

export async function hashCode(code) {
  const digest = await crypto.subtle.digest("SHA-256", encoder().encode(normalizeCode(code)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sessionSecret(env) {
  return String(env.DOWNLOADS_SESSION_KEY || "").trim();
}

export function downloadsConfigured(env) {
  return Boolean(env.TESTER_CODES && sessionSecret(env));
}

async function lookupTester(env, hash) {
  const record = await env.TESTER_CODES.get(`${CODE_PREFIX}${hash}`, {
    type: "json",
    cacheTtl: CODE_CACHE_TTL,
  });
  return record && typeof record.name === "string" ? { name: record.name, hash } : null;
}

export async function testerForCode(env, code) {
  if (!normalizeCode(code)) {
    return null;
  }
  return lookupTester(env, await hashCode(code));
}

// The cookie names the code hash it was issued for, so revoking the code also ends
// sessions that are already open.
export async function signSession(env, hash) {
  const issued = Math.floor(Date.now() / 1000);
  const payload = `t:${hash}:${issued}`;
  const key = await hmacKey(sessionSecret(env));
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder().encode(payload)),
  );
  return `${payload}.${bytesToB64(signature)}`;
}

async function sessionHash(env, token) {
  const secret = sessionSecret(env);
  if (!secret || !token) {
    return "";
  }
  const dot = token.lastIndexOf(".");
  if (dot <= 0) {
    return "";
  }
  const payload = token.slice(0, dot);
  const [kind, hash, issuedRaw] = payload.split(":");
  const issued = Number(issuedRaw);
  if (kind !== "t" || !/^[0-9a-f]{64}$/.test(hash || "") || !Number.isFinite(issued)) {
    return "";
  }
  if (Math.floor(Date.now() / 1000) - issued > COOKIE_MAX_AGE) {
    return "";
  }
  let signature;
  try {
    signature = b64ToBytes(token.slice(dot + 1));
  } catch {
    return "";
  }
  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify("HMAC", key, signature, encoder().encode(payload));
  return valid ? hash : "";
}

export function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) {
      return decodeURIComponent(trimmed.slice(name.length + 1));
    }
  }
  return "";
}

export function readBasicPassword(request) {
  const header = request.headers.get("Authorization") || "";
  const match = /^Basic\s+(\S+)/i.exec(header.trim());
  if (!match) {
    return "";
  }
  let decoded = "";
  try {
    decoded = atob(match[1]);
  } catch {
    return "";
  }
  const colon = decoded.indexOf(":");
  if (colon < 0) {
    return "";
  }
  return decoded.slice(colon + 1);
}

// Keyed by client IP. Limits live in wrangler.toml.
export async function rateLimited(request, limiter) {
  const key = request.headers.get("CF-Connecting-IP") || "unknown";
  const { success } = await limiter.limit({ key });
  return !success;
}

// The tester behind a request: a session cookie first, then the code as the HTTP Basic
// password (curl and the APT install script). Returns { tester, via } on success,
// otherwise { status } with 401, 429 (too many code attempts), or 503 (not set up).
export async function authenticate(request, env) {
  if (!downloadsConfigured(env)) {
    return { status: 503 };
  }
  const hash = await sessionHash(env, readCookie(request, COOKIE_NAME));
  const fromCookie = hash ? await lookupTester(env, hash) : null;
  if (fromCookie) {
    return { tester: fromCookie, via: "cookie" };
  }
  const code = readBasicPassword(request);
  if (!code) {
    return { status: 401 };
  }
  // Each attempt costs a KV read, so guessing is limited like the login form.
  if (await rateLimited(request, env.AUTH_LIMITER)) {
    return { status: 429 };
  }
  const tester = await testerForCode(env, code);
  return tester ? { tester, via: "basic" } : { status: 401 };
}

// Login stats for `scripts/tester-codes.mjs list`. A code used from many countries has
// probably been shared. Stored as metadata so listing needs no per-key reads.
export async function recordUse(env, request, hash) {
  const key = `${USE_PREFIX}${hash}`;
  const { metadata } = await env.TESTER_CODES.getWithMetadata(key);
  const previous = metadata || {};
  const country = request.cf?.country || "unknown";
  const countries = [
    country,
    ...(previous.countries || []).filter((item) => item !== country),
  ].slice(0, MAX_USE_COUNTRIES);
  const usage = {
    logins: (previous.logins || 0) + 1,
    last: new Date().toISOString(),
    countries,
  };
  await env.TESTER_CODES.put(key, JSON.stringify(usage), { metadata: usage });
}

export function sessionCookie(value, requestUrl) {
  const secure = new URL(requestUrl).protocol === "https:";
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${COOKIE_MAX_AGE}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}
