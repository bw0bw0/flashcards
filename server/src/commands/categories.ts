import { int, str, type Args } from "../args.ts";
import { invalid, type Db } from "../db.ts";

export interface Category {
  id: number;
  name: string;
  position: number;
}

function read(db: Db, id: number): Category {
  const row = db.prepare("SELECT id, name, position FROM category WHERE id = ?").get(id);
  if (!row) throw invalid("category not found");
  return row as unknown as Category;
}

export function list_categories(db: Db): Category[] {
  return db
    .prepare("SELECT id, name, position FROM category ORDER BY position, name")
    .all() as unknown as Category[];
}

export function create_category(db: Db, args: Args): Category {
  const name = str(args, "name").trim();
  if (!name) throw invalid("category name cannot be empty");
  const { position } = db
    .prepare("SELECT COALESCE(MAX(position), 0) + 1 AS position FROM category")
    .get() as { position: number };
  const result = db
    .prepare("INSERT INTO category (name, position) VALUES (?, ?)")
    .run(name, position);
  return read(db, Number(result.lastInsertRowid));
}

export function update_category(db: Db, args: Args): Category {
  const id = int(args, "id");
  const name = str(args, "name").trim();
  if (!name) throw invalid("category name cannot be empty");
  const result = db.prepare("UPDATE category SET name = ? WHERE id = ?").run(name, id);
  if (result.changes === 0) throw invalid("category not found");
  return read(db, id);
}

/** Deleting a category leaves its decks in place, uncategorised. */
export function delete_category(db: Db, args: Args): null {
  db.prepare("DELETE FROM category WHERE id = ?").run(int(args, "id"));
  return null;
}
