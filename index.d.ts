// Type definitions for freshjots
// Project: https://github.com/Goran-Arsov/freshjots-js
// License: MIT

declare module "freshjots" {
  export const VERSION: string;

  /** Full note envelope returned by `note()` and `create()`. */
  export interface Note {
    id: number;
    filename: string;
    title: string;
    format: "plain" | "rich";
    folder_id: number | null;
    pinned: boolean;
    append_only: boolean;
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

  export interface ClientOptions {
    token?: string;
    baseUrl?: string;
  }

  export interface CreateInput {
    filename: string;
    body?: string;
    title?: string;
  }

  export class Client {
    token: string;
    baseUrl: string;
    constructor(options?: ClientOptions);
    notes(): Promise<NoteSummary[]>;
    note(filename: string): Promise<Note>;
    create(input: CreateInput): Promise<Note>;
    append(filename: string, text: string): Promise<true>;
  }
}
