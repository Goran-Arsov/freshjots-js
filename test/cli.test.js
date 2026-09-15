// CLI tests. parseArgs is pure so we assert its return shape directly.
// run() is exercised with a stubbed client + captured stdout/stderr;
// the for-await stdin reader is fed by Readable.from() so piped-input
// paths are covered without touching real stdio.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Readable } from "node:stream";
import { ApiError, VERSION } from "../index.js";
import { parseArgs, run } from "../cli.js";

function harness({ token = "mn_test", stdin, readFile } = {}) {
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
    folder: async (id) => { calls.push(["folder", id]); return { id, name: "Work" }; },
    createFolder: async (name) => { calls.push(["createFolder", name]); return { id: 9, name }; },
    renameFolder: async (id, name) => { calls.push(["renameFolder", id, name]); return { id, name }; },
    deleteFolder: async (id) => { calls.push(["deleteFolder", id]); return true; },
    update: async (id, attrs) => { calls.push(["update", id, attrs]); return { id, filename: "log", title: attrs.title ?? "T" }; },
    set: async (filename, attrs) => { calls.push(["set", filename, attrs]); return { id: 7, filename, title: attrs.title ?? "T" }; },
    bulk: async (notes) => { calls.push(["bulk", notes]); return { created: notes.map((_, i) => ({ id: i + 1 })) }; },
  };
  const deps = {
    env: { FRESHJOTS_TOKEN: token },
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    stdin: stdin ?? { isTTY: true },
    clientFactory: () => fakeClient,
    readFile,
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

test("parseArgs: folder with no sub / ls / list is the folders list", () => {
  assert.deepEqual(parseArgs(["folder"]), { command: "folders" });
  assert.deepEqual(parseArgs(["folder", "ls"]), { command: "folders" });
  assert.deepEqual(parseArgs(["folder", "list"]), { command: "folders" });
});

test("parseArgs: folder create/rename/rm shapes", () => {
  assert.deepEqual(parseArgs(["folder", "create", "Ops"]), { command: "folder-create", name: "Ops" });
  assert.deepEqual(parseArgs(["folder", "new", "Ops"]), { command: "folder-create", name: "Ops" });
  assert.deepEqual(parseArgs(["folder", "rename", "3", "Operations"]), { command: "folder-rename", id: "3", name: "Operations" });
  assert.deepEqual(parseArgs(["folder", "rm", "3"]), { command: "folder-rm", id: "3" });
  assert.deepEqual(parseArgs(["folder", "delete", "3"]), { command: "folder-rm", id: "3" });
});

test("parseArgs: folder <id> shows one folder", () => {
  assert.deepEqual(parseArgs(["folder", "3"]), { command: "folder-show", id: "3" });
});

test("parseArgs: folder subcommand usage errors", () => {
  assert.equal(parseArgs(["folder", "create"]).command, "error");            // missing name
  assert.equal(parseArgs(["folder", "rename", "3"]).command, "error");       // missing new name
  assert.equal(parseArgs(["folder", "rm"]).command, "error");                // missing id
  assert.equal(parseArgs(["folder", "3", "extra"]).command, "error");        // show takes one arg
});

test("parseArgs: update parses id + note flags into attrs", () => {
  assert.deepEqual(parseArgs(["update", "42", "--title", "T", "--body", "B"]), {
    command: "update", id: "42", attrs: { title: "T", plain_body: "B" }, bodyFromStdin: false,
  });
  assert.deepEqual(parseArgs(["update", "42", "--folder", "3", "--deadline", "26"]), {
    command: "update", id: "42", attrs: { folder_id: 3, append_deadline_hours: 26 }, bodyFromStdin: false,
  });
  assert.deepEqual(parseArgs(["update", "42", "--root"]).attrs, { folder_id: null });
  assert.equal(parseArgs(["update", "42", "-"]).bodyFromStdin, true);
});

test("parseArgs: set parses filename + flags", () => {
  assert.deepEqual(parseArgs(["set", "cron", "--alert-email", "a@b.co"]), {
    command: "set", filename: "cron", attrs: { alert_email: "a@b.co" }, bodyFromStdin: false,
  });
});

test("parseArgs: update/set guards", () => {
  assert.equal(parseArgs(["update", "42"]).command, "error");                      // no fields
  assert.match(parseArgs(["update", "42", "--title", "T"]).message, /title alone/); // title needs body
  assert.match(parseArgs(["update", "42", "--folder", "Work"]).message, /numeric/);  // name not allowed here
  assert.match(parseArgs(["update", "42", "--bogus"]).message, /unknown flag/);
  assert.equal(parseArgs(["update"]).command, "error");                            // missing id
  assert.equal(parseArgs(["set"]).command, "error");                              // missing filename
});

test("parseArgs: bulk takes an optional file arg (- or none means stdin)", () => {
  assert.deepEqual(parseArgs(["bulk"]), { command: "bulk", file: undefined });
  assert.deepEqual(parseArgs(["bulk", "-"]), { command: "bulk", file: undefined });
  assert.deepEqual(parseArgs(["bulk", "notes.json"]), { command: "bulk", file: "notes.json" });
  assert.equal(parseArgs(["bulk", "a.json", "b.json"]).command, "error");
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

test("run: folder ls is an alias for folders", async () => {
  const h = harness();
  await run(["folder", "ls"], h.deps);
  assert.deepEqual(h.calls[0], ["folders"]);
  assert.equal(h.out(), "3\tWork\n4\tArchive\n");
});

test("run: folder create prints the created confirmation", async () => {
  const h = harness();
  const code = await run(["folder", "create", "Ops"], h.deps);
  assert.equal(code, 0);
  assert.deepEqual(h.calls[0], ["createFolder", "Ops"]);
  assert.equal(h.out(), "created folder #9 Ops\n");
});

test("run: folder rename prints the renamed confirmation", async () => {
  const h = harness();
  await run(["folder", "rename", "9", "Operations"], h.deps);
  assert.deepEqual(h.calls[0], ["renameFolder", "9", "Operations"]);
  assert.equal(h.out(), "renamed folder #9 -> Operations\n");
});

test("run: folder rm deletes silently", async () => {
  const h = harness();
  const code = await run(["folder", "rm", "9"], h.deps);
  assert.equal(code, 0);
  assert.deepEqual(h.calls[0], ["deleteFolder", "9"]);
  assert.equal(h.out(), "");
});

test("run: folder <id> prints the folder as JSON", async () => {
  const h = harness();
  await run(["folder", "3"], h.deps);
  assert.deepEqual(h.calls[0], ["folder", "3"]);
  assert.match(h.out(), /"name": "Work"/);
});

test("run: update forwards attrs and prints `updated #id filename`", async () => {
  const h = harness();
  const code = await run(["update", "42", "--title", "New", "--body", "b"], h.deps);
  assert.equal(code, 0);
  assert.deepEqual(h.calls[0], ["update", "42", { title: "New", plain_body: "b" }]);
  assert.equal(h.out(), "updated #42 log\n");
});

test("run: update --body - reads the body from stdin", async () => {
  const h = harness({ stdin: Readable.from(["piped ", "body"]) });
  await run(["update", "42", "-"], h.deps);
  assert.deepEqual(h.calls[0], ["update", "42", { plain_body: "piped body" }]);
});

test("run: set forwards attrs by filename and prints `updated filename`", async () => {
  const h = harness();
  await run(["set", "cron-jobs-prod", "--folder", "3"], h.deps);
  assert.deepEqual(h.calls[0], ["set", "cron-jobs-prod", { folder_id: 3 }]);
  assert.equal(h.out(), "updated cron-jobs-prod\n");
});

test("run: bulk from stdin posts the parsed array and prints the count", async () => {
  const h = harness({ stdin: Readable.from(['[{"title":"a"},{"title":"b"}]']) });
  const code = await run(["bulk"], h.deps);
  assert.equal(code, 0);
  assert.deepEqual(h.calls[0], ["bulk", [{ title: "a" }, { title: "b" }]]);
  assert.equal(h.out(), "created 2 notes\n");
});

test("run: bulk accepts a { notes: [...] } wrapper", async () => {
  const h = harness({ stdin: Readable.from(['{"notes":[{"title":"a"}]}']) });
  await run(["bulk", "-"], h.deps);
  assert.deepEqual(h.calls[0], ["bulk", [{ title: "a" }]]);
});

test("run: bulk reads a file when a path is given", async () => {
  const h = harness({ readFile: async (p) => { h.calls.push(["readFile", p]); return '[{"title":"x"}]'; } });
  await run(["bulk", "notes.json"], h.deps);
  assert.deepEqual(h.calls[0], ["readFile", "notes.json"]);
  assert.deepEqual(h.calls[1], ["bulk", [{ title: "x" }]]);
});

test("run: bulk rejects a batch over 50 without calling the client", async () => {
  const many = JSON.stringify(Array.from({ length: 51 }, (_, i) => ({ title: `n${i}` })));
  const h = harness({ stdin: Readable.from([many]) });
  const code = await run(["bulk"], h.deps);
  assert.equal(code, 2);
  assert.match(h.err(), /max 50 notes per batch \(got 51\)/);
  assert.equal(h.calls.length, 0);
});

test("run: bulk on invalid JSON returns 2", async () => {
  const h = harness({ stdin: Readable.from(["not json"]) });
  const code = await run(["bulk"], h.deps);
  assert.equal(code, 2);
  assert.match(h.err(), /not valid JSON/);
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
