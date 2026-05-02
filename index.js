// Tiny client for the Fresh Jots API (https://freshjots.com/docs).
//
// Usage:
//
//   import { Client } from "freshjots";
//   const client = new Client();             // reads FRESHJOTS_TOKEN from env
//   await client.append("cron-jobs-prod", "backup ok");
//   const note = await client.note("cron-jobs-prod");
//   console.log(note.plain_body);
//
// Requires Node 18+ (uses global fetch). All methods throw ApiError on
// non-2xx responses, with the code/status/details from the API's stable
// error envelope.

export const VERSION = "0.1.0";
const DEFAULT_BASE_URL = "https://freshjots.com/api/v1";

export class ApiError extends Error {
  constructor({ status, code, message, details }) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class Client {
  constructor({ token, baseUrl = DEFAULT_BASE_URL } = {}) {
    this.token = token || process.env.FRESHJOTS_TOKEN;
    if (!this.token) {
      throw new Error("FRESHJOTS_TOKEN missing — pass {token} or set the env var");
    }
    this.baseUrl = baseUrl;
  }

  async notes() {
    return (await this._request("GET", "/notes")).notes;
  }

  async note(filename) {
    const path = `/notes/by-filename/${encodeURIComponent(filename)}`;
    return (await this._request("GET", path)).note;
  }

  async create({ filename, body = "", title }) {
    const note = { filename, plain_body: body, format: "plain" };
    if (title) note.title = title;
    return (await this._request("POST", "/notes", { note })).note;
  }

  async append(filename, text) {
    const path = `/notes/by-filename/${encodeURIComponent(filename)}/append`;
    await this._request("POST", path, { text });
    return true;
  }

  async _request(method, path, body) {
    const headers = { Authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    const data = text ? JSON.parse(text) : {};

    if (!res.ok) {
      const err = data.error || {};
      throw new ApiError({
        status: res.status,
        code: err.code || "unknown",
        message: err.message || "request failed",
        details: err.details,
      });
    }
    return data;
  }
}
