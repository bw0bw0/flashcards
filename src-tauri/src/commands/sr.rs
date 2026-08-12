use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, Row};
use serde::Serialize;

use crate::commands::{cards, day_start, decks, now_string, parse_time, to_string, today_key};
use crate::db::DbState;
use crate::error::{Error, Result};
use crate::models::{Card, CardSelection, Deck, DeckKind, SrCard, SrDeckStats};
use crate::srs::{self, Grade, Schedule, State as SrState};

/// How far into the future a learning card may be pulled forward, so that a
/// card you just failed comes back inside the same session.
const LEARN_AHEAD_MINUTES: i64 = 20;

/// Today's effective new/review caps for a deck, and how much of each has
/// already been used today.
#[derive(Debug, Clone, Copy)]
struct DailyLimits {
    new_per_day: i64,
    review_per_day: i64,
    new_studied_today: i64,
    reviews_today: i64,
}

impl DailyLimits {
    fn new_remaining(&self) -> i64 {
        (self.new_per_day - self.new_studied_today).max(0)
    }

    fn review_remaining(&self) -> i64 {
        (self.review_per_day - self.reviews_today).max(0)
    }
}

/// Reads a deck's daily caps, folding in any "increase today's limit" bump
/// that still applies, plus how much of each cap is already spent today.
fn daily_limits(conn: &Connection, sr_deck_id: i64, day_start_str: &str) -> Result<DailyLimits> {
    conn.query_row(
        "SELECT d.new_per_day
                    + CASE WHEN d.extra_today_date = ?2 THEN d.extra_new_today ELSE 0 END,
                d.review_per_day
                    + CASE WHEN d.extra_today_date = ?2 THEN d.extra_review_today ELSE 0 END,
                (SELECT COUNT(*) FROM sr_card s
                    WHERE s.sr_deck_id = d.id AND s.first_studied_at >= ?3),
                -- Only review-state reviews count against the review cap;
                -- learning/relearning steps happen automatically until a card
                -- graduates and are not subject to a daily limit.
                (SELECT COUNT(*) FROM review_log r
                    JOIN sr_card s ON s.id = r.sr_card_id
                    WHERE s.sr_deck_id = d.id AND s.state = 'review' AND r.reviewed_at >= ?3)
         FROM deck d WHERE d.id = ?1",
        params![sr_deck_id, today_key(), day_start_str],
        |row| {
            Ok(DailyLimits {
                new_per_day: row.get(0)?,
                review_per_day: row.get(1)?,
                new_studied_today: row.get(2)?,
                reviews_today: row.get(3)?,
            })
        },
    )
    .map_err(|_| Error::invalid("deck not found"))
}

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

/// The study queue: due learning/relearning cards first (uncapped, since they
/// need to be seen again to graduate), then due review cards, then new cards
/// — the last two capped by whatever today's daily limits still allow.
///
/// `review_ahead_days`, when positive, pulls in review cards due within that
/// many days instead of only ones due now, and lifts the review cap for the
/// session, mirroring Anki's "review ahead" custom study option.
#[cfg_attr(not(test), tauri::command)]
pub fn sr_queue(
    db: DbState<'_>,
    sr_deck_id: i64,
    limit: Option<i64>,
    review_ahead_days: Option<i64>,
) -> Result<Vec<SrCard>> {
    let now = Utc::now();
    let now_str = to_string(now);
    let ahead = to_string(now + Duration::minutes(LEARN_AHEAD_MINUTES));
    let review_ahead_days = review_ahead_days.unwrap_or(0).max(0);
    let review_cutoff = if review_ahead_days > 0 {
        to_string(now + Duration::days(review_ahead_days))
    } else {
        now_str.clone()
    };
    let overall_limit = limit.unwrap_or(100);
    let day_start_str = to_string(day_start());

    db.with(|conn| {
        decks::require_kind(conn, sr_deck_id, DeckKind::Sr)?;
        let limits = daily_limits(conn, sr_deck_id, &day_start_str)?;
        let mut cards = Vec::new();

        let learning_sql = format!(
            "{SR_SELECT}
             WHERE s.sr_deck_id = ?1 AND s.state IN ('learning', 'relearning') AND s.due_at <= ?2
             ORDER BY s.due_at, s.id
             LIMIT ?3"
        );
        let mut stmt = conn.prepare(&learning_sql)?;
        cards.extend(
            stmt.query_map(params![sr_deck_id, ahead, overall_limit], sr_card_from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?,
        );

        let review_remaining = if review_ahead_days > 0 {
            overall_limit - cards.len() as i64
        } else {
            limits.review_remaining().min(overall_limit - cards.len() as i64)
        }
        .max(0);
        if review_remaining > 0 {
            let review_sql = format!(
                "{SR_SELECT}
                 WHERE s.sr_deck_id = ?1 AND s.state = 'review' AND s.due_at <= ?2
                 ORDER BY s.due_at, s.id
                 LIMIT ?3"
            );
            let mut stmt = conn.prepare(&review_sql)?;
            cards.extend(
                stmt.query_map(
                    params![sr_deck_id, review_cutoff, review_remaining],
                    sr_card_from_row,
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?,
            );
        }

        let new_remaining = limits.new_remaining().min(overall_limit - cards.len() as i64).max(0);
        if new_remaining > 0 {
            let new_sql = format!(
                "{SR_SELECT}
                 WHERE s.sr_deck_id = ?1 AND s.state = 'new'
                 ORDER BY d.name, k.idx
                 LIMIT ?2"
            );
            let mut stmt = conn.prepare(&new_sql)?;
            cards.extend(
                stmt.query_map(params![sr_deck_id, new_remaining], sr_card_from_row)?
                    .collect::<rusqlite::Result<Vec<_>>>()?,
            );
        }

        Ok(cards)
    })
}

/// Shared by the `sr_deck_stats` command and `increase_sr_limits`, which needs
/// fresh stats after it bumps a deck's limits.
fn compute_stats(conn: &Connection, sr_deck_id: i64, now: DateTime<Utc>) -> Result<SrDeckStats> {
    let now_str = to_string(now);
    let ahead = to_string(now + Duration::minutes(LEARN_AHEAD_MINUTES));
    let day_start_str = to_string(day_start());
    let limits = daily_limits(conn, sr_deck_id, &day_start_str)?;

    let (total, new_raw, learning, review_raw, learning_due, review_due, reviewed_today): (
        i64,
        i64,
        i64,
        i64,
        i64,
        i64,
        i64,
    ) = conn
        .query_row(
            "SELECT COUNT(*),
                    COUNT(*) FILTER (WHERE state = 'new'),
                    COUNT(*) FILTER (WHERE state IN ('learning', 'relearning')),
                    COUNT(*) FILTER (WHERE state = 'review'),
                    COUNT(*) FILTER (WHERE state IN ('learning', 'relearning') AND due_at <= ?3),
                    COUNT(*) FILTER (WHERE state = 'review' AND due_at <= ?2),
                    (SELECT COUNT(*) FROM review_log r
                        WHERE r.sr_card_id IN (SELECT id FROM sr_card WHERE sr_deck_id = ?1)
                          AND r.reviewed_at >= ?4)
             FROM sr_card WHERE sr_deck_id = ?1",
            params![sr_deck_id, now_str, ahead, day_start_str],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )?;

    let new_remaining_today = limits.new_remaining();
    let review_remaining_today = limits.review_remaining();
    let ready_now =
        learning_due + review_due.min(review_remaining_today) + new_raw.min(new_remaining_today);

    Ok(SrDeckStats {
        total,
        due: ready_now,
        new: new_raw,
        learning,
        review: review_raw,
        reviewed_today,
        new_per_day: limits.new_per_day,
        review_per_day: limits.review_per_day,
        new_remaining_today,
        review_remaining_today,
    })
}

#[cfg_attr(not(test), tauri::command)]
pub fn sr_deck_stats(db: DbState<'_>, sr_deck_id: i64) -> Result<SrDeckStats> {
    db.with(|conn| compute_stats(conn, sr_deck_id, Utc::now()))
}

/// A one-off bump to today's new/review limits ("increase today's limit" in
/// Anki), so a deck that ran out mid-session can keep going without changing
/// the deck's permanent daily settings.
#[cfg_attr(not(test), tauri::command)]
pub fn increase_sr_limits(
    db: DbState<'_>,
    sr_deck_id: i64,
    extra_new: i64,
    extra_review: i64,
) -> Result<SrDeckStats> {
    db.with(|conn| {
        decks::require_kind(conn, sr_deck_id, DeckKind::Sr)?;
        let today = today_key();
        conn.execute(
            "UPDATE deck
             SET extra_new_today = (CASE WHEN extra_today_date = ?2 THEN extra_new_today ELSE 0 END) + ?3,
                 extra_review_today = (CASE WHEN extra_today_date = ?2 THEN extra_review_today ELSE 0 END) + ?4,
                 extra_today_date = ?2
             WHERE id = ?1",
            params![sr_deck_id, today, extra_new.max(0), extra_review.max(0)],
        )?;
        compute_stats(conn, sr_deck_id, Utc::now())
    })
}

/// Sets a deck's permanent daily new-card and review limits.
#[cfg_attr(not(test), tauri::command)]
pub fn update_sr_deck_settings(
    db: DbState<'_>,
    sr_deck_id: i64,
    new_per_day: i64,
    review_per_day: i64,
) -> Result<Deck> {
    if new_per_day < 0 || review_per_day < 0 {
        return Err(Error::invalid("limits cannot be negative"));
    }
    db.with(|conn| {
        decks::require_kind(conn, sr_deck_id, DeckKind::Sr)?;
        conn.execute(
            "UPDATE deck SET new_per_day = ?2, review_per_day = ?3 WHERE id = ?1",
            params![sr_deck_id, new_per_day, review_per_day],
        )?;
        decks::read(conn, sr_deck_id)
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
        let leaving_new = previous.state == SrState::New;
        conn.execute(
            "UPDATE sr_card
             SET state = ?2, step = ?3, interval_days = ?4, ease = ?5, reps = ?6, lapses = ?7,
                 due_at = ?8, last_reviewed_at = ?9,
                 first_studied_at = CASE
                     WHEN first_studied_at IS NULL AND ?10 THEN ?9
                     ELSE first_studied_at
                 END
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
                to_string(now),
                leaving_new
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
                 due_at = ?8, last_reviewed_at = NULL, first_studied_at = NULL
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
