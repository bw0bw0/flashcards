import { bool, int, optStr, selection, str, type Args, type CardSelection } from "../args.ts";
import { invalid, transaction, type Db } from "../db.ts";
import { requireKind } from "./decks.ts";

export interface Card {
  id: number;
  deckId: number;
  /** Position of the card inside its deck, 1-based. */
  index: number;
  front: string;
  back: string;
  comment: string;
  story: string;
}

export const CARD_SELECT =
  "SELECT id, deck_id AS deckId, idx AS \"index\", front, back, comment, story FROM card";

function read(db: Db, id: number): Card {
  const row = db.prepare(`${CARD_SELECT} WHERE id = ?`).get(id);
  if (!row) throw invalid("card not found");
  return row as unknown as Card;
}

function cardsOfDeck(db: Db, deckId: number): Card[] {
  return db
    .prepare(`${CARD_SELECT} WHERE deck_id = ? ORDER BY idx`)
    .all(deckId) as unknown as Card[];
}

/** Resolves a whole-deck or sliced selection into the cards it covers. */
export function cardsInSelection(db: Db, sel: CardSelection): Card[] {
  const from = sel.fromIndex ?? Number.MIN_SAFE_INTEGER;
  const to = sel.toIndex ?? Number.MAX_SAFE_INTEGER;
  if (from > to) throw invalid("slice starts after it ends");
  return db
    .prepare(`${CARD_SELECT} WHERE deck_id = ? AND idx BETWEEN ? AND ? ORDER BY idx`)
    .all(sel.deckId, from, to) as unknown as Card[];
}

/**
 * Renumbers a deck's cards 1..n, keeping their current order. Called after
 * anything that can leave gaps.
 */
export function renumber(db: Db, deckId: number): void {
  db.prepare(
    `WITH ordered AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY idx, id) AS position
         FROM card WHERE deck_id = :deck
     )
     UPDATE card SET idx = (SELECT position FROM ordered WHERE ordered.id = card.id)
     WHERE deck_id = :deck`,
  ).run({ deck: deckId });
}

export function list_cards(db: Db, args: Args): Card[] {
  return cardsOfDeck(db, int(args, "deckId"));
}

/** The cards a story session walks through: a whole deck or a slice of one. */
export function list_selection(db: Db, args: Args): Card[] {
  return cardsInSelection(db, selection(args, "selection"));
}

export function create_card(db: Db, args: Args): Card {
  const deckId = int(args, "deckId");
  const front = str(args, "front");
  if (!front.trim()) throw invalid("the front of a card cannot be empty");
  requireKind(db, deckId, "normal");
  const { idx } = db
    .prepare("SELECT COALESCE(MAX(idx), 0) + 1 AS idx FROM card WHERE deck_id = ?")
    .get(deckId) as { idx: number };
  const result = db
    .prepare(
      `INSERT INTO card (deck_id, idx, front, back, comment, story) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      deckId,
      idx,
      front.trim(),
      optStr(args, "back") ?? "",
      optStr(args, "comment") ?? "",
      optStr(args, "story") ?? "",
    );
  return read(db, Number(result.lastInsertRowid));
}

export function update_card(db: Db, args: Args): Card {
  const id = int(args, "id");
  const front = str(args, "front");
  if (!front.trim()) throw invalid("the front of a card cannot be empty");
  const result = db
    .prepare("UPDATE card SET front = ?, back = ?, comment = ?, story = ? WHERE id = ?")
    .run(
      front.trim(),
      optStr(args, "back") ?? "",
      optStr(args, "comment") ?? "",
      optStr(args, "story") ?? "",
      id,
    );
  if (result.changes === 0) throw invalid("card not found");
  return read(db, id);
}

export function delete_card(db: Db, args: Args): null {
  const id = int(args, "id");
  const row = db.prepare("SELECT deck_id FROM card WHERE id = ?").get(id) as
    | { deck_id: number }
    | undefined;
  if (!row) throw invalid("card not found");
  db.prepare("DELETE FROM card WHERE id = ?").run(id);
  renumber(db, row.deck_id);
  return null;
}

/** Moves a card to a new 1-based position within its deck, returning the deck. */
export function moveWithinDeck(db: Db, id: number, toIndex: number): number {
  const row = db.prepare("SELECT deck_id, idx FROM card WHERE id = ?").get(id) as
    | { deck_id: number; idx: number }
    | undefined;
  if (!row) throw invalid("card not found");
  const { deck_id: deckId, idx: current } = row;
  const { count } = db
    .prepare("SELECT COUNT(*) AS count FROM card WHERE deck_id = ?")
    .get(deckId) as { count: number };
  const target = Math.min(Math.max(toIndex, 1), Math.max(count, 1));
  if (target !== current) {
    // Shift the cards between the old and the new position by one, then
    // drop the moved card into the gap it leaves.
    if (target < current) {
      db.prepare(
        "UPDATE card SET idx = idx + 1 WHERE deck_id = ? AND idx >= ? AND idx < ?",
      ).run(deckId, target, current);
    } else {
      db.prepare(
        "UPDATE card SET idx = idx - 1 WHERE deck_id = ? AND idx > ? AND idx <= ?",
      ).run(deckId, current, target);
    }
    db.prepare("UPDATE card SET idx = ? WHERE id = ?").run(target, id);
  }
  renumber(db, deckId);
  return deckId;
}

export function move_card(db: Db, args: Args): Card[] {
  const deckId = moveWithinDeck(db, int(args, "id"), int(args, "toIndex"));
  return cardsOfDeck(db, deckId);
}

/** Strips a markdown code fence, which is what an LLM usually wraps JSON in. */
export function stripFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  // Drop the (optional) language tag on the opening fence.
  const newline = trimmed.indexOf("\n", 3);
  const rest = newline === -1 ? "" : trimmed.slice(newline + 1);
  const end = rest.trimEnd();
  return (end.endsWith("```") ? end.slice(0, -3) : rest).trim();
}

/**
 * Accepts a bare array, or an object with a `cards` key holding one. Shared
 * with the story reply parser, which LLMs wrap the same way.
 */
export function extractArray(text: string): unknown[] {
  let value: unknown;
  try {
    value = JSON.parse(stripFence(text));
  } catch (error) {
    throw invalid(`that is not valid JSON: ${(error as Error).message}`);
  }
  if (Array.isArray(value)) return value;
  if (typeof value === "object" && value !== null) {
    const cards = (value as Record<string, unknown>).cards;
    if (Array.isArray(cards)) return cards;
    throw invalid("expected a JSON array, or an object with a `cards` array");
  }
  throw invalid("expected a JSON array of cards");
}

/**
 * Reads one field of an imported card, accepting its aliases. Returns
 * `undefined` when the entry is unusable (several aliases at once, or not a
 * string), so the card is skipped.
 */
function aliasedField(item: Record<string, unknown>, names: string[]): string | undefined {
  const present = names.filter((name) => name in item);
  if (present.length === 0) return "";
  if (present.length > 1) return undefined;
  const value = item[present[0]];
  return typeof value === "string" ? value : undefined;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  total: number;
}

/**
 * Imports cards into a normal deck. Cards are numbered in the order they
 * appear, continuing from the end of the deck unless `replace` is set.
 */
export function import_cards(db: Db, args: Args): ImportResult {
  const deckId = int(args, "deckId");
  const replace = bool(args, "replace");
  const items = extractArray(str(args, "json"));
  requireKind(db, deckId, "normal");

  const { imported, skipped } = transaction(db, () => {
    if (replace) db.prepare("DELETE FROM card WHERE deck_id = ?").run(deckId);
    let { idx } = db
      .prepare("SELECT COALESCE(MAX(idx), 0) AS idx FROM card WHERE deck_id = ?")
      .get(deckId) as { idx: number };
    const insert = db.prepare(
      `INSERT INTO card (deck_id, idx, front, back, comment, story) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    let imported = 0;
    let skipped = 0;
    for (const item of items) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        skipped++;
        continue;
      }
      const entry = item as Record<string, unknown>;
      const front = aliasedField(entry, ["front", "term", "question"]);
      const back = aliasedField(entry, ["back", "definition", "answer"]);
      const comment = aliasedField(entry, ["comment", "note", "notes"]);
      const story = aliasedField(entry, ["story"]);
      if (
        front === undefined ||
        back === undefined ||
        comment === undefined ||
        story === undefined ||
        !front.trim()
      ) {
        skipped++;
        continue;
      }
      idx++;
      insert.run(deckId, idx, front.trim(), back.trim(), comment.trim(), story.trim());
      imported++;
    }
    return { imported, skipped };
  });
  renumber(db, deckId);
  const { total } = db
    .prepare("SELECT COUNT(*) AS total FROM card WHERE deck_id = ?")
    .get(deckId) as { total: number };
  return { imported, skipped, total };
}

/** Exports a deck in the same shape `import_cards` accepts. */
export function export_cards(db: Db, args: Args): string {
  const cards = cardsOfDeck(db, int(args, "deckId"));
  return JSON.stringify(
    cards.map((card) => ({
      index: card.index,
      front: card.front,
      back: card.back,
      comment: card.comment,
      story: card.story,
    })),
    null,
    2,
  );
}
