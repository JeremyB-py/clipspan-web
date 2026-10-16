#!/usr/bin/env node
// Manage per-tester download codes in the TESTER_CODES KV namespace (see README).
// scripts/tester-admin.mjs does the same from a local web page.
//
//   node scripts/tester-codes.mjs add <name>          create a code and print it once
//   node scripts/tester-codes.mjs add <name> --stdin  store a code read from stdin
//   node scripts/tester-codes.mjs list                who has a code, and how it is used
//   node scripts/tester-codes.mjs revoke <name>       stop that code working
//
// Commands change the live site and need `npx wrangler login`. Add --local to manage
// the codes `npx wrangler dev` uses instead.
import { readFileSync } from "node:fs";
import { createStore, namespaceConfigured } from "./lib/tester-store.mjs";

const args = process.argv.slice(2);
const local = args.includes("--local");
const [command, name] = args.filter((arg) => !arg.startsWith("--"));
const store = createStore({ local });

function printTable(rows) {
  const columns = Object.keys(rows[0]);
  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => String(row[column]).length)),
  );
  const line = (cells) =>
    cells.map((cell, i) => String(cell).padEnd(widths[i])).join("  ").trimEnd();
  console.log(line(columns));
  for (const row of rows) {
    console.log(line(columns.map((column) => row[column])));
  }
}

async function add() {
  const fromStdin = args.includes("--stdin");
  const code = await store.add(name, fromStdin ? readFileSync(0, "utf8") : undefined);
  if (code) {
    console.log(`Code for ${name}: ${code}`);
    console.log("This is the only time it is shown. Only its hash is stored.");
  } else {
    console.log(`Added the code for ${name}.`);
  }
}

async function list() {
  const rows = (await store.list()).map((tester) => ({
    name: tester.name,
    created: tester.created.slice(0, 10),
    logins: tester.logins,
    "last login (UTC)": tester.lastLogin
      ? tester.lastLogin.slice(0, 16).replace("T", " ")
      : "never",
    countries: tester.countries.join(" "),
  }));
  if (!rows.length) {
    console.log("No tester codes yet.");
    return;
  }
  printTable(rows);
}

async function revoke() {
  await store.revoke(name);
  console.log(`Revoked ${name}. The code and any open sessions stop working within about a minute.`);
}

const commands = { add, list, revoke };
if (!commands[command]) {
  console.error("Usage: node scripts/tester-codes.mjs <add|list|revoke> [name] [--stdin] [--local]");
  process.exit(1);
}
if (!local && !namespaceConfigured()) {
  console.error("Set the TESTER_CODES namespace id in wrangler.toml first (see README).");
  process.exit(1);
}
try {
  await commands[command]();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
