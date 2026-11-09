import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { COMMANDS } from "./commands/index.ts";
import { InvalidError, isEmpty } from "./db.ts";
import type { Store } from "./store.ts";

export const VERSION = "0.2.0";

/** Commands carry small JSON; database imports can be larger. */
const MAX_BODY = 10 * 1024 * 1024;
const MAX_IMPORT_BODY = 512 * 1024 * 1024;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, "request too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const body = (await readBody(req, limit)).toString("utf8").trim();
  if (!body) return {};
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new HttpError(400, "the request body is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "the request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body === undefined ? null : body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}

/**
 * The app's API: `POST /api/<command>` with the command's arguments as a JSON
 * object, answering with the command's result as JSON, or `{ "error": "..." }`
 * with a 4xx/5xx status.
 *
 * There is no authentication: the server is meant to listen on localhost and
 * be reached through `tailscale serve`, so only devices on the tailnet can
 * talk to it.
 */
export function createApp(store: Store, log: (line: string) => void = () => {}): Server {
  return createServer(async (req, res) => {
    // The app's web view runs on its own origin, so allow cross-origin calls.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const started = Date.now();
    try {
      if (url.pathname === "/api/health" && req.method === "GET") {
        send(res, 200, { ok: true, app: "flashcards", version: VERSION, empty: isEmpty(store.db) });
        return;
      }

      const match = /^\/api\/([a-z_]+)$/.exec(url.pathname);
      if (!match) throw new HttpError(404, "not found");
      if (req.method !== "POST") throw new HttpError(405, "use POST");
      const name = match[1];

      if (name === "import_database") {
        const args = await readJson(req, MAX_IMPORT_BODY);
        if (typeof args.database !== "string") {
          throw new HttpError(400, "missing `database` (base64)");
        }
        const wal = typeof args.wal === "string" ? Buffer.from(args.wal, "base64") : null;
        const result = store.importDatabase(
          Buffer.from(args.database, "base64"),
          wal,
          args.force === true,
        );
        log(`imported a database${result.backup ? `, previous data kept in ${result.backup}` : ""}`);
        send(res, 200, result);
        return;
      }

      const command = COMMANDS[name];
      if (!command) throw new HttpError(404, `unknown command \`${name}\``);
      const args = await readJson(req, MAX_BODY);
      send(res, 200, command(store.db, args));
      log(`${name} ${Date.now() - started}ms`);
    } catch (error) {
      if (error instanceof HttpError) {
        send(res, error.status, { error: error.message });
      } else if (error instanceof InvalidError) {
        send(res, 400, { error: error.message });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        log(`error in ${url.pathname}: ${error instanceof Error ? error.stack : message}`);
        send(res, 500, { error: `database error: ${message}` });
      }
    }
  });
}
