use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};

use crate::commands::decks;
use crate::db::DbState;
use crate::error::{Error, Result};
use crate::models::{Card, CardSelection, DeckKind};

const CARD_SELECT: &str = "SELECT id, deck_id, idx, front, back, comment, story FROM card";

pub fn card_from_row(row: &Row) -> rusqlite::Result<Card> {
    Ok(Card {
        id: row.get(0)?,
        deck_id: row.get(1)?,
        idx: row.get(2)?,
        front: row.get(3)?,
        back: row.get(4)?,
        comment: row.get(5)?,
        story: row.get(6)?,
    })
}

fn read(conn: &Connection, id: i64) -> Result<Card> {
    let sql = format!("{CARD_SELECT} WHERE id = ?1");
    conn.query_row(&sql, params![id], card_from_row)
        .map_err(|_| Error::invalid("card not found"))
}

/// Resolves a whole-deck or sliced selection into the cards it covers.
pub fn cards_in_selection(conn: &Connection, selection: &CardSelection) -> Result<Vec<Card>> {
    let from = selection.from_index.unwrap_or(i64::MIN);
    let to = selection.to_index.unwrap_or(i64::MAX);
    if from > to {
        return Err(Error::invalid("slice starts after it ends"));
    }
    let sql = format!("{CARD_SELECT} WHERE deck_id = ?1 AND idx BETWEEN ?2 AND ?3 ORDER BY idx");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![selection.deck_id, from, to], card_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Renumbers a deck's cards 1..n, keeping their current order. Called after
/// anything that can leave gaps.
pub fn renumber(conn: &Connection, deck_id: i64) -> Result<()> {
    conn.execute(
        "WITH ordered AS (
             SELECT id, ROW_NUMBER() OVER (ORDER BY idx, id) AS position
             FROM card WHERE deck_id = ?1
         )
         UPDATE card SET idx = (SELECT position FROM ordered WHERE ordered.id = card.id)
         WHERE deck_id = ?1",
        params![deck_id],
    )?;
    Ok(())
}

#[cfg_attr(not(test), tauri::command)]
pub fn list_cards(db: DbState<'_>, deck_id: i64) -> Result<Vec<Card>> {
    db.with(|conn| {
        let sql = format!("{CARD_SELECT} WHERE deck_id = ?1 ORDER BY idx");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![deck_id], card_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

/// The cards a story session walks through: a whole deck or a slice of one.
#[cfg_attr(not(test), tauri::command)]
pub fn list_selection(db: DbState<'_>, selection: CardSelection) -> Result<Vec<Card>> {
    db.with(|conn| cards_in_selection(conn, &selection))
}

#[cfg_attr(not(test), tauri::command)]
pub fn create_card(
    db: DbState<'_>,
    deck_id: i64,
    front: String,
    back: Option<String>,
    comment: Option<String>,
    story: Option<String>,
) -> Result<Card> {
    if front.trim().is_empty() {
        return Err(Error::invalid("the front of a card cannot be empty"));
    }
    db.with(|conn| {
        decks::require_kind(conn, deck_id, DeckKind::Normal)?;
        let idx: i64 = conn.query_row(
            "SELECT COALESCE(MAX(idx), 0) + 1 FROM card WHERE deck_id = ?1",
            params![deck_id],
            |row| row.get(0),
        )?;
        conn.execute(
            "INSERT INTO card (deck_id, idx, front, back, comment, story)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                deck_id,
                idx,
                front.trim(),
                back.unwrap_or_default(),
                comment.unwrap_or_default(),
                story.unwrap_or_default()
            ],
        )?;
        read(conn, conn.last_insert_rowid())
    })
}

#[cfg_attr(not(test), tauri::command)]
pub fn update_card(
    db: DbState<'_>,
    id: i64,
    front: String,
    back: Option<String>,
    comment: Option<String>,
    story: Option<String>,
) -> Result<Card> {
    if front.trim().is_empty() {
        return Err(Error::invalid("the front of a card cannot be empty"));
    }
    db.with(|conn| {
        let changed = conn.execute(
            "UPDATE card SET front = ?2, back = ?3, comment = ?4, story = ?5 WHERE id = ?1",
            params![
                id,
                front.trim(),
                back.unwrap_or_default(),
                comment.unwrap_or_default(),
                story.unwrap_or_default()
            ],
        )?;
        if changed == 0 {
            return Err(Error::invalid("card not found"));
        }
        read(conn, id)
    })
}

#[cfg_attr(not(test), tauri::command)]
pub fn delete_card(db: DbState<'_>, id: i64) -> Result<()> {
    db.with(|conn| {
        let deck_id: i64 = conn
            .query_row("SELECT deck_id FROM card WHERE id = ?1", params![id], |r| {
                r.get(0)
            })
            .map_err(|_| Error::invalid("card not found"))?;
        conn.execute("DELETE FROM card WHERE id = ?1", params![id])?;
        renumber(conn, deck_id)
    })
}

/// Moves a card to a new 1-based position within its deck, returning the deck.
fn move_within_deck(conn: &Connection, id: i64, to_index: i64) -> Result<i64> {
    let (deck_id, current): (i64, i64) = conn
        .query_row(
            "SELECT deck_id, idx FROM card WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| Error::invalid("card not found"))?;
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM card WHERE deck_id = ?1",
        params![deck_id],
        |row| row.get(0),
    )?;
    let target = to_index.clamp(1, count.max(1));
    if target != current {
        // Shift the cards between the old and the new position by one, then
        // drop the moved card into the gap it leaves.
        if target < current {
            conn.execute(
                "UPDATE card SET idx = idx + 1 WHERE deck_id = ?1 AND idx >= ?2 AND idx < ?3",
                params![deck_id, target, current],
            )?;
        } else {
            conn.execute(
                "UPDATE card SET idx = idx - 1 WHERE deck_id = ?1 AND idx > ?2 AND idx <= ?3",
                params![deck_id, current, target],
            )?;
        }
        conn.execute(
            "UPDATE card SET idx = ?2 WHERE id = ?1",
            params![id, target],
        )?;
    }
    renumber(conn, deck_id)?;
    Ok(deck_id)
}

#[cfg_attr(not(test), tauri::command)]
pub fn move_card(db: DbState<'_>, id: i64, to_index: i64) -> Result<Vec<Card>> {
    db.with(|conn| {
        let deck_id = move_within_deck(conn, id, to_index)?;
        let sql = format!("{CARD_SELECT} WHERE deck_id = ?1 ORDER BY idx");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![deck_id], card_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

#[derive(Debug, Default, Deserialize)]
struct ImportCard {
    #[serde(default, alias = "term", alias = "question")]
    front: String,
    #[serde(default, alias = "definition", alias = "answer")]
    back: String,
    #[serde(default, alias = "note", alias = "notes")]
    comment: String,
    #[serde(default)]
    story: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: usize,
    pub skipped: usize,
    pub total: i64,
}

/// Strips a markdown code fence, which is what an LLM usually wraps JSON in.
fn strip_fence(text: &str) -> &str {
    let trimmed = text.trim();
    let Some(rest) = trimmed.strip_prefix("```") else {
        return trimmed;
    };
    // Drop the (optional) language tag on the opening fence.
    let rest = rest.split_once('\n').map(|(_, rest)| rest).unwrap_or("");
    rest.trim_end().strip_suffix("```").unwrap_or(rest).trim()
}

/// Accepts a bare array, or an object with a `cards` key holding one. Shared
/// with the story reply parser, which LLMs wrap the same way.
pub fn extract_array(text: &str) -> Result<Vec<serde_json::Value>> {
    let value: serde_json::Value = serde_json::from_str(strip_fence(text))
        .map_err(|e| Error::invalid(format!("that is not valid JSON: {e}")))?;
    match value {
        serde_json::Value::Array(items) => Ok(items),
        serde_json::Value::Object(mut map) => map
            .remove("cards")
            .and_then(|v| match v {
                serde_json::Value::Array(items) => Some(items),
                _ => None,
            })
            .ok_or_else(|| {
                Error::invalid("expected a JSON array, or an object with a `cards` array")
            }),
        _ => Err(Error::invalid("expected a JSON array of cards")),
    }
}

/// Imports cards into a normal deck. Cards are numbered in the order they
/// appear, continuing from the end of the deck unless `replace` is set.
#[cfg_attr(not(test), tauri::command)]
pub fn import_cards(
    db: DbState<'_>,
    deck_id: i64,
    json: String,
    replace: bool,
) -> Result<ImportResult> {
    let items = extract_array(&json)?;
    db.with(|conn| {
        decks::require_kind(conn, deck_id, DeckKind::Normal)?;
        let tx = conn.transaction()?;
        if replace {
            tx.execute("DELETE FROM card WHERE deck_id = ?1", params![deck_id])?;
        }
        let mut idx: i64 = tx.query_row(
            "SELECT COALESCE(MAX(idx), 0) FROM card WHERE deck_id = ?1",
            params![deck_id],
            |row| row.get(0),
        )?;

        let mut imported = 0usize;
        let mut skipped = 0usize;
        for item in items {
            let card: ImportCard = match serde_json::from_value(item) {
                Ok(card) => card,
                Err(_) => {
                    skipped += 1;
                    continue;
                }
            };
            if card.front.trim().is_empty() {
                skipped += 1;
                continue;
            }
            idx += 1;
            tx.execute(
                "INSERT INTO card (deck_id, idx, front, back, comment, story)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    deck_id,
                    idx,
                    card.front.trim(),
                    card.back.trim(),
                    card.comment.trim(),
                    card.story.trim()
                ],
            )?;
            imported += 1;
        }
        tx.commit()?;
        renumber(conn, deck_id)?;
        let total: i64 = conn.query_row(
            "SELECT COUNT(*) FROM card WHERE deck_id = ?1",
            params![deck_id],
            |row| row.get(0),
        )?;
        Ok(ImportResult {
            imported,
            skipped,
            total,
        })
    })
}

/// Exports a deck in the same shape `import_cards` accepts.
#[cfg_attr(not(test), tauri::command)]
pub fn export_cards(db: DbState<'_>, deck_id: i64) -> Result<String> {
    db.with(|conn| {
        let sql = format!("{CARD_SELECT} WHERE deck_id = ?1 ORDER BY idx");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![deck_id], card_from_row)?;
        let cards = rows
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .map(|card| {
                serde_json::json!({
                    "index": card.idx,
                    "front": card.front,
                    "back": card.back,
                    "comment": card.comment,
                    "story": card.story,
                })
            })
            .collect::<Vec<_>>();
        Ok(serde_json::to_string_pretty(&cards)?)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::models::CardSelection;

    fn seeded() -> Db {
        let db = Db::open_in_memory().unwrap();
        db.with(|conn| {
            conn.execute(
                "INSERT INTO deck (id, name, kind, created_at) VALUES (1, 'deck', 'normal', '')",
                [],
            )?;
            for i in 1..=5 {
                conn.execute(
                    "INSERT INTO card (deck_id, idx, front) VALUES (1, ?1, ?2)",
                    params![i, format!("card {i}")],
                )?;
            }
            Ok(())
        })
        .unwrap();
        db
    }

    fn fronts(db: &Db) -> Vec<String> {
        db.with(|conn| {
            let mut stmt = conn.prepare("SELECT front FROM card WHERE deck_id = 1 ORDER BY idx")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .unwrap()
    }

    #[test]
    fn a_slice_covers_an_inclusive_range() {
        let db = seeded();
        db.with(|conn| {
            let selection = CardSelection {
                deck_id: 1,
                from_index: Some(2),
                to_index: Some(4),
            };
            let picked = cards_in_selection(conn, &selection)?;
            assert_eq!(picked.iter().map(|c| c.idx).collect::<Vec<_>>(), [2, 3, 4]);

            let whole = cards_in_selection(
                conn,
                &CardSelection {
                    deck_id: 1,
                    from_index: None,
                    to_index: None,
                },
            )?;
            assert_eq!(whole.len(), 5);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn renumber_closes_gaps() {
        let db = seeded();
        db.with(|conn| {
            conn.execute("DELETE FROM card WHERE idx IN (2, 4)", [])?;
            renumber(conn, 1)?;
            let indices: Vec<i64> = {
                let mut stmt =
                    conn.prepare("SELECT idx FROM card WHERE deck_id = 1 ORDER BY idx")?;
                let rows = stmt.query_map([], |row| row.get(0))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            assert_eq!(indices, [1, 2, 3]);
            Ok(())
        })
        .unwrap();
    }

    fn id_at(db: &Db, idx: i64) -> i64 {
        db.with(|conn| {
            Ok(conn.query_row(
                "SELECT id FROM card WHERE deck_id = 1 AND idx = ?1",
                params![idx],
                |row| row.get(0),
            )?)
        })
        .unwrap()
    }

    #[test]
    fn moving_a_card_backwards_shifts_the_others() {
        let db = seeded();
        let id = id_at(&db, 4);
        db.with(|conn| move_within_deck(conn, id, 1)).unwrap();
        assert_eq!(
            fronts(&db),
            ["card 4", "card 1", "card 2", "card 3", "card 5"]
        );
    }

    #[test]
    fn moving_a_card_forwards_shifts_the_others() {
        let db = seeded();
        let id = id_at(&db, 2);
        db.with(|conn| move_within_deck(conn, id, 5)).unwrap();
        assert_eq!(
            fronts(&db),
            ["card 1", "card 3", "card 4", "card 5", "card 2"]
        );
    }

    #[test]
    fn moving_out_of_range_clamps_to_the_deck() {
        let db = seeded();
        let id = id_at(&db, 3);
        db.with(|conn| move_within_deck(conn, id, 99)).unwrap();
        assert_eq!(fronts(&db).last().unwrap(), "card 3");
        db.with(|conn| move_within_deck(conn, id, -5)).unwrap();
        assert_eq!(fronts(&db).first().unwrap(), "card 3");
    }

    #[test]
    fn strips_markdown_fences() {
        assert_eq!(strip_fence("```json\n[1]\n```"), "[1]");
        assert_eq!(strip_fence("```\n[1]\n```"), "[1]");
        assert_eq!(strip_fence("  [1]  "), "[1]");
    }

    #[test]
    fn accepts_bare_arrays_and_wrapped_ones() {
        assert_eq!(extract_array("[{\"front\":\"a\"}]").unwrap().len(), 1);
        assert_eq!(
            extract_array("{\"cards\":[{\"front\":\"a\"},{\"front\":\"b\"}]}")
                .unwrap()
                .len(),
            2
        );
        assert!(extract_array("{\"nope\":1}").is_err());
        assert!(extract_array("not json").is_err());
    }
}
