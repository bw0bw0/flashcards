use rusqlite::{params, Connection, Row};

use crate::commands::now_string;
use crate::db::DbState;
use crate::error::{Error, Result};
use crate::models::{Deck, DeckKind};

const DECK_SELECT: &str = "
    SELECT d.id, d.category_id, c.name AS category_name, d.name, d.description, d.kind,
           d.position, d.created_at,
           CASE WHEN d.kind = 'sr'
                THEN (SELECT COUNT(*) FROM sr_card s WHERE s.sr_deck_id = d.id)
                ELSE (SELECT COUNT(*) FROM card k WHERE k.deck_id = d.id)
           END AS card_count,
           (SELECT COUNT(*) FROM sr_card s WHERE s.sr_deck_id = d.id AND s.due_at <= ?1)
               AS due_count,
           (SELECT COUNT(*) FROM sr_card s WHERE s.sr_deck_id = d.id AND s.state = 'new')
               AS new_count,
           d.new_per_day, d.review_per_day
    FROM deck d
    LEFT JOIN category c ON c.id = d.category_id";

fn deck_from_row(row: &Row) -> rusqlite::Result<Deck> {
    let kind: String = row.get(5)?;
    Ok(Deck {
        id: row.get(0)?,
        category_id: row.get(1)?,
        category_name: row.get(2)?,
        name: row.get(3)?,
        description: row.get(4)?,
        kind: DeckKind::parse(&kind),
        position: row.get(6)?,
        created_at: row.get(7)?,
        card_count: row.get(8)?,
        due_count: row.get(9)?,
        new_count: row.get(10)?,
        new_per_day: row.get(11)?,
        review_per_day: row.get(12)?,
    })
}

pub fn read(conn: &Connection, id: i64) -> Result<Deck> {
    let sql = format!("{DECK_SELECT} WHERE d.id = ?2");
    conn.query_row(&sql, params![now_string(), id], deck_from_row)
        .map_err(|_| Error::invalid("deck not found"))
}

/// Fails unless the deck exists and has the expected kind, so that e.g. cards
/// are never added directly to a spaced repetition deck.
pub fn require_kind(conn: &Connection, id: i64, kind: DeckKind) -> Result<()> {
    let actual: String = conn
        .query_row("SELECT kind FROM deck WHERE id = ?1", params![id], |row| {
            row.get(0)
        })
        .map_err(|_| Error::invalid("deck not found"))?;
    if DeckKind::parse(&actual) != kind {
        return Err(Error::invalid(match kind {
            DeckKind::Normal => "that is a spaced repetition deck",
            DeckKind::Sr => "that is not a spaced repetition deck",
        }));
    }
    Ok(())
}

#[cfg_attr(not(test), tauri::command)]
pub fn list_decks(db: DbState<'_>) -> Result<Vec<Deck>> {
    db.with(|conn| {
        let sql = format!(
            "{DECK_SELECT} ORDER BY c.position IS NULL, c.position, c.name, d.position, d.name"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![now_string()], deck_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

#[cfg_attr(not(test), tauri::command)]
pub fn get_deck(db: DbState<'_>, id: i64) -> Result<Deck> {
    db.with(|conn| read(conn, id))
}

#[cfg_attr(not(test), tauri::command)]
pub fn create_deck(
    db: DbState<'_>,
    name: String,
    category_id: Option<i64>,
    description: Option<String>,
) -> Result<Deck> {
    db.with(|conn| insert_deck(conn, &name, category_id, description, DeckKind::Normal))
}

/// Shared by `create_deck` and the spaced repetition deck builder.
pub fn insert_deck(
    conn: &Connection,
    name: &str,
    category_id: Option<i64>,
    description: Option<String>,
    kind: DeckKind,
) -> Result<Deck> {
    let name = name.trim();
    if name.is_empty() {
        return Err(Error::invalid("deck name cannot be empty"));
    }
    let position: i64 = conn.query_row(
        "SELECT COALESCE(MAX(position), 0) + 1 FROM deck WHERE category_id IS ?1",
        params![category_id],
        |row| row.get(0),
    )?;
    conn.execute(
        "INSERT INTO deck (category_id, name, description, kind, position, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            category_id,
            name,
            description.unwrap_or_default(),
            kind.as_str(),
            position,
            now_string()
        ],
    )?;
    read(conn, conn.last_insert_rowid())
}

#[cfg_attr(not(test), tauri::command)]
pub fn update_deck(
    db: DbState<'_>,
    id: i64,
    name: String,
    category_id: Option<i64>,
    description: Option<String>,
) -> Result<Deck> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(Error::invalid("deck name cannot be empty"));
    }
    db.with(|conn| {
        let changed = conn.execute(
            "UPDATE deck SET name = ?2, category_id = ?3, description = ?4 WHERE id = ?1",
            params![id, name, category_id, description.unwrap_or_default()],
        )?;
        if changed == 0 {
            return Err(Error::invalid("deck not found"));
        }
        read(conn, id)
    })
}

/// Deleting a normal deck also deletes its cards, and with them any spaced
/// repetition entries pointing at those cards.
#[cfg_attr(not(test), tauri::command)]
pub fn delete_deck(db: DbState<'_>, id: i64) -> Result<()> {
    db.with(|conn| {
        conn.execute("DELETE FROM deck WHERE id = ?1", params![id])?;
        Ok(())
    })
}
