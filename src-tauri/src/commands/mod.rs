pub mod cards;
pub mod categories;
pub mod decks;
pub mod prompts;
pub mod sr;

use chrono::{DateTime, SecondsFormat, Utc};

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
