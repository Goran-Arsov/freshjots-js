// CLI tests. parseArgs is pure so we assert its return shape directly.
// run() is exercised with a stubbed client + captured stdout/stderr;
// the for-await stdin reader is fed by Readable.from() so piped-input
// paths are covered without touching real stdio.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Readable } from "node:stream";
import { ApiError, VERSION } from "../index.js";
import { parseArgs, run } from "../cli.js";

function harness({ token = "mn_test", stdin } = {}) {
  const out = [];
  const err = [];
  const calls = [];
  const fakeClient = {
    notes: async () => { calls.push(["notes"]); return [{ filename: "a", title: "Alpha" }, { filename: "b", title: "Beta" }]; },
    note: async (filename) => { calls.push(["note", filename]); return { filename, title: "T", plain_body: "hello world" }; },
    create: async (input) => { calls.push(["create", input]); return { id: 1, filename: "derived-slug", title: input.title, plain_body: input.body ?? "" }; },
    append: async (filename, text) => { calls.push(["append", filename, text]); return true; },
  };
  const deps = {
    env: { FRESHJOTS_TOKEN: token },
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    stdin: stdin ?? { isTTY: true },
    clientFactory: () => fakeClient,
  };
  return { deps, out: () => out.join(""), err: () => err.join(""), calls };
}

// --- parseArgs --------------------------------------------------------------

test("parseArgs: no args -> help with exit 2", () => {
  assert.deepEqual(parseArgs([]), { command: "help", exitCode: 2 });
});

test("parseArgs: --help / -h / help -> help with exit 0", () => {
  for (const a of ["--help", "-h", "help"]) {
    assert.deepEqual(parseArgs([a]), { command: "help", exitCode: 0 });
  }
});

test("parseArgs: --version / -v / version", () => {
  for (const a of ["--version", "-v", "version"]) {
    assert.deepEqual(parseArgs([a]), { command: "version" });
  }
});

test("parseArgs: list takes no positional", () => {
  assert.deepEqual(parseArgs(["list"]), { command: "list" });
  assert.equal(parseArgs(["list", "extra"]).command, "error");
});

test("parseArgs: show requires exactly one filename", () => {
  assert.deepEqual(parseArgs(["show", "log"]), { command: "show", filename: "log" });
  assert.equal(parseArgs(["show"]).command, "error");
  assert.equal(parseArgs(["show", "a", "b"]).command, "error");
});

test("parseArgs: create accepts title with --body, -b, --body=value", () => {
  assert.deepEqual(parseArgs(["create", "Title"]), { command: "create", title: "Title", body: undefined });
  assert.deepEqual(parseArgs(["create", "Title", "--body", "x"]), { command: "create", title: "Title", body: "x" });
  assert.deepEqual(parseArgs(["create", "Title", "-b", "x"]), { command: "create", title: "Title", body: "x" });
  assert.deepEqual(parseArgs(["create", "Title", "--body=x"]), { command: "create", title: "Title", body: "x" });
  assert.equal(parseArgs(["create"]).command, "error");
  assert.equal(parseArgs(["create", "Title", "--body"]).command, "error");
});

test("parseArgs: append accepts filename + optional text", () => {
  assert.deepEqual(parseArgs(["append", "log"]), { command: "append", filename: "log", text: undefined });
  assert.deepEqual(parseArgs(["append", "log", "hi"]), { command: "append", filename: "log", text: "hi" });
  assert.equal(parseArgs(["append"]).command, "error");
  assert.equal(parseArgs(["append", "a", "b", "c"]).command, "error");
});

test("parseArgs: unknown command yields error", () => {
  const r = parseArgs(["sing"]);
  assert.equal(r.command, "error");
  assert.match(r.message, /unknown command/);
});

// --- run --------------------------------------------------------------------

test("run: no args writes usage to stderr and returns 2", async () => {
  const h = harness();
  const code = await run([], h.deps);
  assert.equal(code, 2);
  assert.match(h.err(), /Usage:/);
  assert.equal(h.out(), "");
});

test("run: --help writes usage to stdout and returns 0", async () => {
  const h = harness();
  const code = await run(["--help"], h.deps);
  assert.equal(code, 0);
  assert.match(h.out(), /Usage:/);
});

test("run: --version prints `freshjots <VERSION>`", async () => {
  const h = harness();
  const code = await run(["--version"], h.deps);
  assert.equal(code, 0);
  assert.equal(h.out(), `freshjots ${VERSION}\n`);
});

test("run: missing FRESHJOTS_TOKEN errors with code 1", async () => {
  const h = harness({ token: null }); // null bypasses harness's default-arg fallback
  const code = await run(["list"], h.deps);
  assert.equal(code, 1);
  assert.match(h.err(), /FRESHJOTS_TOKEN is not set/);
});

test("run: list prints `filename\\ttitle` per row", async () => {
  const h = harness();
  const code = await run(["list"], h.deps);
  assert.equal(code, 0);
  assert.equal(h.out(), "a\tAlpha\nb\tBeta\n");
  assert.deepEqual(h.calls[0], ["notes"]);
});

test("run: show prints plain_body verbatim", async () => {
  const h = harness();
  const code = await run(["show", "log"], h.deps);
  assert.equal(code, 0);
  assert.equal(h.out(), "hello world");
  assert.deepEqual(h.calls[0], ["note", "log"]);
});

test("run: create with --body forwards title+body and prints derived filename", async () => {
  const h = harness();
  const code = await run(["create", "My Title", "--body", "first line"], h.deps);
  assert.equal(code, 0);
  assert.equal(h.out(), "derived-slug\n");
  assert.deepEqual(h.calls[0], ["create", { title: "My Title", body: "first line" }]);
});

test("run: create reads body from stdin when --body is omitted", async () => {
  const h = harness({ stdin: Readable.from(["piped ", "body"]) });
  const code = await run(["create", "Piped"], h.deps);
  assert.equal(code, 0);
  assert.deepEqual(h.calls[0], ["create", { title: "Piped", body: "piped body" }]);
});

test("run: append with text arg forwards verbatim", async () => {
  const h = harness();
  const code = await run(["append", "log", "shipped"], h.deps);
  assert.equal(code, 0);
  assert.deepEqual(h.calls[0], ["append", "log", "shipped"]);
});

test("run: append reads text from stdin when arg omitted", async () => {
  const h = harness({ stdin: Readable.from(["from-pipe"]) });
  const code = await run(["append", "log"], h.deps);
  assert.equal(code, 0);
  assert.deepEqual(h.calls[0], ["append", "log", "from-pipe"]);
});

test("run: append with no arg and no stdin returns 2", async () => {
  const h = harness();
  const code = await run(["append", "log"], h.deps);
  assert.equal(code, 2);
  assert.match(h.err(), /append requires text/);
  assert.equal(h.calls.length, 0);
});

test("run: ApiError from client is formatted with status + code + message", async () => {
  const h = harness();
  h.deps.clientFactory = () => ({
    notes: async () => { throw new ApiError({ status: 422, code: "cap_exceeded", message: "over" }); },
  });
  const code = await run(["list"], h.deps);
  assert.equal(code, 1);
  assert.match(h.err(), /HTTP 422 cap_exceeded: over/);
});

test("run: unknown command returns 2 with usage", async () => {
  const h = harness();
  const code = await run(["sing"], h.deps);
  assert.equal(code, 2);
  assert.match(h.err(), /unknown command: sing/);
  assert.match(h.err(), /Usage:/);
});
