// Tiny client for the Fresh Jots API (https://freshjots.com/docs).
//
// Usage:
//
//   import { Client } from "freshjots";
//   const client = new Client();             // reads FRESHJOTS_TOKEN from env
//   await client.append("cron-jobs-prod", "backup ok");
//   const note = await client.note("cron-jobs-prod");
//   console.log(note.plain_body);
//   const created = await client.create({ title: "Deploy log" });
//   console.log(created.filename);            // server-derived from the title
//
// Requires Node 18+ (uses global fetch). All methods throw ApiError on
// non-2xx responses, with the code/status/details from the API's stable
// error envelope.
//
// Note on response shapes: GET /notes is the only endpoint that wraps its
// payload ({ "notes": [...] }). show / show-by-filename / create return
// the note object at the TOP LEVEL — there is no { "note": ... } wrapper.

export const VERSION = "1.0.2";
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

  // List notes (summary projection). Options mirror the API query params:
  //   sort:    "created" | "updated" | "appended"  (default updated)
  //   folderId: a folder id, or "none" for un-foldered notes only
  //   limit/offset: pagination (server caps a page at 200)
  async notes({ sort, folderId, limit, offset } = {}) {
    const qs = new URLSearchParams();
    if (sort) qs.set("sort", sort);
    if (folderId !== undefined && folderId !== null && folderId !== "") {
      qs.set("folder_id", String(folderId));
    }
    if (limit !== undefined && limit !== null && limit !== "") qs.set("limit", String(limit));
    if (offset !== undefined && offset !== null && offset !== "") qs.set("offset", String(offset));
    const q = qs.toString();
    return (await this._request("GET", q ? `/notes?${q}` : "/notes")).notes;
  }

  async note(filename) {
    // show-by-filename renders the serializer at the top level (no
    // { note: ... } wrapper), so return the response as-is.
    const path = `/notes/by-filename/${encodeURIComponent(filename)}`;
    return await this._request("GET", path);
  }

  // Full note by numeric id (GET /notes/:id) — top-level serializer.
  async noteById(id) {
    return await this._request("GET", `/notes/${encodeURIComponent(id)}`);
  }

  // Delete a note by id. Locked (append-only) notes are refused by the
  // API with note_locked. Returns true on success (204).
  async remove(id) {
    await this._request("DELETE", `/notes/${encodeURIComponent(id)}`);
    return true;
  }

  // Move a note into a folder (or to the root with folderId null/"none").
  async move(id, folderId) {
    const folder_id =
      folderId === null || folderId === undefined || folderId === "" || folderId === "none"
        ? null
        : folderId;
    return await this._request("POST", `/notes/${encodeURIComponent(id)}/move`, { folder_id });
  }

  // List folders ({ folders: [...] } envelope).
  async folders() {
    return (await this._request("GET", "/folders")).folders;
  }

  // Create a note. The API permits note[title, plain_body, format, ...]
  // — NOT filename: the server DERIVES the filename from the title. For
  // a note addressable by an exact, caller-chosen filename, use append()
  // (the by-filename endpoint creates it with that exact name on first
  // call). Returns the created note (top level); read `.filename` for
  // the server-derived stream name.
  async create({ title, body = "" }) {
    if (!title) {
      throw new Error(
        "create requires a title — the API derives the filename from it. " +
          "For a note addressable by an exact filename, use append().",
      );
    }
    const note = { title, plain_body: body, format: "plain" };
    return await this._request("POST", "/notes", { note });
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
