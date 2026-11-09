import { int, selection, str, type Args } from "../args.ts";
import { invalid, transaction, type Db } from "../db.ts";
import { nowString } from "../time.ts";
import { cardsInSelection, extractArray } from "./cards.ts";
import { read as readDeck } from "./decks.ts";

export interface StoryPrompt {
  id: number;
  name: string;
  prompt: string;
  createdAt: string;
}

const PROMPT_SELECT = "SELECT id, name, prompt, created_at AS createdAt FROM story_prompt";

function read(db: Db, id: number): StoryPrompt {
  const row = db.prepare(`${PROMPT_SELECT} WHERE id = ?`).get(id);
  if (!row) throw invalid("story prompt not found");
  return row as unknown as StoryPrompt;
}

export function list_story_prompts(db: Db): StoryPrompt[] {
  return db.prepare(`${PROMPT_SELECT} ORDER BY name`).all() as unknown as StoryPrompt[];
}

export function create_story_prompt(db: Db, args: Args): StoryPrompt {
  const name = str(args, "name").trim();
  const prompt = str(args, "prompt");
  if (!name) throw invalid("give the prompt a name");
  if (!prompt.trim()) throw invalid("the prompt cannot be empty");
  const result = db
    .prepare("INSERT INTO story_prompt (name, prompt, created_at) VALUES (?, ?, ?)")
    .run(name, prompt.trim(), nowString());
  return read(db, Number(result.lastInsertRowid));
}

export function update_story_prompt(db: Db, args: Args): StoryPrompt {
  const id = int(args, "id");
  const name = str(args, "name").trim();
  const prompt = str(args, "prompt");
  if (!name) throw invalid("give the prompt a name");
  const result = db
    .prepare("UPDATE story_prompt SET name = ?, prompt = ? WHERE id = ?")
    .run(name, prompt.trim(), id);
  if (result.changes === 0) throw invalid("story prompt not found");
  return read(db, id);
}

export function delete_story_prompt(db: Db, args: Args): null {
  db.prepare("DELETE FROM story_prompt WHERE id = ?").run(int(args, "id"));
  return null;
}

/**
 * The instructions appended to every story request, so that whatever comes
 * back can be pasted straight into `apply_story_response`.
 */
const RESPONSE_FORMAT = `## How to answer

Reply with JSON and nothing else: no greeting, no explanation, no markdown fence.
The reply must be a single array whose elements are objects with exactly two keys:

  "index" - the index of the card the story belongs to, copied from the input
  "story" - the story text for that card, as one string (use \\n for line breaks)

Write one object per input card and keep them in the input order. Example:

[{"index": 1, "story": "..."}, {"index": 2, "story": "..."}]`;

export interface StoryRequest {
  /** The full text to put on the clipboard. */
  text: string;
  cardCount: number;
}

/**
 * Builds the text the user pastes into an LLM: the chosen prompt, the response
 * format, and the selected cards as JSON.
 */
export function build_story_request(db: Db, args: Args): StoryRequest {
  const prompt = read(db, int(args, "promptId"));
  const sel = selection(args, "selection");
  const deck = readDeck(db, sel.deckId);
  const cards = cardsInSelection(db, sel);
  if (cards.length === 0) throw invalid("that selection has no cards");

  // The index the reply must echo back comes first.
  const payload = cards.map((card) => ({
    index: card.index,
    front: card.front,
    back: card.back,
    comment: card.comment,
  }));

  const first = cards[0];
  const last = cards[cards.length - 1];
  const range =
    first.index !== last.index ? ` (cards ${first.index}-${last.index})` : ` (card ${first.index})`;
  const category = deck.categoryName !== null ? `${deck.categoryName} / ` : "";

  const text =
    `## Instructions\n\n${prompt.prompt.trim()}\n\n${RESPONSE_FORMAT}\n\n` +
    `## Cards\n\nDeck: ${category}${deck.name}${range}\n\n${JSON.stringify(payload, null, 2)}\n`;
  return { text, cardCount: cards.length };
}

export interface ApplyResult {
  updated: number;
  /** Entries that did not match a card in the deck, described for the user. */
  unmatched: string[];
}

interface StoryReply {
  index: number | null;
  front: string | null;
  story: string;
}

/** Mirrors the Rust (serde) parsing: wrong types make the entry unusable. */
function parseReply(item: unknown): StoryReply | null {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
  const v = item as Record<string, unknown>;
  const index = v.index ?? null;
  const front = v.front ?? null;
  const story = "story" in v ? v.story : "";
  if (index !== null && !Number.isSafeInteger(index)) return null;
  if (front !== null && typeof front !== "string") return null;
  if (typeof story !== "string") return null;
  return { index: index as number | null, front: front as string | null, story };
}

/** Compact JSON with sorted keys, matching how serde_json prints a value. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

function describe(reply: StoryReply): string {
  if (reply.index !== null && reply.front !== null) return `#${reply.index} "${reply.front}"`;
  if (reply.index !== null) return `#${reply.index}`;
  if (reply.front !== null) return `"${reply.front}"`;
  return "an entry without an index or front";
}

/**
 * Attaches the stories from an LLM reply to the cards of a deck. Entries are
 * matched on the card index, falling back to an exact match on the front.
 */
export function apply_story_response(db: Db, args: Args): ApplyResult {
  const deckId = int(args, "deckId");
  const items = extractArray(str(args, "response"));
  return transaction(db, () => {
    let updated = 0;
    const unmatched: string[] = [];
    const byIndex = db.prepare("UPDATE card SET story = ? WHERE deck_id = ? AND idx = ?");
    const byFront = db.prepare(
      "UPDATE card SET story = ? WHERE deck_id = ? AND lower(trim(front)) = lower(?)",
    );
    for (const item of items) {
      const reply = parseReply(item);
      if (!reply) {
        unmatched.push(canonicalJson(item));
        continue;
      }
      const story = reply.story.trim();
      if (!story) {
        unmatched.push(describe(reply));
        continue;
      }
      let changed =
        reply.index !== null ? Number(byIndex.run(story, deckId, reply.index).changes) : 0;
      if (changed === 0) {
        const front = reply.front?.trim();
        if (front) changed = Number(byFront.run(story, deckId, front).changes);
      }
      if (changed === 0) unmatched.push(describe(reply));
      else updated += changed;
    }
    return { updated, unmatched };
  });
}
