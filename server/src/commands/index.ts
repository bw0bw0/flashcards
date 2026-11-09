import type { Args } from "../args.ts";
import type { Db } from "../db.ts";
import * as cards from "./cards.ts";
import * as categories from "./categories.ts";
import * as decks from "./decks.ts";
import * as prompts from "./prompts.ts";
import * as sr from "./sr.ts";

export type Command = (db: Db, args: Args) => unknown;

/**
 * Every command the app can call, by the name it calls it with. Arguments
 * arrive as a JSON object with camelCase keys.
 */
export const COMMANDS: Record<string, Command> = {
  list_categories: categories.list_categories,
  create_category: categories.create_category,
  update_category: categories.update_category,
  delete_category: categories.delete_category,

  list_decks: decks.list_decks,
  get_deck: decks.get_deck,
  create_deck: decks.create_deck,
  update_deck: decks.update_deck,
  delete_deck: decks.delete_deck,

  list_cards: cards.list_cards,
  list_selection: cards.list_selection,
  create_card: cards.create_card,
  update_card: cards.update_card,
  delete_card: cards.delete_card,
  move_card: cards.move_card,
  import_cards: cards.import_cards,
  export_cards: cards.export_cards,

  create_sr_deck: sr.create_sr_deck,
  add_to_sr_deck: sr.add_to_sr_deck,
  list_sr_cards: sr.list_sr_cards,
  remove_sr_cards: sr.remove_sr_cards,
  sr_queue: sr.sr_queue,
  sr_deck_stats: sr.sr_deck_stats,
  increase_sr_limits: sr.increase_sr_limits,
  update_sr_deck_settings: sr.update_sr_deck_settings,
  grade_sr_card: sr.grade_sr_card,
  reset_sr_card: sr.reset_sr_card,

  list_story_prompts: prompts.list_story_prompts,
  create_story_prompt: prompts.create_story_prompt,
  update_story_prompt: prompts.update_story_prompt,
  delete_story_prompt: prompts.delete_story_prompt,
  build_story_request: prompts.build_story_request,
  apply_story_response: prompts.apply_story_response,
};
