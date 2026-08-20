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
    notes: async (opts) => { calls.push(["notes", opts]); return [{ id: 1, filename: "a", title: "Alpha" }, { id: 2, filename: "b", title: "Beta" }]; },
    note: async (filename) => { calls.push(["note", filename]); return { id: 7, filename, title: "T", plain_body: "hello world" }; },
    noteById: async (id) => { calls.push(["noteById", id]); return { id, filename: "byid", title: "T", plain_body: "by id body" }; },
    create: async (input) => { calls.push(["create", input]); return { id: 1, filename: "derived-slug", title: input.title, plain_body: input.body ?? "" }; },
    append: async (filename, text) => { calls.push(["append", filename, text]); return true; },
    remove: async (id) => { calls.push(["remove", id]); return true; },
    move: async (id, folderId) => { calls.push(["move", id, folderId]); return { id, folder_id: folderId }; },
    folders: async () => { calls.push(["folders"]); return [{ id: 3, name: "Work" }, { id: 4, name: "Archive" }]; },
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

test("parseArgs: list/ls default shape", () => {
  const want = { command: "list", limit: null, sort: null, folder: null, all: false, long: false };
  assert.deepEqual(parseArgs(["list"]), want);
  assert.deepEqual(parseArgs(["ls"]), want);
});

test("parseArgs: list parses flags", () => {
  assert.deepEqual(parseArgs(["ls", "-n", "5", "--sort", "created", "--folder", "Work", "--all", "-l"]), {
    command: "list", limit: "5", sort: "created", folder: "Work", all: true, long: true,
  });
  assert.equal(parseArgs(["ls", "--root"]).folder, "none");
  assert.equal(parseArgs(["ls", "--limit"]).command, "error");
  assert.equal(parseArgs(["ls", "--bogus"]).command, "error");
});

test("parseArgs: get requires exactly one id", () => {
  assert.deepEqual(parseArgs(["get", "42"]), { command: "get", id: "42" });
  assert.equal(parseArgs(["get"]).command, "error");
});

test("parseArgs: show/cat take one id-or-filename as target", () => {
  assert.deepEqual(parseArgs(["show", "log"]), { command: "show", target: "log", decrypt: false });
  assert.deepEqual(parseArgs(["cat", "42"]), { command: "show", target: "42", decrypt: false });
  assert.equal(parseArgs(["show"]).command, "error");
  assert.equal(parseArgs(["cat", "a", "b"]).command, "error");
});

test("parseArgs: create accepts title with --body, -b, --body=value", () => {
  assert.deepEqual(parseArgs(["create", "Title"]), { command: "create", title: "Title", body: undefined, encrypt: false });
  assert.deepEqual(parseArgs(["create", "Title", "--body", "x"]), { command: "create", title: "Title", body: "x", encrypt: false });
  assert.deepEqual(parseArgs(["create", "Title", "-b", "x"]), { command: "create", title: "Title", body: "x", encrypt: false });
  assert.deepEqual(parseArgs(["create", "Title", "--body=x"]), { command: "create", title: "Title", body: "x", encrypt: false });
  assert.equal(parseArgs(["create"]).command, "error");
  assert.equal(parseArgs(["create", "Title", "--body"]).command, "error");
});

test("parseArgs: append accepts filename + optional text", () => {
  assert.deepEqual(parseArgs(["append", "log"]), { command: "append", filename: "log", text: undefined, encrypt: false });
  assert.deepEqual(parseArgs(["append", "log", "hi"]), { command: "append", filename: "log", text: "hi", encrypt: false });
  assert.equal(parseArgs(["append"]).command, "error");
  assert.equal(parseArgs(["append", "a", "b", "c"]).command, "error");
});

test("parseArgs: rm/delete take one id-or-filename target", () => {
  assert.deepEqual(parseArgs(["rm", "x"]), { command: "rm", target: "x" });
  assert.deepEqual(parseArgs(["delete", "42"]), { command: "rm", target: "42" });
  assert.equal(parseArgs(["rm"]).command, "error");
});

test("parseArgs: mv/move take a target and a destination", () => {
  assert.deepEqual(parseArgs(["mv", "x", "Work"]), { command: "mv", target: "x", dest: "Work" });
  assert.deepEqual(parseArgs(["move", "42", "--root"]), { command: "mv", target: "42", dest: "--root" });
  assert.equal(parseArgs(["mv", "x"]).command, "error");
});

test("parseArgs: folders takes no arguments", () => {
  assert.deepEqual(parseArgs(["folders"]), { command: "folders" });
  assert.equal(parseArgs(["folders", "x"]).command, "error");
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

test("run: list prints `id\\tfilename\\ttitle` per row", async () => {
  const h = harness();
  const code = await run(["list"], h.deps);
  assert.equal(code, 0);
  assert.equal(h.out(), "1\ta\tAlpha\n2\tb\tBeta\n");
  assert.deepEqual(h.calls[0], ["notes", { sort: null, folderId: undefined, limit: undefined }]);
});

test("run: list forwards sort + numeric folder + limit", async () => {
  const h = harness();
  await run(["ls", "-n", "5", "--sort", "created", "--folder", "9"], h.deps);
  assert.deepEqual(h.calls[0], ["notes", { sort: "created", folderId: "9", limit: "5" }]);
});

test("run: list --root passes the 'none' folder sentinel", async () => {
  const h = harness();
  await run(["ls", "--root"], h.deps);
  assert.equal(h.calls[0][1].folderId, "none");
});

test("run: list --folder <name> resolves the name to an id", async () => {
  const h = harness();
  await run(["ls", "--folder", "Work"], h.deps);
  assert.deepEqual(h.calls[0], ["folders"]);          // resolved name first
  assert.equal(h.calls[1][1].folderId, 3);            // Work -> id 3
});

test("run: list -l prints the long format", async () => {
  const h = harness();
  h.deps.clientFactory = () => ({
    notes: async () => [{ id: 5, filename: "f", title: "T", append_only: true, folder_id: 9, updated_at: "2026-05-29T00:00:00Z" }],
  });
  await run(["ls", "-l"], h.deps);
  assert.equal(h.out(), "5\t2026-05-29T00:00:00Z\tL\t9\tf\tT\n");
});

test("run: cat by filename prints plain_body", async () => {
  const h = harness();
  await run(["cat", "log"], h.deps);
  assert.equal(h.out(), "hello world");
  assert.deepEqual(h.calls[0], ["note", "log"]);
});

test("run: cat by numeric id uses noteById", async () => {
  const h = harness();
  await run(["cat", "42"], h.deps);
  assert.equal(h.out(), "by id body");
  assert.deepEqual(h.calls[0], ["noteById", "42"]);
});

test("run: get prints the full note as JSON", async () => {
  const h = harness();
  await run(["get", "42"], h.deps);
  assert.deepEqual(h.calls[0], ["noteById", "42"]);
  assert.match(h.out(), /"id": "42"/);
});

test("run: rm by id calls remove directly", async () => {
  const h = harness();
  const code = await run(["rm", "42"], h.deps);
  assert.equal(code, 0);
  assert.deepEqual(h.calls[0], ["remove", "42"]);
});

test("run: rm by name resolves to an id first", async () => {
  const h = harness();
  await run(["rm", "my-note"], h.deps);
  assert.deepEqual(h.calls[0], ["note", "my-note"]); // resolve
  assert.deepEqual(h.calls[1], ["remove", 7]);       // note().id
});

test("run: mv to a folder by name resolves both note and folder", async () => {
  const h = harness();
  await run(["mv", "my-note", "Work"], h.deps);
  assert.deepEqual(h.calls[0], ["note", "my-note"]); // note -> id 7
  assert.deepEqual(h.calls[1], ["folders"]);          // Work -> id 3
  assert.deepEqual(h.calls[2], ["move", 7, 3]);
});

test("run: mv --root moves to the root (null folder)", async () => {
  const h = harness();
  await run(["mv", "42", "--root"], h.deps);
  assert.deepEqual(h.calls[0], ["move", "42", null]);
});

test("run: folders prints `id\\tname` per row", async () => {
  const h = harness();
  await run(["folders"], h.deps);
  assert.equal(h.out(), "3\tWork\n4\tArchive\n");
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
