// Runs public/assets/pair.js against a tiny fake DOM: what the page shows for a pairing
// fragment, and that it drops the fragment from the address bar.
import assert from "node:assert/strict";
import { test } from "node:test";

const TOKEN = "Zm9vYmFyX2Jhei1xdXV4LTEyMw";
const PIN = "mfrggzdfmztwq2lknnwg23tpoa";

function fakeElement() {
  const listeners = {};
  return {
    hidden: true,
    value: "",
    textContent: "",
    dataset: {},
    listeners,
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
    focus() {},
    select() {
      this.selected = true;
    },
    // pair.js must only ever set .value and .textContent.
    set innerHTML(_) {
      throw new Error("innerHTML must not be used");
    },
  };
}

let loads = 0;

async function loadPage(hash, clipboard) {
  const elements = Object.fromEntries(
    ["year", "older-app", "pair-link", "copy-link", "copy-status"].map((id) => [id, fakeElement()]),
  );
  const replaced = [];
  const execCommands = [];
  const globals = {
    document: {
      getElementById: (id) => elements[id] ?? null,
      execCommand: (command) => {
        execCommands.push(command);
        return true;
      },
    },
    location: { hash, pathname: "/pair" },
    history: { replaceState: (...args) => replaced.push(args) },
    navigator: { clipboard },
  };
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  try {
    loads += 1;
    await import(`../public/assets/pair.js?load=${loads}`);
  } finally {
    for (const name of Object.keys(globals)) {
      delete globalThis[name];
    }
  }
  return { elements, replaced, execCommands, globals };
}

const VALID_HASH = `#v=1&h=192.168.1.20&p=47321&t=${TOKEN}&f=${PIN}`;
const LINK = `https://192.168.1.20:47321/p?t=${TOKEN}&f=${PIN}`;

test("a valid fragment shows the older-app link and is dropped from the URL", async () => {
  const { elements, replaced } = await loadPage(VALID_HASH);
  assert.equal(elements["older-app"].hidden, false);
  assert.equal(elements["pair-link"].value, LINK);
  assert.deepEqual(replaced, [[null, "", "/pair"]]);
  assert.match(elements.year.textContent, /^\d{4}$/);
});

test("an invalid fragment shows only the general instructions, and is dropped too", async () => {
  const { elements, replaced } = await loadPage("#v=2&h=evil.com/x&p=0&t=a&f=b");
  assert.equal(elements["older-app"].hidden, true);
  assert.equal(elements["pair-link"].value, "");
  assert.deepEqual(replaced, [[null, "", "/pair"]]);
});

test("no fragment leaves the URL alone", async () => {
  const { elements, replaced } = await loadPage("");
  assert.equal(elements["older-app"].hidden, true);
  assert.deepEqual(replaced, []);
});

test("Copy uses the Clipboard API", async () => {
  const written = [];
  const clipboard = { writeText: async (text) => written.push(text) };
  const { elements, globals } = await loadPage(VALID_HASH, clipboard);
  globalThis.navigator = globals.navigator;
  try {
    await elements["copy-link"].listeners.click();
  } finally {
    delete globalThis.navigator;
  }
  assert.deepEqual(written, [LINK]);
  assert.equal(elements["copy-status"].dataset.state, "ok");
  assert.equal(elements["copy-status"].textContent, "Copied.");
});

test("Copy falls back to selecting the link when the Clipboard API fails", async () => {
  const clipboard = {
    writeText: async () => {
      throw new Error("denied");
    },
  };
  const { elements, globals, execCommands } = await loadPage(VALID_HASH, clipboard);
  Object.assign(globalThis, { navigator: globals.navigator, document: globals.document });
  try {
    await elements["copy-link"].listeners.click();
  } finally {
    delete globalThis.navigator;
    delete globalThis.document;
  }
  assert.equal(elements["pair-link"].selected, true);
  assert.deepEqual(execCommands, ["copy"]);
  assert.equal(elements["copy-status"].dataset.state, "ok");
});
