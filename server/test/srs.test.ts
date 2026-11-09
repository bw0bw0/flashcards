import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { StdRng } from "../src/rng.ts";
import {
  answer,
  constrainedFuzzBounds,
  fuzzSeed,
  internals,
  newSchedule,
  type Grade,
  type Schedule,
  type State,
} from "../src/srs.ts";

const { withReviewFuzz, maybeRoundInDays, LearningSteps } = internals;
const f = Math.fround;
const DAY = 86_400;

const NOW = new Date("2026-01-01T12:00:00Z");
const BASE = Date.parse("2026-01-01T04:00:00Z");
const rollover = (days: number) => new Date(BASE + days * DAY * 1000);
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

function ctx(daysSinceDue = 0, fuzz: bigint | null = null, now = NOW) {
  return { now, dayStart: rollover, daysSinceDue, fuzzSeed: fuzz };
}

const grade = (card: Schedule, g: Grade) => answer(card, g, ctx());

function reviewCard(intervalDays: number, ease: number): Schedule {
  return { ...newSchedule(NOW), state: "review", intervalDays, ease, reps: 5 };
}

describe("Anki's own unit tests", () => {
  test("delay secs (steps.rs)", () => {
    const check = (
      steps: number[],
      remaining: number,
      again: number | null,
      hard: number | null,
      good: number | null,
    ) => {
      const s = new LearningSteps(steps.map(f));
      assert.equal(s.againDelaySecsLearn(), again);
      assert.equal(s.hardDelaySecs(remaining), hard);
      assert.equal(s.goodDelaySecs(remaining), good);
    };
    check([10], 1, 600, 900, null);
    check([(3 * DAY) / 60], 1, 3 * DAY, 4 * DAY, null);
    check([1, 10], 2, 60, 330, 600);
    check([1, 10], 1, 60, 600, null);
    check([1, 10, 100], 3, 60, 330, 600);
    check([1, 10, 100], 2, 60, 600, 6000);
    check([1, 10, 100], 1, 60, 6000, null);
  });

  test("rounding days (steps.rs)", () => {
    assert.equal(maybeRoundInDays(DAY - 1), DAY - 1);
    assert.equal(maybeRoundInDays(Math.trunc(f(1.5 * DAY))), 2 * DAY);
  });

  test("review fuzz (fuzz.rs)", () => {
    assert.equal(withReviewFuzz(null, f(1.5), 1, 100), 2);
    assert.equal(withReviewFuzz(null, f(0.1), 1, 100), 1);
    assert.equal(withReviewFuzz(null, f(101), 1, 100), 100);

    const lmu = (
      interval: number,
      min: number,
      max: number,
      lower: number,
      middle: number,
      upper: number,
    ) => {
      assert.equal(withReviewFuzz(f(0), f(interval), min, max), lower, `${interval} lower`);
      assert.equal(withReviewFuzz(f(0.5), f(interval), min, max), middle, `${interval} middle`);
      assert.equal(withReviewFuzz(f(0.99), f(interval), min, max), upper, `${interval} upper`);
    };
    lmu(1.0, 1, 1000, 1, 1, 1);
    lmu(2.49, 1, 1000, 2, 2, 2);
    lmu(2.5, 1, 1000, 2, 3, 4);
    lmu(7.0, 1, 1000, 5, 7, 9);
    lmu(17.0, 1, 1000, 14, 17, 20);
    lmu(37.0, 1, 1000, 33, 37, 41);
    lmu(2.0, 2, 1000, 2, 2, 2);
    lmu(2.0, 3, 1000, 3, 4, 4);
    lmu(2.0, 3, 3, 3, 3, 3);
    lmu(6.9, 3, 1000, 5, 7, 9);
    lmu(7.0, 3, 1000, 5, 7, 9);
    lmu(7.1, 3, 1000, 5, 7, 9);
    lmu(19.9, 3, 1000, 17, 20, 23);
    lmu(20.0, 3, 1000, 17, 20, 23);
    lmu(20.1, 3, 1000, 17, 20, 23);
    lmu(100.0, 101, 1000, 101, 105, 108);
    lmu(100.0, 1, 99, 92, 96, 99);
    lmu(100.0, 97, 103, 97, 100, 103);
  });

  test("invalid values will not panic (fuzz.rs)", () => {
    constrainedFuzzBounds(1.0, 3, 2);
  });
});

describe("scheduler", () => {
  test("a new card walks the learning steps", () => {
    const first = grade(newSchedule(NOW), "good");
    assert.equal(first.state, "learning");
    assert.equal(first.step, 1);
    assert.deepEqual(first.dueAt, minutes(10));

    const second = grade(first, "good");
    assert.equal(second.state, "review");
    assert.equal(second.intervalDays, 1);
    // Due at the start of tomorrow (4am), not 24 hours from now.
    assert.deepEqual(second.dueAt, rollover(1));
    assert.equal(second.ease, 2.5);
  });

  test("hard on the first step averages the first two steps", () => {
    const card = grade(newSchedule(NOW), "hard");
    assert.equal(card.step, 0);
    assert.deepEqual(card.dueAt, new Date(NOW.getTime() + 330_000));
    const later = grade(grade(newSchedule(NOW), "good"), "hard");
    assert.equal(later.step, 1);
    assert.deepEqual(later.dueAt, minutes(10));
  });

  test("a step past the rollover moves to the next day", () => {
    const t = new Date(rollover(1).getTime() - 5 * 60_000);
    const card: Schedule = { ...newSchedule(t), state: "learning", step: 0 };
    const next = answer(card, "good", ctx(0, null, t));
    assert.equal(next.state, "learning");
    assert.deepEqual(next.dueAt, rollover(1));
  });

  test("easy skips straight to review", () => {
    const card = grade(newSchedule(NOW), "easy");
    assert.equal(card.state, "review");
    assert.equal(card.intervalDays, 4);
    assert.deepEqual(card.dueAt, rollover(4));
  });

  test("review answers follow Anki", () => {
    const card = reviewCard(10, 2.5);
    const hard = grade(card, "hard");
    assert.equal(hard.intervalDays, 12);
    assert.equal(hard.ease, 2.35);
    const good = grade(card, "good");
    assert.equal(good.intervalDays, 25);
    assert.deepEqual(good.dueAt, rollover(25));
    const easy = grade(card, "easy");
    assert.equal(easy.intervalDays, 33);
    assert.equal(easy.ease, 2.65);
  });

  test("late and early reviews", () => {
    const card = reviewCard(10, 2.5);
    assert.equal(answer(card, "good", ctx(4)).intervalDays, 30);
    assert.equal(answer(card, "easy", ctx(4)).intervalDays, 46);
    assert.equal(answer(card, "hard", ctx(4)).intervalDays, 12);
    assert.equal(answer(card, "good", ctx(-6)).intervalDays, 10);
    assert.equal(answer(card, "hard", ctx(-6)).intervalDays, 6);
    assert.equal(answer(card, "easy", ctx(-6)).intervalDays, 12);
  });

  test("a lapse relearns, then restarts at one day", () => {
    const lapsed = grade(reviewCard(20, 2.5), "again");
    assert.equal(lapsed.state, "relearning");
    assert.equal(lapsed.lapses, 1);
    assert.equal(lapsed.intervalDays, 1);
    assert.equal(lapsed.ease, 2.3);
    assert.deepEqual(lapsed.dueAt, minutes(10));
    assert.deepEqual(grade(lapsed, "hard").dueAt, minutes(15));
    assert.equal(grade(lapsed, "again").lapses, 1);
    const relearned = grade(lapsed, "good");
    assert.equal(relearned.state, "review");
    assert.deepEqual(relearned.dueAt, rollover(1));
    assert.equal(grade(lapsed, "easy").intervalDays, 2);
  });

  test("ease has a floor but no ceiling, interval has a cap", () => {
    let card = reviewCard(5, 1.4);
    for (let i = 0; i < 3; i++) card = grade(card, "hard");
    assert.equal(card.ease, 1.3);
    for (let i = 0; i < 20; i++) card = { ...grade(card, "easy"), intervalDays: 5 };
    assert.ok(card.ease > 4);
    assert.equal(grade(reviewCard(36_000, 2.5), "good").intervalDays, 36_500);
  });
});

describe("matches the Rust port (same scheduler, same StdRng as Anki)", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/anki-scheduler.json", import.meta.url), "utf8"),
  );

  test("StdRng output, fuzz factors and learning fuzz are bit-exact", () => {
    for (const c of fixture.rng) {
      const rng = StdRng.seedFromU64(BigInt(c.seed));
      assert.deepEqual(
        Array.from({ length: 20 }, () => rng.nextU32()),
        c.words,
      );
      const bits = new DataView(new ArrayBuffer(4));
      bits.setFloat32(0, StdRng.seedFromU64(BigInt(c.seed)).randomF32Unit());
      assert.equal(bits.getUint32(0), c.factorBits, `seed ${c.seed}`);
      const upper = c.secs + Math.floor(Math.min(f(c.secs * 0.25), 300));
      const learn =
        c.secs >= upper ? c.secs : StdRng.seedFromU64(BigInt(c.seed)).randomRangeU32(c.secs, upper);
      assert.equal(learn, c.learn, `seed ${c.seed}`);
    }
  });

  test(`every scheduler case gives the same result`, () => {
    const base = Date.parse(fixture.rollover0);
    const dayStart = (n: number) => new Date(base + n * DAY * 1000);
    const grades: Grade[] = ["again", "hard", "good", "easy"];
    const ts = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
    for (const { input: i, output } of fixture.review) {
      const now = new Date(i.now);
      const out = answer(
        {
          state: i.state as State,
          step: i.step,
          intervalDays: i.intervalDays,
          ease: i.ease,
          reps: i.reps,
          lapses: i.lapses,
          dueAt: now,
        },
        grades[i.grade],
        {
          now,
          dayStart,
          daysSinceDue: i.daysSinceDue,
          fuzzSeed: i.fuzz ? fuzzSeed(i.cardId, i.reps) : null,
        },
      );
      assert.deepEqual(
        {
          state: out.state,
          step: out.step,
          intervalDays: out.intervalDays,
          ease: out.ease,
          reps: out.reps,
          lapses: out.lapses,
          dueAt: ts(out.dueAt),
        },
        output,
        JSON.stringify(i),
      );
    }
    assert.ok(fixture.review.length >= 1000);
  });
});
