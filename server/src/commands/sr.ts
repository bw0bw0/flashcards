import { int, intArray, optInt, optStr, selections, str, type Args, type CardSelection } from "../args.ts";
import { invalid, transaction, type Db } from "../db.ts";
import * as srs from "../srs.ts";
import {
  dayStart,
  dayStartIn,
  daysSince,
  nowString,
  parseTime,
  toTimestamp,
  todayKey,
} from "../time.ts";
import { cardsInSelection, type Card } from "./cards.ts";
import { insertDeck, read as readDeck, requireKind, type Deck } from "./decks.ts";

/**
 * How far into the future a learning card may be pulled forward, so that a
 * card you just failed comes back inside the same session (Anki's default
 * "learn ahead limit").
 */
const LEARN_AHEAD_MINUTES = 20;

/** A card in an SR deck together with its schedule for that deck. */
export interface SrCard {
  id: number;
  srDeckId: number;
  card: Card;
  /** Name of the deck the card is owned by. */
  sourceDeckName: string;
  state: string;
  dueAt: string;
  intervalDays: number;
  ease: number;
  reps: number;
  lapses: number;
  step: number;
}

export interface SrDeckStats {
  total: number;
  /**
   * Cards actually ready to study right now: due learning/relearning cards,
   * plus however many review and new cards today's limits still allow.
   */
  due: number;
  /** Cards still sitting in the 'new' state (the whole pool). */
  new: number;
  learning: number;
  review: number;
  /** Every card graded today, any state. */
  reviewedToday: number;
  newPerDay: number;
  reviewPerDay: number;
  /** How many more new cards may be introduced today. */
  newRemainingToday: number;
  /** How many more review-state cards may be shown today. */
  reviewRemainingToday: number;
}

/** Today's effective new/review caps for a deck, and how much is used. */
interface DailyLimits {
  newPerDay: number;
  reviewPerDay: number;
  newStudiedToday: number;
  reviewsToday: number;
}

const newRemaining = (l: DailyLimits) => Math.max(l.newPerDay - l.newStudiedToday, 0);
const reviewRemaining = (l: DailyLimits) => Math.max(l.reviewPerDay - l.reviewsToday, 0);

/**
 * Reads a deck's daily caps, folding in any "increase today's limit" bump
 * that still applies, plus how much of each cap is already spent today.
 */
function dailyLimits(db: Db, srDeckId: number, dayStartStr: string): DailyLimits {
  const row = db
    .prepare(
      `SELECT d.new_per_day
                  + CASE WHEN d.extra_today_date = :today THEN d.extra_new_today ELSE 0 END
                  AS newPerDay,
              d.review_per_day
                  + CASE WHEN d.extra_today_date = :today THEN d.extra_review_today ELSE 0 END
                  AS reviewPerDay,
              (SELECT COUNT(*) FROM sr_card s
                  WHERE s.sr_deck_id = d.id AND s.first_studied_at >= :start) AS newStudiedToday,
              -- Only answers to cards that were in the review state at the
              -- time count against the review cap; learning/relearning
              -- steps are not subject to a daily limit.
              (SELECT COUNT(*) FROM review_log r
                  JOIN sr_card s ON s.id = r.sr_card_id
                  WHERE s.sr_deck_id = d.id AND r.state = 'review' AND r.reviewed_at >= :start)
                  AS reviewsToday
       FROM deck d WHERE d.id = :deck`,
    )
    .get({ deck: srDeckId, today: todayKey(), start: dayStartStr });
  if (!row) throw invalid("deck not found");
  return row as unknown as DailyLimits;
}

const SR_SELECT = `
    SELECT s.id AS sId, s.sr_deck_id AS srDeckId, s.state, s.due_at AS dueAt,
           s.interval_days AS intervalDays, s.ease, s.reps, s.lapses, s.step,
           k.id AS cardId, k.deck_id AS deckId, k.idx AS cardIndex, k.front, k.back,
           k.comment, k.story,
           d.name AS sourceDeckName
    FROM sr_card s
    JOIN card k ON k.id = s.card_id
    JOIN deck d ON d.id = k.deck_id`;

function toSrCard(row: Record<string, unknown>): SrCard {
  const r = row as Record<string, never>;
  return {
    id: r.sId,
    srDeckId: r.srDeckId,
    card: {
      id: r.cardId,
      deckId: r.deckId,
      index: r.cardIndex,
      front: r.front,
      back: r.back,
      comment: r.comment,
      story: r.story,
    },
    sourceDeckName: r.sourceDeckName,
    state: r.state,
    dueAt: r.dueAt,
    intervalDays: r.intervalDays,
    ease: r.ease,
    reps: r.reps,
    lapses: r.lapses,
    step: r.step,
  };
}

function srCards(db: Db, sql: string, ...params: (string | number)[]): SrCard[] {
  return db
    .prepare(sql)
    .all(...params)
    .map((row) => toSrCard(row));
}

/**
 * Adds every card covered by the selections to the SR deck. Cards already in
 * the deck keep the schedule they have.
 */
function addSelections(db: Db, srDeckId: number, sels: CardSelection[]): number {
  const now = nowString();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO sr_card (sr_deck_id, card_id, added_at, state, due_at)
     VALUES (?, ?, ?, 'new', ?)`,
  );
  let added = 0;
  for (const sel of sels) {
    requireKind(db, sel.deckId, "normal");
    for (const card of cardsInSelection(db, sel)) {
      added += Number(insert.run(srDeckId, card.id, now, now).changes);
    }
  }
  return added;
}

export function create_sr_deck(db: Db, args: Args): Deck {
  const sels = selections(args, "selections");
  return transaction(db, () => {
    const deck = insertDeck(
      db,
      str(args, "name"),
      optInt(args, "categoryId"),
      optStr(args, "description"),
      "sr",
    );
    addSelections(db, deck.id, sels);
    return readDeck(db, deck.id);
  });
}

export function add_to_sr_deck(db: Db, args: Args): number {
  const srDeckId = int(args, "srDeckId");
  const sels = selections(args, "selections");
  requireKind(db, srDeckId, "sr");
  return transaction(db, () => addSelections(db, srDeckId, sels));
}

export function list_sr_cards(db: Db, args: Args): SrCard[] {
  return srCards(
    db,
    `${SR_SELECT} WHERE s.sr_deck_id = ? ORDER BY d.name, k.idx`,
    int(args, "srDeckId"),
  );
}

export function remove_sr_cards(db: Db, args: Args): number {
  const ids = intArray(args, "srCardIds");
  return transaction(db, () => {
    const remove = db.prepare("DELETE FROM sr_card WHERE id = ?");
    return ids.reduce((removed, id) => removed + Number(remove.run(id).changes), 0);
  });
}

/**
 * The study queue: due learning/relearning cards first (uncapped, since they
 * need to be seen again to graduate), then due review cards, then new cards
 * — the last two capped by whatever today's daily limits still allow.
 *
 * `reviewAheadDays`, when positive, pulls in review cards due within that
 * many days instead of only ones due now, and lifts the review cap for the
 * session, mirroring Anki's "review ahead" custom study option.
 */
export function sr_queue(db: Db, args: Args): SrCard[] {
  const srDeckId = int(args, "srDeckId");
  const now = new Date();
  const nowStr = toTimestamp(now);
  const ahead = toTimestamp(new Date(now.getTime() + LEARN_AHEAD_MINUTES * 60_000));
  const reviewAheadDays = Math.max(optInt(args, "reviewAheadDays") ?? 0, 0);
  const reviewCutoff =
    reviewAheadDays > 0
      ? toTimestamp(new Date(now.getTime() + reviewAheadDays * 86_400_000))
      : nowStr;
  const overallLimit = optInt(args, "limit") ?? 100;

  requireKind(db, srDeckId, "sr");
  const limits = dailyLimits(db, srDeckId, toTimestamp(dayStart()));

  // Only cards whose step has actually elapsed are "due" here; a card that
  // was just graded goes back into this same pool with a due time a few
  // minutes out, so it must not count as ready again until that time passes.
  // Otherwise the same card keeps coming back to back.
  const learningSql = `${SR_SELECT}
      WHERE s.sr_deck_id = ? AND s.state IN ('learning', 'relearning') AND s.due_at <= ?
      ORDER BY s.due_at, s.id
      LIMIT ?`;
  const cards = srCards(db, learningSql, srDeckId, nowStr, overallLimit);

  const reviewBudget = Math.max(
    reviewAheadDays > 0
      ? overallLimit - cards.length
      : Math.min(reviewRemaining(limits), overallLimit - cards.length),
    0,
  );
  if (reviewBudget > 0) {
    cards.push(
      ...srCards(
        db,
        `${SR_SELECT}
         WHERE s.sr_deck_id = ? AND s.state = 'review' AND s.due_at <= ?
         ORDER BY s.due_at, s.id
         LIMIT ?`,
        srDeckId,
        reviewCutoff,
        reviewBudget,
      ),
    );
  }

  const newBudget = Math.max(Math.min(newRemaining(limits), overallLimit - cards.length), 0);
  if (newBudget > 0) {
    cards.push(
      ...srCards(
        db,
        `${SR_SELECT}
         WHERE s.sr_deck_id = ? AND s.state = 'new'
         ORDER BY d.name, k.idx
         LIMIT ?`,
        srDeckId,
        newBudget,
      ),
    );
  }

  // Nothing due right now, and nothing else to fill the session with: like
  // Anki's "learn ahead", show learning/relearning cards that are about to
  // become due rather than ending the session with a card minutes away.
  if (cards.length === 0) {
    cards.push(...srCards(db, learningSql, srDeckId, ahead, overallLimit));
  }
  return cards;
}

/** Shared by `sr_deck_stats` and `increase_sr_limits`. */
function computeStats(db: Db, srDeckId: number, now: Date): SrDeckStats {
  const dayStartStr = toTimestamp(dayStart());
  const limits = dailyLimits(db, srDeckId, dayStartStr);
  const counts = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE state = 'new') AS newRaw,
              COUNT(*) FILTER (WHERE state IN ('learning', 'relearning')) AS learning,
              COUNT(*) FILTER (WHERE state = 'review') AS reviewRaw,
              COUNT(*) FILTER (WHERE state IN ('learning', 'relearning') AND due_at <= :ahead)
                  AS learningDue,
              COUNT(*) FILTER (WHERE state = 'review' AND due_at <= :now) AS reviewDue,
              (SELECT COUNT(*) FROM review_log r
                  WHERE r.sr_card_id IN (SELECT id FROM sr_card WHERE sr_deck_id = :deck)
                    AND r.reviewed_at >= :start) AS reviewedToday
       FROM sr_card WHERE sr_deck_id = :deck`,
    )
    .get({
      deck: srDeckId,
      now: toTimestamp(now),
      ahead: toTimestamp(new Date(now.getTime() + LEARN_AHEAD_MINUTES * 60_000)),
      start: dayStartStr,
    }) as Record<string, number>;

  const newRemainingToday = newRemaining(limits);
  const reviewRemainingToday = reviewRemaining(limits);
  return {
    total: counts.total,
    due:
      counts.learningDue +
      Math.min(counts.reviewDue, reviewRemainingToday) +
      Math.min(counts.newRaw, newRemainingToday),
    new: counts.newRaw,
    learning: counts.learning,
    review: counts.reviewRaw,
    reviewedToday: counts.reviewedToday,
    newPerDay: limits.newPerDay,
    reviewPerDay: limits.reviewPerDay,
    newRemainingToday,
    reviewRemainingToday,
  };
}

export function sr_deck_stats(db: Db, args: Args): SrDeckStats {
  return computeStats(db, int(args, "srDeckId"), new Date());
}

/**
 * A one-off bump to today's new/review limits ("increase today's limit" in
 * Anki), so a deck that ran out mid-session can keep going without changing
 * the deck's permanent daily settings.
 */
export function increase_sr_limits(db: Db, args: Args): SrDeckStats {
  const srDeckId = int(args, "srDeckId");
  requireKind(db, srDeckId, "sr");
  db.prepare(
    `UPDATE deck
     SET extra_new_today = (CASE WHEN extra_today_date = :today THEN extra_new_today ELSE 0 END) + :extraNew,
         extra_review_today = (CASE WHEN extra_today_date = :today THEN extra_review_today ELSE 0 END) + :extraReview,
         extra_today_date = :today
     WHERE id = :deck`,
  ).run({
    deck: srDeckId,
    today: todayKey(),
    extraNew: Math.max(int(args, "extraNew"), 0),
    extraReview: Math.max(int(args, "extraReview"), 0),
  });
  return computeStats(db, srDeckId, new Date());
}

/** Sets a deck's permanent daily new-card and review limits. */
export function update_sr_deck_settings(db: Db, args: Args): Deck {
  const srDeckId = int(args, "srDeckId");
  const newPerDay = int(args, "newPerDay");
  const reviewPerDay = int(args, "reviewPerDay");
  if (newPerDay < 0 || reviewPerDay < 0) throw invalid("limits cannot be negative");
  requireKind(db, srDeckId, "sr");
  db.prepare("UPDATE deck SET new_per_day = ?, review_per_day = ? WHERE id = ?").run(
    newPerDay,
    reviewPerDay,
    srDeckId,
  );
  return readDeck(db, srDeckId);
}

export interface GradeResult {
  card: SrCard;
  /** Human readable delay until the card comes back, e.g. "10m" or "3d". */
  nextDueIn: string;
}

/** Rust's `f64::round`: halves away from zero. */
function round(x: number): number {
  const r = Math.round(x);
  return x < 0 && r - x === 0.5 ? r - 1 : r;
}

export function humanise(minutes: number): string {
  if (minutes < 60) return `${Math.max(minutes, 1)}m`;
  if (minutes < 60 * 24) return `${round(minutes / 60)}h`;
  if (minutes < 60 * 24 * 30) return `${round(minutes / 1440)}d`;
  if (minutes < 60 * 24 * 365) return `${round(minutes / 43_200)}mo`;
  return `${(minutes / 525_600).toFixed(1)}y`;
}

const GRADES: srs.Grade[] = ["again", "hard", "good", "easy"];

export function grade_sr_card(db: Db, args: Args): GradeResult {
  const srCardId = int(args, "srCardId");
  const grade = str(args, "grade") as srs.Grade;
  if (!GRADES.includes(grade)) throw invalid("grade must be again, hard, good or easy");
  const now = new Date();

  return transaction(db, () => {
    const row = db
      .prepare(
        `SELECT state, step, interval_days, ease, reps, lapses, due_at
         FROM sr_card WHERE id = ?`,
      )
      .get(srCardId) as Record<string, never> | undefined;
    if (!row) throw invalid("card is not in this deck");
    const previous: srs.Schedule = {
      state: srs.parseState(row.state),
      step: row.step,
      intervalDays: row.interval_days,
      ease: row.ease,
      reps: row.reps,
      lapses: row.lapses,
      dueAt: parseTime(row.due_at),
    };

    const next = srs.answer(previous, grade, {
      now,
      dayStart: (days) => dayStartIn(days, now),
      daysSinceDue: daysSince(previous.dueAt, now),
      fuzzSeed: srs.fuzzSeed(srCardId, previous.reps),
    });
    const leavingNew = previous.state === "new";
    const nowStr = toTimestamp(now);
    db.prepare(
      `UPDATE sr_card
       SET state = :state, step = :step, interval_days = :interval, ease = :ease, reps = :reps,
           lapses = :lapses, due_at = :due, last_reviewed_at = :now,
           first_studied_at = CASE
               WHEN first_studied_at IS NULL AND :leavingNew THEN :now
               ELSE first_studied_at
           END
       WHERE id = :id`,
    ).run({
      id: srCardId,
      state: next.state,
      step: next.step,
      interval: next.intervalDays,
      ease: next.ease,
      reps: next.reps,
      lapses: next.lapses,
      due: toTimestamp(next.dueAt),
      now: nowStr,
      leavingNew: leavingNew ? 1 : 0,
    });
    db.prepare(
      `INSERT INTO review_log (sr_card_id, reviewed_at, grade, interval_days, state)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(srCardId, nowStr, srs.gradeNumber(grade), next.intervalDays, previous.state);

    const card = srCards(db, `${SR_SELECT} WHERE s.id = ?`, srCardId)[0];
    // Like Anki's answer buttons, review cards show their interval in days
    // rather than the time left until their due day starts.
    const nextDueIn =
      next.state === "review"
        ? humanise(Math.trunc(next.intervalDays) * 1440)
        : humanise(Math.trunc((next.dueAt.getTime() - now.getTime()) / 60_000));
    return { card, nextDueIn };
  });
}

/** Puts a card back to the state it had when it was first added to the deck. */
export function reset_sr_card(db: Db, args: Args): null {
  const fresh = srs.newSchedule(new Date());
  db.prepare(
    `UPDATE sr_card
     SET state = ?, step = ?, interval_days = ?, ease = ?, reps = ?, lapses = ?,
         due_at = ?, last_reviewed_at = NULL, first_studied_at = NULL
     WHERE id = ?`,
  ).run(
    fresh.state,
    fresh.step,
    fresh.intervalDays,
    fresh.ease,
    fresh.reps,
    fresh.lapses,
    toTimestamp(fresh.dueAt),
    int(args, "srCardId"),
  );
  return null;
}
