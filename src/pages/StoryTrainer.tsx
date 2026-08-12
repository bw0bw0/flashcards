import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";

import { api } from "../api";
import { CardFace } from "../components/CardFace";
import { ErrorBanner, Screen } from "../components/Screen";
import { useLoader } from "../hooks";
import type { Card } from "../types";

function parseIndex(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Fisher-Yates, so a shuffled run visits every card exactly once. */
function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Story mode: walks a deck, or a slice of one, front to back. */
export function StoryTrainer() {
  const { deckId } = useParams();
  const id = Number(deckId);
  const [params] = useSearchParams();
  const fromIndex = parseIndex(params.get("from"));
  const toIndex = parseIndex(params.get("to"));
  const shuffle = params.get("shuffle") === "1";

  const deck = useLoader(() => api.getDeck(id), [id]);
  const cards = useLoader(
    () => api.listSelection({ deckId: id, fromIndex, toIndex }),
    [id, fromIndex, toIndex],
  );

  const order = useMemo<Card[]>(() => {
    const list = cards.data ?? [];
    return shuffle ? shuffled(list) : list;
  }, [cards.data, shuffle]);

  const [position, setPosition] = useState(0);
  const [revealed, setRevealed] = useState(false);

  const card = order[position];
  const atEnd = order.length > 0 && position >= order.length;

  function next() {
    if (!revealed) {
      setRevealed(true);
      return;
    }
    setRevealed(false);
    setPosition((current) => Math.min(current + 1, order.length));
  }

  function previous() {
    setRevealed(false);
    setPosition((current) => Math.max(current - 1, 0));
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === " " || event.key === "Enter" || event.key === "ArrowRight") {
        event.preventDefault();
        next();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        previous();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <Screen
      title={deck.data?.name ?? "Training"}
      subtitle={
        order.length > 0
          ? `Story · ${Math.min(position + 1, order.length)} of ${order.length}`
          : "Story"
      }
      back
    >
      <ErrorBanner message={cards.error ?? deck.error} />

      <div className="progress">
        <div
          style={{
            width: `${order.length === 0 ? 0 : (position / order.length) * 100}%`,
          }}
        />
      </div>

      {order.length === 0 && !cards.loading && (
        <div className="empty">There are no cards in that selection.</div>
      )}

      {atEnd && (
        <div className="trainer">
          <div className="empty">
            That is the whole set — {order.length} cards.
          </div>
          <button
            className="btn primary block"
            onClick={() => {
              setPosition(0);
              setRevealed(false);
            }}
          >
            Go again
          </button>
        </div>
      )}

      {card && (
        <div className="trainer">
          <CardFace card={card} revealed={revealed} onReveal={() => setRevealed(true)} />
          <div className="row">
            <button className="btn" onClick={previous} disabled={position === 0}>
              ←
            </button>
            <button className="btn primary" style={{ flex: 1 }} onClick={next}>
              {revealed ? "Next" : "Reveal"}
            </button>
          </div>
        </div>
      )}
    </Screen>
  );
}
