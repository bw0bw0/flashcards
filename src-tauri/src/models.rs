use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: i64,
    pub name: String,
    pub position: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeckKind {
    Normal,
    Sr,
}

impl DeckKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DeckKind::Normal => "normal",
            DeckKind::Sr => "sr",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "sr" => DeckKind::Sr,
            _ => DeckKind::Normal,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Deck {
    pub id: i64,
    pub category_id: Option<i64>,
    pub category_name: Option<String>,
    pub name: String,
    pub description: String,
    pub kind: DeckKind,
    pub position: i64,
    pub created_at: String,
    /// Cards owned by the deck, or referenced by it when it is an SR deck.
    pub card_count: i64,
    /// SR decks only: cards that are due right now.
    pub due_count: i64,
    /// SR decks only: cards that have never been reviewed.
    pub new_count: i64,
    /// SR decks only: how many new cards may be introduced per day.
    pub new_per_day: i64,
    /// SR decks only: how many review-state cards may be shown per day.
    pub review_per_day: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub id: i64,
    pub deck_id: i64,
    /// Position of the card inside its deck, 1-based.
    #[serde(rename = "index")]
    pub idx: i64,
    pub front: String,
    pub back: String,
    pub comment: String,
    pub story: String,
}

/// A whole deck, or an inclusive slice of one by card index. Used both for
/// building SR decks and for picking the cards a story prompt covers.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardSelection {
    pub deck_id: i64,
    pub from_index: Option<i64>,
    pub to_index: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryPrompt {
    pub id: i64,
    pub name: String,
    pub prompt: String,
    pub created_at: String,
}

/// A card in an SR deck together with its schedule for that deck.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SrCard {
    pub id: i64,
    pub sr_deck_id: i64,
    pub card: Card,
    /// Name of the deck the card is owned by.
    pub source_deck_name: String,
    pub state: String,
    pub due_at: String,
    pub interval_days: f64,
    pub ease: f64,
    pub reps: i64,
    pub lapses: i64,
    pub step: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SrDeckStats {
    pub total: i64,
    /// Cards actually ready to study right now: due learning/relearning cards,
    /// plus however many review and new cards today's limits still allow.
    pub due: i64,
    /// Cards still sitting in the 'new' state (the whole pool, not just what
    /// today's limit allows through).
    pub new: i64,
    pub learning: i64,
    pub review: i64,
    /// Every card graded today, any state, calendar-day based.
    pub reviewed_today: i64,
    pub new_per_day: i64,
    pub review_per_day: i64,
    /// How many more new cards may be introduced today.
    pub new_remaining_today: i64,
    /// How many more review-state cards may be shown today.
    pub review_remaining_today: i64,
}
