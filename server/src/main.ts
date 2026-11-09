import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { createApp, VERSION } from "./http.ts";
import { Store } from "./store.ts";

const { values } = parseArgs({
  options: {
    db: { type: "string" },
    host: { type: "string" },
    port: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`Flashcards server ${VERSION}

Usage: node src/main.ts [--db PATH] [--host HOST] [--port PORT]

  --db    SQLite database file (default: $FLASHCARDS_DB, or
          ~/.local/share/flashcards-server/flashcards.db)
  --host  address to listen on (default: $FLASHCARDS_HOST or 127.0.0.1)
  --port  port to listen on (default: $FLASHCARDS_PORT or 8787)

Days roll over at 4am in the server's time zone (set TZ to change it).`);
  process.exit(0);
}

const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
const dbPath = resolve(
  values.db ?? process.env.FLASHCARDS_DB ?? join(dataHome, "flashcards-server", "flashcards.db"),
);
const host = values.host ?? process.env.FLASHCARDS_HOST ?? "127.0.0.1";
const port = Number(values.port ?? process.env.FLASHCARDS_PORT ?? 8787);

const store = new Store(dbPath);
const server = createApp(store, (line) => console.log(`${new Date().toISOString()} ${line}`));
server.listen(port, host, () => {
  console.log(`Flashcards server ${VERSION} listening on http://${host}:${port}`);
  console.log(`Database: ${dbPath}`);
});

function shutdown(): void {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
