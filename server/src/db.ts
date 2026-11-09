import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

/** A problem with the request (bad input, missing row, wrong deck kind, ...). */
export class InvalidError extends Error {}

export function invalid(message: string): InvalidError {
  return new InvalidError(message);
}

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

/** Ordered list of migrations. Never edit an existing one, only add new ones. */
export const MIGRATIONS: string[] = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFileSync(new URL(name, MIGRATIONS_DIR), "utf8"));

/** Opens (creating if needed) a database and brings its schema up to date. */
export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  MIGRATIONS.forEach((sql, i) => {
    const target = i + 1;
    if (version >= target) return;
    transaction(db, () => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${target}`);
    });
  });
}

/** Runs `fn` in a transaction, rolling back if it throws. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Whether the database holds anything the user made. */
export function isEmpty(db: Db): boolean {
  const row = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM deck) + (SELECT COUNT(*) FROM category)
            + (SELECT COUNT(*) FROM story_prompt) AS n`,
    )
    .get() as { n: number };
  return row.n === 0;
}
