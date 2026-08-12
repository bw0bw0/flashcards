use chrono::{Duration, Utc};
use rusqlite::{params, Connection, Row};
use serde::Serialize;

use crate::commands::{cards, decks, now_string, parse_time, to_string};
use crate::db::DbState;
use crate::error::{Error, Result};
use crate::models::{Card, CardSelection, Deck, DeckKind, SrCard, SrDeckStats};
use crate::srs::{self, Grade, Schedule, State as SrState};

/// How far into the future a learning card may be pulled forward, so that a
/// card you just failed comes back inside the same session.
const LEARN_AHEAD_MINUTES: i64 = 20;

const SR_SELECT: &str = "
    SELECT s.id, s.sr_deck_id, s.state, s.due_at, s.interval_days, s.ease, s.reps, s.lapses,
           s.step,
           k.id, k.deck_id, k.idx, k.front, k.back, k.comment, k.story,
           d.name AS source_deck_name
    FROM sr_card s
    JOIN card k ON k.id = s.card_id
    JOIN deck d ON d.id = k.deck_id";

fn sr_card_from_row(row: &Row) -> rusqlite::Result<SrCard> {
    Ok(SrCard {
        id: row.get(0)?,
        sr_deck_id: row.get(1)?,
        state: row.get(2)?,
        due_at: row.get(3)?,
        interval_days: row.get(4)?,
        ease: row.get(5)?,
        reps: row.get(6)?,
        lapses: row.get(7)?,
        step: row.get(8)?,
        card: Card {
            id: row.get(9)?,
            deck_id: row.get(10)?,
            idx: row.get(11)?,
            front: row.get(12)?,
            back: row.get(13)?,
            comment: row.get(14)?,
            story: row.get(15)?,
        },
        source_deck_name: row.get(16)?,
    })
}

/// Adds every card covered by the selections to the SR deck. Cards already in
/// the deck keep the schedule they have.
fn add_selections(conn: &Connection, sr_deck_id: i64, selections: &[CardSelection]) -> Result<i64> {
    let now = now_string();
    let mut added = 0i64;
    for selection in selections {
        decks::require_kind(conn, selection.deck_id, DeckKind::Normal)?;
        for card in cards::cards_in_selection(conn, selection)? {
            added += conn.execute(
                "INSERT OR IGNORE INTO sr_card (sr_deck_id, card_id, added_at, state, due_at)
                 VALUES (?1, ?2, ?3, 'new', ?3)",
                params![sr_deck_id, card.id, now],
            )? as i64;
        }
    }
    Ok(added)
}

#[cfg_attr(not(test), tauri::command)]
pub fn create_sr_deck(
    db: DbState<'_>,
    name: String,
    category_id: Option<i64>,
    description: Option<String>,
    selections: Vec<CardSelection>,
) -> Result<Deck> {
    db.with(|conn| {
        let deck = decks::insert_deck(conn, &name, category_id, description, DeckKind::Sr)?;
        add_selections(conn, deck.id, &selections)?;
        decks::read(conn, deck.id)
    })
}

#[cfg_attr(not(test), tauri::command)]
pub fn add_to_sr_deck(
    db: DbState<'_>,
    sr_deck_id: i64,
    selections: Vec<CardSelection>,
) -> Result<i64> {
    db.with(|conn| {
        decks::require_kind(conn, sr_deck_id, DeckKind::Sr)?;
        add_selections(conn, sr_deck_id, &selections)
    })
}

#[cfg_attr(not(test), tauri::command)]
pub fn list_sr_cards(db: DbState<'_>, sr_deck_id: i64) -> Result<Vec<SrCard>> {
    db.with(|conn| {
        let sql = format!("{SR_SELECT} WHERE s.sr_deck_id = ?1 ORDER BY d.name, k.idx");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![sr_deck_id], sr_card_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

#[cfg_attr(not(test), tauri::command)]
pub fn remove_sr_cards(db: DbState<'_>, sr_card_ids: Vec<i64>) -> Result<usize> {
    db.with(|conn| {
        let tx = conn.transaction()?;
        let mut removed = 0;
        for id in sr_card_ids {
            removed += tx.execute("DELETE FROM sr_card WHERE id = ?1", params![id])?;
        }
        tx.commit()?;
        Ok(removed)
    })
}

/// The study queue: cards that are due now, followed by learning cards due in
/// the next few minutes.
#[cfg_attr(not(test), tauri::command)]
pub fn sr_queue(db: DbState<'_>, sr_deck_id: i64, limit: Option<i64>) -> Result<Vec<SrCard>> {
    let now = Utc::now();
    let now_str = to_string(now);
    let ahead = to_string(now + Duration::minutes(LEARN_AHEAD_MINUTES));
    db.with(|conn| {
        decks::require_kind(conn, sr_deck_id, DeckKind::Sr)?;
        let sql = format!(
            "{SR_SELECT}
             WHERE s.sr_deck_id = ?1
               AND (s.due_at <= ?2
                    OR (s.state IN ('learning', 'relearning') AND s.due_at <= ?3))
             ORDER BY (s.due_at <= ?2) DESC, s.due_at, s.id
             LIMIT ?4"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            params![sr_deck_id, now_str, ahead, limit.unwrap_or(100)],
            sr_card_from_row,
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

#[cfg_attr(not(test), tauri::command)]
pub fn sr_deck_stats(db: DbState<'_>, sr_deck_id: i64) -> Result<SrDeckStats> {
    let now = now_string();
    let today = to_string(Utc::now() - Duration::hours(24));
    db.with(|conn| {
        let (total, due, new, learning, review) = conn.query_row(
            "SELECT COUNT(*),
                    COUNT(*) FILTER (WHERE due_at <= ?2),
                    COUNT(*) FILTER (WHERE state = 'new'),
                    COUNT(*) FILTER (WHERE state IN ('learning', 'relearning')),
                    COUNT(*) FILTER (WHERE state = 'review')
             FROM sr_card WHERE sr_deck_id = ?1",
            params![sr_deck_id, now],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )?;
        let reviewed_today: i64 = conn.query_row(
            "SELECT COUNT(*) FROM review_log r
             JOIN sr_card s ON s.id = r.sr_card_id
             WHERE s.sr_deck_id = ?1 AND r.reviewed_at >= ?2",
            params![sr_deck_id, today],
            |row| row.get(0),
        )?;
        Ok(SrDeckStats {
            total,
            due,
            new,
            learning,
            review,
            reviewed_today,
        })
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GradeResult {
    pub card: SrCard,
    /// Human readable delay until the card comes back, e.g. "10m" or "3d".
    pub next_due_in: String,
}

fn humanise(minutes: i64) -> String {
    if minutes < 60 {
        format!("{}m", minutes.max(1))
    } else if minutes < 60 * 24 {
        format!("{}h", (minutes as f64 / 60.0).round() as i64)
    } else if minutes < 60 * 24 * 30 {
        format!("{}d", (minutes as f64 / 1440.0).round() as i64)
    } else if minutes < 60 * 24 * 365 {
        format!("{}mo", (minutes as f64 / 43_200.0).round() as i64)
    } else {
        format!("{:.1}y", minutes as f64 / 525_600.0)
    }
}

#[cfg_attr(not(test), tauri::command)]
pub fn grade_sr_card(db: DbState<'_>, sr_card_id: i64, grade: Grade) -> Result<GradeResult> {
    let now = Utc::now();
    db.with(|conn| {
        let previous = conn
            .query_row(
                "SELECT state, step, interval_days, ease, reps, lapses, due_at
                 FROM sr_card WHERE id = ?1",
                params![sr_card_id],
                |row| {
                    let state: String = row.get(0)?;
                    let due_at: String = row.get(6)?;
                    Ok(Schedule {
                        state: SrState::parse(&state),
                        step: row.get(1)?,
                        interval_days: row.get(2)?,
                        ease: row.get(3)?,
                        reps: row.get(4)?,
                        lapses: row.get(5)?,
                        due_at: parse_time(&due_at),
                    })
                },
            )
            .map_err(|_| Error::invalid("card is not in this deck"))?;

        let next = srs::review(previous, grade, now);
        conn.execute(
            "UPDATE sr_card
             SET state = ?2, step = ?3, interval_days = ?4, ease = ?5, reps = ?6, lapses = ?7,
                 due_at = ?8, last_reviewed_at = ?9
             WHERE id = ?1",
            params![
                sr_card_id,
                next.state.as_str(),
                next.step,
                next.interval_days,
                next.ease,
                next.reps,
                next.lapses,
                to_string(next.due_at),
                to_string(now)
            ],
        )?;
        conn.execute(
            "INSERT INTO review_log (sr_card_id, reviewed_at, grade, interval_days)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                sr_card_id,
                to_string(now),
                grade.as_i64(),
                next.interval_days
            ],
        )?;

        let sql = format!("{SR_SELECT} WHERE s.id = ?1");
        let card = conn.query_row(&sql, params![sr_card_id], sr_card_from_row)?;
        Ok(GradeResult {
            card,
            next_due_in: humanise((next.due_at - now).num_minutes()),
        })
    })
}

/// Puts a card back to the state it had when it was first added to the deck.
#[cfg_attr(not(test), tauri::command)]
pub fn reset_sr_card(db: DbState<'_>, sr_card_id: i64) -> Result<()> {
    let fresh = Schedule::new(Utc::now());
    db.with(|conn| {
        conn.execute(
            "UPDATE sr_card
             SET state = ?2, step = ?3, interval_days = ?4, ease = ?5, reps = ?6, lapses = ?7,
                 due_at = ?8, last_reviewed_at = NULL
             WHERE id = ?1",
            params![
                sr_card_id,
                fresh.state.as_str(),
                fresh.step,
                fresh.interval_days,
                fresh.ease,
                fresh.reps,
                fresh.lapses,
                to_string(fresh.due_at)
            ],
        )?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn humanises_delays() {
        assert_eq!(humanise(0), "1m");
        assert_eq!(humanise(10), "10m");
        assert_eq!(humanise(90), "2h");
        assert_eq!(humanise(1440), "1d");
        assert_eq!(humanise(1440 * 45), "2mo");
        assert_eq!(humanise(1440 * 400), "1.1y");
    }
}
