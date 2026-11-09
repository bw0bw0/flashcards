// Ported from Anki (https://github.com/ankitects/anki), rslib/src/scheduler:
// states/{steps,fuzz,learning,relearning,review,interval_kind}.rs and
// answering/{mod,learning,current}.rs.
// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

//! Anki's SM-2 scheduler (the v3 scheduler with FSRS turned off), using
//! Anki's default deck options.
//!
//! The port keeps Anki's arithmetic (`f32`, the same rounding, the same fuzz
//! ranges and the same `StdRng` seeding) so that, given the same card id,
//! review count and history, it produces the same intervals Anki would.
//! Not ported: FSRS, the load balancer, filtered decks and leech tagging
//! (Anki's default leech action only adds a tag, which this app has no
//! equivalent for).

use chrono::{DateTime, Duration, Utc};
use rand::prelude::*;
use rand::rngs::StdRng;
use serde::{Deserialize, Serialize};

/// Anki's deck options (`StateContext`), with Anki's defaults.
#[derive(Debug, Clone, Copy)]
pub struct Config {
    /// Learning steps, in minutes.
    pub learn_steps: &'static [f32],
    /// Relearning steps, in minutes.
    pub relearn_steps: &'static [f32],
    pub graduating_interval_good: u32,
    pub graduating_interval_easy: u32,
    pub initial_ease_factor: f32,
    pub hard_multiplier: f32,
    pub easy_multiplier: f32,
    pub interval_multiplier: f32,
    pub maximum_review_interval: u32,
    /// "New interval" after a lapse.
    pub lapse_multiplier: f32,
    pub minimum_lapse_interval: u32,
}

pub const DEFAULT_CONFIG: Config = Config {
    learn_steps: &[1.0, 10.0],
    relearn_steps: &[10.0],
    graduating_interval_good: 1,
    graduating_interval_easy: 4,
    initial_ease_factor: INITIAL_EASE_FACTOR,
    hard_multiplier: 1.2,
    easy_multiplier: 1.3,
    interval_multiplier: 1.0,
    maximum_review_interval: 36_500,
    lapse_multiplier: 0.0,
    minimum_lapse_interval: 1,
};

/// Anki's day starts at 4am local time by default ("next day starts at").
pub const ROLLOVER_HOUR: u32 = 4;

pub const INITIAL_EASE_FACTOR: f32 = 2.5;
pub const MINIMUM_EASE_FACTOR: f32 = 1.3;
pub const EASE_FACTOR_AGAIN_DELTA: f32 = -0.2;
pub const EASE_FACTOR_HARD_DELTA: f32 = -0.15;
pub const EASE_FACTOR_EASY_DELTA: f32 = 0.15;

const DAY: u32 = 60 * 60 * 24;

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

/// A card's schedule as the app stores it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Schedule {
    pub state: State,
    /// Index into the learning / relearning steps (Anki stores the number of
    /// steps remaining instead; `index = steps.len() - remaining`).
    pub step: i64,
    /// Anki's `card.interval`: the review interval in whole days. Kept while
    /// relearning, since that is the interval the card returns to review with.
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
            ease: INITIAL_EASE_FACTOR as f64,
            reps: 0,
            lapses: 0,
            due_at: now,
        }
    }
}

/// Everything about "now" the scheduler needs.
pub struct Context<'a> {
    pub now: DateTime<Utc>,
    /// The start (rollover) of the day `n` days after today.
    pub day_start: &'a dyn Fn(i64) -> DateTime<Utc>,
    /// Today minus the card's due day; for review cards this gives Anki's
    /// `elapsed_days`. Negative when reviewing ahead.
    pub days_since_due: i64,
    /// Anki's fuzz seed (`card id + reps`), or `None` to disable fuzz.
    pub fuzz_seed: Option<u64>,
}

impl Context<'_> {
    fn fuzz_factor(&self) -> Option<f32> {
        get_fuzz_factor(self.fuzz_seed)
    }

    fn secs_until_rollover(&self) -> u32 {
        ((self.day_start)(1) - self.now).num_seconds().max(0) as u32
    }
}

/// Anki's `get_fuzz_seed_for_id_and_reps`; `reps` is the count before the answer.
pub fn fuzz_seed(card_id: i64, reps: i64) -> u64 {
    (card_id as u64).wrapping_add(reps as u32 as u64)
}

/// Return a fuzz factor from the range `0.0..1.0`, using the provided seed.
fn get_fuzz_factor(seed: Option<u64>) -> Option<f32> {
    seed.map(|s| StdRng::seed_from_u64(s).random_range(0.0..1.0))
}

// ======================================================================
// states/steps.rs

#[derive(Clone, Copy, Debug, PartialEq)]
struct LearningSteps<'a> {
    /// The steps in minutes.
    steps: &'a [f32],
}

fn to_secs(v: f32) -> u32 {
    (v * 60.0) as u32
}

impl LearningSteps<'_> {
    fn new(steps: &[f32]) -> LearningSteps<'_> {
        LearningSteps { steps }
    }

    /// Strip off 'learning today', and ensure index is in bounds.
    fn get_index(self, remaining: u32) -> usize {
        let total = self.steps.len();
        total
            .saturating_sub((remaining % 1000) as usize)
            .min(total.saturating_sub(1))
    }

    fn secs_at_index(&self, index: usize) -> Option<u32> {
        self.steps.get(index).copied().map(to_secs)
    }

    fn again_delay_secs_learn(&self) -> Option<u32> {
        self.secs_at_index(0)
    }

    fn hard_delay_secs(self, remaining: u32) -> Option<u32> {
        let idx = self.get_index(remaining);
        self.secs_at_index(idx)
            // if current is invalid, try first step
            .or_else(|| self.steps.first().copied().map(to_secs))
            .map(|current| {
                if idx == 0 {
                    self.hard_delay_secs_for_first_step(current)
                } else {
                    current
                }
            })
    }

    /// Special case the hard interval for the first step to avoid equality with
    /// the again interval. Also ensure it's smaller than the good interval,
    /// at least with reasonable settings.
    fn hard_delay_secs_for_first_step(self, again_secs: u32) -> u32 {
        if let Some(next) = self.secs_at_index(1) {
            // average of first (again) and second (good) steps
            maybe_round_in_days(again_secs.saturating_add(next) / 2)
        } else {
            // 50% more than the again secs, but at most one day more
            // otherwise, a learning step of 3 days and a graduating interval of 4 days e.g.
            // would lead to the hard interval being larger than the good interval
            let secs = (again_secs.saturating_mul(3) / 2).min(again_secs.saturating_add(DAY));
            maybe_round_in_days(secs)
        }
    }

    fn good_delay_secs(self, remaining: u32) -> Option<u32> {
        let idx = self.get_index(remaining);
        self.secs_at_index(idx + 1)
    }

    fn remaining_for_good(self, remaining: u32) -> u32 {
        let idx = self.get_index(remaining);
        self.steps.len().saturating_sub(idx + 1) as u32
    }

    fn remaining_for_failed(self) -> u32 {
        self.steps.len() as u32
    }
}

/// If the given interval in seconds surpasses 1 day, rounds it to a whole
/// number of days. Ensures that the user gets the same results earlier and
/// later in the day. Returns seconds.
fn maybe_round_in_days(secs: u32) -> u32 {
    if secs > DAY {
        ((secs as f32 / DAY as f32).round() as u32).saturating_mul(DAY)
    } else {
        secs
    }
}

// ======================================================================
// states/fuzz.rs

/// Describes a range of days for which a certain amount of fuzz is applied to
/// the new interval.
struct FuzzRange {
    start: f32,
    end: f32,
    factor: f32,
}

static FUZZ_RANGES: [FuzzRange; 3] = [
    FuzzRange { start: 2.5, end: 7.0, factor: 0.15 },
    FuzzRange { start: 7.0, end: 20.0, factor: 0.1 },
    FuzzRange { start: 20.0, end: f32::MAX, factor: 0.05 },
];

fn with_review_fuzz(fuzz_factor: Option<f32>, interval: f32, minimum: u32, maximum: u32) -> u32 {
    if let Some(fuzz_factor) = fuzz_factor {
        let (lower, upper) = constrained_fuzz_bounds(interval, minimum, maximum);
        (lower as f32 + fuzz_factor * ((1 + upper - lower) as f32)).floor() as u32
    } else {
        (interval.round() as u32).clamp(minimum, maximum)
    }
}

/// Return the bounds of the fuzz range, respecting `minimum` and `maximum`.
/// Ensure the upper bound is larger than the lower bound, if `maximum` allows
/// it and it is larger than 1.
fn constrained_fuzz_bounds(interval: f32, minimum: u32, maximum: u32) -> (u32, u32) {
    let minimum = minimum.min(maximum);
    let interval = interval.clamp(minimum as f32, maximum as f32);
    let (mut lower, mut upper) = fuzz_bounds(interval);

    // minimum <= maximum and lower <= upper are assumed
    // now ensure minimum <= lower <= upper <= maximum
    lower = lower.clamp(minimum, maximum);
    upper = upper.clamp(minimum, maximum);

    if upper == lower && upper > 2 && upper < maximum {
        upper = lower + 1;
    };

    (lower, upper)
}

fn fuzz_bounds(interval: f32) -> (u32, u32) {
    let delta = fuzz_delta(interval);
    (
        (interval - delta).round() as u32,
        (interval + delta).round() as u32,
    )
}

/// Return the amount of fuzz to apply to the interval in both directions.
/// Short intervals do not get fuzzed. All other intervals get fuzzed by 1 day
/// plus the number of its days in each defined fuzz range multiplied with the
/// given factor.
fn fuzz_delta(interval: f32) -> f32 {
    if interval < 2.5 {
        0.0
    } else {
        FUZZ_RANGES.iter().fold(1.0, |delta, range| {
            delta + range.factor * (interval.min(range.end) - range.start).max(0.0)
        })
    }
}

// ======================================================================
// states/{learning,relearning,review}.rs

#[derive(Debug, Clone, Copy, PartialEq)]
struct LearnState {
    remaining_steps: u32,
    scheduled_secs: u32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct ReviewState {
    scheduled_days: u32,
    elapsed_days: u32,
    ease_factor: f32,
    lapses: u32,
}

impl Default for ReviewState {
    fn default() -> Self {
        ReviewState {
            scheduled_days: 0,
            elapsed_days: 0,
            ease_factor: INITIAL_EASE_FACTOR,
            lapses: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct RelearnState {
    learning: LearnState,
    review: ReviewState,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum CardState {
    Learning(LearnState),
    Review(ReviewState),
    Relearning(RelearnState),
}

impl From<LearnState> for CardState {
    fn from(s: LearnState) -> Self {
        CardState::Learning(s)
    }
}
impl From<ReviewState> for CardState {
    fn from(s: ReviewState) -> Self {
        CardState::Review(s)
    }
}
impl From<RelearnState> for CardState {
    fn from(s: RelearnState) -> Self {
        CardState::Relearning(s)
    }
}

/// Anki's `StateContext`, minus FSRS / load balancer / filtered decks.
struct StateContext<'a> {
    fuzz_factor: Option<f32>,
    steps: LearningSteps<'a>,
    graduating_interval_good: u32,
    graduating_interval_easy: u32,
    initial_ease_factor: f32,
    hard_multiplier: f32,
    easy_multiplier: f32,
    interval_multiplier: f32,
    maximum_review_interval: u32,
    relearn_steps: LearningSteps<'a>,
    lapse_multiplier: f32,
    minimum_lapse_interval: u32,
}

impl StateContext<'_> {
    /// Return the minimum and maximum review intervals.
    /// - `maximum` is `self.maximum_review_interval`, but at least 1.
    /// - `minimum` is as passed, but at least 1, and at most `maximum`.
    fn min_and_max_review_intervals(&self, minimum: u32) -> (u32, u32) {
        let maximum = self.maximum_review_interval.max(1);
        let minimum = minimum.clamp(1, maximum);
        (minimum, maximum)
    }

    fn with_review_fuzz(&self, interval: f32, minimum: u32, maximum: u32) -> u32 {
        with_review_fuzz(self.fuzz_factor, interval, minimum, maximum)
    }
}

impl LearnState {
    fn answer(self, grade: Grade, ctx: &StateContext) -> CardState {
        match grade {
            Grade::Again => self.answer_again(ctx),
            Grade::Hard => self.answer_hard(ctx),
            Grade::Good => self.answer_good(ctx),
            Grade::Easy => self.answer_easy(ctx).into(),
        }
    }

    fn graduate_good(ctx: &StateContext) -> CardState {
        let (minimum, maximum) = ctx.min_and_max_review_intervals(1);
        let interval = ctx.graduating_interval_good as f32;
        ReviewState {
            scheduled_days: ctx.with_review_fuzz(interval.round().max(1.0), minimum, maximum),
            ease_factor: ctx.initial_ease_factor,
            ..Default::default()
        }
        .into()
    }

    fn answer_again(self, ctx: &StateContext) -> CardState {
        if let Some(again_delay) = ctx.steps.again_delay_secs_learn() {
            LearnState {
                remaining_steps: ctx.steps.remaining_for_failed(),
                scheduled_secs: again_delay,
            }
            .into()
        } else {
            Self::graduate_good(ctx)
        }
    }

    fn answer_hard(self, ctx: &StateContext) -> CardState {
        if let Some(hard_delay) = ctx.steps.hard_delay_secs(self.remaining_steps) {
            LearnState {
                scheduled_secs: hard_delay,
                ..self
            }
            .into()
        } else {
            Self::graduate_good(ctx)
        }
    }

    fn answer_good(self, ctx: &StateContext) -> CardState {
        if let Some(good_delay) = ctx.steps.good_delay_secs(self.remaining_steps) {
            LearnState {
                remaining_steps: ctx.steps.remaining_for_good(self.remaining_steps),
                scheduled_secs: good_delay,
            }
            .into()
        } else {
            Self::graduate_good(ctx)
        }
    }

    fn answer_easy(self, ctx: &StateContext) -> ReviewState {
        let (minimum, maximum) = ctx.min_and_max_review_intervals(1);
        let interval = ctx.graduating_interval_easy;
        ReviewState {
            scheduled_days: ctx.with_review_fuzz(interval as f32, minimum, maximum),
            ease_factor: ctx.initial_ease_factor,
            ..Default::default()
        }
    }
}

impl RelearnState {
    fn answer(self, grade: Grade, ctx: &StateContext) -> CardState {
        match grade {
            Grade::Again => self.answer_again(ctx),
            Grade::Hard => self.answer_hard(ctx),
            Grade::Good => self.answer_good(ctx),
            Grade::Easy => self.answer_easy().into(),
        }
    }

    fn answer_again(self, ctx: &StateContext) -> CardState {
        let scheduled_days = self.review.failing_review_interval(ctx);
        if let Some(again_delay) = ctx.relearn_steps.again_delay_secs_learn() {
            RelearnState {
                learning: LearnState {
                    remaining_steps: ctx.relearn_steps.remaining_for_failed(),
                    scheduled_secs: again_delay,
                },
                review: ReviewState {
                    scheduled_days: scheduled_days.round().max(1.0) as u32,
                    elapsed_days: 0,
                    ..self.review
                },
            }
            .into()
        } else {
            self.review.into()
        }
    }

    fn answer_hard(self, ctx: &StateContext) -> CardState {
        if let Some(hard_delay) = ctx.relearn_steps.hard_delay_secs(self.learning.remaining_steps) {
            RelearnState {
                learning: LearnState {
                    scheduled_secs: hard_delay,
                    ..self.learning
                },
                review: ReviewState {
                    elapsed_days: 0,
                    ..self.review
                },
            }
            .into()
        } else {
            self.review.into()
        }
    }

    fn answer_good(self, ctx: &StateContext) -> CardState {
        if let Some(good_delay) = ctx.relearn_steps.good_delay_secs(self.learning.remaining_steps) {
            RelearnState {
                learning: LearnState {
                    scheduled_secs: good_delay,
                    remaining_steps: ctx
                        .relearn_steps
                        .remaining_for_good(self.learning.remaining_steps),
                },
                review: ReviewState {
                    elapsed_days: 0,
                    ..self.review
                },
            }
            .into()
        } else {
            self.review.into()
        }
    }

    fn answer_easy(self) -> ReviewState {
        ReviewState {
            scheduled_days: self.review.scheduled_days + 1,
            elapsed_days: 0,
            ..self.review
        }
    }
}

impl ReviewState {
    fn days_late(&self) -> i32 {
        self.elapsed_days as i32 - self.scheduled_days as i32
    }

    fn answer(self, grade: Grade, ctx: &StateContext) -> CardState {
        if grade == Grade::Again {
            return self.answer_again(ctx);
        }
        let (hard_interval, good_interval, easy_interval) = self.passing_review_intervals(ctx);
        match grade {
            Grade::Hard => self.answer_hard(hard_interval).into(),
            Grade::Good => self.answer_good(good_interval).into(),
            _ => self.answer_easy(easy_interval).into(),
        }
    }

    fn failing_review_interval(self, ctx: &StateContext) -> f32 {
        let (minimum, maximum) = ctx.min_and_max_review_intervals(ctx.minimum_lapse_interval);
        let interval = ctx.with_review_fuzz(
            (self.scheduled_days as f32).max(1.0) * ctx.lapse_multiplier,
            minimum,
            maximum,
        );
        interval as f32
    }

    fn answer_again(self, ctx: &StateContext) -> CardState {
        let lapses = self.lapses + 1;
        let scheduled_days = self.failing_review_interval(ctx);
        let again_review = ReviewState {
            scheduled_days: scheduled_days.round().max(1.0) as u32,
            elapsed_days: 0,
            ease_factor: (self.ease_factor + EASE_FACTOR_AGAIN_DELTA).max(MINIMUM_EASE_FACTOR),
            lapses,
        };

        if let Some(again_delay) = ctx.relearn_steps.again_delay_secs_learn() {
            RelearnState {
                learning: LearnState {
                    remaining_steps: ctx.relearn_steps.remaining_for_failed(),
                    scheduled_secs: again_delay,
                },
                review: again_review,
            }
            .into()
        } else {
            again_review.into()
        }
    }

    fn answer_hard(self, scheduled_days: u32) -> ReviewState {
        ReviewState {
            scheduled_days,
            elapsed_days: 0,
            ease_factor: (self.ease_factor + EASE_FACTOR_HARD_DELTA).max(MINIMUM_EASE_FACTOR),
            ..self
        }
    }

    fn answer_good(self, scheduled_days: u32) -> ReviewState {
        ReviewState {
            scheduled_days,
            elapsed_days: 0,
            ..self
        }
    }

    fn answer_easy(self, scheduled_days: u32) -> ReviewState {
        ReviewState {
            scheduled_days,
            elapsed_days: 0,
            ease_factor: self.ease_factor + EASE_FACTOR_EASY_DELTA,
            ..self
        }
    }

    /// Return the intervals for hard, good and easy, each of which depends on
    /// the previous.
    fn passing_review_intervals(self, ctx: &StateContext) -> (u32, u32, u32) {
        if self.days_late() < 0 {
            self.passing_early_review_intervals(ctx)
        } else {
            self.passing_nonearly_review_intervals(ctx)
        }
    }

    fn passing_nonearly_review_intervals(self, ctx: &StateContext) -> (u32, u32, u32) {
        let current_interval = (self.scheduled_days as f32).max(1.0);
        let days_late = self.days_late().max(0) as f32;

        // hard
        let hard_factor = ctx.hard_multiplier;
        let hard_minimum = if hard_factor <= 1.0 {
            0
        } else {
            self.scheduled_days + 1
        };
        let hard_interval =
            constrain_passing_interval(ctx, current_interval * hard_factor, hard_minimum, true);
        // good
        let good_minimum = if hard_factor <= 1.0 {
            self.scheduled_days + 1
        } else {
            hard_interval + 1
        };
        let good_interval = constrain_passing_interval(
            ctx,
            (current_interval + days_late / 2.0) * self.ease_factor,
            good_minimum,
            true,
        );
        // easy
        let easy_interval = constrain_passing_interval(
            ctx,
            (current_interval + days_late) * self.ease_factor * ctx.easy_multiplier,
            good_interval + 1,
            true,
        );

        (hard_interval, good_interval, easy_interval)
    }

    /// Mostly direct port from the Python version (Anki's own comment).
    fn passing_early_review_intervals(self, ctx: &StateContext) -> (u32, u32, u32) {
        let scheduled = (self.scheduled_days as f32).max(1.0);
        let elapsed = self.elapsed_days as f32;

        let hard_interval = {
            let factor = ctx.hard_multiplier;
            let half_usual = factor / 2.0;
            constrain_passing_interval(
                ctx,
                (elapsed * factor).max(scheduled * half_usual),
                0,
                false,
            )
        };

        let good_interval =
            constrain_passing_interval(ctx, (elapsed * self.ease_factor).max(scheduled), 0, false);

        let easy_interval = {
            let reduced_bonus = ctx.easy_multiplier - (ctx.easy_multiplier - 1.0) / 2.0;
            constrain_passing_interval(
                ctx,
                (elapsed * self.ease_factor).max(scheduled) * reduced_bonus,
                0,
                false,
            )
        };

        (hard_interval, good_interval, easy_interval)
    }
}

/// Transform the provided hard/good/easy interval.
/// - Apply configured interval multiplier.
/// - Apply fuzz.
/// - Ensure it is at least `minimum`, and at least 1.
/// - Ensure it is at or below the configured maximum interval.
fn constrain_passing_interval(ctx: &StateContext, interval: f32, minimum: u32, fuzz: bool) -> u32 {
    let interval = interval * ctx.interval_multiplier;
    let (minimum, maximum) = ctx.min_and_max_review_intervals(minimum);
    if fuzz {
        ctx.with_review_fuzz(interval, minimum, maximum)
    } else {
        (interval.round() as u32).clamp(minimum, maximum)
    }
}

// ======================================================================
// answering/: reading the stored card into a state, and applying the result

/// Applies a grade to a schedule, returning the next one.
pub fn review(prev: Schedule, grade: Grade, ctx: &Context) -> Schedule {
    review_with(&DEFAULT_CONFIG, prev, grade, ctx)
}

pub fn review_with(cfg: &Config, prev: Schedule, grade: Grade, ctx: &Context) -> Schedule {
    let state_ctx = StateContext {
        fuzz_factor: ctx.fuzz_factor(),
        steps: LearningSteps::new(cfg.learn_steps),
        graduating_interval_good: cfg.graduating_interval_good,
        graduating_interval_easy: cfg.graduating_interval_easy,
        initial_ease_factor: cfg.initial_ease_factor,
        hard_multiplier: cfg.hard_multiplier,
        easy_multiplier: cfg.easy_multiplier,
        interval_multiplier: cfg.interval_multiplier,
        maximum_review_interval: cfg.maximum_review_interval,
        relearn_steps: LearningSteps::new(cfg.relearn_steps),
        lapse_multiplier: cfg.lapse_multiplier,
        minimum_lapse_interval: cfg.minimum_lapse_interval,
    };

    // Anki keeps `remaining_steps`; the app keeps the step index.
    let remaining = |steps: &[f32]| (steps.len() as i64 - prev.step).max(0) as u32;
    // Anki stores the ease factor as permille.
    let ease_factor = ((prev.ease * 1000.0).round() / 1000.0) as f32;
    let interval = prev.interval_days.round().max(0.0) as u32;
    let lapses = prev.lapses.max(0) as u32;

    let next = match prev.state {
        // New state acts like answering a failed learning card.
        State::New => LearnState {
            remaining_steps: state_ctx.steps.remaining_for_failed(),
            scheduled_secs: 0,
        }
        .answer(grade, &state_ctx),
        State::Learning => LearnState {
            remaining_steps: remaining(cfg.learn_steps),
            scheduled_secs: 0,
        }
        .answer(grade, &state_ctx),
        State::Review => ReviewState {
            scheduled_days: interval,
            elapsed_days: (interval as i64 + ctx.days_since_due).max(0) as u32,
            ease_factor,
            lapses,
        }
        .answer(grade, &state_ctx),
        State::Relearning => RelearnState {
            learning: LearnState {
                remaining_steps: remaining(cfg.relearn_steps),
                scheduled_secs: 0,
            },
            review: ReviewState {
                scheduled_days: interval,
                elapsed_days: interval,
                ease_factor,
                lapses,
            },
        }
        .answer(grade, &state_ctx),
    };

    let mut out = prev;
    out.reps = prev.reps + 1;
    let index = |steps: &[f32], remaining: u32| (steps.len() as i64 - remaining as i64).max(0);
    match next {
        CardState::Learning(learn) => {
            out.state = State::Learning;
            out.step = index(cfg.learn_steps, learn.remaining_steps);
            out.due_at = learning_due(learn.scheduled_secs, ctx);
        }
        CardState::Relearning(relearn) => {
            out.state = State::Relearning;
            out.step = index(cfg.relearn_steps, relearn.learning.remaining_steps);
            out.interval_days = relearn.review.scheduled_days as f64;
            out.ease = permille(relearn.review.ease_factor);
            out.lapses = relearn.review.lapses as i64;
            out.due_at = learning_due(relearn.learning.scheduled_secs, ctx);
        }
        CardState::Review(review) => {
            out.state = State::Review;
            out.step = 0;
            out.interval_days = review.scheduled_days as f64;
            out.ease = permille(review.ease_factor);
            out.lapses = review.lapses as i64;
            out.due_at = (ctx.day_start)(review.scheduled_days as i64);
        }
    }
    out
}

fn permille(ease: f32) -> f64 {
    (ease * 1000.0).round() as f64 / 1000.0
}

/// `IntervalKind::maybe_as_days` + `fuzzed_next_learning_timestamp`: a step
/// that reaches past the next day rollover becomes day-based.
fn learning_due(secs: u32, ctx: &Context) -> DateTime<Utc> {
    let secs_until_rollover = ctx.secs_until_rollover();
    if secs >= secs_until_rollover {
        let days = ((secs - secs_until_rollover) / 86_400) + 1;
        (ctx.day_start)(days as i64)
    } else {
        ctx.now + Duration::seconds(learning_ivl_with_fuzz(ctx.fuzz_seed, secs) as i64)
    }
}

/// Add up to 25% increase to seconds, but no more than 5 minutes.
fn learning_ivl_with_fuzz(input_seed: Option<u64>, secs: u32) -> u32 {
    if let Some(seed) = input_seed {
        let mut rng = StdRng::seed_from_u64(seed);
        let upper_exclusive = secs + ((secs as f32) * 0.25).min(300.0).floor() as u32;
        if secs >= upper_exclusive {
            secs
        } else {
            rng.random_range(secs..upper_exclusive)
        }
    } else {
        secs
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

    fn rollover(days: i64) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-01-01T04:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
            + Duration::days(days)
    }

    fn ctx_at(now: DateTime<Utc>, days_since_due: i64, fuzz_seed: Option<u64>) -> Context<'static> {
        Context { now, day_start: &rollover, days_since_due, fuzz_seed }
    }

    fn ctx(days_since_due: i64) -> Context<'static> {
        ctx_at(now(), days_since_due, None)
    }

    fn answer(card: Schedule, grade: Grade) -> Schedule {
        review(card, grade, &ctx(0))
    }

    fn review_card(interval: f64, ease: f64) -> Schedule {
        Schedule {
            state: State::Review,
            interval_days: interval,
            ease,
            reps: 5,
            ..Schedule::new(now())
        }
    }

    // ---- Anki's own unit tests (steps.rs, fuzz.rs, mod.rs)

    macro_rules! assert_delay_secs {
        ($steps:expr, $remaining:expr, $again_delay:expr, $hard_delay:expr, $good_delay:expr) => {
            let steps = LearningSteps::new(&$steps);
            assert_eq!(steps.again_delay_secs_learn(), $again_delay);
            assert_eq!(steps.hard_delay_secs($remaining), $hard_delay);
            assert_eq!(steps.good_delay_secs($remaining), $good_delay);
        };
    }

    #[test]
    fn delay_secs() {
        assert_delay_secs!([10.0], 1, Some(600), Some(900), None);
        assert_delay_secs!([(3 * DAY / 60) as f32], 1, Some(3 * DAY), Some(4 * DAY), None);
        assert_delay_secs!([1.0, 10.0], 2, Some(60), Some(330), Some(600));
        assert_delay_secs!([1.0, 10.0], 1, Some(60), Some(600), None);
        assert_delay_secs!([1.0, 10.0, 100.0], 3, Some(60), Some(330), Some(600));
        assert_delay_secs!([1.0, 10.0, 100.0], 2, Some(60), Some(600), Some(6000));
        assert_delay_secs!([1.0, 10.0, 100.0], 1, Some(60), Some(6000), None);
    }

    #[test]
    fn rounding_days() {
        assert_eq!(maybe_round_in_days(DAY - 1), DAY - 1);
        assert_eq!(maybe_round_in_days((1.5 * DAY as f32) as u32), 2 * DAY);
    }

    #[test]
    fn review_fuzz() {
        let fuzz = |f: Option<f32>, i, min, max| with_review_fuzz(f, i, min, max);
        assert_eq!(fuzz(None, 1.5, 1, 100), 2);
        assert_eq!(fuzz(None, 0.1, 1, 100), 1);
        assert_eq!(fuzz(None, 101.0, 1, 100), 100);

        macro_rules! assert_lower_middle_upper {
            ($interval:expr, $minimum:expr, $maximum:expr, $lower:expr, $middle:expr, $upper:expr) => {{
                assert_eq!(fuzz(Some(0.0), $interval, $minimum, $maximum), $lower);
                assert_eq!(fuzz(Some(0.5), $interval, $minimum, $maximum), $middle);
                assert_eq!(fuzz(Some(0.99), $interval, $minimum, $maximum), $upper);
            }};
        }
        assert_lower_middle_upper!(1.0, 1, 1000, 1, 1, 1);
        assert_lower_middle_upper!(2.49, 1, 1000, 2, 2, 2);
        assert_lower_middle_upper!(2.5, 1, 1000, 2, 3, 4);
        assert_lower_middle_upper!(7.0, 1, 1000, 5, 7, 9);
        assert_lower_middle_upper!(17.0, 1, 1000, 14, 17, 20);
        assert_lower_middle_upper!(37.0, 1, 1000, 33, 37, 41);
        assert_lower_middle_upper!(2.0, 2, 1000, 2, 2, 2);
        assert_lower_middle_upper!(2.0, 3, 1000, 3, 4, 4);
        assert_lower_middle_upper!(2.0, 3, 3, 3, 3, 3);
        assert_lower_middle_upper!(6.9, 3, 1000, 5, 7, 9);
        assert_lower_middle_upper!(7.0, 3, 1000, 5, 7, 9);
        assert_lower_middle_upper!(7.1, 3, 1000, 5, 7, 9);
        assert_lower_middle_upper!(19.9, 3, 1000, 17, 20, 23);
        assert_lower_middle_upper!(20.0, 3, 1000, 17, 20, 23);
        assert_lower_middle_upper!(20.1, 3, 1000, 17, 20, 23);
        assert_lower_middle_upper!(100.0, 101, 1000, 101, 105, 108);
        assert_lower_middle_upper!(100.0, 1, 99, 92, 96, 99);
        assert_lower_middle_upper!(100.0, 97, 103, 97, 100, 103);
    }

    #[test]
    fn invalid_values_will_not_panic() {
        constrained_fuzz_bounds(1.0, 3, 2);
    }

    // ---- the app-level wrapper

    #[test]
    fn new_card_walks_the_learning_steps() {
        let first = answer(Schedule::new(now()), Grade::Good);
        assert_eq!(first.state, State::Learning);
        assert_eq!(first.step, 1);
        assert_eq!(first.due_at, now() + Duration::minutes(10));

        let second = answer(first, Grade::Good);
        assert_eq!(second.state, State::Review);
        assert_eq!(second.interval_days, 1.0);
        // Due at the start of tomorrow (4am), not 24 hours from now.
        assert_eq!(second.due_at, rollover(1));
        assert_eq!(second.ease, 2.5);
    }

    #[test]
    fn hard_on_the_first_step_averages_the_first_two_steps() {
        let card = answer(Schedule::new(now()), Grade::Hard);
        assert_eq!(card.state, State::Learning);
        assert_eq!(card.step, 0);
        assert_eq!(card.due_at, now() + Duration::seconds(330));

        let card = answer(answer(Schedule::new(now()), Grade::Good), Grade::Hard);
        assert_eq!(card.step, 1);
        assert_eq!(card.due_at, now() + Duration::minutes(10));
    }

    #[test]
    fn again_restarts_the_learning_steps() {
        let card = answer(answer(Schedule::new(now()), Grade::Good), Grade::Again);
        assert_eq!(card.state, State::Learning);
        assert_eq!(card.step, 0);
        assert_eq!(card.due_at, now() + Duration::minutes(1));
    }

    #[test]
    fn a_step_past_the_rollover_moves_to_the_next_day() {
        // 3:55am (still "today" until 4am): a 10 minute step would land past
        // the rollover, so it becomes due at the start of the next day.
        let t = rollover(1) - Duration::minutes(5);
        let card = Schedule { state: State::Learning, step: 0, ..Schedule::new(t) };
        let next = review(card, Grade::Good, &ctx_at(t, 0, None));
        assert_eq!(next.state, State::Learning);
        assert_eq!(next.due_at, rollover(1));
    }

    #[test]
    fn easy_skips_straight_to_review() {
        let card = answer(Schedule::new(now()), Grade::Easy);
        assert_eq!(card.state, State::Review);
        assert_eq!(card.interval_days, 4.0);
        assert_eq!(card.due_at, rollover(4));
    }

    #[test]
    fn review_answers_follow_anki() {
        let card = review_card(10.0, 2.5);

        let hard = answer(card, Grade::Hard);
        assert_eq!(hard.interval_days, 12.0);
        assert_eq!(hard.ease, 2.35);

        let good = answer(card, Grade::Good);
        assert_eq!(good.interval_days, 25.0);
        assert_eq!(good.ease, 2.5);
        assert_eq!(good.due_at, rollover(25));

        // Easy uses the ease from *before* the answer: 10 * 2.5 * 1.3.
        let easy = answer(card, Grade::Easy);
        assert_eq!(easy.interval_days, 33.0);
        assert_eq!(easy.ease, 2.65);
    }

    #[test]
    fn late_reviews_get_credit_for_the_extra_time() {
        let card = review_card(10.0, 2.5);
        assert_eq!(review(card, Grade::Good, &ctx(4)).interval_days, 30.0);
        assert_eq!(review(card, Grade::Easy, &ctx(4)).interval_days, 46.0);
        assert_eq!(review(card, Grade::Hard, &ctx(4)).interval_days, 12.0);
    }

    #[test]
    fn early_reviews_are_based_on_elapsed_time() {
        let card = review_card(10.0, 2.5);
        assert_eq!(review(card, Grade::Good, &ctx(-6)).interval_days, 10.0);
        assert_eq!(review(card, Grade::Hard, &ctx(-6)).interval_days, 6.0);
        assert_eq!(review(card, Grade::Easy, &ctx(-6)).interval_days, 12.0);
    }

    #[test]
    fn hard_and_good_always_grow_the_interval() {
        let card = review_card(1.0, 1.3);
        assert_eq!(answer(card, Grade::Hard).interval_days, 2.0);
        assert_eq!(answer(card, Grade::Good).interval_days, 3.0);
        assert_eq!(answer(card, Grade::Easy).interval_days, 4.0);
    }

    #[test]
    fn a_lapse_relearns_then_restarts_at_one_day() {
        let lapsed = answer(review_card(20.0, 2.5), Grade::Again);
        assert_eq!(lapsed.state, State::Relearning);
        assert_eq!(lapsed.lapses, 1);
        assert_eq!(lapsed.interval_days, 1.0);
        assert_eq!(lapsed.ease, 2.3);
        assert_eq!(lapsed.due_at, now() + Duration::minutes(10));

        let hard = answer(lapsed, Grade::Hard);
        assert_eq!(hard.state, State::Relearning);
        assert_eq!(hard.due_at, now() + Duration::minutes(15));

        // Failing again while relearning doesn't count as another lapse.
        let again = answer(lapsed, Grade::Again);
        assert_eq!(again.lapses, 1);
        assert_eq!(again.ease, 2.3);

        let relearned = answer(lapsed, Grade::Good);
        assert_eq!(relearned.state, State::Review);
        assert_eq!(relearned.interval_days, 1.0);
        assert_eq!(relearned.due_at, rollover(1));

        assert_eq!(answer(lapsed, Grade::Easy).interval_days, 2.0);
    }

    #[test]
    fn ease_has_a_floor_but_no_ceiling() {
        let mut card = review_card(5.0, 1.4);
        for _ in 0..3 {
            card = answer(card, Grade::Hard);
        }
        assert_eq!(card.ease, 1.3);
        for _ in 0..20 {
            card = answer(card, Grade::Easy);
            card.interval_days = 5.0;
        }
        assert!(card.ease > 4.0);
    }

    #[test]
    fn interval_is_capped() {
        assert_eq!(answer(review_card(36_000.0, 2.5), Grade::Good).interval_days, 36_500.0);
    }

    #[test]
    fn fuzz_is_seeded_like_anki() {
        let card = review_card(10.0, 2.5);
        let mut seen = std::collections::HashSet::new();
        for id in 0..50 {
            let seed = Some(fuzz_seed(id, card.reps));
            let a = review(card, Grade::Good, &ctx_at(now(), 0, seed)).interval_days;
            let b = review(card, Grade::Good, &ctx_at(now(), 0, seed)).interval_days;
            assert_eq!(a, b, "same seed, same interval");
            assert!((22.0..=28.0).contains(&a), "{a}");
            seen.insert(a as u32);
        }
        assert!(seen.len() > 3);

        // Learning steps get up to 25% (max 5 min) extra.
        for id in 0..50 {
            let card = review(Schedule::new(now()), Grade::Good, &ctx_at(now(), 0, Some(id)));
            let secs = (card.due_at - now()).num_seconds();
            assert!((600..750).contains(&secs), "{secs}");
        }
    }
}
