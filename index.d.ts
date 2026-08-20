// Type definitions for freshjots
// Project: https://github.com/Goran-Arsov/freshjots-js
// License: MIT

declare module "freshjots" {
  export const VERSION: string;

  /** True if `text` carries the Fresh Jots ciphertext prefix ("fj1:"). */
  export function isEncrypted(text: unknown): boolean;
  /** Encrypt a UTF-8 string with a passphrase (format "fj1"). Returns an "fj1:" token. */
  export function encrypt(plaintext: string, passphrase: string): string;
  /** Decrypt an "fj1:" token back to plaintext; throws on a wrong passphrase or tampering. */
  export function decrypt(token: string, passphrase: string): string;

  /** Full note envelope returned by `note()` and `create()`. */
  export interface Note {
    id: number;
    filename: string;
    title: string;
    format: "plain" | "rich";
    folder_id: number | null;
    pinned: boolean;
    append_only: boolean;
    /** The note is marked client-encrypted (body is opaque ciphertext). */
    client_encrypted: boolean;
    append_deadline_hours: number | null;
    alert_email: string | null;
    last_appended_at: string | null;
    alerted_at: string | null;
    webhook_url: string | null;
    webhook_failure_count: number;
    webhook_disabled_at: string | null;
    plain_body: string;
    byte_size: number;
  }

  /** Summary projection returned by `notes()` (list view). */
  export interface NoteSummary {
    id: number;
    filename: string;
    title: string;
    format: "plain" | "rich";
    last_appended_at: string | null;
    plain_body_excerpt?: string;
    byte_size?: number;
  }

  /** Stable error codes — safe to branch on. */
  export type ApiErrorCode =
    | "unauthenticated"
    | "forbidden"
    | "not_found"
    | "validation_failed"
    | "cap_exceeded"
    | "storage_cap_exceeded"
    | "content_too_large"
    | "content_type_mismatch"
    | "rate_limited"
    | "unknown";

  export class ApiError extends Error {
    status: number;
    code: ApiErrorCode;
    details?: unknown;
    constructor(opts: { status: number; code: ApiErrorCode; message: string; details?: unknown });
  }

  /** A folder, as returned by `folders()`. */
  export interface Folder {
    id: number;
    name: string;
    created_at: string;
    updated_at: string;
  }

  /** Options for `notes()` — mirror the API's list query params. */
  export interface ListOptions {
    sort?: "created" | "updated" | "appended";
    /** A folder id, or "none" for un-foldered notes only. */
    folderId?: number | string;
    limit?: number;
    offset?: number;
  }

  export interface ClientOptions {
    token?: string;
    baseUrl?: string;
  }

  /**
   * Input for `create()`. The API derives the note's filename from the
   * title (it does not accept a client-supplied filename). For a note
   * addressable by an exact, caller-chosen filename, use `append()`.
   */
  export interface CreateInput {
    title: string;
    body?: string;
    /** Mark the note client-encrypted (`body` is ciphertext from `encrypt()`). Personal accounts only. */
    client_encrypted?: boolean;
  }

  /** Options for `append()`. */
  export interface AppendOptions {
    /** On first-touch creation, open the stream as a client-encrypted note. */
    client_encrypted?: boolean;
  }

  export class Client {
    token: string;
    baseUrl: string;
    constructor(options?: ClientOptions);
    notes(options?: ListOptions): Promise<NoteSummary[]>;
    note(filename: string): Promise<Note>;
    noteById(id: number | string): Promise<Note>;
    create(input: CreateInput): Promise<Note>;
    append(filename: string, text: string, options?: AppendOptions): Promise<true>;
    remove(id: number | string): Promise<true>;
    move(id: number | string, folderId: number | string | null): Promise<Note>;
    folders(): Promise<Folder[]>;
  }
}
