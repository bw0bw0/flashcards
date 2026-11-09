import { int, optInt, optStr, str, type Args } from "../args.ts";
import { invalid, type Db } from "../db.ts";
import { nowString } from "../time.ts";

export type DeckKind = "normal" | "sr";

export interface Deck {
  id: number;
  categoryId: number | null;
  categoryName: string | null;
  name: string;
  description: string;
  kind: DeckKind;
  position: number;
  createdAt: string;
  /** Cards owned by the deck, or referenced by it when it is an SR deck. */
  cardCount: number;
  /** SR decks only: cards that are due right now. */
  dueCount: number;
  /** SR decks only: cards that have never been reviewed. */
  newCount: number;
  /** SR decks only: how many new cards may be introduced per day. */
  newPerDay: number;
  /** SR decks only: how many review-state cards may be shown per day. */
  reviewPerDay: number;
}

const DECK_SELECT = `
    SELECT d.id, d.category_id AS categoryId, c.name AS categoryName, d.name, d.description,
           d.kind, d.position, d.created_at AS createdAt,
           CASE WHEN d.kind = 'sr'
                THEN (SELECT COUNT(*) FROM sr_card s WHERE s.sr_deck_id = d.id)
                ELSE (SELECT COUNT(*) FROM card k WHERE k.deck_id = d.id)
           END AS cardCount,
           (SELECT COUNT(*) FROM sr_card s WHERE s.sr_deck_id = d.id AND s.due_at <= :now)
               AS dueCount,
           (SELECT COUNT(*) FROM sr_card s WHERE s.sr_deck_id = d.id AND s.state = 'new')
               AS newCount,
           d.new_per_day AS newPerDay, d.review_per_day AS reviewPerDay
    FROM deck d
    LEFT JOIN category c ON c.id = d.category_id`;

function toDeck(row: Record<string, unknown>): Deck {
  return { ...(row as unknown as Deck), kind: row.kind === "sr" ? "sr" : "normal" };
}

export function read(db: Db, id: number): Deck {
  const row = db.prepare(`${DECK_SELECT} WHERE d.id = :id`).get({ now: nowString(), id });
  if (!row) throw invalid("deck not found");
  return toDeck(row);
}

/**
 * Fails unless the deck exists and has the expected kind, so that e.g. cards
 * are never added directly to a spaced repetition deck.
 */
export function requireKind(db: Db, id: number, kind: DeckKind): void {
  const row = db.prepare("SELECT kind FROM deck WHERE id = ?").get(id) as
    | { kind: string }
    | undefined;
  if (!row) throw invalid("deck not found");
  const actual: DeckKind = row.kind === "sr" ? "sr" : "normal";
  if (actual !== kind) {
    throw invalid(
      kind === "normal" ? "that is a spaced repetition deck" : "that is not a spaced repetition deck",
    );
  }
}

export function list_decks(db: Db): Deck[] {
  return db
    .prepare(
      `${DECK_SELECT} ORDER BY c.position IS NULL, c.position, c.name, d.position, d.name`,
    )
    .all({ now: nowString() })
    .map(toDeck);
}

export function get_deck(db: Db, args: Args): Deck {
  return read(db, int(args, "id"));
}

export function create_deck(db: Db, args: Args): Deck {
  return insertDeck(
    db,
    str(args, "name"),
    optInt(args, "categoryId"),
    optStr(args, "description"),
    "normal",
  );
}

/** Shared by `create_deck` and the spaced repetition deck builder. */
export function insertDeck(
  db: Db,
  name: string,
  categoryId: number | null,
  description: string | null,
  kind: DeckKind,
): Deck {
  name = name.trim();
  if (!name) throw invalid("deck name cannot be empty");
  const { position } = db
    .prepare("SELECT COALESCE(MAX(position), 0) + 1 AS position FROM deck WHERE category_id IS ?")
    .get(categoryId) as { position: number };
  const result = db
    .prepare(
      `INSERT INTO deck (category_id, name, description, kind, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(categoryId, name, description ?? "", kind, position, nowString());
  return read(db, Number(result.lastInsertRowid));
}

export function update_deck(db: Db, args: Args): Deck {
  const id = int(args, "id");
  const name = str(args, "name").trim();
  if (!name) throw invalid("deck name cannot be empty");
  const result = db
    .prepare("UPDATE deck SET name = ?, category_id = ?, description = ? WHERE id = ?")
    .run(name, optInt(args, "categoryId"), optStr(args, "description") ?? "", id);
  if (result.changes === 0) throw invalid("deck not found");
  return read(db, id);
}

/**
 * Deleting a normal deck also deletes its cards, and with them any spaced
 * repetition entries pointing at those cards.
 */
export function delete_deck(db: Db, args: Args): null {
  db.prepare("DELETE FROM deck WHERE id = ?").run(int(args, "id"));
  return null;
}
