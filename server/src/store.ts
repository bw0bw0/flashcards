import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join } from "node:path";

import { invalid, isEmpty, migrate, openDb, type Db } from "./db.ts";

/** The server's database, which an import can swap out for another file. */
export class Store {
  readonly path: string;
  private current: Db;

  constructor(path: string) {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.current = openDb(path);
  }

  get db(): Db {
    return this.current;
  }

  close(): void {
    this.current.close();
  }

  /**
   * Replaces the server's data with a database file from the old,
   * local-only version of the app (same schema, possibly older migrations).
   * `wal` is that database's write-ahead log, which can hold recent changes
   * that were never copied into the main file.
   *
   * Refuses to overwrite a server that already has data unless `force` is
   * set; the previous database is kept next to it as a backup either way.
   */
  importDatabase(database: Buffer, wal: Buffer | null, force: boolean): { backup: string | null } {
    if (this.path === ":memory:") throw invalid("cannot import into an in-memory database");
    if (database.subarray(0, 16).toString("latin1") !== "SQLite format 3\0") {
      throw invalid("that is not an SQLite database");
    }
    if (!force && !isEmpty(this.current)) {
      throw invalid("the server already has data; import it anyway to replace it");
    }

    // Recover the upload (database + WAL) in a scratch directory, check it,
    // bring its schema up to date and fold the WAL into the main file.
    const scratch = mkdtempSync(join(dirname(this.path), ".import-"));
    const staged = join(scratch, basename(this.path));
    try {
      writeFileSync(staged, database);
      if (wal) writeFileSync(`${staged}-wal`, wal);
      const incoming = new DatabaseSync(staged);
      try {
        const check = incoming.prepare("PRAGMA quick_check").get() as Record<string, string>;
        if (Object.values(check)[0] !== "ok") throw invalid("that database is damaged");
        const hasDecks = incoming
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'deck'")
          .get();
        if (!hasDecks) throw invalid("that is not a flashcards database");
        incoming.exec("PRAGMA foreign_keys = ON");
        migrate(incoming);
        incoming.exec("PRAGMA journal_mode = DELETE");
      } finally {
        incoming.close();
      }

      // Swap it in, keeping the old database as a backup.
      this.current.close();
      let backup: string | null = null;
      try {
        if (existsSync(this.path)) {
          backup = `${this.path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
          const old = new DatabaseSync(this.path);
          old.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          old.close();
          copyFileSync(this.path, backup);
        }
        for (const suffix of ["-wal", "-shm"]) rmSync(`${this.path}${suffix}`, { force: true });
        renameSync(staged, this.path);
      } finally {
        this.current = openDb(this.path);
      }
      return { backup };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
