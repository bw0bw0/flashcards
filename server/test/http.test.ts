import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createApp } from "../src/http.ts";
import { Store } from "../src/store.ts";

let dir: string;
let store: Store;
let base: string;
let close: () => Promise<void>;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "flashcards-test-"));
  store = new Store(join(dir, "server", "flashcards.db"));
  const server = createApp(store);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((resolve) => server.close(() => resolve()));
});

after(async () => {
  await close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
async function post(command: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/${command}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test("health reports an empty server", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const body: any = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.app, "flashcards");
  assert.equal(body.empty, true);
});

test("commands run and errors come back as JSON", async () => {
  const created = await post("create_category", { name: "Japanese" });
  assert.equal(created.status, 200);
  assert.equal(created.body.name, "Japanese");

  const listed = await post("list_categories", {});
  assert.deepEqual(listed.body.map((c: { name: string }) => c.name), ["Japanese"]);

  assert.deepEqual(await post("delete_category", { id: created.body.id }), {
    status: 200,
    body: null,
  });

  const invalid = await post("create_category", { name: " " });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, "category name cannot be empty");

  const unknown = await post("drop_everything", {});
  assert.equal(unknown.status, 404);

  const res = await fetch(`${base}/api/list_decks`);
  assert.equal(res.status, 405);
});

test("cross-origin preflight is allowed", async () => {
  const res = await fetch(`${base}/api/list_decks`, {
    method: "OPTIONS",
    headers: { Origin: "http://tauri.localhost", "Access-Control-Request-Method": "POST" },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

/** A database as the old app left it: migrations up to 0002, data in the WAL. */
function legacyDatabase(): { database: string; wal: string | null; cleanup: () => void } {
  const legacyDir = mkdtempSync(join(tmpdir(), "flashcards-legacy-"));
  const path = join(legacyDir, "flashcards.db");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA wal_autocheckpoint = 0");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of ["0001_initial.sql", "0002_sr_daily_limits.sql"]) {
    db.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  db.exec("PRAGMA user_version = 2");
  db.exec("INSERT INTO deck (name, kind, created_at) VALUES ('Old deck', 'normal', '2026-01-01T00:00:00Z')");
  db.exec("INSERT INTO card (deck_id, idx, front) VALUES (1, 1, 'old card')");
  // Read the files while the connection is still open, like copying them off
  // a phone where the app never checkpointed.
  const database = readFileSync(path).toString("base64");
  const wal = existsSync(`${path}-wal`) ? readFileSync(`${path}-wal`).toString("base64") : null;
  return {
    database,
    wal,
    cleanup: () => {
      db.close();
      rmSync(legacyDir, { recursive: true, force: true });
    },
  };
}

test("an old local database can be imported, WAL included", async () => {
  const legacy = legacyDatabase();
  try {
    assert.ok(legacy.wal, "test setup: the data should still be in the WAL");

    // The server has data from the earlier tests? Make sure, then check that
    // importing over it needs `force`.
    await post("create_story_prompt", { name: "Keep", prompt: "me" });
    const refused = await post("import_database", { database: legacy.database, wal: legacy.wal });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /already has data/);

    const imported = await post("import_database", {
      database: legacy.database,
      wal: legacy.wal,
      force: true,
    });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    assert.ok(imported.body.backup && existsSync(imported.body.backup));

    const decks = await post("list_decks", {});
    assert.deepEqual(decks.body.map((d: { name: string }) => d.name), ["Old deck"]);
    const cards = await post("list_cards", { deckId: decks.body[0].id });
    assert.equal(cards.body[0].front, "old card");
    assert.equal((await post("list_story_prompts", {})).body.length, 0);

    // The imported database was migrated to the current schema.
    const version = store.db.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(version.user_version, 3);
    // No scratch directories left behind.
    assert.deepEqual(
      readdirSync(join(dir, "server")).filter((name) => name.startsWith(".import-")),
      [],
    );
  } finally {
    legacy.cleanup();
  }
});

test("garbage is not imported", async () => {
  const res = await post("import_database", {
    database: Buffer.from("definitely not sqlite").toString("base64"),
    force: true,
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /not an SQLite database/);
  assert.equal((await post("list_decks", {})).body.length, 1);
});
