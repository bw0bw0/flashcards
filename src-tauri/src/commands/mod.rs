pub mod cards;
pub mod categories;
pub mod decks;
pub mod prompts;
pub mod sr;

use chrono::{DateTime, Duration, Local, LocalResult, NaiveDate, SecondsFormat, TimeZone, Utc};

use crate::srs::ROLLOVER_HOUR;

/// Timestamps are stored as RFC 3339 in UTC, which sorts correctly as text.
pub fn now_string() -> String {
    to_string(Utc::now())
}

pub fn to_string(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Secs, true)
}

pub fn parse_time(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .map(|t| t.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}

/// Today's date in Anki's sense: the day changes at the rollover hour (4am),
/// not at midnight. Used to decide whether an "increase today's limit" bump
/// still applies.
pub fn today_key() -> String {
    anki_date(Utc::now()).to_string()
}

/// The start of today (the last rollover), in UTC, used as the cutoff for
/// "studied/reviewed today". Like Anki, daily limits reset at the rollover
/// rather than over a rolling 24 hours.
pub fn day_start() -> DateTime<Utc> {
    day_start_in(0)
}

/// The rollover `days` days from today, in UTC. Review cards become due at
/// the start of their due day, like in Anki.
pub fn day_start_in(days: i64) -> DateTime<Utc> {
    rollover_of(anki_date(Utc::now()) + Duration::days(days))
}

/// Whole days from `time`'s day to today, using rollover-based days
/// (negative if `time` falls on a later day).
pub fn days_since(time: DateTime<Utc>) -> i64 {
    (anki_date(Utc::now()) - anki_date(time)).num_days()
}

/// The day `time` belongs to, if days start at the rollover hour.
fn anki_date(time: DateTime<Utc>) -> NaiveDate {
    (time.with_timezone(&Local) - Duration::hours(ROLLOVER_HOUR as i64)).date_naive()
}

fn rollover_of(date: NaiveDate) -> DateTime<Utc> {
    let start = date.and_hms_opt(ROLLOVER_HOUR, 0, 0).unwrap();
    match Local.from_local_datetime(&start) {
        LocalResult::Single(dt) | LocalResult::Ambiguous(dt, _) => dt.with_timezone(&Utc),
        // A DST jump can skip the rollover hour; the hour after it is close
        // enough.
        LocalResult::None => Local
            .from_local_datetime(&(start + Duration::hours(1)))
            .earliest()
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(Utc::now),
    }
}
