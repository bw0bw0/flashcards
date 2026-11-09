// End-to-end tests over the command layer, against a real (in-memory) SQLite.
// Ported from the Rust backend's tests.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Args } from "../src/args.ts";
import { COMMANDS } from "../src/commands/index.ts";
import { moveWithinDeck, renumber, stripFence, extractArray, cardsInSelection } from "../src/commands/cards.ts";
import { humanise } from "../src/commands/sr.ts";
import { MIGRATIONS, migrate, openDb, type Db } from "../src/db.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
function call(db: Db, name: string, args: Args = {}): any {
  return COMMANDS[name](db, args);
}

const fresh = () => openDb(":memory:");
const whole = (deckId: number) => ({ deckId, fromIndex: null, toIndex: null });
const slice = (deckId: number, fromIndex: number, toIndex: number) => ({ deckId, fromIndex, toIndex });

/** A deck of `count` cards named "front 1", "front 2", ... */
function deckWithCards(db: Db, name: string, count: number): number {
  const deck = call(db, "create_deck", { name, categoryId: null, description: null });
  const json = JSON.stringify(
    Array.from({ length: count }, (_, i) => ({ front: `front ${i + 1}`, back: `back ${i + 1}` })),
  );
  const result = call(db, "import_cards", { deckId: deck.id, json, replace: false });
  assert.equal(result.imported, count);
  return deck.id;
}

function srDeck(db: Db, source: number): number {
  return call(db, "create_sr_deck", {
    name: "Daily",
    categoryId: null,
    description: null,
    selections: [whole(source)],
  }).id;
}

// ---- db

test("migrations apply and are idempotent", () => {
  const db = fresh();
  const { user_version } = db.prepare("PRAGMA user_version").get() as any;
  assert.equal(user_version, MIGRATIONS.length);
  migrate(db);
  assert.equal((db.prepare("PRAGMA user_version").get() as any).user_version, MIGRATIONS.length);
});

test("deleting a deck cascades to its cards", () => {
  const db = fresh();
  db.exec("INSERT INTO deck (id, name, kind, created_at) VALUES (1, 'd', 'normal', '')");
  db.exec("INSERT INTO card (deck_id, idx, front) VALUES (1, 1, 'a')");
  db.exec("DELETE FROM deck WHERE id = 1");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM card").get() as any).n, 0);
});

// ---- cards internals

function seeded(): Db {
  const db = fresh();
  db.exec("INSERT INTO deck (id, name, kind, created_at) VALUES (1, 'deck', 'normal', '')");
  for (let i = 1; i <= 5; i++) {
    db.prepare("INSERT INTO card (deck_id, idx, front) VALUES (1, ?, ?)").run(i, `card ${i}`);
  }
  return db;
}

const fronts = (db: Db) =>
  (db.prepare("SELECT front FROM card WHERE deck_id = 1 ORDER BY idx").all() as any[]).map(
    (r) => r.front,
  );
const idAt = (db: Db, idx: number) =>
  (db.prepare("SELECT id FROM card WHERE deck_id = 1 AND idx = ?").get(idx) as any).id;

test("a slice covers an inclusive range", () => {
  const db = seeded();
  assert.deepEqual(
    cardsInSelection(db, slice(1, 2, 4)).map((c) => c.index),
    [2, 3, 4],
  );
  assert.equal(cardsInSelection(db, whole(1)).length, 5);
});

test("renumber closes gaps", () => {
  const db = seeded();
  db.exec("DELETE FROM card WHERE idx IN (2, 4)");
  renumber(db, 1);
  assert.deepEqual(
    (db.prepare("SELECT idx FROM card WHERE deck_id = 1 ORDER BY idx").all() as any[]).map(
      (r) => r.idx,
    ),
    [1, 2, 3],
  );
});

test("moving a card shifts the others", () => {
  let db = seeded();
  moveWithinDeck(db, idAt(db, 4), 1);
  assert.deepEqual(fronts(db), ["card 4", "card 1", "card 2", "card 3", "card 5"]);

  db = seeded();
  moveWithinDeck(db, idAt(db, 2), 5);
  assert.deepEqual(fronts(db), ["card 1", "card 3", "card 4", "card 5", "card 2"]);

  db = seeded();
  const id = idAt(db, 3);
  moveWithinDeck(db, id, 99);
  assert.equal(fronts(db).at(-1), "card 3");
  moveWithinDeck(db, id, -5);
  assert.equal(fronts(db)[0], "card 3");
});

test("strips markdown fences and accepts wrapped arrays", () => {
  assert.equal(stripFence("```json\n[1]\n```"), "[1]");
  assert.equal(stripFence("```\n[1]\n```"), "[1]");
  assert.equal(stripFence("  [1]  "), "[1]");
  assert.equal(extractArray('[{"front":"a"}]').length, 1);
  assert.equal(extractArray('{"cards":[{"front":"a"},{"front":"b"}]}').length, 2);
  assert.throws(() => extractArray('{"nope":1}'));
  assert.throws(() => extractArray("not json"));
});

// ---- commands

test("decks are grouped under their category", () => {
  const db = fresh();
  const category = call(db, "create_category", { name: "Japanese" });
  const deck = call(db, "create_deck", {
    name: "Verbs",
    categoryId: category.id,
    description: "group 1",
  });
  const listed = call(db, "list_decks");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, "Verbs");
  assert.equal(listed[0].categoryName, "Japanese");
  assert.equal(listed[0].kind, "normal");

  call(db, "delete_category", { id: category.id });
  assert.equal(call(db, "get_deck", { id: deck.id }).categoryId, null);
});

test("importing numbers cards in order", () => {
  const db = fresh();
  const deckId = deckWithCards(db, "Kanji", 3);
  assert.deepEqual(
    call(db, "list_cards", { deckId }).map((c: any) => [c.index, c.front]),
    [
      [1, "front 1"],
      [2, "front 2"],
      [3, "front 3"],
    ],
  );
  call(db, "import_cards", { deckId, json: '[{"front":"extra"}]', replace: false });
  assert.equal(call(db, "list_cards", { deckId }).at(-1).index, 4);
  const replaced = call(db, "import_cards", { deckId, json: '[{"front":"only"}]', replace: true });
  assert.equal(replaced.total, 1);
  assert.equal(call(db, "list_cards", { deckId })[0].index, 1);
});

test("imports accept aliases and skip unusable entries", () => {
  const db = fresh();
  const deckId = deckWithCards(db, "Kanji", 0);
  const result = call(db, "import_cards", {
    deckId,
    json: JSON.stringify([
      { term: "t", definition: "d", notes: "n" },
      { front: "a", term: "b" },
      { front: 3 },
      "nope",
      { front: "  " },
    ]),
    replace: false,
  });
  assert.deepEqual(result, { imported: 1, skipped: 4, total: 1 });
  assert.equal(call(db, "list_cards", { deckId })[0].comment, "n");
});

test("categories and decks survive a round trip", () => {
  const db = fresh();
  const category = call(db, "create_category", { name: " Japanese " });
  assert.equal(category.name, "Japanese");
  assert.throws(() => call(db, "create_category", { name: "  " }));
  assert.equal(call(db, "update_category", { id: category.id, name: "Nihongo" }).name, "Nihongo");
  assert.equal(call(db, "list_categories").length, 1);

  const deck = call(db, "create_deck", { name: "Verbs", categoryId: null, description: null });
  const moved = call(db, "update_deck", {
    id: deck.id,
    name: "Verbs I",
    categoryId: category.id,
    description: "group 1",
  });
  assert.equal(moved.name, "Verbs I");
  assert.equal(moved.categoryName, "Nihongo");
  assert.equal(moved.description, "group 1");

  call(db, "delete_deck", { id: deck.id });
  assert.equal(call(db, "list_decks").length, 0);
  assert.throws(() => call(db, "get_deck", { id: deck.id }));
});

test("cards can be edited, reordered and exported", () => {
  const db = fresh();
  const deckId = deckWithCards(db, "Kanji", 3);
  const card = call(db, "list_cards", { deckId })[0];
  const updated = call(db, "update_card", {
    id: card.id,
    front: "水",
    back: "water",
    comment: "mizu",
    story: "a river runs through it",
  });
  assert.equal(updated.front, "水");
  assert.equal(updated.story, "a river runs through it");
  assert.throws(() => call(db, "update_card", { id: card.id, front: "  " }));

  const reordered = call(db, "move_card", { id: card.id, toIndex: 3 });
  assert.equal(reordered.at(-1).front, "水");
  assert.equal(reordered.at(-1).index, 3);

  const picked = call(db, "list_selection", { selection: slice(deckId, 3, 3) });
  assert.equal(picked.length, 1);
  assert.equal(picked[0].front, "水");

  const exported: string = call(db, "export_cards", { deckId });
  assert.ok(exported.includes('"story": "a river runs through it"'));
  assert.ok(exported.includes('"index": 1,\n    "front"'));

  const copy = call(db, "create_deck", { name: "Copy", categoryId: null, description: null });
  assert.equal(call(db, "import_cards", { deckId: copy.id, json: exported, replace: false }).imported, 3);
  assert.equal(call(db, "list_cards", { deckId: copy.id })[2].front, "水");
});

test("story prompts survive a round trip", () => {
  const db = fresh();
  const prompt = call(db, "create_story_prompt", { name: "Mnemonics", prompt: "Be vivid." });
  assert.throws(() => call(db, "create_story_prompt", { name: "Empty", prompt: "  " }));
  const renamed = call(db, "update_story_prompt", {
    id: prompt.id,
    name: "Vivid",
    prompt: "Be brief.",
  });
  assert.equal(renamed.name, "Vivid");
  assert.equal(renamed.prompt, "Be brief.");
  assert.equal(call(db, "list_story_prompts").length, 1);
  call(db, "delete_story_prompt", { id: prompt.id });
  assert.equal(call(db, "list_story_prompts").length, 0);
});

test("removing a card from an SR deck leaves the original alone", () => {
  const db = fresh();
  const source = deckWithCards(db, "Source", 3);
  const sr = srDeck(db, source);
  const members = call(db, "list_sr_cards", { srDeckId: sr });
  assert.equal(call(db, "remove_sr_cards", { srCardIds: [members[0].id, members[1].id] }), 2);
  assert.equal(call(db, "list_sr_cards", { srDeckId: sr }).length, 1);
  assert.equal(call(db, "list_cards", { deckId: source }).length, 3);
});

test("cards cannot be added to a spaced repetition deck", () => {
  const db = fresh();
  const source = deckWithCards(db, "Source", 1);
  const sr = srDeck(db, source);
  assert.throws(() => call(db, "create_card", { deckId: sr, front: "nope" }));
  assert.throws(() => call(db, "import_cards", { deckId: sr, json: "[]", replace: false }));
});

test("an SR deck is built from decks and slices", () => {
  const db = fresh();
  const first = deckWithCards(db, "First", 10);
  const second = deckWithCards(db, "Second", 4);
  const sr = call(db, "create_sr_deck", {
    name: "Mix",
    categoryId: null,
    description: null,
    selections: [slice(first, 1, 5), whole(second)],
  });
  assert.equal(sr.kind, "sr");
  const members = call(db, "list_sr_cards", { srDeckId: sr.id });
  assert.equal(members.length, 9);
  assert.ok(members.every((m: any) => m.state === "new"));
  assert.equal(members[0].sourceDeckName, "First");

  // Overlapping slices only add what is not there yet.
  assert.equal(call(db, "add_to_sr_deck", { srDeckId: sr.id, selections: [slice(first, 4, 7)] }), 2);
  assert.equal(call(db, "list_sr_cards", { srDeckId: sr.id }).length, 11);
  const listed = call(db, "get_deck", { id: sr.id });
  assert.equal(listed.cardCount, 11);
  assert.equal(listed.newCount, 11);
});

test("deleting a source card removes it from SR decks", () => {
  const db = fresh();
  const source = deckWithCards(db, "Source", 3);
  const sr = srDeck(db, source);
  call(db, "delete_card", { id: call(db, "list_cards", { deckId: source })[1].id });
  assert.equal(call(db, "list_sr_cards", { srDeckId: sr }).length, 2);
  assert.equal(call(db, "list_cards", { deckId: source })[1].index, 2);
});

test("grading moves a card through the queue", () => {
  const db = fresh();
  const source = deckWithCards(db, "Source", 2);
  const sr = srDeck(db, source);
  const queue = call(db, "sr_queue", { srDeckId: sr });
  assert.equal(queue.length, 2);

  // Easy graduates a new card straight into the review queue, days away.
  const result = call(db, "grade_sr_card", { srCardId: queue[0].id, grade: "easy" });
  assert.equal(result.card.state, "review");
  assert.ok(result.card.intervalDays >= 3 && result.card.intervalDays <= 5);
  assert.equal(result.nextDueIn, `${result.card.intervalDays}d`);

  let stats = call(db, "sr_deck_stats", { srDeckId: sr });
  assert.equal(stats.total, 2);
  assert.equal(stats.due, 1);
  assert.equal(stats.new, 1);
  assert.equal(stats.review, 1);
  assert.equal(stats.reviewedToday, 1);

  // Again keeps the other card in the session: it is not due yet, but the
  // queue reaches a little way into the future for learning cards.
  const again = call(db, "grade_sr_card", { srCardId: queue[1].id, grade: "again" });
  assert.equal(again.card.state, "learning");
  const next = call(db, "sr_queue", { srDeckId: sr });
  assert.equal(next.length, 1);
  assert.equal(next[0].id, again.card.id);

  call(db, "reset_sr_card", { srCardId: again.card.id });
  stats = call(db, "sr_deck_stats", { srDeckId: sr });
  assert.equal(stats.new, 1);
  assert.equal(stats.learning, 0);
});

test("a card graded again does not immediately repeat while others are available", () => {
  const db = fresh();
  const sr = srDeck(db, deckWithCards(db, "Source", 3));
  const queue = call(db, "sr_queue", { srDeckId: sr });
  assert.equal(queue.length, 3);
  call(db, "grade_sr_card", { srCardId: queue[0].id, grade: "again" });
  const next = call(db, "sr_queue", { srDeckId: sr });
  assert.equal(next.length, 2);
  assert.ok(next.every((c: any) => c.id !== queue[0].id));
});

test("the queue only offers cards that are due", () => {
  const db = fresh();
  const source = deckWithCards(db, "Source", 1);
  const sr = srDeck(db, source);
  call(db, "grade_sr_card", { srCardId: call(db, "sr_queue", { srDeckId: sr })[0].id, grade: "easy" });
  assert.equal(call(db, "sr_queue", { srDeckId: sr }).length, 0);
  assert.throws(() => call(db, "sr_queue", { srDeckId: source }));
});

test("new cards trickle in by the daily limit", () => {
  const db = fresh();
  const sr = srDeck(db, deckWithCards(db, "Source", 10));
  call(db, "update_sr_deck_settings", { srDeckId: sr, newPerDay: 3, reviewPerDay: 200 });

  const queue = call(db, "sr_queue", { srDeckId: sr });
  assert.equal(queue.length, 3);
  let stats = call(db, "sr_deck_stats", { srDeckId: sr });
  assert.equal(stats.due, 3);
  assert.equal(stats.new, 10);
  assert.equal(stats.newRemainingToday, 3);

  for (const card of queue) call(db, "grade_sr_card", { srCardId: card.id, grade: "easy" });
  assert.equal(call(db, "sr_queue", { srDeckId: sr }).length, 0);
  stats = call(db, "sr_deck_stats", { srDeckId: sr });
  assert.equal(stats.newRemainingToday, 0);
  assert.equal(stats.due, 0);

  const bumped = call(db, "increase_sr_limits", { srDeckId: sr, extraNew: 2, extraReview: 0 });
  assert.equal(bumped.newRemainingToday, 2);
  assert.equal(call(db, "sr_queue", { srDeckId: sr }).length, 2);
  assert.equal(call(db, "get_deck", { id: sr }).newPerDay, 3);
});

test("learning a new card does not use up the review limit", () => {
  const db = fresh();
  const sr = srDeck(db, deckWithCards(db, "Source", 1));
  call(db, "update_sr_deck_settings", { srDeckId: sr, newPerDay: 20, reviewPerDay: 5 });
  const id = call(db, "sr_queue", { srDeckId: sr })[0].id;
  call(db, "grade_sr_card", { srCardId: id, grade: "again" });
  call(db, "grade_sr_card", { srCardId: id, grade: "good" });
  const result = call(db, "grade_sr_card", { srCardId: id, grade: "good" });
  assert.equal(result.card.state, "review");
  assert.equal(result.card.intervalDays, 1);
  assert.equal(result.nextDueIn, "1d");
  assert.equal(call(db, "sr_deck_stats", { srDeckId: sr }).reviewRemainingToday, 5);
});

test("reviewing ahead pulls in cards due later", () => {
  const db = fresh();
  const sr = srDeck(db, deckWithCards(db, "Source", 1));
  const id = call(db, "sr_queue", { srDeckId: sr })[0].id;
  call(db, "grade_sr_card", { srCardId: id, grade: "easy" }); // due 3-5 days out
  assert.equal(call(db, "sr_queue", { srDeckId: sr }).length, 0);
  assert.equal(call(db, "sr_queue", { srDeckId: sr, reviewAheadDays: 2 }).length, 0);
  const ahead = call(db, "sr_queue", { srDeckId: sr, reviewAheadDays: 6 });
  assert.equal(ahead.length, 1);
  assert.equal(ahead[0].id, id);
});

test("a story request carries the prompt and the selected cards", () => {
  const db = fresh();
  const deckId = deckWithCards(db, "Kanji", 6);
  const prompt = call(db, "create_story_prompt", {
    name: "Mnemonics",
    prompt: "Write a short mnemonic.",
  });
  const request = call(db, "build_story_request", {
    promptId: prompt.id,
    selection: slice(deckId, 2, 4),
  });
  assert.equal(request.cardCount, 3);
  assert.ok(request.text.includes("Write a short mnemonic."));
  assert.ok(request.text.includes("cards 2-4"));
  assert.ok(request.text.includes('"front": "front 3"'));
  assert.ok(request.text.includes('"index": 3,\n    "front"'));
  assert.ok(!request.text.includes("front 5"));
  assert.throws(() =>
    call(db, "build_story_request", { promptId: prompt.id, selection: slice(deckId, 90, 99) }),
  );
});

test("a story reply attaches stories by index or front", () => {
  const db = fresh();
  const deckId = deckWithCards(db, "Kanji", 3);
  const reply = `\`\`\`json
    [
      {"index": 1, "story": "the first story"},
      {"front": "front 2", "story": "the second story"},
      {"index": 99, "story": "nobody"},
      {"index": 3, "story": "  "},
      {"story": 5, "index": 2}
    ]
    \`\`\``;
  const result = call(db, "apply_story_response", { deckId, response: reply });
  assert.equal(result.updated, 2);
  assert.deepEqual(result.unmatched, ["#99", "#3", '{"index":2,"story":5}']);
  const listed = call(db, "list_cards", { deckId });
  assert.equal(listed[0].story, "the first story");
  assert.equal(listed[1].story, "the second story");
  assert.equal(listed[2].story, "");
});

test("a bad story reply is rejected rather than half applied", () => {
  const db = fresh();
  const deckId = deckWithCards(db, "Kanji", 2);
  assert.throws(() => call(db, "apply_story_response", { deckId, response: "sorry, I can't" }));
  assert.ok(call(db, "list_cards", { deckId }).every((c: any) => c.story === ""));
});

test("bad arguments are reported, not crashed on", () => {
  const db = fresh();
  assert.throws(() => call(db, "get_deck", {}), /argument `id`/);
  assert.throws(() => call(db, "grade_sr_card", { srCardId: 1, grade: "meh" }), /grade/);
});

test("humanises delays", () => {
  assert.equal(humanise(0), "1m");
  assert.equal(humanise(10), "10m");
  assert.equal(humanise(90), "2h");
  assert.equal(humanise(1440), "1d");
  assert.equal(humanise(1440 * 45), "2mo");
  assert.equal(humanise(1440 * 400), "1.1y");
});
