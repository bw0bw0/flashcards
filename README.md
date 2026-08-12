# Flashcards

A flashcard app with a flexible training program, built with Tauri, React and
SQLite. Desktop for now; the Rust side is written so it will build for Android
without changes.

## Running it

```sh
npm install
npm run tauri dev     # develop
npm run tauri build   # bundle
cargo test            # in src-tauri, the backend test suite
```

The database lives in the platform app data directory (`flashcards.db`) and
migrates itself on startup.

## How it fits together

- `src-tauri/src/commands/` — one module per area (categories, decks, cards,
  spaced repetition, story prompts). Each command takes the database and returns
  a serialisable result; errors reach the frontend as plain strings.
- `src-tauri/src/srs.rs` — the scheduler, an SM-2 variant with learning steps. It
  is a pure function of the previous schedule, the grade and the time, so it can
  be tested and replaced on its own.
- `src-tauri/src/migrations/` — the schema, applied in order and tracked in
  `PRAGMA user_version`.
- `src/api.ts` — the typed frontend binding for every command.

## Decks and cards

A card has an index within its deck, a front, a back, a comment and a story.
Decks are grouped into categories. Cards can be added by hand or imported as a
JSON array:

```json
[{ "front": "いぬ", "back": "dog", "comment": "inu", "story": "" }]
```

Only `front` is required. Cards are numbered in the order they appear, which is
what makes it possible to refer to *slices* of a deck — "cards 3 to 20" — when
building spaced repetition decks or asking for stories.

## Spaced repetition decks

A spaced repetition deck holds references to cards owned by ordinary decks,
picked as whole decks or slices. Each membership carries its own schedule, so
the same card can sit in several such decks independently. Grading a card as
Again / Hard / Good / Easy moves it through the learning steps and then the
review queue.

## Training

- **Story** walks a deck, or a slice of it, front to back, optionally shuffled.
- **Spaced repetition** works through the due queue of an SR deck.

Either way the story attached to a card is shown along with its answer.

## Story prompts

A story prompt is an instruction for an LLM. From a deck, *Prompt a story* asks
which prompt and which cards, then puts the instruction, the reply format and the
selected cards on the clipboard. Paste that into any LLM, paste its answer back,
and the stories are attached to the matching cards — by index, falling back to
the card's front.
