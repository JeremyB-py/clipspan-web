// The /pair page. Pairing QR codes from ClipSpan 0.23.1 hold
//
//   https://www.clipspan.com/pair#v=1&h=<host>&p=<port>&t=<token>&f=<pin>
//
// With ClipSpan installed, Android opens that link in the app (an App Link, verified
// through /.well-known/assetlinks.json). Without the app, or with one older than 0.23.1,
// the camera opens this page instead.
//
// Everything after # stays on the phone: browsers don't send it to any server, and this
// script makes no network requests. When it holds a valid pairing code, the page shows the
// link older apps take under "Can't scan? Enter the pairing link", then drops the code from
// the address bar and history.
//
// parsePairFragment and legacyPairLink are pure, so test/pair.test.js imports them in Node.

const MAX_FRAGMENT = 1024;
const MAX_HOST = 253;
const IPV4_OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`^${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}$`);
const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
// URL parsers read a name whose last label is a number as an IPv4 address ("10.0.0.300"
// fails, "pc.0x1f" turns into another address), so names like that must be real IPv4.
const NUMBER_LABEL = /^(?:\d+|0x[0-9a-f]*)$/i;
const PORT = /^[1-9]\d{0,4}$/;
const MAX_PORT = 65535;
const TOKEN = /^[A-Za-z0-9_-]{4,128}$/;
// The desktop's TLS pin as it writes it, the only form ClipSpan accepts.
const PIN = /^[a-z2-7]{26}$/;
const FIELDS = new Set(["v", "h", "p", "t", "f"]);

// A LAN IPv4 address or a DNS name. No IPv6, ports, paths, or user info, and no loopback or
// localhost: any app on the phone can listen there.
export function validHost(host) {
  if (typeof host !== "string" || host.length === 0 || host.length > MAX_HOST) {
    return false;
  }
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) {
    return false;
  }
  if (IPV4.test(host)) {
    const first = Number(host.split(".")[0]);
    return first !== 127 && first !== 0;
  }
  const labels = host.split(".");
  const last = labels[labels.length - 1];
  return labels.every((label) => HOST_LABEL.test(label)) && !NUMBER_LABEL.test(last);
}

// location.hash (with or without the leading #) to { host, port, token, pin }, or null
// when it isn't a valid version 1 pairing code. Values are matched as written, without
// percent-decoding: valid ones never need escaping. Unknown fields are ignored so later
// QR codes can add some, but a repeated field fails.
export function parsePairFragment(hash) {
  if (typeof hash !== "string") {
    return null;
  }
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw || raw.length > MAX_FRAGMENT) {
    return null;
  }

  const fields = new Map();
  for (const part of raw.split("&")) {
    const eq = part.indexOf("=");
    if (eq <= 0) {
      return null;
    }
    const key = part.slice(0, eq);
    if (!FIELDS.has(key)) {
      continue;
    }
    if (fields.has(key)) {
      return null;
    }
    fields.set(key, part.slice(eq + 1));
  }

  const value = (key) => fields.get(key) ?? "";
  const host = value("h");
  const port = value("p");
  const token = value("t");
  const pin = value("f");
  if (
    value("v") !== "1" ||
    !validHost(host) ||
    !PORT.test(port) ||
    Number(port) > MAX_PORT ||
    !TOKEN.test(token) ||
    !PIN.test(pin)
  ) {
    return null;
  }
  return { host, port: Number(port), token, pin };
}

// The pairing link ClipSpan apps before 0.23.1 accept: the desktop's own address.
export function legacyPairLink({ host, port, token, pin }) {
  return `https://${host}:${port}/p?t=${token}&f=${pin}`;
}

async function copyText(input) {
  try {
    await navigator.clipboard.writeText(input.value);
    return true;
  } catch {
    // No Clipboard API (or it was refused): copy the selection the old way.
    input.focus();
    input.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    }
  }
}

function showOlderAppLink(pairing) {
  const section = document.getElementById("older-app");
  const input = document.getElementById("pair-link");
  const button = document.getElementById("copy-link");
  const status = document.getElementById("copy-status");

  input.value = legacyPairLink(pairing);
  section.hidden = false;
  input.addEventListener("focus", () => input.select());
  button.addEventListener("click", async () => {
    const copied = await copyText(input);
    status.dataset.state = copied ? "ok" : "err";
    status.textContent = copied ? "Copied." : "Couldn't copy. Select the link and copy it.";
  });
}

function showPage() {
  const year = document.getElementById("year");
  if (year) {
    year.textContent = String(new Date().getFullYear());
  }

  const hash = location.hash;
  const pairing = parsePairFragment(hash);
  if (pairing) {
    showOlderAppLink(pairing);
  }
  if (hash) {
    // The code now lives only in the field above, not in the address bar or history.
    history.replaceState(null, "", location.pathname);
  }
}

if (typeof document !== "undefined") {
  showPage();
}
