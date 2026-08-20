import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { encrypt, decrypt, isEncrypted } from "../crypto.js";
import { run } from "../cli.js";

// A fixed known-answer vector, embedded verbatim in the JS, Python, and Ruby
// test suites. All three decrypting this same token to the same plaintext is
// the cross-client interoperability guarantee for the fj1 format.
const KAT_PASSPHRASE = "test-passphrase-123";
const KAT_PLAINTEXT = "Fresh Jots ✔ interop\nline two";
const KAT_TOKEN =
  "fj1:n0zMBI1YWjNr84OlkYe1UZ6NQlez9Bre77p2CJe/BgmsOPFghVmAhriP+JEw0WXn7znpaiJHZrH42EgoZSTcp9pgDySf5dciijwvUVdUouwSC6ZyDpbIelOnvE+WFiUO";

test("encrypt/decrypt round-trips arbitrary UTF-8", () => {
  const pass = "hunter2";
  for (const msg of ["", "hello", "línea ñ 日本語 🔐", "a\nb\nc"]) {
    const token = encrypt(msg, pass);
    assert.ok(isEncrypted(token));
    assert.equal(decrypt(token, pass), msg);
  }
});

test("output is a single line with the fj1: prefix", () => {
  const token = encrypt("multi\nline\nplaintext", "pw");
  assert.ok(token.startsWith("fj1:"));
  assert.equal(token.includes("\n"), false);
});

test("decrypts the shared cross-client known-answer vector", () => {
  assert.equal(decrypt(KAT_TOKEN, KAT_PASSPHRASE), KAT_PLAINTEXT);
});

test("wrong passphrase throws", () => {
  const token = encrypt("secret", "right");
  assert.throws(() => decrypt(token, "wrong"), /decryption failed/);
});

test("tampered ciphertext throws", () => {
  const token = encrypt("secret", "pw");
  const i = 8; // inside the base64 body (corrupts the salt -> key mismatch)
  const c = token[i] === "A" ? "B" : "A";
  assert.throws(() => decrypt(token.slice(0, i) + c + token.slice(i + 1), "pw"));
});

test("decrypt rejects non-fj1 input", () => {
  assert.throws(() => decrypt("plain text", "pw"), /fj1:/);
  assert.equal(isEncrypted("plain text"), false);
});

test("encrypt is randomized (fresh salt/nonce each call)", () => {
  assert.notEqual(encrypt("x", "pw"), encrypt("x", "pw"));
});

// ---- CLI ----

test("CLI encrypt | decrypt round-trips (local, no token needed)", async () => {
  const env = { FRESHJOTS_PASSPHRASE: "pw" };
  let out = [];
  const code1 = await run(["encrypt"], { env, stdin: Readable.from(["hello cli"]), stdout: (s) => out.push(s), stderr: () => {} });
  assert.equal(code1, 0);
  const token = out.join("");
  assert.ok(token.startsWith("fj1:"));

  out = [];
  const code2 = await run(["decrypt"], { env, stdin: Readable.from([token]), stdout: (s) => out.push(s), stderr: () => {} });
  assert.equal(code2, 0);
  assert.equal(out.join(""), "hello cli");
});

test("CLI decrypt passes through non-fj1 lines (webhook-style stream)", async () => {
  const env = { FRESHJOTS_PASSPHRASE: "pw" };
  const stream = `── 2026-01-01 00:00 UTC ──\n${encrypt("event one", "pw")}\n── 2026-01-01 00:05 UTC ──\n${encrypt("event two", "pw")}`;
  let out = [];
  const code = await run(["decrypt"], { env, stdin: Readable.from([stream]), stdout: (s) => out.push(s), stderr: () => {} });
  assert.equal(code, 0);
  const lines = out.join("").split("\n");
  assert.equal(lines[1], "event one");
  assert.equal(lines[3], "event two");
});

test("CLI encrypt without passphrase errors (exit 1)", async () => {
  let err = [];
  const code = await run(["encrypt"], { env: {}, stdin: Readable.from(["x"]), stdout: () => {}, stderr: (s) => err.push(s) });
  assert.equal(code, 1);
  assert.match(err.join(""), /FRESHJOTS_PASSPHRASE/);
});

test("create --encrypt encrypts the body and sets client_encrypted", async () => {
  const calls = [];
  const client = { create: async (input) => (calls.push(input), { filename: "creds.txt" }) };
  const env = { FRESHJOTS_TOKEN: "t", FRESHJOTS_PASSPHRASE: "pw" };
  const code = await run(["create", "creds", "--body", "s3cret", "--encrypt"], {
    env, stdin: { isTTY: true }, stdout: () => {}, stderr: () => {}, clientFactory: () => client,
  });
  assert.equal(code, 0);
  assert.equal(calls[0].client_encrypted, true);
  assert.ok(calls[0].body.startsWith("fj1:"));
  assert.equal(decrypt(calls[0].body, "pw"), "s3cret");
});

test("append --encrypt encrypts the text and flags client_encrypted", async () => {
  const calls = [];
  const client = { append: async (fn, text, opts) => (calls.push({ fn, text, opts }), true) };
  const env = { FRESHJOTS_TOKEN: "t", FRESHJOTS_PASSPHRASE: "pw" };
  const code = await run(["append", "log.txt", "event happened", "--encrypt"], {
    env, stdin: { isTTY: true }, stdout: () => {}, stderr: () => {}, clientFactory: () => client,
  });
  assert.equal(code, 0);
  assert.equal(calls[0].opts.client_encrypted, true);
  assert.equal(decrypt(calls[0].text, "pw"), "event happened");
});

test("cat --decrypt decrypts the fetched body", async () => {
  const token = encrypt("top secret", "pw");
  const client = { note: async () => ({ plain_body: token }), noteById: async () => ({ plain_body: token }) };
  const env = { FRESHJOTS_TOKEN: "t", FRESHJOTS_PASSPHRASE: "pw" };
  let out = [];
  const code = await run(["cat", "creds.txt", "--decrypt"], {
    env, stdin: { isTTY: true }, stdout: (s) => out.push(s), stderr: () => {}, clientFactory: () => client,
  });
  assert.equal(code, 0);
  assert.equal(out.join(""), "top secret");
});
