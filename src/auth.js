export const COOKIE_NAME = "clipspan_dl";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

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

export async function hashesEqual(left, right) {
  const digest = async (value) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder().encode(value)));
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    diff |= (a[i] || 0) ^ (b[i] || 0);
  }
  return diff === 0;
}

export async function signSession(secret) {
  const issued = Math.floor(Date.now() / 1000);
  const payload = `ok:${issued}`;
  const key = await hmacKey(secret);
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder().encode(payload)),
  );
  return `${payload}.${bytesToB64(signature)}`;
}

export async function sessionValid(secret, token) {
  if (!secret || !token) {
    return false;
  }
  const dot = token.lastIndexOf(".");
  if (dot <= 0) {
    return false;
  }
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const [kind, issuedRaw] = payload.split(":");
  const issued = Number(issuedRaw);
  if (kind !== "ok" || !Number.isFinite(issued)) {
    return false;
  }
  if (Math.floor(Date.now() / 1000) - issued > COOKIE_MAX_AGE) {
    return false;
  }
  const key = await hmacKey(secret);
  return crypto.subtle.verify(
    "HMAC",
    key,
    b64ToBytes(signature),
    encoder().encode(payload),
  );
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

export async function isAuthorized(request, env) {
  const secret = String(env.DOWNLOADS_PASSWORD || "").trim();
  if (!secret) {
    return false;
  }
  return sessionValid(secret, readCookie(request, COOKIE_NAME));
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
