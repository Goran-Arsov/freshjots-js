// Tests run with `node --test`. The token/ApiError checks need no
// network; the method tests stub global fetch so they assert the real
// request shape and response parsing (these would have caught the
// top-level-serializer and unpermitted-filename bugs).

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { ApiError, Client, VERSION } from "../index.js";

// Install a fake global fetch. `respond` is { ok, status, body } where
// body is the JSON object the API would return. Returns a `calls` array
// capturing [url, init] and a restore() to put the real fetch back.
function stubFetch(respond) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push([url, init]);
    return {
      ok: respond.ok,
      status: respond.status,
      text: async () => (respond.body === undefined ? "" : JSON.stringify(respond.body)),
    };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("VERSION is pinned to 0.2.1", () => {
  assert.equal(VERSION, "0.2.1");
});

test("Client throws when no token is available", () => {
  const previous = process.env.FRESHJOTS_TOKEN;
  delete process.env.FRESHJOTS_TOKEN;
  try {
    assert.throws(() => new Client(), /FRESHJOTS_TOKEN/);
  } finally {
    if (previous !== undefined) process.env.FRESHJOTS_TOKEN = previous;
  }
});

test("Client accepts an explicit token", () => {
  const c = new Client({ token: "mn_test" });
  assert.equal(c.token, "mn_test");
});

test("Client reads the token from FRESHJOTS_TOKEN", () => {
  const previous = process.env.FRESHJOTS_TOKEN;
  process.env.FRESHJOTS_TOKEN = "mn_env";
  try {
    assert.equal(new Client().token, "mn_env");
  } finally {
    if (previous === undefined) delete process.env.FRESHJOTS_TOKEN;
    else process.env.FRESHJOTS_TOKEN = previous;
  }
});

test("ApiError carries code and status", () => {
  const err = new ApiError({ status: 422, code: "cap_exceeded", message: "over the limit" });
  assert.equal(err.status, 422);
  assert.equal(err.code, "cap_exceeded");
  assert.equal(err.message, "over the limit");
  assert.equal(err.name, "ApiError");
});

test("note() returns the top-level serializer body (no { note } wrapper)", async () => {
  const { calls, restore } = stubFetch({
    ok: true,
    status: 200,
    body: { id: 7, filename: "cron jobs", title: "t", plain_body: "hello" },
  });
  try {
    const note = await new Client({ token: "mn_x" }).note("cron jobs");
    assert.equal(note.id, 7);
    assert.equal(note.plain_body, "hello");
    assert.match(calls[0][0], /\/notes\/by-filename\/cron%20jobs$/);
  } finally {
    restore();
  }
});

test("notes() unwraps the { notes: [...] } envelope", async () => {
  const { restore } = stubFetch({ ok: true, status: 200, body: { notes: [{ id: 1 }, { id: 2 }] } });
  try {
    const list = await new Client({ token: "mn_x" }).notes();
    assert.equal(list.length, 2);
    assert.equal(list[1].id, 2);
  } finally {
    restore();
  }
});

test("create() requires a title", async () => {
  await assert.rejects(
    () => new Client({ token: "mn_x" }).create({ body: "x" }),
    /create requires a title/,
  );
});

test("create() posts note.title (never filename) and returns the created note", async () => {
  const { calls, restore } = stubFetch({
    ok: true,
    status: 201,
    body: { id: 9, filename: "research-2026-q2", title: "Research 2026 Q2", plain_body: "o" },
  });
  try {
    const created = await new Client({ token: "mn_x" }).create({ title: "Research 2026 Q2", body: "o" });
    assert.equal(created.id, 9);
    assert.equal(created.filename, "research-2026-q2"); // server-derived
    const sent = JSON.parse(calls[0][1].body);
    assert.equal(sent.note.title, "Research 2026 Q2");
    assert.equal(sent.note.format, "plain");
    assert.equal("filename" in sent.note, false); // API does not permit it
  } finally {
    restore();
  }
});

test("append() posts { text } to the by-filename append path", async () => {
  const { calls, restore } = stubFetch({ ok: true, status: 200, body: { id: 1, created: false } });
  try {
    const ok = await new Client({ token: "mn_x" }).append("deploys", "shipped");
    assert.equal(ok, true);
    assert.match(calls[0][0], /\/notes\/by-filename\/deploys\/append$/);
    assert.equal(JSON.parse(calls[0][1].body).text, "shipped");
  } finally {
    restore();
  }
});

test("non-2xx throws ApiError carrying the stable envelope", async () => {
  const { restore } = stubFetch({
    ok: false,
    status: 422,
    body: { error: { code: "cap_exceeded", message: "over", details: ["d"] } },
  });
  try {
    await assert.rejects(
      () => new Client({ token: "mn_x" }).notes(),
      (e) => e instanceof ApiError && e.status === 422 && e.code === "cap_exceeded" &&
             e.message === "over" && Array.isArray(e.details),
    );
  } finally {
    restore();
  }
});
