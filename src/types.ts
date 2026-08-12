export type DeckKind = "normal" | "sr";

export interface Category {
  id: number;
  name: string;
  position: number;
}

export interface Deck {
  id: number;
  categoryId: number | null;
  categoryName: string | null;
  name: string;
  description: string;
  kind: DeckKind;
  position: number;
  createdAt: string;
  cardCount: number;
  dueCount: number;
  newCount: number;
  /** SR decks only: new cards introduced per day. */
  newPerDay: number;
  /** SR decks only: review-state cards shown per day. */
  reviewPerDay: number;
}

export interface Card {
  id: number;
  deckId: number;
  index: number;
  front: string;
  back: string;
  comment: string;
  story: string;
}

/** A whole deck, or an inclusive slice of one by card index. */
export interface CardSelection {
  deckId: number;
  fromIndex: number | null;
  toIndex: number | null;
}

export interface StoryPrompt {
  id: number;
  name: string;
  prompt: string;
  createdAt: string;
}

export type SrState = "new" | "learning" | "review" | "relearning";

export interface SrCard {
  id: number;
  srDeckId: number;
  card: Card;
  sourceDeckName: string;
  state: SrState;
  dueAt: string;
  intervalDays: number;
  ease: number;
  reps: number;
  lapses: number;
  step: number;
}

export interface SrDeckStats {
  total: number;
  /** Cards actually ready to study right now, respecting today's limits. */
  due: number;
  /** Cards still in the 'new' state — the whole pool, not just today's slice. */
  new: number;
  learning: number;
  review: number;
  reviewedToday: number;
  newPerDay: number;
  reviewPerDay: number;
  newRemainingToday: number;
  reviewRemainingToday: number;
}

export type Grade = "again" | "hard" | "good" | "easy";

export interface GradeResult {
  card: SrCard;
  /** Human readable delay until the card comes back, e.g. "10m". */
  nextDueIn: string;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  total: number;
}

export interface StoryRequest {
  text: string;
  cardCount: number;
}

export interface ApplyResult {
  updated: number;
  unmatched: string[];
}
