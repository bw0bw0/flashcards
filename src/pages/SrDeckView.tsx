import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { api } from "../api";
import { Field, Modal } from "../components/Modal";
import { ErrorBanner, Screen } from "../components/Screen";
import { SelectionPicker } from "../components/SelectionPicker";
import { useAction, useLoader } from "../hooks";
import type { CardSelection, Deck, SrCard, SrDeckStats } from "../types";
import { DeckModal } from "./DecksPage";

interface Props {
  deck: Deck;
  reloadDeck: () => Promise<void>;
}

export function SrDeckView({ deck, reloadDeck }: Props) {
  const navigate = useNavigate();
  const stats = useLoader(() => api.srDeckStats(deck.id), [deck.id]);
  const cards = useLoader(() => api.listSrCards(deck.id), [deck.id]);
  const categories = useLoader(() => api.listCategories(), []);
  const [dialog, setDialog] = useState<"add" | "edit" | "study" | null>(null);
  const action = useAction();

  async function reload() {
    await Promise.all([stats.reload(), cards.reload(), reloadDeck()]);
  }

  const list = cards.data ?? [];

  return (
    <Screen
      title={deck.name}
      subtitle={`Spaced repetition · ${deck.categoryName ?? "No category"}`}
      back
      actions={
        <>
          <button
            className="icon-btn"
            onClick={() => setDialog("study")}
            aria-label="Study options"
            title="Study options"
          >
            ⚙
          </button>
          <button className="icon-btn" onClick={() => setDialog("edit")} aria-label="Edit deck">
            ✎
          </button>
        </>
      }
    >
      <ErrorBanner message={stats.error ?? cards.error ?? action.error} />

      <StatsRow stats={stats.data} />

      <div className="row wrap">
        <button
          className="btn primary"
          onClick={() => navigate(`/deck/${deck.id}/review`)}
          disabled={(stats.data?.due ?? 0) === 0}
        >
          {stats.data && stats.data.due > 0 ? `Review ${stats.data.due}` : "Nothing due"}
        </button>
        <button className="btn" onClick={() => setDialog("add")}>
          Add cards
        </button>
      </div>

      <div className="section-title">{list.length} cards</div>

      {list.length === 0 && !cards.loading && (
        <div className="empty">
          This deck has no cards yet.
          <br />
          Add whole decks or slices of them.
        </div>
      )}

      <div className="deck-list">
        {list.map((entry) => (
          <SrCardRow key={entry.id} entry={entry} onChanged={reload} />
        ))}
      </div>

      {dialog === "add" && (
        <AddCardsDialog
          srDeckId={deck.id}
          onClose={() => setDialog(null)}
          onAdded={reload}
        />
      )}
      {dialog === "edit" && (
        <DeckModal
          deck={deck}
          categories={categories.data ?? []}
          onClose={() => setDialog(null)}
          onSaved={reloadDeck}
        />
      )}
      {dialog === "study" && (
        <StudyOptionsModal
          deck={deck}
          stats={stats.data}
          onClose={() => setDialog(null)}
          onSettingsSaved={reloadDeck}
          onLimitsIncreased={stats.reload}
        />
      )}
    </Screen>
  );
}

function StatsRow({ stats }: { stats: SrDeckStats | null }) {
  if (!stats) return null;
  const items = [
    { label: "Due", value: stats.due },
    { label: "New today", value: stats.newRemainingToday, title: `${stats.new} in the pool` },
    { label: "Learning", value: stats.learning },
    { label: "Review", value: stats.review },
    { label: "Today", value: stats.reviewedToday },
  ];
  return (
    <div className="stats">
      {items.map((item) => (
        <div key={item.label} className="stat" title={item.title}>
          <div className="value">{item.value}</div>
          <div className="label">{item.label}</div>
        </div>
      ))}
    </div>
  );
}

/** Anki-style knobs for how the queue behaves: daily limits, a one-off bump
 * to today's limits, and reviewing ahead of schedule. */
function StudyOptionsModal({
  deck,
  stats,
  onClose,
  onSettingsSaved,
  onLimitsIncreased,
}: {
  deck: Deck;
  stats: SrDeckStats | null;
  onClose: () => void;
  onSettingsSaved: () => Promise<void>;
  onLimitsIncreased: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const [newPerDay, setNewPerDay] = useState(String(deck.newPerDay));
  const [reviewPerDay, setReviewPerDay] = useState(String(deck.reviewPerDay));
  const [extraNew, setExtraNew] = useState("10");
  const [extraReview, setExtraReview] = useState("0");
  const [aheadDays, setAheadDays] = useState("1");
  const settingsAction = useAction();
  const increaseAction = useAction();

  async function saveSettings() {
    const saved = await settingsAction.run(() =>
      api.updateSrDeckSettings(
        deck.id,
        Math.max(0, Number(newPerDay) || 0),
        Math.max(0, Number(reviewPerDay) || 0),
      ),
    );
    if (!saved) return;
    await onSettingsSaved();
  }

  async function increaseLimits() {
    const result = await increaseAction.run(() =>
      api.increaseSrLimits(deck.id, Math.max(0, Number(extraNew) || 0), Math.max(0, Number(extraReview) || 0)),
    );
    if (!result) return;
    await onLimitsIncreased();
  }

  return (
    <Modal
      title="Study options"
      onClose={onClose}
      footer={
        <button className="btn ghost" onClick={onClose}>
          Close
        </button>
      }
    >
      <ErrorBanner message={settingsAction.error ?? increaseAction.error} />

      <div className="section-title">Daily limits</div>
      <div className="row wrap">
        <Field label="New cards/day">
          <input
            type="number"
            min={0}
            value={newPerDay}
            onChange={(event) => setNewPerDay(event.target.value)}
          />
        </Field>
        <Field label="Reviews/day">
          <input
            type="number"
            min={0}
            value={reviewPerDay}
            onChange={(event) => setReviewPerDay(event.target.value)}
          />
        </Field>
      </div>
      <button className="btn" onClick={saveSettings} disabled={settingsAction.busy}>
        Save limits
      </button>

      <div className="section-title">Increase today's limit</div>
      <div className="small muted">
        Adds to today's allowance only; the daily limits above are unchanged.
      </div>
      <div className="row wrap">
        <Field label="Extra new cards">
          <input
            type="number"
            min={0}
            value={extraNew}
            onChange={(event) => setExtraNew(event.target.value)}
          />
        </Field>
        <Field label="Extra reviews">
          <input
            type="number"
            min={0}
            value={extraReview}
            onChange={(event) => setExtraReview(event.target.value)}
          />
        </Field>
      </div>
      <button className="btn" onClick={increaseLimits} disabled={increaseAction.busy}>
        Add to today
      </button>
      {stats && (
        <div className="small muted">
          {stats.newRemainingToday} new · {stats.reviewRemainingToday} reviews left today.
        </div>
      )}

      <div className="section-title">Review ahead</div>
      <div className="small muted">
        Study review cards that aren't due yet, ignoring the review limit for this
        session.
      </div>
      <Field label="Days ahead">
        <input
          type="number"
          min={1}
          value={aheadDays}
          onChange={(event) => setAheadDays(event.target.value)}
        />
      </Field>
      <button
        className="btn"
        onClick={() => navigate(`/deck/${deck.id}/review?ahead=${Math.max(1, Number(aheadDays) || 1)}`)}
      >
        Review ahead
      </button>
    </Modal>
  );
}

function SrCardRow({
  entry,
  onChanged,
}: {
  entry: SrCard;
  onChanged: () => Promise<void>;
}) {
  const action = useAction();
  return (
    <div className="card-row">
      <div className="body">
        <div className="front">{entry.card.front}</div>
        <div className="back">
          {entry.sourceDeckName} · #{entry.card.index}
        </div>
        <div className="flags">
          <span className="badge">{entry.state}</span>
          <span className="badge">due {formatDue(entry.dueAt)}</span>
          {entry.lapses > 0 && <span className="badge">{entry.lapses} lapses</span>}
        </div>
      </div>
      <button
        className="icon-btn"
        aria-label="Reset schedule"
        title="Reset schedule"
        onClick={async () => {
          await action.run(() => api.resetSrCard(entry.id));
          await onChanged();
        }}
      >
        ↺
      </button>
      <button
        className="icon-btn"
        aria-label="Remove from deck"
        onClick={async () => {
          if (!confirm("Remove this card from the deck?")) return;
          await action.run(() => api.removeSrCards([entry.id]));
          await onChanged();
        }}
      >
        🗑
      </button>
    </div>
  );
}

/** Shows the due date as a day, or "now" once it has passed. */
function formatDue(dueAt: string): string {
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) return "?";
  if (due.getTime() <= Date.now()) return "now";
  return due.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function AddCardsDialog({
  srDeckId,
  onClose,
  onAdded,
}: {
  srDeckId: number;
  onClose: () => void;
  onAdded: () => Promise<void>;
}) {
  const decks = useLoader(() => api.listDecks(), []);
  const [selections, setSelections] = useState<CardSelection[]>([]);
  const [added, setAdded] = useState<number | null>(null);
  const action = useAction();

  async function add() {
    const count = await action.run(() => api.addToSrDeck(srDeckId, selections));
    if (count === undefined) return;
    setAdded(count);
    await onAdded();
  }

  return (
    <Modal
      title="Add cards"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
          <button
            className="btn primary"
            onClick={add}
            disabled={action.busy || selections.length === 0}
          >
            Add
          </button>
        </>
      }
    >
      <ErrorBanner message={action.error ?? decks.error} />
      <div className="small muted">
        Cards already in this deck keep the schedule they have.
      </div>
      <SelectionPicker
        decks={(decks.data ?? []).filter((deck) => deck.kind === "normal")}
        value={selections}
        onChange={setSelections}
      />
      {added !== null && <div className="notice">Added {added} cards.</div>}
    </Modal>
  );
}
