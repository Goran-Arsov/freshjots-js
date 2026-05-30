// CLI dispatcher for the `freshjots` command. The shebang entry
// (bin/freshjots.js) is a one-line wrapper around run() so this module
// stays import-safe and testable: parseArgs is pure, run takes its I/O
// surface as deps so tests can stub stdin/stdout/stderr and the Client.

import { Client, ApiError, VERSION } from "./index.js";

const USAGE = `freshjots — Fresh Jots CLI

Usage:
  freshjots ls [flags]                 List notes as id<TAB>filename<TAB>title.
                                         -n N | --limit N
                                         --sort created|updated|appended
                                         --folder <id|name> | --root
                                         --all      fetch every page (past the 200 cap)
                                         -l|--long  id, updated_at, lock, folder, name, title
  freshjots get <id>                   Print a note as JSON (full metadata).
  freshjots cat <id|filename>          Print a note's body.
  freshjots create <title> [--body <text>]
  freshjots append <filename> [<text>]
  freshjots rm <id|filename>           Delete a note.
  freshjots mv <id|filename> <folder-id|name|--root>
  freshjots folders                    List folders as id<TAB>name.
  freshjots --help | --version

Notes:
  - <text> for append and --body for create may also be piped on stdin.
  - Auth: set FRESHJOTS_TOKEN. Mint one at
    https://freshjots.com/settings/api_tokens.
`;

const isNumeric = (s) => /^\d+$/.test(s);
const errResult = (message) => ({ command: "error", message });

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
    if (rest.length !== 1) return errResult(`${first} requires exactly one <id|filename>`);
    return { command: "show", target: rest[0] };
  }
  if (first === "create") {
    let body;
    const positional = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "--body" || a === "-b") {
        if (i + 1 >= rest.length) return errResult("--body requires a value");
        body = rest[++i];
      } else if (a.startsWith("--body=")) {
        body = a.slice("--body=".length);
      } else {
        positional.push(a);
      }
    }
    if (positional.length !== 1) return errResult("create requires exactly one <title>");
    return { command: "create", title: positional[0], body };
  }
  if (first === "append") {
    if (rest.length < 1 || rest.length > 2) {
      return errResult("append requires <filename> and optional <text>");
    }
    return { command: "append", filename: rest[0], text: rest[1] };
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
      stdout(note.plain_body ?? "");
      return 0;
    }
    if (parsed.command === "create") {
      let body = parsed.body;
      if (body === undefined) body = await readStdin(stdin);
      const created = await client.create({ title: parsed.title, body });
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
      await client.append(parsed.filename, text);
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
