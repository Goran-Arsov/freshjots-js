# freshjots — JS, TS, Windows CLI

Tiny JavaScript client for the [Fresh Jots](https://freshjots.com) API.
One file, zero dependencies (uses Node 18's global `fetch`).

## CLI

Installing the package globally puts a `freshjots` command on your
PATH, so you can read and write notes straight from a terminal without
writing any JavaScript. This works in bash, zsh, fish, Windows
PowerShell, and CMD — npm generates a `.cmd` shim on Windows
automatically.

```sh
npm install -g freshjots

# Persist the token for every new shell (macOS defaults to zsh; use ~/.bashrc on bash):
echo 'export FRESHJOTS_TOKEN=mn_…' >> ~/.zshrc && source ~/.zshrc
# Windows PowerShell: [Environment]::SetEnvironmentVariable("FRESHJOTS_TOKEN", "mn_…", "User")
```

The CLI covers reading, writing, and organizing notes:

```sh
freshjots ls                              # prints "<id>\t<filename>\t<title>" per row
freshjots ls -n 10 --sort created         # last 10 by creation (--sort created|updated|appended)
freshjots ls --folder Work                # filter by folder id or name; --root for un-foldered
freshjots ls --all -l                     # every page, long format (id, updated, lock, folder, …)
freshjots get 42                          # full note as JSON
freshjots cat cron-jobs-prod              # note body, by id or filename
freshjots create "Research 2026 Q2"       # body from stdin or --body
freshjots append cron-jobs-prod "ok"      # text may also be piped on stdin
freshjots update 42 --title "Q2" --body … # update a note by id (only the fields you pass)
freshjots set cron-jobs-prod --deadline 26 # update a note by filename (metadata-only shown)
freshjots rm cron-jobs-prod               # delete by id or filename
freshjots mv cron-jobs-prod Work          # move into a folder (id or name); --root to un-folder
freshjots bulk notes.json                 # create many notes atomically (JSON array; stdin or file)
freshjots folders                         # prints "<id>\t<name>" per row
freshjots folder create "Ops"             # create a folder
freshjots folder rename 3 "Operations"    # rename by id
freshjots folder rm 3                      # delete by id (its notes survive, un-foldered)
freshjots --version                       # print version (--help for full usage)
```

`update` and `set` change only the flags you pass, so an unmentioned
field is never clobbered. A title change rewrites the body as a unit, so
pass `--body` (or `-` to read it from stdin) alongside `--title`;
metadata-only changes (`--folder`/`--root`, `--deadline`, `--alert-email`,
`--webhook-url`, `--webhook-secret`) need no body. Run `freshjots --help`
for the full flag list.

Both `create` and `append` read from stdin when the body or text isn't
passed as an argument, so the usual pipe patterns work:

```sh
backup.sh && echo "backup ok $(date -Iseconds)" | freshjots append cron-jobs-prod
git log -1 --pretty=format:"%h %s" | freshjots append deploys
```

The same patterns work in PowerShell:

```powershell
"backup ok $(Get-Date -Format o)" | freshjots append cron-jobs-prod
freshjots create "Deploy log" --body "Initial entry."
```

Exit codes: `0` on success, `1` on runtime errors (missing token,
network failure, non-2xx API response — printed as `Error: HTTP <status>
<code>: <message>`), `2` on usage errors.

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

// List your notes (most recent activity first). Pass options to sort/filter:
const notes = await client.notes({ sort: "created", folderId: 3, limit: 20 });
for (const n of notes) console.log(`${n.id}\t${n.filename}\t${n.title}`);

// Create a note. The API derives the filename from the title — for a
// note addressable by an exact filename, use append() instead.
const created = await client.create({ title: "Research 2026 Q2", body: "Initial outline." });
console.log(created.filename); // server-derived stream name
```

Client methods: `notes({ sort, folderId, limit, offset })`,
`note(filename)`, `noteById(id)`, `create({ title, body, client_encrypted })`,
`append(filename, text, { client_encrypted })`, `update(id, attrs)`,
`set(filename, attrs)`, `bulk(notes)`, `remove(id)`, `move(id, folderId)`,
`folders()`, `folder(id)`, `createFolder(name)`, `renameFolder(id, name)`,
and `deleteFolder(id)`. Client-side crypto: `encrypt(text,
passphrase)` / `decrypt(token, passphrase)` (see [Encryption](#encryption)). `note()`/`noteById()`/`create()`/`update()`/`set()` and the single-folder
methods return the object directly (no `{ note: … }` / `{ folder: … }`
wrapper); `notes()` and `folders()` return arrays, and `bulk()` returns
`{ created: [...] }`. For `update()`/`set()`, `attrs` carries only the
fields to change (`title`, `plain_body`, `folder_id` — `null` to un-folder —
`append_deadline_hours`, `alert_email`, `webhook_url`, `webhook_secret`);
`deleteFolder()` leaves the folder's notes in place (they become un-foldered).
For `notes()`, `sort` is `created|updated|appended` and
`folderId` may be a folder id or `"none"` (un-foldered only).

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

## Encryption

Fresh Jots stores whatever text you send, byte-for-byte — so you can keep notes
the server can't read: encrypt locally with your own passphrase, store the
ciphertext, decrypt locally on read. The helpers are built in (format `fj1`:
AES-256-CBC + HMAC-SHA256, PBKDF2, zero dependencies) and interoperate with the
Python, Ruby, MCP, and shell (`brew`) clients.

```js
import { Client, encrypt, decrypt } from "freshjots";

const client = new Client();
const pass = process.env.FRESHJOTS_PASSPHRASE;

// Store an encrypted note: encrypt the body, flag it client_encrypted.
await client.create({ title: "Recovery codes", body: encrypt("1234-5678", pass), client_encrypted: true });

// Read it back and decrypt locally.
const note = await client.note("recovery-codes");
console.log(decrypt(note.plain_body, pass));
```

From the CLI, `--encrypt` / `--decrypt` do the same, reading the passphrase
from `FRESHJOTS_PASSPHRASE`:

```sh
export FRESHJOTS_PASSPHRASE='correct horse battery staple'
freshjots create "Recovery codes" --body "1234-5678" --encrypt
freshjots cat recovery-codes --decrypt

# An encrypted log stream — one ciphertext line per event:
freshjots append deploys "shipped v2" --encrypt

# Standalone: pipe anything through encrypt / decrypt.
echo "secret" | freshjots encrypt          # -> fj1:…
printf 'fj1:…' | freshjots decrypt         # -> secret
```

You hold the only key. Fresh Jots never receives it and **cannot recover the
note if you lose it** — back the passphrase up somewhere safe. Encryption is
per-note and personal-only (not team notes); the note's title and metadata stay
in the clear, so keep secrets out of the title. See
<https://freshjots.com/encrypted-notes>.

## Auth

Mint a token at <https://freshjots.com/settings/api_tokens> (Dev or
Team tier required). Set it once:

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
