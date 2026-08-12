use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::{cards, decks, now_string};
use crate::db::Db;
use crate::error::{Error, Result};
use crate::models::{CardSelection, StoryPrompt};

const PROMPT_SELECT: &str = "SELECT id, name, prompt, created_at FROM story_prompt";

fn prompt_from_row(row: &rusqlite::Row) -> rusqlite::Result<StoryPrompt> {
    Ok(StoryPrompt {
        id: row.get(0)?,
        name: row.get(1)?,
        prompt: row.get(2)?,
        created_at: row.get(3)?,
    })
}

fn read(conn: &Connection, id: i64) -> Result<StoryPrompt> {
    let sql = format!("{PROMPT_SELECT} WHERE id = ?1");
    conn.query_row(&sql, params![id], prompt_from_row)
        .map_err(|_| Error::invalid("story prompt not found"))
}

#[tauri::command]
pub fn list_story_prompts(db: State<'_, Db>) -> Result<Vec<StoryPrompt>> {
    db.with(|conn| {
        let sql = format!("{PROMPT_SELECT} ORDER BY name");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], prompt_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

#[tauri::command]
pub fn create_story_prompt(db: State<'_, Db>, name: String, prompt: String) -> Result<StoryPrompt> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(Error::invalid("give the prompt a name"));
    }
    if prompt.trim().is_empty() {
        return Err(Error::invalid("the prompt cannot be empty"));
    }
    db.with(|conn| {
        conn.execute(
            "INSERT INTO story_prompt (name, prompt, created_at) VALUES (?1, ?2, ?3)",
            params![name, prompt.trim(), now_string()],
        )?;
        read(conn, conn.last_insert_rowid())
    })
}

#[tauri::command]
pub fn update_story_prompt(
    db: State<'_, Db>,
    id: i64,
    name: String,
    prompt: String,
) -> Result<StoryPrompt> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(Error::invalid("give the prompt a name"));
    }
    db.with(|conn| {
        let changed = conn.execute(
            "UPDATE story_prompt SET name = ?2, prompt = ?3 WHERE id = ?1",
            params![id, name, prompt.trim()],
        )?;
        if changed == 0 {
            return Err(Error::invalid("story prompt not found"));
        }
        read(conn, id)
    })
}

#[tauri::command]
pub fn delete_story_prompt(db: State<'_, Db>, id: i64) -> Result<()> {
    db.with(|conn| {
        conn.execute("DELETE FROM story_prompt WHERE id = ?1", params![id])?;
        Ok(())
    })
}

/// The instructions appended to every story request, so that whatever comes
/// back can be pasted straight into `apply_story_response`.
const RESPONSE_FORMAT: &str = r#"## How to answer

Reply with JSON and nothing else: no greeting, no explanation, no markdown fence.
The reply must be a single array whose elements are objects with exactly two keys:

  "index" - the index of the card the story belongs to, copied from the input
  "story" - the story text for that card, as one string (use \n for line breaks)

Write one object per input card and keep them in the input order. Example:

[{"index": 1, "story": "..."}, {"index": 2, "story": "..."}]"#;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryRequest {
    /// The full text to put on the clipboard.
    pub text: String,
    pub card_count: usize,
}

/// Builds the text the user pastes into an LLM: the chosen prompt, the response
/// format, and the selected cards as JSON.
#[tauri::command]
pub fn build_story_request(
    db: State<'_, Db>,
    prompt_id: i64,
    selection: CardSelection,
) -> Result<StoryRequest> {
    db.with(|conn| {
        let prompt = read(conn, prompt_id)?;
        let deck = decks::read(conn, selection.deck_id)?;
        let cards = cards::cards_in_selection(conn, &selection)?;
        if cards.is_empty() {
            return Err(Error::invalid("that selection has no cards"));
        }

        let payload = cards
            .iter()
            .map(|card| {
                serde_json::json!({
                    "index": card.idx,
                    "front": card.front,
                    "back": card.back,
                    "comment": card.comment,
                })
            })
            .collect::<Vec<_>>();

        let range = match (cards.first(), cards.last()) {
            (Some(first), Some(last)) if first.idx != last.idx => {
                format!(" (cards {}-{})", first.idx, last.idx)
            }
            (Some(first), _) => format!(" (card {})", first.idx),
            _ => String::new(),
        };
        let category = deck
            .category_name
            .as_deref()
            .map(|name| format!("{name} / "))
            .unwrap_or_default();

        let text = format!(
            "## Instructions\n\n{}\n\n{}\n\n## Cards\n\nDeck: {}{}{}\n\n{}\n",
            prompt.prompt.trim(),
            RESPONSE_FORMAT,
            category,
            deck.name,
            range,
            serde_json::to_string_pretty(&payload)?
        );

        Ok(StoryRequest {
            text,
            card_count: cards.len(),
        })
    })
}

#[derive(Debug, Deserialize)]
struct StoryReply {
    index: Option<i64>,
    #[serde(default)]
    front: Option<String>,
    #[serde(default)]
    story: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub updated: usize,
    /// Entries that did not match a card in the deck, described for the user.
    pub unmatched: Vec<String>,
}

/// Attaches the stories from an LLM reply to the cards of a deck. Entries are
/// matched on the card index, falling back to an exact match on the front.
#[tauri::command]
pub fn apply_story_response(
    db: State<'_, Db>,
    deck_id: i64,
    response: String,
) -> Result<ApplyResult> {
    let items = cards::extract_array(&response)?;
    db.with(|conn| {
        let tx = conn.transaction()?;
        let mut updated = 0usize;
        let mut unmatched = Vec::new();
        for item in items {
            let reply: StoryReply = match serde_json::from_value(item.clone()) {
                Ok(reply) => reply,
                Err(_) => {
                    unmatched.push(item.to_string());
                    continue;
                }
            };
            if reply.story.trim().is_empty() {
                unmatched.push(describe(&reply));
                continue;
            }

            let changed = match reply.index {
                Some(index) => tx.execute(
                    "UPDATE card SET story = ?3 WHERE deck_id = ?1 AND idx = ?2",
                    params![deck_id, index, reply.story.trim()],
                )?,
                None => 0,
            };
            let changed = if changed == 0 {
                match reply.front.as_deref().map(str::trim) {
                    Some(front) if !front.is_empty() => tx.execute(
                        "UPDATE card SET story = ?3
                         WHERE deck_id = ?1 AND lower(trim(front)) = lower(?2)",
                        params![deck_id, front, reply.story.trim()],
                    )?,
                    _ => 0,
                }
            } else {
                changed
            };

            if changed == 0 {
                unmatched.push(describe(&reply));
            } else {
                updated += changed;
            }
        }
        tx.commit()?;
        Ok(ApplyResult { updated, unmatched })
    })
}

fn describe(reply: &StoryReply) -> String {
    match (reply.index, reply.front.as_deref()) {
        (Some(index), Some(front)) => format!("#{index} \"{front}\""),
        (Some(index), None) => format!("#{index}"),
        (None, Some(front)) => format!("\"{front}\""),
        (None, None) => "an entry without an index or front".to_string(),
    }
}
