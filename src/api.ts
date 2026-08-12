import { invoke } from "@tauri-apps/api/core";
import {
  writeText as writeClipboard,
  readText as readClipboard,
} from "@tauri-apps/plugin-clipboard-manager";

import type {
  ApplyResult,
  Card,
  CardSelection,
  Category,
  Deck,
  Grade,
  GradeResult,
  ImportResult,
  SrCard,
  SrDeckStats,
  StoryPrompt,
  StoryRequest,
} from "./types";

/** Every backend error arrives as a plain string. */
export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

export const api = {
  listCategories: () => invoke<Category[]>("list_categories"),
  createCategory: (name: string) => invoke<Category>("create_category", { name }),
  updateCategory: (id: number, name: string) =>
    invoke<Category>("update_category", { id, name }),
  deleteCategory: (id: number) => invoke<void>("delete_category", { id }),

  listDecks: () => invoke<Deck[]>("list_decks"),
  getDeck: (id: number) => invoke<Deck>("get_deck", { id }),
  createDeck: (name: string, categoryId: number | null, description: string) =>
    invoke<Deck>("create_deck", { name, categoryId, description }),
  updateDeck: (
    id: number,
    name: string,
    categoryId: number | null,
    description: string,
  ) => invoke<Deck>("update_deck", { id, name, categoryId, description }),
  deleteDeck: (id: number) => invoke<void>("delete_deck", { id }),

  listCards: (deckId: number) => invoke<Card[]>("list_cards", { deckId }),
  listSelection: (selection: CardSelection) =>
    invoke<Card[]>("list_selection", { selection }),
  createCard: (
    deckId: number,
    front: string,
    back: string,
    comment: string,
    story: string,
  ) => invoke<Card>("create_card", { deckId, front, back, comment, story }),
  updateCard: (
    id: number,
    front: string,
    back: string,
    comment: string,
    story: string,
  ) => invoke<Card>("update_card", { id, front, back, comment, story }),
  deleteCard: (id: number) => invoke<void>("delete_card", { id }),
  moveCard: (id: number, toIndex: number) =>
    invoke<Card[]>("move_card", { id, toIndex }),
  importCards: (deckId: number, json: string, replace: boolean) =>
    invoke<ImportResult>("import_cards", { deckId, json, replace }),
  exportCards: (deckId: number) => invoke<string>("export_cards", { deckId }),

  createSrDeck: (
    name: string,
    categoryId: number | null,
    description: string,
    selections: CardSelection[],
  ) =>
    invoke<Deck>("create_sr_deck", {
      name,
      categoryId,
      description,
      selections,
    }),
  addToSrDeck: (srDeckId: number, selections: CardSelection[]) =>
    invoke<number>("add_to_sr_deck", { srDeckId, selections }),
  listSrCards: (srDeckId: number) => invoke<SrCard[]>("list_sr_cards", { srDeckId }),
  removeSrCards: (srCardIds: number[]) =>
    invoke<number>("remove_sr_cards", { srCardIds }),
  srQueue: (srDeckId: number, limit?: number) =>
    invoke<SrCard[]>("sr_queue", { srDeckId, limit: limit ?? null }),
  srDeckStats: (srDeckId: number) => invoke<SrDeckStats>("sr_deck_stats", { srDeckId }),
  gradeSrCard: (srCardId: number, grade: Grade) =>
    invoke<GradeResult>("grade_sr_card", { srCardId, grade }),
  resetSrCard: (srCardId: number) => invoke<void>("reset_sr_card", { srCardId }),

  listStoryPrompts: () => invoke<StoryPrompt[]>("list_story_prompts"),
  createStoryPrompt: (name: string, prompt: string) =>
    invoke<StoryPrompt>("create_story_prompt", { name, prompt }),
  updateStoryPrompt: (id: number, name: string, prompt: string) =>
    invoke<StoryPrompt>("update_story_prompt", { id, name, prompt }),
  deleteStoryPrompt: (id: number) => invoke<void>("delete_story_prompt", { id }),
  buildStoryRequest: (promptId: number, selection: CardSelection) =>
    invoke<StoryRequest>("build_story_request", { promptId, selection }),
  applyStoryResponse: (deckId: number, response: string) =>
    invoke<ApplyResult>("apply_story_response", { deckId, response }),
};

/**
 * Clipboard access goes through the Tauri plugin, which works on mobile too,
 * and falls back to the web API when it is unavailable (e.g. `vite dev`).
 */
export async function copyToClipboard(text: string): Promise<void> {
  try {
    await writeClipboard(text);
  } catch {
    await navigator.clipboard.writeText(text);
  }
}

export async function pasteFromClipboard(): Promise<string> {
  try {
    return await readClipboard();
  } catch {
    return await navigator.clipboard.readText();
  }
}
