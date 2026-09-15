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

export const VERSION = "1.2.0";
const DEFAULT_BASE_URL = "https://freshjots.com/api/v1";

// Client-side encryption helpers (format "fj1", interoperable with the Python
// and Ruby clients). Encrypt locally, store the ciphertext as a note body with
// { client_encrypted: true }, decrypt locally on read.
export { encrypt, decrypt, isEncrypted } from "./crypto.js";

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

  // Delete a note by id. Works on any note, including locked (append-only)
  // ones — the lock freezes content, not deletability. Returns true (204).
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

  // Fetch one folder by id (GET /folders/:id). Like the note reads, the
  // serializer renders at the top level — no { folder: ... } wrapper.
  async folder(id) {
    return await this._request("GET", `/folders/${encodeURIComponent(id)}`);
  }

  // Create a folder (POST /folders, body { folder: { name } }). Returns the
  // created folder at the top level (201). A personal token creates a personal
  // folder, a team token a workspace folder — the server decides from the token.
  async createFolder(name) {
    return await this._request("POST", "/folders", { folder: { name } });
  }

  // Rename a folder (PATCH /folders/:id, body { folder: { name } }). Returns
  // the updated folder (top level).
  async renameFolder(id, name) {
    return await this._request("PATCH", `/folders/${encodeURIComponent(id)}`, { folder: { name } });
  }

  // Delete a folder by id (DELETE /folders/:id). Its notes survive — the FK
  // nullifies folder_id, so they just become un-foldered. Returns true (204).
  async deleteFolder(id) {
    await this._request("DELETE", `/folders/${encodeURIComponent(id)}`);
    return true;
  }

  // Create a note. The API permits note[title, plain_body, format, ...]
  // — NOT filename: the server DERIVES the filename from the title. For
  // a note addressable by an exact, caller-chosen filename, use append()
  // (the by-filename endpoint creates it with that exact name on first
  // call). Returns the created note (top level); read `.filename` for
  // the server-derived stream name.
  // Pass `client_encrypted: true` to mark the note as a client-encrypted note
  // — `body` is opaque ciphertext you produced with encrypt(); the server
  // stores it verbatim and never reads it. Personal accounts only; immutable
  // after creation.
  async create({ title, body = "", client_encrypted = false }) {
    if (!title) {
      throw new Error(
        "create requires a title — the API derives the filename from it. " +
          "For a note addressable by an exact filename, use append().",
      );
    }
    const note = { title, plain_body: body, format: "plain" };
    if (client_encrypted) note.client_encrypted = true;
    return await this._request("POST", "/notes", { note });
  }

  // On first-touch creation, pass `{ client_encrypted: true }` to open the
  // stream as a client-encrypted note (send one ciphertext line per append).
  // Ignored once the note exists — encryption is set at create.
  async append(filename, text, { client_encrypted = false } = {}) {
    const path = `/notes/by-filename/${encodeURIComponent(filename)}/append`;
    const body = { text };
    if (client_encrypted) body.client_encrypted = true;
    await this._request("POST", path, body);
    return true;
  }

  // Update a note by numeric id (PATCH /notes/:id, body { note: attrs }).
  // `attrs` holds only the fields to change — title, plain_body, folder_id
  // (null to un-folder), append_deadline_hours, alert_email, webhook_url,
  // webhook_secret — so an unmentioned field is never clobbered. A content
  // change (title/plain_body) rewrites the body as a unit and requires a
  // non-empty plain_body. Locked (append-only) notes refuse content edits
  // with an ApiError (code note_locked); metadata-only changes are allowed.
  // Returns the full updated note (top level).
  async update(id, attrs) {
    return await this._request("PATCH", `/notes/${encodeURIComponent(id)}`, { note: attrs });
  }

  // Update a note addressed by its exact filename / stream name
  // (PATCH /notes/by-filename/:filename). Same body and contract as update().
  async set(filename, attrs) {
    const path = `/notes/by-filename/${encodeURIComponent(filename)}`;
    return await this._request("PATCH", path, { note: attrs });
  }

  // Bulk-create notes in one atomic batch (POST /notes/bulk, body
  // { notes: [...] }). `notes` is an array of note objects (server cap: 50);
  // all land or none do. Returns the response envelope { created: [...] } —
  // read `.created` for the created notes.
  async bulk(notes) {
    return await this._request("POST", "/notes/bulk", { notes });
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
