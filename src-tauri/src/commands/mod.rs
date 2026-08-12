pub mod cards;
pub mod categories;
pub mod decks;
pub mod prompts;
pub mod sr;

use chrono::{DateTime, Duration, Local, LocalResult, SecondsFormat, TimeZone, Utc};

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

/// The local calendar day, used to decide whether an "increase today's limit"
/// bump still applies.
pub fn today_key() -> String {
    Local::now().date_naive().to_string()
}

/// Local midnight, in UTC, used as the cutoff for "studied/reviewed today".
/// Daily limits reset by calendar day rather than a rolling 24 hours, same as
/// Anki, so a card studied at 11pm and one studied at 8am the next morning
/// count against different days even though under 24 hours apart.
pub fn day_start() -> DateTime<Utc> {
    let midnight = Local::now().date_naive().and_hms_opt(0, 0, 0).unwrap();
    match Local.from_local_datetime(&midnight) {
        LocalResult::Single(dt) | LocalResult::Ambiguous(dt, _) => dt.with_timezone(&Utc),
        // A DST spring-forward can make local midnight not exist; falling
        // back to "24 hours ago" is close enough for a daily-limit cutoff.
        LocalResult::None => Utc::now() - Duration::hours(24),
    }
}
