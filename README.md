# freshjots — JavaScript

Tiny JavaScript client for the [Fresh Jots](https://freshjots.com) API.
One file, zero dependencies (uses Node 18's global `fetch`).

## Install

```sh
npm install freshjots
```

(Or `pnpm add freshjots`, `yarn add freshjots`, `bun add freshjots`.)

## Use

```js
import { Client } from "freshjots";

// Reads FRESHJOTS_TOKEN from the environment by default.
const client = new Client();

// Append text to a note (creates it if missing).
await client.append("cron-jobs-prod", "backup ok");

// Read a note's body.
const note = await client.note("cron-jobs-prod");
console.log(note.plain_body);

// List your notes.
const notes = await client.notes();
for (const n of notes) console.log(`${n.filename}\t${n.title}`);

// Create a note. The API derives the filename from the title — for a
// note addressable by an exact filename, use append() instead.
const created = await client.create({ title: "Research 2026 Q2", body: "Initial outline." });
console.log(created.filename); // server-derived stream name
```

The whole API is four methods: `notes()`, `note(filename)`,
`create({ title, body })`, `append(filename, text)`. `note()` and
`create()` return the note object directly (no `{ note: … }` wrapper);
`notes()` returns the array.

## TypeScript

Types ship with the package — no `@types/freshjots` needed, no `.d.ts`
to hand-write. Just import the typed surface:

```ts
import { Client, ApiError, type Note, type ApiErrorCode } from "freshjots";

const client = new Client();
const note: Note = await client.note("cron-jobs-prod");
//        ^? Note — full editor autocomplete on plain_body, byte_size, etc.

try {
  await client.append("log", "ok");
} catch (e) {
  if (e instanceof ApiError) {
    const code: ApiErrorCode = e.code; // narrowed union; exhaustive switches work
  }
}
```

Requires TypeScript 4.5 or later (anything that understands the `"types"`
field in `package.json`'s `"exports"` map).

## Errors

Any non-2xx response throws `ApiError` with `status`, `code`, `message`,
and (when present) `details`:

```js
import { ApiError } from "freshjots";

try {
  await client.append("huge", "x".repeat(5_000_000));
} catch (e) {
  if (e instanceof ApiError) {
    console.log(`${e.status} ${e.code}: ${e.message}`);
    // 413 content_too_large: body exceeds the per-note 3 MB cap
  } else {
    throw e;
  }
}
```

Stable error codes: `unauthenticated`, `forbidden`, `not_found`,
`validation_failed`, `cap_exceeded`, `storage_cap_exceeded`,
`content_too_large`, `content_type_mismatch`, `rate_limited`. Full list:
<https://freshjots.com/docs>.

## Auth

Mint a token at <https://freshjots.com/settings/api_tokens> (Dev or
Dev-pro tier required). Set it once:

```sh
export FRESHJOTS_TOKEN=<your-token>
```

Or pass explicitly:

```js
new Client({ token: "mn_…" })
```

## Requirements

Node.js 18 or later. Older versions don't have global `fetch`.

## License

MIT.
