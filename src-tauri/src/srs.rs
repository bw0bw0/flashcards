//! SM-2 style spaced repetition scheduler with learning / relearning steps.
//!
//! The scheduler is a pure function of the previous schedule, the grade and the
//! current time, which keeps it easy to test and easy to swap out later.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

/// Minutes between the short-term repetitions a brand new card goes through
/// before it graduates into the long-term queue.
const LEARNING_STEPS_MINS: &[f64] = &[1.0, 10.0];
/// Same, for a card that was forgotten and has to be relearned.
const RELEARNING_STEPS_MINS: &[f64] = &[10.0];
/// Interval a card gets when it finishes the learning steps.
const GRADUATING_INTERVAL_DAYS: f64 = 1.0;
/// Interval a card gets when it skips the learning steps with `Easy`.
const EASY_INTERVAL_DAYS: f64 = 4.0;
const MIN_EASE: f64 = 1.3;
const MAX_EASE: f64 = 3.5;
const MAX_INTERVAL_DAYS: f64 = 365.0 * 5.0;
/// Fraction of the interval a card keeps when it lapses.
const LAPSE_INTERVAL_FACTOR: f64 = 0.5;
const HARD_INTERVAL_FACTOR: f64 = 1.2;
const EASY_BONUS: f64 = 1.3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Grade {
    Again,
    Hard,
    Good,
    Easy,
}

impl Grade {
    pub fn as_i64(self) -> i64 {
        match self {
            Grade::Again => 0,
            Grade::Hard => 1,
            Grade::Good => 2,
            Grade::Easy => 3,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    New,
    Learning,
    Review,
    Relearning,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::New => "new",
            State::Learning => "learning",
            State::Review => "review",
            State::Relearning => "relearning",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "learning" => State::Learning,
            "review" => State::Review,
            "relearning" => State::Relearning,
            _ => State::New,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Schedule {
    pub state: State,
    /// Index into the learning / relearning steps.
    pub step: i64,
    pub interval_days: f64,
    pub ease: f64,
    pub reps: i64,
    pub lapses: i64,
    pub due_at: DateTime<Utc>,
}

impl Schedule {
    /// The schedule of a card that has just been added to an SR deck.
    pub fn new(now: DateTime<Utc>) -> Self {
        Schedule {
            state: State::New,
            step: 0,
            interval_days: 0.0,
            ease: 2.5,
            reps: 0,
            lapses: 0,
            due_at: now,
        }
    }
}

fn days(value: f64) -> Duration {
    Duration::seconds((value * 86_400.0).round() as i64)
}

fn minutes(value: f64) -> Duration {
    Duration::seconds((value * 60.0).round() as i64)
}

fn clamp_ease(ease: f64) -> f64 {
    ease.clamp(MIN_EASE, MAX_EASE)
}

fn clamp_interval(interval: f64) -> f64 {
    interval.clamp(1.0, MAX_INTERVAL_DAYS)
}

/// Applies a grade to a schedule, returning the next one.
pub fn review(prev: Schedule, grade: Grade, now: DateTime<Utc>) -> Schedule {
    let mut next = prev;
    next.reps = prev.reps + 1;

    match prev.state {
        State::New | State::Learning => grade_learning(&mut next, grade, now, LEARNING_STEPS_MINS),
        State::Relearning => grade_learning(&mut next, grade, now, RELEARNING_STEPS_MINS),
        State::Review => grade_review(&mut next, grade, now),
    }

    next
}

/// Learning and relearning share their step logic; they differ only in the steps
/// themselves and in the interval a card graduates with.
fn grade_learning(next: &mut Schedule, grade: Grade, now: DateTime<Utc>, steps: &[f64]) {
    let relearning = next.state == State::Relearning;
    // A relearning card keeps the (already shortened) interval it had when it
    // lapsed; a new card has nothing to fall back on.
    let graduating_interval = if relearning {
        clamp_interval(next.interval_days)
    } else {
        GRADUATING_INTERVAL_DAYS
    };

    match grade {
        Grade::Again => {
            next.state = if relearning {
                State::Relearning
            } else {
                State::Learning
            };
            next.step = 0;
            next.due_at = now + minutes(steps[0]);
        }
        Grade::Hard => {
            next.state = if relearning {
                State::Relearning
            } else {
                State::Learning
            };
            let step = (next.step.max(0) as usize).min(steps.len() - 1);
            next.due_at = now + minutes(steps[step]);
        }
        Grade::Good => {
            let step = next.step + 1;
            if step as usize >= steps.len() {
                graduate(next, now, graduating_interval);
            } else {
                next.state = if relearning {
                    State::Relearning
                } else {
                    State::Learning
                };
                next.step = step;
                next.due_at = now + minutes(steps[step as usize]);
            }
        }
        Grade::Easy => {
            let interval = if relearning {
                clamp_interval(graduating_interval * EASY_BONUS)
            } else {
                EASY_INTERVAL_DAYS
            };
            graduate(next, now, interval);
        }
    }
}

fn graduate(next: &mut Schedule, now: DateTime<Utc>, interval_days: f64) {
    next.state = State::Review;
    next.step = 0;
    next.interval_days = clamp_interval(interval_days);
    next.due_at = now + days(next.interval_days);
}

fn grade_review(next: &mut Schedule, grade: Grade, now: DateTime<Utc>) {
    let interval = next.interval_days.max(1.0);
    match grade {
        Grade::Again => {
            next.lapses += 1;
            next.ease = clamp_ease(next.ease - 0.2);
            next.interval_days = clamp_interval(interval * LAPSE_INTERVAL_FACTOR);
            next.state = State::Relearning;
            next.step = 0;
            next.due_at = now + minutes(RELEARNING_STEPS_MINS[0]);
        }
        Grade::Hard => {
            next.ease = clamp_ease(next.ease - 0.15);
            next.interval_days = clamp_interval(interval * HARD_INTERVAL_FACTOR);
            next.due_at = now + days(next.interval_days);
        }
        Grade::Good => {
            next.interval_days = clamp_interval(interval * next.ease);
            next.due_at = now + days(next.interval_days);
        }
        Grade::Easy => {
            next.ease = clamp_ease(next.ease + 0.15);
            next.interval_days = clamp_interval(interval * next.ease * EASY_BONUS);
            next.due_at = now + days(next.interval_days);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-01-01T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn new_card_walks_the_learning_steps() {
        let t = now();
        let first = review(Schedule::new(t), Grade::Good, t);
        assert_eq!(first.state, State::Learning);
        assert_eq!(first.step, 1);
        assert_eq!(first.due_at, t + minutes(10.0));

        let second = review(first, Grade::Good, t);
        assert_eq!(second.state, State::Review);
        assert_eq!(second.interval_days, GRADUATING_INTERVAL_DAYS);
        assert_eq!(second.due_at, t + days(1.0));
    }

    #[test]
    fn again_restarts_the_learning_steps() {
        let t = now();
        let card = review(Schedule::new(t), Grade::Good, t);
        let card = review(card, Grade::Again, t);
        assert_eq!(card.state, State::Learning);
        assert_eq!(card.step, 0);
        assert_eq!(card.due_at, t + minutes(1.0));
    }

    #[test]
    fn easy_skips_straight_to_review() {
        let t = now();
        let card = review(Schedule::new(t), Grade::Easy, t);
        assert_eq!(card.state, State::Review);
        assert_eq!(card.interval_days, EASY_INTERVAL_DAYS);
    }

    #[test]
    fn good_multiplies_the_interval_by_the_ease() {
        let t = now();
        let card = Schedule {
            state: State::Review,
            interval_days: 10.0,
            ease: 2.5,
            ..Schedule::new(t)
        };
        let next = review(card, Grade::Good, t);
        assert_eq!(next.interval_days, 25.0);
        assert_eq!(next.ease, 2.5);
        assert_eq!(next.due_at, t + days(25.0));
    }

    #[test]
    fn hard_grows_slowly_and_lowers_the_ease() {
        let t = now();
        let card = Schedule {
            state: State::Review,
            interval_days: 10.0,
            ease: 2.5,
            ..Schedule::new(t)
        };
        let next = review(card, Grade::Hard, t);
        assert!((next.ease - 2.35).abs() < 1e-9);
        assert!((next.interval_days - 12.0).abs() < 1e-9);
    }

    #[test]
    fn lapse_halves_the_interval_and_relearns() {
        let t = now();
        let card = Schedule {
            state: State::Review,
            interval_days: 20.0,
            ease: 2.5,
            ..Schedule::new(t)
        };
        let lapsed = review(card, Grade::Again, t);
        assert_eq!(lapsed.state, State::Relearning);
        assert_eq!(lapsed.lapses, 1);
        assert_eq!(lapsed.interval_days, 10.0);
        assert!((lapsed.ease - 2.3).abs() < 1e-9);
        assert_eq!(lapsed.due_at, t + minutes(10.0));

        // Relearning graduates back to review with the shortened interval.
        let relearned = review(lapsed, Grade::Good, t);
        assert_eq!(relearned.state, State::Review);
        assert_eq!(relearned.interval_days, 10.0);
        assert_eq!(relearned.due_at, t + days(10.0));
    }

    #[test]
    fn ease_stays_within_bounds() {
        let t = now();
        let mut card = Schedule {
            state: State::Review,
            interval_days: 5.0,
            ease: 1.4,
            ..Schedule::new(t)
        };
        for _ in 0..10 {
            card = review(card, Grade::Hard, t);
            card.state = State::Review;
        }
        assert_eq!(card.ease, MIN_EASE);

        card.ease = 3.4;
        for _ in 0..10 {
            card = review(card, Grade::Easy, t);
        }
        assert_eq!(card.ease, MAX_EASE);
    }

    #[test]
    fn interval_is_capped() {
        let t = now();
        let card = Schedule {
            state: State::Review,
            interval_days: MAX_INTERVAL_DAYS,
            ease: 2.5,
            ..Schedule::new(t)
        };
        let next = review(card, Grade::Good, t);
        assert_eq!(next.interval_days, MAX_INTERVAL_DAYS);
    }
}
