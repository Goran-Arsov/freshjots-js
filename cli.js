// CLI dispatcher for the `freshjots` command. The shebang entry
// (bin/freshjots.js) is a one-line wrapper around run() so this module
// stays import-safe and testable: parseArgs is pure, run takes its I/O
// surface as deps so tests can stub stdin/stdout/stderr and the Client.

import { Client, ApiError, VERSION } from "./index.js";

const USAGE = `freshjots — Fresh Jots CLI

Usage:
  freshjots list
  freshjots show <filename>
  freshjots create <title> [--body <text>]
  freshjots append <filename> [<text>]
  freshjots --help | --version

Notes:
  - <text> for append and --body for create may also be piped on stdin.
  - Auth: set FRESHJOTS_TOKEN. Mint one at
    https://freshjots.com/settings/api_tokens.
`;

export function parseArgs(argv) {
  if (argv.length === 0) return { command: "help", exitCode: 2 };
  const [first, ...rest] = argv;

  if (first === "-h" || first === "--help" || first === "help") {
    return { command: "help", exitCode: 0 };
  }
  if (first === "-v" || first === "--version" || first === "version") {
    return { command: "version" };
  }
  if (first === "list") {
    if (rest.length) return { command: "error", message: "list takes no arguments" };
    return { command: "list" };
  }
  if (first === "show") {
    if (rest.length !== 1) return { command: "error", message: "show requires exactly one <filename>" };
    return { command: "show", filename: rest[0] };
  }
  if (first === "create") {
    let body;
    const positional = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "--body" || a === "-b") {
        if (i + 1 >= rest.length) return { command: "error", message: "--body requires a value" };
        body = rest[++i];
      } else if (a.startsWith("--body=")) {
        body = a.slice("--body=".length);
      } else {
        positional.push(a);
      }
    }
    if (positional.length !== 1) return { command: "error", message: "create requires exactly one <title>" };
    return { command: "create", title: positional[0], body };
  }
  if (first === "append") {
    if (rest.length < 1 || rest.length > 2) {
      return { command: "error", message: "append requires <filename> and optional <text>" };
    }
    return { command: "append", filename: rest[0], text: rest[1] };
  }
  return { command: "error", message: `unknown command: ${first}` };
}

async function readStdin(stdin) {
  if (!stdin || stdin.isTTY) return "";
  let buf = "";
  for await (const chunk of stdin) {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }
  return buf;
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
      const notes = await client.notes();
      for (const n of notes) stdout(`${n.filename}\t${n.title}\n`);
      return 0;
    }
    if (parsed.command === "show") {
      const note = await client.note(parsed.filename);
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
