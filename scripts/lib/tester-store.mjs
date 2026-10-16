// TESTER_CODES access through wrangler, shared by tester-codes.mjs (CLI) and
// tester-admin.mjs (local web page).
import { execFile } from "node:child_process";
import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CODE_PREFIX, USE_PREFIX, hashCode, normalizeCode } from "../../src/auth.js";

const BINDING = "TESTER_CODES";
// No 0/O, 1/I/L, or U, so codes survive being read aloud and retyped.
const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
// Four groups of four: about 78 bits, far beyond guessing at 10 tries a minute.
const GROUPS = 4;
const GROUP_LENGTH = 4;
const NAME_PATTERN = /^[\w .@+-]{1,64}$/;
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

// Messages meant for the person running the tool, as opposed to wrangler failures.
export class TesterError extends Error {}

export function namespaceConfigured() {
  const config = readFileSync(new URL("../../wrangler.toml", import.meta.url), "utf8");
  return !config.includes("REPLACE_WITH_");
}

function generateCode() {
  const groups = [];
  for (let g = 0; g < GROUPS; g += 1) {
    let group = "";
    for (let i = 0; i < GROUP_LENGTH; i += 1) {
      group += ALPHABET[randomInt(ALPHABET.length)];
    }
    groups.push(group);
  }
  return groups.join("-");
}

export function createStore({ local }) {
  function wrangler(...args) {
    return new Promise((resolve, reject) => {
      execFile(
        "npx",
        ["wrangler", ...args, "--binding", BINDING, local ? "--local" : "--remote"],
        { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          // wrangler warns about wrangler.toml on every call; its output matters only on failure.
          if (error) {
            const detail = stderr.replace(/\x1b\[[0-9;]*m/g, "").trim();
            reject(new Error(`wrangler ${args.slice(0, 3).join(" ")} failed.\n${detail}`));
          } else {
            resolve(stdout);
          }
        },
      );
    });
  }

  async function listKeys(prefix) {
    return JSON.parse(await wrangler("kv", "key", "list", "--prefix", prefix));
  }

  async function codes() {
    return (await listKeys(CODE_PREFIX)).map((key) => ({
      hash: key.name.slice(CODE_PREFIX.length),
      name: key.metadata?.name ?? "?",
      created: key.metadata?.created ?? "",
    }));
  }

  // One row per tester, sorted by name, with login stats from the Worker.
  async function list() {
    const [codeKeys, useKeys] = await Promise.all([codes(), listKeys(USE_PREFIX)]);
    const usage = new Map(
      useKeys.map((key) => [key.name.slice(USE_PREFIX.length), key.metadata || {}]),
    );
    return codeKeys
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((tester) => {
        const use = usage.get(tester.hash) || {};
        return {
          name: tester.name,
          created: tester.created,
          logins: use.logins ?? 0,
          lastLogin: use.last ?? null,
          countries: use.countries ?? [],
        };
      });
  }

  // Generates a code unless `existingCode` is given. Returns the new code, which is
  // never stored and can't be shown again, or null for an existing code.
  async function add(name, existingCode) {
    if (!NAME_PATTERN.test(name || "")) {
      throw new TesterError("A name is 1-64 letters, digits, spaces, or . @ + - _");
    }
    const code = existingCode ? existingCode.trim() : generateCode();
    if (!normalizeCode(code)) {
      throw new TesterError("The code is empty.");
    }
    const hash = await hashCode(code);
    const existing = await codes();
    if (existing.some((tester) => tester.name === name)) {
      throw new TesterError(`${name} already has a code. Revoke it first to issue a new one.`);
    }
    if (existing.some((tester) => tester.hash === hash)) {
      throw new TesterError("That code already belongs to someone else.");
    }
    const record = JSON.stringify({ name, created: new Date().toISOString() });
    await wrangler("kv", "key", "put", `${CODE_PREFIX}${hash}`, record, "--metadata", record);
    return existingCode ? null : code;
  }

  async function revoke(name) {
    const matches = (await codes()).filter((tester) => tester.name === name);
    if (!matches.length) {
      throw new TesterError(`No code for ${name || "that name"}.`);
    }
    // One at a time: wrangler's local storage fails concurrent writes. Deleting the code
    // is the revocation; leftover stats are never listed, so their delete can fail.
    for (const { hash } of matches) {
      await wrangler("kv", "key", "delete", `${CODE_PREFIX}${hash}`);
      await wrangler("kv", "key", "delete", `${USE_PREFIX}${hash}`).catch(() => {});
    }
  }

  return { list, add, revoke };
}
