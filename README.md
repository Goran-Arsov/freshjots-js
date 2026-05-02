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

// Create a new note explicitly (errors if the filename is taken).
await client.create({ filename: "research-2026-q2", body: "Initial outline." });
```

The whole API is four methods: `notes()`, `note(filename)`,
`create({ filename, body, title })`, `append(filename, text)`.

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
new Client({ token: "fjk_…" })
```

## Requirements

Node.js 18 or later. Older versions don't have global `fetch`.

## License

MIT.
