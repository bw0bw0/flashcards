//! End-to-end tests over the command layer, against a real (in-memory) SQLite.

use crate::commands::{cards, categories, decks, prompts, sr};
use crate::db::Db;
use crate::models::{CardSelection, DeckKind};
use crate::srs::Grade;

fn db() -> Db {
    Db::open_in_memory().expect("in-memory database")
}

fn whole(deck_id: i64) -> CardSelection {
    CardSelection {
        deck_id,
        from_index: None,
        to_index: None,
    }
}

fn slice(deck_id: i64, from: i64, to: i64) -> CardSelection {
    CardSelection {
        deck_id,
        from_index: Some(from),
        to_index: Some(to),
    }
}

/// A deck of `count` cards named "front 1", "front 2", ...
fn deck_with_cards(db: &Db, name: &str, count: i64) -> i64 {
    let deck = decks::create_deck(db, name.into(), None, None).unwrap();
    let json = (1..=count)
        .map(|i| format!(r#"{{"front":"front {i}","back":"back {i}"}}"#))
        .collect::<Vec<_>>()
        .join(",");
    let result = cards::import_cards(db, deck.id, format!("[{json}]"), false).unwrap();
    assert_eq!(result.imported, count as usize);
    deck.id
}

#[test]
fn decks_are_grouped_under_their_category() {
    let db = db();
    let category = categories::create_category(&db, "Japanese".into()).unwrap();
    let deck = decks::create_deck(
        &db,
        "Verbs".into(),
        Some(category.id),
        Some("group 1".into()),
    )
    .unwrap();

    let listed = decks::list_decks(&db).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name, "Verbs");
    assert_eq!(listed[0].category_name.as_deref(), Some("Japanese"));
    assert_eq!(listed[0].kind, DeckKind::Normal);

    // Deleting the category keeps the deck, uncategorised.
    categories::delete_category(&db, category.id).unwrap();
    let after = decks::get_deck(&db, deck.id).unwrap();
    assert_eq!(after.category_id, None);
}

#[test]
fn importing_numbers_cards_in_order() {
    let db = db();
    let deck_id = deck_with_cards(&db, "Kanji", 3);

    let listed = cards::list_cards(&db, deck_id).unwrap();
    assert_eq!(
        listed
            .iter()
            .map(|c| (c.idx, c.front.as_str()))
            .collect::<Vec<_>>(),
        [(1, "front 1"), (2, "front 2"), (3, "front 3")]
    );

    // Appending continues the numbering; replacing starts over.
    cards::import_cards(&db, deck_id, r#"[{"front":"extra"}]"#.into(), false).unwrap();
    assert_eq!(
        cards::list_cards(&db, deck_id).unwrap().last().unwrap().idx,
        4
    );

    let replaced = cards::import_cards(&db, deck_id, r#"[{"front":"only"}]"#.into(), true).unwrap();
    assert_eq!(replaced.total, 1);
    assert_eq!(cards::list_cards(&db, deck_id).unwrap()[0].idx, 1);
}

#[test]
fn categories_and_decks_survive_a_round_trip() {
    let db = db();
    let category = categories::create_category(&db, " Japanese ".into()).unwrap();
    assert_eq!(category.name, "Japanese");
    assert!(categories::create_category(&db, "  ".into()).is_err());

    let renamed = categories::update_category(&db, category.id, "Nihongo".into()).unwrap();
    assert_eq!(renamed.name, "Nihongo");
    assert_eq!(categories::list_categories(&db).unwrap().len(), 1);

    let deck = decks::create_deck(&db, "Verbs".into(), None, None).unwrap();
    let moved = decks::update_deck(
        &db,
        deck.id,
        "Verbs I".into(),
        Some(category.id),
        Some("group 1".into()),
    )
    .unwrap();
    assert_eq!(moved.name, "Verbs I");
    assert_eq!(moved.category_name.as_deref(), Some("Nihongo"));
    assert_eq!(moved.description, "group 1");

    decks::delete_deck(&db, deck.id).unwrap();
    assert!(decks::list_decks(&db).unwrap().is_empty());
    assert!(decks::get_deck(&db, deck.id).is_err());
}

#[test]
fn cards_can_be_edited_reordered_and_exported() {
    let db = db();
    let deck_id = deck_with_cards(&db, "Kanji", 3);
    let card = cards::list_cards(&db, deck_id).unwrap()[0].clone();

    let updated = cards::update_card(
        &db,
        card.id,
        "水".into(),
        Some("water".into()),
        Some("mizu".into()),
        Some("a river runs through it".into()),
    )
    .unwrap();
    assert_eq!(updated.front, "水");
    assert_eq!(updated.story, "a river runs through it");
    assert!(cards::update_card(&db, card.id, "  ".into(), None, None, None).is_err());

    let reordered = cards::move_card(&db, card.id, 3).unwrap();
    assert_eq!(reordered.last().unwrap().front, "水");
    assert_eq!(reordered.last().unwrap().idx, 3);

    // A slice reads the cards in their new order.
    let picked = cards::list_selection(&db, slice(deck_id, 3, 3)).unwrap();
    assert_eq!(picked.len(), 1);
    assert_eq!(picked[0].front, "水");

    let exported = cards::export_cards(&db, deck_id).unwrap();
    assert!(exported.contains("\"story\": \"a river runs through it\""));
    assert!(exported.contains("\"index\": 1,\n    \"front\""));

    // What comes out of the export goes back in unchanged.
    let fresh = decks::create_deck(&db, "Copy".into(), None, None).unwrap();
    let result = cards::import_cards(&db, fresh.id, exported, false).unwrap();
    assert_eq!(result.imported, 3);
    assert_eq!(cards::list_cards(&db, fresh.id).unwrap()[2].front, "水");
}

#[test]
fn story_prompts_survive_a_round_trip() {
    let db = db();
    let prompt = prompts::create_story_prompt(&db, "Mnemonics".into(), "Be vivid.".into()).unwrap();
    assert!(prompts::create_story_prompt(&db, "Empty".into(), "  ".into()).is_err());

    let renamed =
        prompts::update_story_prompt(&db, prompt.id, "Vivid".into(), "Be brief.".into()).unwrap();
    assert_eq!(renamed.name, "Vivid");
    assert_eq!(renamed.prompt, "Be brief.");

    assert_eq!(prompts::list_story_prompts(&db).unwrap().len(), 1);
    prompts::delete_story_prompt(&db, prompt.id).unwrap();
    assert!(prompts::list_story_prompts(&db).unwrap().is_empty());
}

#[test]
fn removing_a_card_from_an_sr_deck_leaves_the_original_alone() {
    let db = db();
    let source = deck_with_cards(&db, "Source", 3);
    let sr_deck = sr::create_sr_deck(&db, "Daily".into(), None, None, vec![whole(source)]).unwrap();

    let members = sr::list_sr_cards(&db, sr_deck.id).unwrap();
    let removed = sr::remove_sr_cards(&db, vec![members[0].id, members[1].id]).unwrap();
    assert_eq!(removed, 2);
    assert_eq!(sr::list_sr_cards(&db, sr_deck.id).unwrap().len(), 1);
    assert_eq!(cards::list_cards(&db, source).unwrap().len(), 3);
}

#[test]
fn cards_cannot_be_added_to_a_spaced_repetition_deck() {
    let db = db();
    let source = deck_with_cards(&db, "Source", 2);
    let sr_deck = sr::create_sr_deck(&db, "Daily".into(), None, None, vec![whole(source)]).unwrap();

    assert!(cards::create_card(&db, sr_deck.id, "nope".into(), None, None, None).is_err());
    assert!(cards::import_cards(&db, sr_deck.id, "[]".into(), false).is_err());
}

#[test]
fn an_sr_deck_is_built_from_decks_and_slices() {
    let db = db();
    let first = deck_with_cards(&db, "First", 10);
    let second = deck_with_cards(&db, "Second", 4);

    let sr_deck = sr::create_sr_deck(
        &db,
        "Mixed".into(),
        None,
        None,
        vec![slice(first, 3, 5), whole(second)],
    )
    .unwrap();

    assert_eq!(sr_deck.kind, DeckKind::Sr);
    let members = sr::list_sr_cards(&db, sr_deck.id).unwrap();
    assert_eq!(members.len(), 7);
    assert_eq!(
        members
            .iter()
            .filter(|m| m.source_deck_name == "First")
            .map(|m| m.card.idx)
            .collect::<Vec<_>>(),
        [3, 4, 5]
    );

    // Adding an overlapping slice only brings in what is missing.
    let added = sr::add_to_sr_deck(&db, sr_deck.id, vec![slice(first, 4, 7)]).unwrap();
    assert_eq!(added, 2);
    assert_eq!(sr::list_sr_cards(&db, sr_deck.id).unwrap().len(), 9);

    // The deck listing counts referenced cards, not owned ones.
    let listed = decks::get_deck(&db, sr_deck.id).unwrap();
    assert_eq!(listed.card_count, 9);
    assert_eq!(listed.new_count, 9);
    assert_eq!(listed.due_count, 9);
}

#[test]
fn deleting_a_source_card_removes_it_from_sr_decks() {
    let db = db();
    let source = deck_with_cards(&db, "Source", 3);
    let sr_deck = sr::create_sr_deck(&db, "Daily".into(), None, None, vec![whole(source)]).unwrap();

    let card_id = cards::list_cards(&db, source).unwrap()[1].id;
    cards::delete_card(&db, card_id).unwrap();

    assert_eq!(sr::list_sr_cards(&db, sr_deck.id).unwrap().len(), 2);
    // The surviving cards were renumbered in their own deck.
    assert_eq!(cards::list_cards(&db, source).unwrap()[1].idx, 2);
}

#[test]
fn grading_moves_a_card_through_the_queue() {
    let db = db();
    let source = deck_with_cards(&db, "Source", 2);
    let sr_deck = sr::create_sr_deck(&db, "Daily".into(), None, None, vec![whole(source)]).unwrap();

    let queue = sr::sr_queue(&db, sr_deck.id, None, None).unwrap();
    assert_eq!(queue.len(), 2);

    // `Easy` graduates a new card straight into the review queue, days away.
    let result = sr::grade_sr_card(&db, queue[0].id, Grade::Easy).unwrap();
    assert_eq!(result.card.state, "review");
    assert_eq!(result.next_due_in, "4d");

    let stats = sr::sr_deck_stats(&db, sr_deck.id).unwrap();
    assert_eq!(stats.total, 2);
    assert_eq!(stats.due, 1);
    assert_eq!(stats.new, 1);
    assert_eq!(stats.review, 1);
    assert_eq!(stats.reviewed_today, 1);

    // `Again` keeps the other card in the session: it is not due yet, but the
    // queue reaches a little way into the future for learning cards.
    let result = sr::grade_sr_card(&db, queue[1].id, Grade::Again).unwrap();
    assert_eq!(result.card.state, "learning");
    let queue = sr::sr_queue(&db, sr_deck.id, None, None).unwrap();
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].id, result.card.id);

    sr::reset_sr_card(&db, result.card.id).unwrap();
    let stats = sr::sr_deck_stats(&db, sr_deck.id).unwrap();
    assert_eq!(stats.new, 1);
    assert_eq!(stats.learning, 0);
}

#[test]
fn a_card_graded_again_does_not_immediately_repeat_while_other_cards_are_available() {
    let db = db();
    let source = deck_with_cards(&db, "Source", 3);
    let sr_deck = sr::create_sr_deck(&db, "Daily".into(), None, None, vec![whole(source)]).unwrap();

    let queue = sr::sr_queue(&db, sr_deck.id, None, None).unwrap();
    assert_eq!(queue.len(), 3);
    let first_id = queue[0].id;

    // Grading anything but `Easy` sends the card into the learning queue with
    // a due time a few minutes out. Since two other new cards are still
    // available, the just-graded card must not jump back to the front.
    sr::grade_sr_card(&db, first_id, Grade::Again).unwrap();
    let queue = sr::sr_queue(&db, sr_deck.id, None, None).unwrap();
    assert_eq!(queue.len(), 2);
    assert!(queue.iter().all(|card| card.id != first_id));
}

#[test]
fn the_queue_only_offers_cards_that_are_due() {
    let db = db();
    let source = deck_with_cards(&db, "Source", 1);
    let sr_deck = sr::create_sr_deck(&db, "Daily".into(), None, None, vec![whole(source)]).unwrap();
    let entry = sr::sr_queue(&db, sr_deck.id, None, None).unwrap()[0].id;

    sr::grade_sr_card(&db, entry, Grade::Easy).unwrap();
    assert!(sr::sr_queue(&db, sr_deck.id, None, None).unwrap().is_empty());

    // A story deck has no queue at all.
    assert!(sr::sr_queue(&db, source, None, None).is_err());
}

#[test]
fn new_cards_trickle_in_by_the_daily_limit() {
    let db = db();
    let source = deck_with_cards(&db, "Source", 10);
    let sr_deck = sr::create_sr_deck(&db, "Daily".into(), None, None, vec![whole(source)]).unwrap();
    sr::update_sr_deck_settings(&db, sr_deck.id, 3, 200).unwrap();

    // Only 3 of the 10 new cards are offered, even though all 10 are "due".
    let queue = sr::sr_queue(&db, sr_deck.id, None, None).unwrap();
    assert_eq!(queue.len(), 3);
    let stats = sr::sr_deck_stats(&db, sr_deck.id).unwrap();
    assert_eq!(stats.due, 3);
    assert_eq!(stats.new, 10);
    assert_eq!(stats.new_remaining_today, 3);

    // Using up today's allowance empties the queue, even with 7 cards left.
    for card in &queue {
        sr::grade_sr_card(&db, card.id, Grade::Easy).unwrap();
    }
    assert!(sr::sr_queue(&db, sr_deck.id, None, None).unwrap().is_empty());
    let stats = sr::sr_deck_stats(&db, sr_deck.id).unwrap();
    assert_eq!(stats.new_remaining_today, 0);
    assert_eq!(stats.due, 0);

    // "Increase today's limit" lets more through without touching the
    // permanent per-day setting.
    let bumped = sr::increase_sr_limits(&db, sr_deck.id, 2, 0).unwrap();
    assert_eq!(bumped.new_remaining_today, 2);
    assert_eq!(sr::sr_queue(&db, sr_deck.id, None, None).unwrap().len(), 2);
    assert_eq!(decks::get_deck(&db, sr_deck.id).unwrap().new_per_day, 3);
}

#[test]
fn reviewing_ahead_pulls_in_cards_due_later() {
    let db = db();
    let source = deck_with_cards(&db, "Source", 1);
    let sr_deck = sr::create_sr_deck(&db, "Daily".into(), None, None, vec![whole(source)]).unwrap();
    let card_id = sr::sr_queue(&db, sr_deck.id, None, None).unwrap()[0].id;
    sr::grade_sr_card(&db, card_id, Grade::Easy).unwrap(); // due 4 days out

    assert!(sr::sr_queue(&db, sr_deck.id, None, None).unwrap().is_empty());
    // Not far enough ahead yet...
    assert!(sr::sr_queue(&db, sr_deck.id, None, Some(2)).unwrap().is_empty());
    // ...but far enough now.
    let ahead = sr::sr_queue(&db, sr_deck.id, None, Some(5)).unwrap();
    assert_eq!(ahead.len(), 1);
    assert_eq!(ahead[0].id, card_id);
}

#[test]
fn a_story_request_carries_the_prompt_and_the_selected_cards() {
    let db = db();
    let deck_id = deck_with_cards(&db, "Kanji", 6);
    let prompt =
        prompts::create_story_prompt(&db, "Mnemonics".into(), "Write a short mnemonic.".into())
            .unwrap();

    let request = prompts::build_story_request(&db, prompt.id, slice(deck_id, 2, 4)).unwrap();
    assert_eq!(request.card_count, 3);
    assert!(request.text.contains("Write a short mnemonic."));
    assert!(request.text.contains("cards 2-4"));
    assert!(request.text.contains("\"front\": \"front 3\""));
    // The index leads each card, since the reply has to echo it back.
    assert!(request.text.contains("\"index\": 3,\n    \"front\""));
    assert!(!request.text.contains("front 5"));

    // An empty slice is a mistake worth reporting.
    assert!(prompts::build_story_request(&db, prompt.id, slice(deck_id, 90, 99)).is_err());
}

#[test]
fn a_story_reply_attaches_stories_by_index_or_front() {
    let db = db();
    let deck_id = deck_with_cards(&db, "Kanji", 3);

    let reply = r#"```json
    [
      {"index": 1, "story": "the first story"},
      {"front": "front 2", "story": "the second story"},
      {"index": 99, "story": "nobody"},
      {"index": 3, "story": "  "}
    ]
    ```"#;
    let result = prompts::apply_story_response(&db, deck_id, reply.into()).unwrap();

    assert_eq!(result.updated, 2);
    assert_eq!(result.unmatched, ["#99", "#3"]);

    let listed = cards::list_cards(&db, deck_id).unwrap();
    assert_eq!(listed[0].story, "the first story");
    assert_eq!(listed[1].story, "the second story");
    assert_eq!(listed[2].story, "");
}

#[test]
fn a_bad_story_reply_is_rejected_rather_than_half_applied() {
    let db = db();
    let deck_id = deck_with_cards(&db, "Kanji", 2);
    assert!(prompts::apply_story_response(&db, deck_id, "sorry, I can't".into()).is_err());
    assert!(cards::list_cards(&db, deck_id)
        .unwrap()
        .iter()
        .all(|card| card.story.is_empty()));
}
