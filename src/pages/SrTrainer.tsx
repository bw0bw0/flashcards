import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";

import { api } from "../api";
import { CardFace } from "../components/CardFace";
import { ErrorBanner, Screen } from "../components/Screen";
import { useAction, useLoader } from "../hooks";
import type { Grade, SrCard } from "../types";

const GRADES: { grade: Grade; label: string; className: string; key: string }[] = [
  { grade: "again", label: "Again", className: "grade-again", key: "1" },
  { grade: "hard", label: "Hard", className: "grade-hard", key: "2" },
  { grade: "good", label: "Good", className: "grade-good", key: "3" },
  { grade: "easy", label: "Easy", className: "grade-easy", key: "4" },
];

/** Spaced repetition mode: grades the due queue of an SR deck. */
export function SrTrainer() {
  const { deckId } = useParams();
  const id = Number(deckId);
  const [searchParams] = useSearchParams();
  const reviewAheadDays = Number(searchParams.get("ahead") ?? 0) || undefined;

  const deck = useLoader(() => api.getDeck(id), [id]);
  const queue = useLoader(
    () => api.srQueue(id, undefined, reviewAheadDays),
    [id, reviewAheadDays],
  );
  const [revealed, setRevealed] = useState(false);
  const [reviewed, setReviewed] = useState(0);
  const [last, setLast] = useState<string | null>(null);
  const action = useAction();

  const cards: SrCard[] = queue.data ?? [];
  const current = cards[0];

  async function grade(value: Grade) {
    if (!current || action.busy) return;
    const result = await action.run(() => api.gradeSrCard(current.id, value));
    if (!result) return;
    setLast(`${labelFor(value)} · back in ${result.nextDueIn}`);
    setReviewed((count) => count + 1);
    setRevealed(false);
    // The scheduler decides where the card lands, so refetch rather than
    // guessing whether it should come back in this session.
    await queue.reload();
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!revealed && (event.key === " " || event.key === "Enter")) {
        event.preventDefault();
        setRevealed(true);
        return;
      }
      const match = GRADES.find((entry) => entry.key === event.key);
      if (revealed && match) {
        event.preventDefault();
        void grade(match.grade);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <Screen
      title={deck.data?.name ?? "Review"}
      subtitle={
        reviewAheadDays
          ? `Reviewing ahead · ${reviewed} reviewed`
          : `Spaced repetition · ${reviewed} reviewed`
      }
      back
    >
      <ErrorBanner message={queue.error ?? deck.error ?? action.error} />

      {!current && !queue.loading && (
        <div className="trainer">
          <div className="empty">
            Nothing left to review right now.
            {reviewed > 0 && (
              <>
                <br />
                You got through {reviewed} cards.
              </>
            )}
          </div>
          <button className="btn block" onClick={() => queue.reload()}>
            Check again
          </button>
        </div>
      )}

      {current && (
        <div className="trainer">
          <div className="row small muted">
            <span>
              {current.sourceDeckName} · #{current.card.index}
            </span>
            <div className="spacer" />
            <span>{current.state}</span>
          </div>

          <CardFace
            card={current.card}
            revealed={revealed}
            onReveal={() => setRevealed(true)}
          />

          {revealed ? (
            <div className="grade-buttons">
              {GRADES.map((entry) => (
                <button
                  key={entry.grade}
                  className={`btn ${entry.className}`}
                  disabled={action.busy}
                  onClick={() => grade(entry.grade)}
                >
                  {entry.label}
                  <span className="when">{entry.key}</span>
                </button>
              ))}
            </div>
          ) : (
            <button className="btn primary block" onClick={() => setRevealed(true)}>
              Reveal
            </button>
          )}

          {last && <div className="hint muted small">{last}</div>}
        </div>
      )}
    </Screen>
  );
}

function labelFor(grade: Grade): string {
  return GRADES.find((entry) => entry.grade === grade)?.label ?? grade;
}
