// CLI dispatcher for the `freshjots` command. The shebang entry
// (bin/freshjots.js) is a one-line wrapper around run() so this module
// stays import-safe and testable: parseArgs is pure, run takes its I/O
// surface as deps so tests can stub stdin/stdout/stderr and the Client.

import { readFile } from "node:fs/promises";
import { Client, ApiError, VERSION, encrypt, decrypt, isEncrypted } from "./index.js";

const USAGE = `freshjots — Fresh Jots CLI

Usage:
  freshjots ls [flags]                 List notes as id<TAB>filename<TAB>title.
                                         -n N | --limit N
                                         --sort created|updated|appended
                                         --folder <id|name> | --root
                                         --all      fetch every page (past the 200 cap)
                                         -l|--long  id, updated_at, lock, folder, name, title
  freshjots get <id>                   Print a note as JSON (full metadata).
  freshjots cat <id|filename> [--decrypt]   Print a note's body.
  freshjots create <title> [--body <text>] [--encrypt]
  freshjots append <filename> [<text>] [--encrypt]
  freshjots update <id> [flags]        Update a note by id (see Update flags).
  freshjots set <filename> [flags]     Update a note by filename (see Update flags).
  freshjots rm <id|filename>           Delete a note.
  freshjots mv <id|filename> <folder-id|name|--root>
  freshjots bulk [file.json]           Bulk-create notes (JSON array/{notes:[…]}
                                         on stdin or from a file; max 50).
  freshjots folders                    List folders as id<TAB>name.
  freshjots folder <subcommand>        Manage folders:
                                         folder [ls]                list (same as 'folders')
                                         folder create <name>       create a folder
                                         folder rename <id> <name>  rename a folder
                                         folder rm <id>             delete a folder (notes survive)
                                         folder <id>                show one folder as JSON
  freshjots encrypt                    Encrypt stdin, print an fj1: token.
  freshjots decrypt                    Decrypt fj1: lines from stdin to plaintext.
  freshjots --help | --version

Update flags (update / set) — only the fields you pass are changed:
  --title <s>              new title (a title change rewrites the body,
                             so pass --body too)
  --body <text> | -        new body (- reads the body from stdin)
  --folder <id> | --root   move into a folder (numeric id) or un-folder
  --deadline <hours>       dead-man's-switch deadline
  --alert-email <s>        dead-man alert address
  --webhook-url <s>        outbound webhook URL
  --webhook-secret <s>     outbound webhook signing secret

Notes:
  - <text> for append and --body for create may also be piped on stdin.
  - --encrypt / --decrypt and the encrypt/decrypt commands encrypt client-side
    with the passphrase in FRESHJOTS_PASSPHRASE; the server only ever stores the
    ciphertext and cannot read it. Lose the passphrase and the note is lost.
  - Auth: set FRESHJOTS_TOKEN. Mint one at
    https://freshjots.com/settings/api_tokens.
`;

const isNumeric = (s) => /^\d+$/.test(s);
const errResult = (message) => ({ command: "error", message });

// Parse the shared `update` / `set` flags into a { note: attrs } payload.
// Mirrors the bash CLI's build_note_body: only keys the caller passed are
// included, so a PATCH never clobbers an unmentioned field. `-` marks the body
// as coming from stdin (resolved by run()). Returns { attrs, bodyFromStdin } or
// { error }. `append_only` / `format` are intentionally absent — the API does
// not update them.
function parseNoteAttrs(args) {
  const attrs = {};
  let bodyFromStdin = false;
  let hasTitle = false;
  let hasBody = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const value = () => (i + 1 < args.length ? args[++i] : undefined);
    if (a === "--title") {
      const v = value();
      if (v === undefined) return { error: "--title requires a value" };
      attrs.title = v; hasTitle = true;
    } else if (a === "--body" || a === "-b") {
      const v = value();
      if (v === undefined) return { error: "--body requires a value" };
      attrs.plain_body = v; hasBody = true;
    } else if (a === "-") {
      bodyFromStdin = true; hasBody = true;
    } else if (a === "--folder") {
      const v = value();
      if (v === undefined) return { error: "--folder requires a value" };
      if (!isNumeric(v)) return { error: "--folder requires a numeric folder id (or use --root)" };
      attrs.folder_id = Number(v);
    } else if (a === "--root") {
      attrs.folder_id = null;
    } else if (a === "--deadline") {
      const v = value();
      if (v === undefined) return { error: "--deadline requires a value" };
      if (!isNumeric(v)) return { error: "--deadline requires a number of hours" };
      attrs.append_deadline_hours = Number(v);
    } else if (a === "--alert-email") {
      const v = value();
      if (v === undefined) return { error: "--alert-email requires a value" };
      attrs.alert_email = v;
    } else if (a === "--webhook-url") {
      const v = value();
      if (v === undefined) return { error: "--webhook-url requires a value" };
      attrs.webhook_url = v;
    } else if (a === "--webhook-secret") {
      const v = value();
      if (v === undefined) return { error: "--webhook-secret requires a value" };
      attrs.webhook_secret = v;
    } else {
      return { error: `unknown flag: ${a} (append_only/format are not API-updatable)` };
    }
  }
  if (Object.keys(attrs).length === 0 && !bodyFromStdin) {
    return { error: "no fields to update. See 'freshjots --help'." };
  }
  // A content PATCH (title/plain_body) rewrites the body as a unit and the API
  // requires a non-empty plain_body, so a title-only change 422s. Refuse it
  // here with actionable guidance instead of making a doomed call.
  if (hasTitle && !hasBody) {
    return {
      error:
        "can't change the title alone: a content update rewrites the body too, so pass " +
        "--body (or '-'). For metadata-only changes use --folder/--root/--deadline/" +
        "--alert-email/--webhook-url/--webhook-secret (no body needed).",
    };
  }
  return { attrs, bodyFromStdin };
}

export function parseArgs(argv) {
  if (argv.length === 0) return { command: "help", exitCode: 2 };
  const [first, ...rest] = argv;

  if (first === "-h" || first === "--help" || first === "help") {
    return { command: "help", exitCode: 0 };
  }
  if (first === "-v" || first === "--version" || first === "version") {
    return { command: "version" };
  }
  if (first === "list" || first === "ls") {
    const opts = { command: "list", limit: null, sort: null, folder: null, all: false, long: false };
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "-n" || a === "--limit") {
        if (i + 1 >= rest.length) return errResult("--limit requires a value");
        opts.limit = rest[++i];
      } else if (a === "--sort") {
        if (i + 1 >= rest.length) return errResult("--sort requires a value");
        opts.sort = rest[++i];
      } else if (a === "--folder") {
        if (i + 1 >= rest.length) return errResult("--folder requires a value");
        opts.folder = rest[++i];
      } else if (a === "--root") {
        opts.folder = "none";
      } else if (a === "--all") {
        opts.all = true;
      } else if (a === "-l" || a === "--long") {
        opts.long = true;
      } else {
        return errResult(`unknown flag for list: ${a}`);
      }
    }
    return opts;
  }
  if (first === "get") {
    if (rest.length !== 1) return errResult("get requires exactly one <id>");
    return { command: "get", id: rest[0] };
  }
  if (first === "show" || first === "cat") {
    let decrypt = false;
    const positional = [];
    for (const a of rest) {
      if (a === "--decrypt") decrypt = true;
      else positional.push(a);
    }
    if (positional.length !== 1) return errResult(`${first} requires exactly one <id|filename>`);
    return { command: "show", target: positional[0], decrypt };
  }
  if (first === "create") {
    let body;
    let encrypt = false;
    const positional = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "--body" || a === "-b") {
        if (i + 1 >= rest.length) return errResult("--body requires a value");
        body = rest[++i];
      } else if (a.startsWith("--body=")) {
        body = a.slice("--body=".length);
      } else if (a === "--encrypt") {
        encrypt = true;
      } else {
        positional.push(a);
      }
    }
    if (positional.length !== 1) return errResult("create requires exactly one <title>");
    return { command: "create", title: positional[0], body, encrypt };
  }
  if (first === "append") {
    let encrypt = false;
    const positional = [];
    for (const a of rest) {
      if (a === "--encrypt") encrypt = true;
      else positional.push(a);
    }
    if (positional.length < 1 || positional.length > 2) {
      return errResult("append requires <filename> and optional <text>");
    }
    return { command: "append", filename: positional[0], text: positional[1], encrypt };
  }
  if (first === "rm" || first === "delete") {
    if (rest.length !== 1) return errResult(`${first} requires exactly one <id|filename>`);
    return { command: "rm", target: rest[0] };
  }
  if (first === "mv" || first === "move") {
    if (rest.length !== 2) return errResult(`${first} requires <id|filename> <folder-id|name|--root>`);
    return { command: "mv", target: rest[0], dest: rest[1] };
  }
  if (first === "folders") {
    if (rest.length) return errResult("folders takes no arguments");
    return { command: "folders" };
  }
  if (first === "folder") {
    const sub = rest[0];
    if (sub === undefined || sub === "ls" || sub === "list") {
      if (rest.length > 1) return errResult("usage: freshjots folder ls");
      return { command: "folders" }; // 'folder ls' is an alias for 'folders'
    }
    if (sub === "create" || sub === "new") {
      if (rest.length !== 2 || !rest[1]) return errResult("usage: freshjots folder create <name>");
      return { command: "folder-create", name: rest[1] };
    }
    if (sub === "rename") {
      if (rest.length !== 3 || !rest[1] || !rest[2]) return errResult("usage: freshjots folder rename <id> <new-name>");
      return { command: "folder-rename", id: rest[1], name: rest[2] };
    }
    if (sub === "rm" || sub === "delete") {
      if (rest.length !== 2 || !rest[1]) return errResult("usage: freshjots folder rm <id>");
      return { command: "folder-rm", id: rest[1] };
    }
    // `folder <id>` — show one folder. Name resolution stays on ls/mv only.
    if (rest.length !== 1) return errResult("usage: freshjots folder <id>");
    return { command: "folder-show", id: sub };
  }
  if (first === "update") {
    if (rest.length < 1) return errResult("update requires <note-id> and at least one field flag");
    const parsed = parseNoteAttrs(rest.slice(1));
    if (parsed.error) return errResult(parsed.error);
    return { command: "update", id: rest[0], attrs: parsed.attrs, bodyFromStdin: parsed.bodyFromStdin };
  }
  if (first === "set") {
    if (rest.length < 1) return errResult("set requires <filename> and at least one field flag");
    const parsed = parseNoteAttrs(rest.slice(1));
    if (parsed.error) return errResult(parsed.error);
    return { command: "set", filename: rest[0], attrs: parsed.attrs, bodyFromStdin: parsed.bodyFromStdin };
  }
  if (first === "bulk") {
    // An optional file path; "-" or nothing means read JSON from stdin.
    const files = rest.filter((a) => a !== "-");
    if (files.length > 1) return errResult("usage: freshjots bulk [file.json] (or pipe JSON on stdin)");
    return { command: "bulk", file: files[0] }; // undefined -> stdin
  }
  if (first === "encrypt" || first === "decrypt") {
    if (rest.length) return errResult(`${first} takes no arguments (reads stdin)`);
    return { command: first };
  }
  return errResult(`unknown command: ${first}`);
}

async function readStdin(stdin) {
  if (!stdin || stdin.isTTY) return "";
  let buf = "";
  for await (const chunk of stdin) {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }
  return buf;
}

// The passphrase for --encrypt/--decrypt comes from the environment (never a
// flag or stdin — stdin already carries the note body). Throws if unset.
function getPassphrase(env) {
  const p = env.FRESHJOTS_PASSPHRASE;
  if (!p) throw new Error("FRESHJOTS_PASSPHRASE is not set — required for --encrypt/--decrypt");
  return p;
}

// Decrypt a note body line by line: fj1: lines are decrypted, any other line
// (e.g. a webhook timestamp header) passes through unchanged. Handles both a
// whole-body ciphertext (one line) and an append stream (one ciphertext line
// per entry).
function decryptBody(body, passphrase) {
  return body
    .split("\n")
    .map((line) => (isEncrypted(line) ? decrypt(line, passphrase) : line))
    .join("\n");
}

// A note argument may be a numeric id (used as-is) or a filename/title,
// resolved to an id via the by-filename lookup (which carries .id).
async function resolveNoteId(client, target) {
  if (isNumeric(target)) return target;
  return (await client.note(target)).id;
}

// A folder NAME resolves to its id via GET /folders; ambiguous or unknown
// names are an error (disambiguate with the numeric id).
async function resolveFolderName(client, name) {
  const matches = (await client.folders()).filter((f) => f.name === name);
  if (matches.length === 0) throw new Error(`no folder named '${name}' (see: freshjots folders)`);
  if (matches.length > 1) throw new Error(`ambiguous folder name '${name}' — use its numeric id`);
  return matches[0].id;
}

function printNotes(notes, long, stdout) {
  for (const n of notes) {
    const title = n.title ?? "(untitled)";
    if (long) {
      const lock = n.append_only ? "L" : "-";
      stdout(`${n.id}\t${n.updated_at}\t${lock}\t${n.folder_id ?? "-"}\t${n.filename}\t${title}\n`);
    } else {
      stdout(`${n.id}\t${n.filename}\t${title}\n`);
    }
  }
}

export async function run(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? ((s) => process.stdout.write(s));
  const stderr = deps.stderr ?? ((s) => process.stderr.write(s));
  const stdin = deps.stdin ?? process.stdin;
  const clientFactory = deps.clientFactory ?? ((token) => new Client({ token }));
  const readFileText = deps.readFile ?? ((p) => readFile(p, "utf8"));

  const parsed = parseArgs(argv);

  if (parsed.command === "help") {
    (parsed.exitCode ? stderr : stdout)(USAGE);
    return parsed.exitCode ?? 0;
  }
  if (parsed.command === "version") {
    stdout(`freshjots ${VERSION}\n`);
    return 0;
  }
  if (parsed.command === "error") {
    stderr(`Error: ${parsed.message}\n\n${USAGE}`);
    return 2;
  }

  // Local, offline crypto — no API call, so no token required (only the
  // passphrase). encrypt reads plaintext on stdin and prints an fj1: token;
  // decrypt reads fj1: lines and prints the plaintext.
  if (parsed.command === "encrypt" || parsed.command === "decrypt") {
    let passphrase;
    try {
      passphrase = getPassphrase(env);
    } catch (e) {
      stderr(`Error: ${e.message}\n`);
      return 1;
    }
    const input = await readStdin(stdin);
    if (!input) {
      stderr(`Error: ${parsed.command} reads ${parsed.command === "encrypt" ? "plaintext" : "ciphertext"} on stdin\n`);
      return 2;
    }
    try {
      stdout(parsed.command === "encrypt" ? encrypt(input, passphrase) : decryptBody(input, passphrase));
      return 0;
    } catch (e) {
      stderr(`Error: ${e.message}\n`);
      return 1;
    }
  }

  const token = env.FRESHJOTS_TOKEN;
  if (!token) {
    stderr("Error: FRESHJOTS_TOKEN is not set. Mint one at https://freshjots.com/settings/api_tokens\n");
    return 1;
  }

  let client;
  try {
    client = clientFactory(token);
  } catch (e) {
    stderr(`Error: ${e.message}\n`);
    return 1;
  }

  try {
    if (parsed.command === "list") {
      let folderId;
      if (parsed.folder) {
        if (parsed.folder === "none") folderId = "none";
        else if (isNumeric(parsed.folder)) folderId = parsed.folder;
        else folderId = await resolveFolderName(client, parsed.folder);
      }
      let notes;
      if (parsed.all) {
        notes = [];
        let offset = 0;
        for (;;) {
          const page = await client.notes({ sort: parsed.sort, folderId, limit: 200, offset });
          notes.push(...page);
          if (page.length < 200) break;
          offset += 200;
          if (offset >= 100000) {
            stderr("stopping at 100000 notes (safety cap) — narrow with --folder or --sort\n");
            break;
          }
        }
      } else {
        notes = await client.notes({ sort: parsed.sort, folderId, limit: parsed.limit ?? undefined });
      }
      printNotes(notes, parsed.long, stdout);
      return 0;
    }
    if (parsed.command === "get") {
      stdout(`${JSON.stringify(await client.noteById(parsed.id), null, 2)}\n`);
      return 0;
    }
    if (parsed.command === "show") {
      const note = isNumeric(parsed.target)
        ? await client.noteById(parsed.target)
        : await client.note(parsed.target);
      let body = note.plain_body ?? "";
      if (parsed.decrypt) body = decryptBody(body, getPassphrase(env));
      stdout(body);
      return 0;
    }
    if (parsed.command === "create") {
      let body = parsed.body;
      if (body === undefined) body = await readStdin(stdin);
      const input = { title: parsed.title, body };
      if (parsed.encrypt) {
        input.body = encrypt(body, getPassphrase(env));
        input.client_encrypted = true;
      }
      const created = await client.create(input);
      stdout(`${created.filename}\n`);
      return 0;
    }
    if (parsed.command === "append") {
      let text = parsed.text;
      if (text === undefined) text = await readStdin(stdin);
      if (!text) {
        stderr("Error: append requires text (as an argument or on stdin)\n");
        return 2;
      }
      if (parsed.encrypt) {
        await client.append(parsed.filename, encrypt(text, getPassphrase(env)), { client_encrypted: true });
      } else {
        await client.append(parsed.filename, text);
      }
      return 0;
    }
    if (parsed.command === "rm") {
      await client.remove(await resolveNoteId(client, parsed.target));
      return 0;
    }
    if (parsed.command === "mv") {
      const id = await resolveNoteId(client, parsed.target);
      let folderId;
      if (["--root", "root", "none", "null"].includes(parsed.dest)) folderId = null;
      else if (isNumeric(parsed.dest)) folderId = parsed.dest;
      else folderId = await resolveFolderName(client, parsed.dest);
      await client.move(id, folderId);
      return 0;
    }
    if (parsed.command === "folders") {
      for (const f of await client.folders()) stdout(`${f.id}\t${f.name}\n`);
      return 0;
    }
    if (parsed.command === "folder-create") {
      const f = await client.createFolder(parsed.name);
      stdout(`created folder #${f.id} ${f.name}\n`);
      return 0;
    }
    if (parsed.command === "folder-rename") {
      const f = await client.renameFolder(parsed.id, parsed.name);
      stdout(`renamed folder #${f.id} -> ${f.name}\n`);
      return 0;
    }
    if (parsed.command === "folder-rm") {
      await client.deleteFolder(parsed.id);
      return 0; // silent, like `rm`
    }
    if (parsed.command === "folder-show") {
      stdout(`${JSON.stringify(await client.folder(parsed.id), null, 2)}\n`);
      return 0;
    }
    if (parsed.command === "update" || parsed.command === "set") {
      const attrs = { ...parsed.attrs };
      if (parsed.bodyFromStdin) attrs.plain_body = await readStdin(stdin);
      const note = parsed.command === "update"
        ? await client.update(parsed.id, attrs)
        : await client.set(parsed.filename, attrs);
      stdout(parsed.command === "update"
        ? `updated #${note.id} ${note.filename}\n`
        : `updated ${note.filename}\n`);
      return 0;
    }
    if (parsed.command === "bulk") {
      let raw;
      if (parsed.file !== undefined) {
        raw = await readFileText(parsed.file);
      } else {
        raw = await readStdin(stdin);
        if (!raw) {
          stderr("Error: bulk reads a JSON array of notes from a file arg or stdin\n");
          return 2;
        }
      }
      let json;
      try {
        json = JSON.parse(raw);
      } catch (e) {
        stderr(`Error: bulk input is not valid JSON: ${e.message}\n`);
        return 2;
      }
      let notes;
      if (Array.isArray(json)) notes = json;
      else if (json && Array.isArray(json.notes)) notes = json.notes;
      else {
        stderr('Error: bulk expects a JSON array of notes, or {"notes":[...]}\n');
        return 2;
      }
      if (notes.length > 50) {
        stderr(`Error: max 50 notes per batch (got ${notes.length}). Split the input.\n`);
        return 2;
      }
      const res = await client.bulk(notes);
      stdout(`created ${res.created.length} notes\n`);
      return 0;
    }
  } catch (e) {
    if (e instanceof ApiError) {
      stderr(`Error: HTTP ${e.status} ${e.code}: ${e.message}\n`);
    } else {
      stderr(`Error: ${e.message}\n`);
    }
    return 1;
  }
  return 0;
}
