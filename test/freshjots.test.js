// Smoke tests — no network, contract assertions only. Run with `node --test test/`.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { ApiError, Client, VERSION } from "../index.js";

test("VERSION is a string", () => {
  assert.equal(typeof VERSION, "string");
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
    const c = new Client();
    assert.equal(c.token, "mn_env");
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
