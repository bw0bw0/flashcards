// Ported from Anki (https://github.com/ankitects/anki), rslib/src/scheduler:
// states/{steps,fuzz,learning,relearning,review,interval_kind}.rs and
// answering/{mod,learning,current}.rs.
// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Anki's SM-2 scheduler (the v3 scheduler with FSRS turned off), using
 * Anki's default deck options.
 *
 * Anki does its scheduling arithmetic in `f32`; every float operation here
 * goes through `Math.fround` so the results are bit-for-bit the same, and the
 * fuzz uses a bit-exact port of the `StdRng` Anki seeds (see rng.ts). Given
 * the same card id, review count and history, it picks the same intervals
 * Anki would.
 *
 * Not ported: FSRS, the load balancer, filtered decks and leech tagging
 * (Anki's default leech action only adds a tag, which this app has no
 * equivalent for).
 */

import { StdRng } from "./rng.ts";

const f = Math.fround;

export interface Config {
  /** Learning steps, in minutes. */
  learnSteps: number[];
  /** Relearning steps, in minutes. */
  relearnSteps: number[];
  graduatingIntervalGood: number;
  graduatingIntervalEasy: number;
  initialEaseFactor: number;
  hardMultiplier: number;
  easyMultiplier: number;
  intervalMultiplier: number;
  maximumReviewInterval: number;
  /** "New interval" after a lapse. */
  lapseMultiplier: number;
  minimumLapseInterval: number;
}

export const INITIAL_EASE_FACTOR = f(2.5);
export const MINIMUM_EASE_FACTOR = f(1.3);
export const EASE_FACTOR_AGAIN_DELTA = f(-0.2);
export const EASE_FACTOR_HARD_DELTA = f(-0.15);
export const EASE_FACTOR_EASY_DELTA = f(0.15);

export const DEFAULT_CONFIG: Config = {
  learnSteps: [f(1.0), f(10.0)],
  relearnSteps: [f(10.0)],
  graduatingIntervalGood: 1,
  graduatingIntervalEasy: 4,
  initialEaseFactor: INITIAL_EASE_FACTOR,
  hardMultiplier: f(1.2),
  easyMultiplier: f(1.3),
  intervalMultiplier: f(1.0),
  maximumReviewInterval: 36_500,
  lapseMultiplier: f(0.0),
  minimumLapseInterval: 1,
};

/** Anki's day starts at 4am local time by default ("next day starts at"). */
export const ROLLOVER_HOUR = 4;

const DAY = 60 * 60 * 24;
const U32_MAX = 0xffffffff;

export type Grade = "again" | "hard" | "good" | "easy";
export type State = "new" | "learning" | "review" | "relearning";

export function gradeNumber(grade: Grade): number {
  return { again: 0, hard: 1, good: 2, easy: 3 }[grade];
}

export function parseState(value: string): State {
  return value === "learning" || value === "review" || value === "relearning" ? value : "new";
}

/** A card's schedule as the app stores it. */
export interface Schedule {
  state: State;
  /**
   * Index into the learning / relearning steps (Anki stores the number of
   * steps remaining instead; `index = steps.length - remaining`).
   */
  step: number;
  /**
   * Anki's `card.interval`: the review interval in whole days. Kept while
   * relearning, since that is the interval the card returns to review with.
   */
  intervalDays: number;
  ease: number;
  reps: number;
  lapses: number;
  dueAt: Date;
}

export function newSchedule(now: Date): Schedule {
  return {
    state: "new",
    step: 0,
    intervalDays: 0,
    ease: INITIAL_EASE_FACTOR,
    reps: 0,
    lapses: 0,
    dueAt: now,
  };
}

/** Everything about "now" the scheduler needs. */
export interface Context {
  now: Date;
  /** The start (rollover) of the day `n` days after today. */
  dayStart: (days: number) => Date;
  /**
   * Today minus the card's due day; for review cards this gives Anki's
   * `elapsed_days`. Negative when reviewing ahead.
   */
  daysSinceDue: number;
  /** Anki's fuzz seed (`card id + reps`), or null to disable fuzz. */
  fuzzSeed: bigint | null;
}

/** Anki's `get_fuzz_seed_for_id_and_reps`; `reps` is the count before the answer. */
export function fuzzSeed(cardId: number, reps: number): bigint {
  return BigInt.asUintN(64, BigInt.asUintN(64, BigInt(cardId)) + BigInt.asUintN(32, BigInt(reps)));
}

/** Return a fuzz factor from the range `0.0..1.0`, using the provided seed. */
function getFuzzFactor(seed: bigint | null): number | null {
  return seed === null ? null : StdRng.seedFromU64(seed).randomF32Unit();
}

// ---------------------------------------------------------------------------
// Rust numeric semantics

/** `f32::round` / `f64::round`: halves round away from zero. */
function round(x: number): number {
  const r = Math.round(x);
  return x < 0 && r - x === 0.5 ? r - 1 : r;
}

/** `x as u32` from a float: truncates, saturates, NaN becomes 0. */
function asU32(x: number): number {
  if (Number.isNaN(x) || x <= 0) return 0;
  return x >= U32_MAX ? U32_MAX : Math.trunc(x);
}

function satAdd(a: number, b: number): number {
  return Math.min(a + b, U32_MAX);
}

function clamp(x: number, min: number, max: number): number {
  return Math.min(Math.max(x, min), max);
}

// ===========================================================================
// states/steps.rs

function toSecs(v: number): number {
  return asU32(f(v * 60.0));
}

class LearningSteps {
  /** The steps in minutes. */
  private readonly steps: number[];

  constructor(steps: number[]) {
    this.steps = steps;
  }

  /** Strip off 'learning today', and ensure index is in bounds. */
  private getIndex(remaining: number): number {
    const total = this.steps.length;
    return Math.min(Math.max(total - (remaining % 1000), 0), Math.max(total - 1, 0));
  }

  private secsAtIndex(index: number): number | null {
    return index < this.steps.length ? toSecs(this.steps[index]) : null;
  }

  againDelaySecsLearn(): number | null {
    return this.secsAtIndex(0);
  }

  hardDelaySecs(remaining: number): number | null {
    const idx = this.getIndex(remaining);
    // if current is invalid, try first step
    const current =
      this.secsAtIndex(idx) ?? (this.steps.length > 0 ? toSecs(this.steps[0]) : null);
    if (current === null) return null;
    return idx === 0 ? this.hardDelaySecsForFirstStep(current) : current;
  }

  /**
   * Special case the hard interval for the first step to avoid equality with
   * the again interval. Also ensure it's smaller than the good interval,
   * at least with reasonable settings.
   */
  private hardDelaySecsForFirstStep(againSecs: number): number {
    const next = this.secsAtIndex(1);
    if (next !== null) {
      // average of first (again) and second (good) steps
      return maybeRoundInDays(Math.floor(satAdd(againSecs, next) / 2));
    }
    // 50% more than the again secs, but at most one day more
    // otherwise, a learning step of 3 days and a graduating interval of 4 days e.g.
    // would lead to the hard interval being larger than the good interval
    const secs = Math.min(
      Math.floor(Math.min(againSecs * 3, U32_MAX) / 2),
      satAdd(againSecs, DAY),
    );
    return maybeRoundInDays(secs);
  }

  goodDelaySecs(remaining: number): number | null {
    return this.secsAtIndex(this.getIndex(remaining) + 1);
  }

  remainingForGood(remaining: number): number {
    return Math.max(this.steps.length - (this.getIndex(remaining) + 1), 0);
  }

  remainingForFailed(): number {
    return this.steps.length;
  }
}

/**
 * If the given interval in seconds surpasses 1 day, rounds it to a whole
 * number of days. Ensures that the user gets the same results earlier and
 * later in the day. Returns seconds.
 */
function maybeRoundInDays(secs: number): number {
  if (secs > DAY) {
    return Math.min(asU32(round(f(f(secs) / f(DAY)))) * DAY, U32_MAX);
  }
  return secs;
}

// ===========================================================================
// states/fuzz.rs

/** A range of days for which a certain amount of fuzz is applied. */
const FUZZ_RANGES = [
  { start: f(2.5), end: f(7.0), factor: f(0.15) },
  { start: f(7.0), end: f(20.0), factor: f(0.1) },
  { start: f(20.0), end: 3.4028234663852886e38, factor: f(0.05) },
];

function withReviewFuzz(
  fuzzFactor: number | null,
  interval: number,
  minimum: number,
  maximum: number,
): number {
  if (fuzzFactor !== null) {
    const [lower, upper] = constrainedFuzzBounds(interval, minimum, maximum);
    return asU32(Math.floor(f(f(lower) + f(fuzzFactor * f(1 + upper - lower)))));
  }
  return clamp(asU32(round(interval)), minimum, maximum);
}

/**
 * Return the bounds of the fuzz range, respecting `minimum` and `maximum`.
 * Ensure the upper bound is larger than the lower bound, if `maximum` allows
 * it and it is larger than 1.
 */
export function constrainedFuzzBounds(
  interval: number,
  minimum: number,
  maximum: number,
): [number, number] {
  minimum = Math.min(minimum, maximum);
  interval = clamp(interval, f(minimum), f(maximum));
  let [lower, upper] = fuzzBounds(interval);

  // minimum <= maximum and lower <= upper are assumed
  // now ensure minimum <= lower <= upper <= maximum
  lower = clamp(lower, minimum, maximum);
  upper = clamp(upper, minimum, maximum);

  if (upper === lower && upper > 2 && upper < maximum) {
    upper = lower + 1;
  }
  return [lower, upper];
}

function fuzzBounds(interval: number): [number, number] {
  const delta = fuzzDelta(interval);
  return [asU32(round(f(interval - delta))), asU32(round(f(interval + delta)))];
}

/**
 * Return the amount of fuzz to apply to the interval in both directions.
 * Short intervals do not get fuzzed. All other intervals get fuzzed by 1 day
 * plus the number of its days in each defined fuzz range multiplied with the
 * given factor.
 */
function fuzzDelta(interval: number): number {
  if (interval < 2.5) return 0.0;
  return FUZZ_RANGES.reduce(
    (delta, range) =>
      f(delta + f(range.factor * Math.max(f(Math.min(interval, range.end) - range.start), 0.0))),
    f(1.0),
  );
}

// ===========================================================================
// states/{learning,relearning,review}.rs

interface LearnState {
  remainingSteps: number;
  scheduledSecs: number;
}

interface ReviewState {
  scheduledDays: number;
  elapsedDays: number;
  easeFactor: number;
  lapses: number;
}

interface RelearnState {
  learning: LearnState;
  review: ReviewState;
}

type CardState =
  | { kind: "learning"; state: LearnState }
  | { kind: "review"; state: ReviewState }
  | { kind: "relearning"; state: RelearnState };

const learning = (state: LearnState): CardState => ({ kind: "learning", state });
const review = (state: ReviewState): CardState => ({ kind: "review", state });
const relearning = (state: RelearnState): CardState => ({ kind: "relearning", state });

function defaultReview(): ReviewState {
  return { scheduledDays: 0, elapsedDays: 0, easeFactor: INITIAL_EASE_FACTOR, lapses: 0 };
}

/** Anki's `StateContext`, minus FSRS / load balancer / filtered decks. */
class StateContext {
  readonly cfg: Config;
  readonly fuzzFactor: number | null;
  readonly steps: LearningSteps;
  readonly relearnSteps: LearningSteps;

  constructor(cfg: Config, fuzzFactor: number | null) {
    this.cfg = cfg;
    this.fuzzFactor = fuzzFactor;
    this.steps = new LearningSteps(cfg.learnSteps);
    this.relearnSteps = new LearningSteps(cfg.relearnSteps);
  }

  /**
   * Return the minimum and maximum review intervals.
   * - `maximum` is `maximumReviewInterval`, but at least 1.
   * - `minimum` is as passed, but at least 1, and at most `maximum`.
   */
  minAndMaxReviewIntervals(minimum: number): [number, number] {
    const maximum = Math.max(this.cfg.maximumReviewInterval, 1);
    return [clamp(minimum, 1, maximum), maximum];
  }

  withReviewFuzz(interval: number, minimum: number, maximum: number): number {
    return withReviewFuzz(this.fuzzFactor, interval, minimum, maximum);
  }
}

// ---- learning.rs

function learnAnswer(self: LearnState, grade: Grade, ctx: StateContext): CardState {
  switch (grade) {
    case "again":
      return learnAnswerAgain(ctx);
    case "hard":
      return learnAnswerHard(self, ctx);
    case "good":
      return learnAnswerGood(self, ctx);
    case "easy":
      return review(learnAnswerEasy(ctx));
  }
}

function graduateGood(ctx: StateContext): CardState {
  const [minimum, maximum] = ctx.minAndMaxReviewIntervals(1);
  const interval = f(ctx.cfg.graduatingIntervalGood);
  return review({
    ...defaultReview(),
    scheduledDays: ctx.withReviewFuzz(Math.max(round(interval), 1.0), minimum, maximum),
    easeFactor: ctx.cfg.initialEaseFactor,
  });
}

function learnAnswerAgain(ctx: StateContext): CardState {
  const againDelay = ctx.steps.againDelaySecsLearn();
  if (againDelay === null) return graduateGood(ctx);
  return learning({ remainingSteps: ctx.steps.remainingForFailed(), scheduledSecs: againDelay });
}

function learnAnswerHard(self: LearnState, ctx: StateContext): CardState {
  const hardDelay = ctx.steps.hardDelaySecs(self.remainingSteps);
  if (hardDelay === null) return graduateGood(ctx);
  return learning({ ...self, scheduledSecs: hardDelay });
}

function learnAnswerGood(self: LearnState, ctx: StateContext): CardState {
  const goodDelay = ctx.steps.goodDelaySecs(self.remainingSteps);
  if (goodDelay === null) return graduateGood(ctx);
  return learning({
    remainingSteps: ctx.steps.remainingForGood(self.remainingSteps),
    scheduledSecs: goodDelay,
  });
}

function learnAnswerEasy(ctx: StateContext): ReviewState {
  const [minimum, maximum] = ctx.minAndMaxReviewIntervals(1);
  return {
    ...defaultReview(),
    scheduledDays: ctx.withReviewFuzz(f(ctx.cfg.graduatingIntervalEasy), minimum, maximum),
    easeFactor: ctx.cfg.initialEaseFactor,
  };
}

// ---- relearning.rs

function relearnAnswer(self: RelearnState, grade: Grade, ctx: StateContext): CardState {
  switch (grade) {
    case "again": {
      const scheduledDays = failingReviewInterval(self.review, ctx);
      const againDelay = ctx.relearnSteps.againDelaySecsLearn();
      if (againDelay === null) return review(self.review);
      return relearning({
        learning: {
          remainingSteps: ctx.relearnSteps.remainingForFailed(),
          scheduledSecs: againDelay,
        },
        review: {
          ...self.review,
          scheduledDays: asU32(Math.max(round(scheduledDays), 1.0)),
          elapsedDays: 0,
        },
      });
    }
    case "hard": {
      const hardDelay = ctx.relearnSteps.hardDelaySecs(self.learning.remainingSteps);
      if (hardDelay === null) return review(self.review);
      return relearning({
        learning: { ...self.learning, scheduledSecs: hardDelay },
        review: { ...self.review, elapsedDays: 0 },
      });
    }
    case "good": {
      const goodDelay = ctx.relearnSteps.goodDelaySecs(self.learning.remainingSteps);
      if (goodDelay === null) return review(self.review);
      return relearning({
        learning: {
          scheduledSecs: goodDelay,
          remainingSteps: ctx.relearnSteps.remainingForGood(self.learning.remainingSteps),
        },
        review: { ...self.review, elapsedDays: 0 },
      });
    }
    case "easy":
      return review({
        ...self.review,
        scheduledDays: self.review.scheduledDays + 1,
        elapsedDays: 0,
      });
  }
}

// ---- review.rs

function daysLate(self: ReviewState): number {
  return self.elapsedDays - self.scheduledDays;
}

function reviewAnswer(self: ReviewState, grade: Grade, ctx: StateContext): CardState {
  if (grade === "again") return reviewAnswerAgain(self, ctx);
  const [hardInterval, goodInterval, easyInterval] =
    daysLate(self) < 0
      ? passingEarlyReviewIntervals(self, ctx)
      : passingNonearlyReviewIntervals(self, ctx);
  switch (grade) {
    case "hard":
      return review({
        ...self,
        scheduledDays: hardInterval,
        elapsedDays: 0,
        easeFactor: Math.max(f(self.easeFactor + EASE_FACTOR_HARD_DELTA), MINIMUM_EASE_FACTOR),
      });
    case "good":
      return review({ ...self, scheduledDays: goodInterval, elapsedDays: 0 });
    default:
      return review({
        ...self,
        scheduledDays: easyInterval,
        elapsedDays: 0,
        easeFactor: f(self.easeFactor + EASE_FACTOR_EASY_DELTA),
      });
  }
}

function failingReviewInterval(self: ReviewState, ctx: StateContext): number {
  const [minimum, maximum] = ctx.minAndMaxReviewIntervals(ctx.cfg.minimumLapseInterval);
  const interval = ctx.withReviewFuzz(
    f(Math.max(f(self.scheduledDays), 1.0) * ctx.cfg.lapseMultiplier),
    minimum,
    maximum,
  );
  return f(interval);
}

function reviewAnswerAgain(self: ReviewState, ctx: StateContext): CardState {
  const lapses = self.lapses + 1;
  const scheduledDays = failingReviewInterval(self, ctx);
  const againReview: ReviewState = {
    scheduledDays: asU32(Math.max(round(scheduledDays), 1.0)),
    elapsedDays: 0,
    easeFactor: Math.max(f(self.easeFactor + EASE_FACTOR_AGAIN_DELTA), MINIMUM_EASE_FACTOR),
    lapses,
  };
  const againDelay = ctx.relearnSteps.againDelaySecsLearn();
  if (againDelay === null) return review(againReview);
  return relearning({
    learning: { remainingSteps: ctx.relearnSteps.remainingForFailed(), scheduledSecs: againDelay },
    review: againReview,
  });
}

function passingNonearlyReviewIntervals(
  self: ReviewState,
  ctx: StateContext,
): [number, number, number] {
  const currentInterval = Math.max(f(self.scheduledDays), 1.0);
  const late = f(Math.max(daysLate(self), 0));

  // hard
  const hardFactor = ctx.cfg.hardMultiplier;
  const hardMinimum = hardFactor <= 1.0 ? 0 : self.scheduledDays + 1;
  const hardInterval = constrainPassingInterval(
    ctx,
    f(currentInterval * hardFactor),
    hardMinimum,
    true,
  );
  // good
  const goodMinimum = hardFactor <= 1.0 ? self.scheduledDays + 1 : hardInterval + 1;
  const goodInterval = constrainPassingInterval(
    ctx,
    f(f(currentInterval + f(late / 2.0)) * self.easeFactor),
    goodMinimum,
    true,
  );
  // easy
  const easyInterval = constrainPassingInterval(
    ctx,
    f(f(f(currentInterval + late) * self.easeFactor) * ctx.cfg.easyMultiplier),
    goodInterval + 1,
    true,
  );
  return [hardInterval, goodInterval, easyInterval];
}

/** Mostly direct port from the Python version (Anki's own comment). */
function passingEarlyReviewIntervals(
  self: ReviewState,
  ctx: StateContext,
): [number, number, number] {
  const scheduled = Math.max(f(self.scheduledDays), 1.0);
  const elapsed = f(self.elapsedDays);

  const factor = ctx.cfg.hardMultiplier;
  const halfUsual = f(factor / 2.0);
  const hardInterval = constrainPassingInterval(
    ctx,
    Math.max(f(elapsed * factor), f(scheduled * halfUsual)),
    0,
    false,
  );

  const goodInterval = constrainPassingInterval(
    ctx,
    Math.max(f(elapsed * self.easeFactor), scheduled),
    0,
    false,
  );

  const easyMult = ctx.cfg.easyMultiplier;
  const reducedBonus = f(easyMult - f(f(easyMult - 1.0) / 2.0));
  const easyInterval = constrainPassingInterval(
    ctx,
    f(Math.max(f(elapsed * self.easeFactor), scheduled) * reducedBonus),
    0,
    false,
  );

  return [hardInterval, goodInterval, easyInterval];
}

/**
 * Transform the provided hard/good/easy interval.
 * - Apply configured interval multiplier.
 * - Apply fuzz.
 * - Ensure it is at least `minimum`, and at least 1.
 * - Ensure it is at or below the configured maximum interval.
 */
function constrainPassingInterval(
  ctx: StateContext,
  interval: number,
  minimum: number,
  fuzz: boolean,
): number {
  interval = f(interval * ctx.cfg.intervalMultiplier);
  const [min, max] = ctx.minAndMaxReviewIntervals(minimum);
  return fuzz ? ctx.withReviewFuzz(interval, min, max) : clamp(asU32(round(interval)), min, max);
}

// ===========================================================================
// answering/: reading the stored card into a state, and applying the result

/** Applies a grade to a schedule, returning the next one. */
export function answer(
  prev: Schedule,
  grade: Grade,
  ctx: Context,
  cfg: Config = DEFAULT_CONFIG,
): Schedule {
  const stateCtx = new StateContext(cfg, getFuzzFactor(ctx.fuzzSeed));

  // Anki keeps `remaining_steps`; the app keeps the step index.
  const remaining = (steps: number[]) => Math.max(steps.length - prev.step, 0);
  // Anki stores the ease factor as permille.
  const easeFactor = f(round(prev.ease * 1000.0) / 1000.0);
  const interval = asU32(Math.max(round(prev.intervalDays), 0));
  const lapses = Math.max(prev.lapses, 0);

  let next: CardState;
  switch (prev.state) {
    case "new":
      // New state acts like answering a failed learning card.
      next = learnAnswer(
        { remainingSteps: stateCtx.steps.remainingForFailed(), scheduledSecs: 0 },
        grade,
        stateCtx,
      );
      break;
    case "learning":
      next = learnAnswer(
        { remainingSteps: remaining(cfg.learnSteps), scheduledSecs: 0 },
        grade,
        stateCtx,
      );
      break;
    case "review":
      next = reviewAnswer(
        {
          scheduledDays: interval,
          elapsedDays: Math.max(interval + ctx.daysSinceDue, 0),
          easeFactor,
          lapses,
        },
        grade,
        stateCtx,
      );
      break;
    case "relearning":
      next = relearnAnswer(
        {
          learning: { remainingSteps: remaining(cfg.relearnSteps), scheduledSecs: 0 },
          review: { scheduledDays: interval, elapsedDays: interval, easeFactor, lapses },
        },
        grade,
        stateCtx,
      );
      break;
  }

  const out: Schedule = { ...prev, reps: prev.reps + 1 };
  const index = (steps: number[], remainingSteps: number) =>
    Math.max(steps.length - remainingSteps, 0);
  switch (next.kind) {
    case "learning":
      out.state = "learning";
      out.step = index(cfg.learnSteps, next.state.remainingSteps);
      out.dueAt = learningDue(next.state.scheduledSecs, ctx);
      break;
    case "relearning":
      out.state = "relearning";
      out.step = index(cfg.relearnSteps, next.state.learning.remainingSteps);
      out.intervalDays = next.state.review.scheduledDays;
      out.ease = permille(next.state.review.easeFactor);
      out.lapses = next.state.review.lapses;
      out.dueAt = learningDue(next.state.learning.scheduledSecs, ctx);
      break;
    case "review":
      out.state = "review";
      out.step = 0;
      out.intervalDays = next.state.scheduledDays;
      out.ease = permille(next.state.easeFactor);
      out.lapses = next.state.lapses;
      out.dueAt = ctx.dayStart(next.state.scheduledDays);
      break;
  }
  return out;
}

function permille(ease: number): number {
  return round(f(ease * 1000.0)) / 1000.0;
}

/**
 * `IntervalKind::maybe_as_days` + `fuzzed_next_learning_timestamp`: a step
 * that reaches past the next day rollover becomes day-based.
 */
function learningDue(secs: number, ctx: Context): Date {
  const untilRollover = Math.max(
    Math.trunc((ctx.dayStart(1).getTime() - ctx.now.getTime()) / 1000),
    0,
  );
  if (secs >= untilRollover) {
    const days = Math.floor((secs - untilRollover) / 86_400) + 1;
    return ctx.dayStart(days);
  }
  return new Date(ctx.now.getTime() + learningIvlWithFuzz(ctx.fuzzSeed, secs) * 1000);
}

/** Add up to 25% increase to seconds, but no more than 5 minutes. */
function learningIvlWithFuzz(seed: bigint | null, secs: number): number {
  if (seed === null) return secs;
  const upperExclusive = secs + asU32(Math.floor(Math.min(f(f(secs) * 0.25), 300.0)));
  if (secs >= upperExclusive) return secs;
  return StdRng.seedFromU64(seed).randomRangeU32(secs, upperExclusive);
}

/** Exposed for tests. */
export const internals = { withReviewFuzz, maybeRoundInDays, LearningSteps };
