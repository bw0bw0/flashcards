import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { api } from "../api";
import { CardEditor } from "../components/CardEditor";
import { ExportDialog, ImportDialog } from "../components/ImportDialog";
import { Field, Modal } from "../components/Modal";
import { ErrorBanner, Screen } from "../components/Screen";
import { RangeFields } from "../components/SelectionPicker";
import { StoryPromptDialog } from "../components/StoryPromptDialog";
import { useAction, useLoader } from "../hooks";
import type { Card, Deck } from "../types";
import { DeckModal } from "./DecksPage";

type Dialog = "edit" | "import" | "export" | "story" | "train" | "new-card" | null;

interface Props {
  deck: Deck;
  reloadDeck: () => Promise<void>;
}

export function NormalDeckView({ deck, reloadDeck }: Props) {
  const cards = useLoader(() => api.listCards(deck.id), [deck.id]);
  const categories = useLoader(() => api.listCategories(), []);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [editing, setEditing] = useState<Card | null>(null);
  const action = useAction();

  async function reload() {
    await Promise.all([cards.reload(), reloadDeck()]);
  }

  async function move(card: Card, delta: number) {
    await action.run(() => api.moveCard(card.id, card.index + delta));
    await cards.reload();
  }

  const list = cards.data ?? [];

  return (
    <Screen
      title={deck.name}
      subtitle={deck.categoryName ?? "No category"}
      back
      actions={
        <button className="icon-btn" onClick={() => setDialog("edit")} aria-label="Edit deck">
          ✎
        </button>
      }
    >
      <ErrorBanner message={cards.error ?? action.error} />

      <div className="row wrap">
        <button
          className="btn primary"
          onClick={() => setDialog("train")}
          disabled={list.length === 0}
        >
          Train
        </button>
        <button className="btn" onClick={() => setDialog("story")}>
          Prompt a story
        </button>
        <button className="btn ghost" onClick={() => setDialog("import")}>
          Import
        </button>
        <button
          className="btn ghost"
          onClick={() => setDialog("export")}
          disabled={list.length === 0}
        >
          Export
        </button>
      </div>

      <div className="section-title">
        <span>{list.length} cards</span>
        <button className="btn small" onClick={() => setDialog("new-card")}>
          Add card
        </button>
      </div>

      {list.length === 0 && !cards.loading && (
        <div className="empty">
          This deck is empty.
          <br />
          Add cards one by one, or import them as JSON.
        </div>
      )}

      <div className="deck-list">
        {list.map((card) => (
          <div key={card.id} className="card-row">
            <span className="idx">{card.index}</span>
            <div className="body" onClick={() => setEditing(card)}>
              <div className="front">{card.front}</div>
              {card.back && <div className="back">{card.back}</div>}
              <div className="flags">
                {card.comment && <span className="badge">note</span>}
                {card.story && <span className="badge sr">story</span>}
              </div>
            </div>
            <button
              className="icon-btn"
              aria-label="Move up"
              disabled={card.index === 1}
              onClick={() => move(card, -1)}
            >
              ↑
            </button>
            <button
              className="icon-btn"
              aria-label="Move down"
              disabled={card.index === list.length}
              onClick={() => move(card, 1)}
            >
              ↓
            </button>
          </div>
        ))}
      </div>

      {dialog === "edit" && (
        <DeckModal
          deck={deck}
          categories={categories.data ?? []}
          onClose={() => setDialog(null)}
          onSaved={reloadDeck}
        />
      )}
      {dialog === "import" && (
        <ImportDialog
          deckId={deck.id}
          onClose={() => setDialog(null)}
          onImported={reload}
        />
      )}
      {dialog === "export" && (
        <ExportDialog deckId={deck.id} onClose={() => setDialog(null)} />
      )}
      {dialog === "story" && (
        <StoryPromptDialog
          deck={deck}
          onClose={() => setDialog(null)}
          onApplied={reload}
        />
      )}
      {dialog === "train" && (
        <TrainRangeDialog deck={deck} onClose={() => setDialog(null)} />
      )}
      {(dialog === "new-card" || editing) && (
        <CardEditor
          deckId={deck.id}
          card={editing ?? undefined}
          onClose={() => {
            setDialog(null);
            setEditing(null);
          }}
          onSaved={reload}
        />
      )}
    </Screen>
  );
}

/** Picks the slice a story session walks through before starting it. */
function TrainRangeDialog({ deck, onClose }: { deck: Deck; onClose: () => void }) {
  const navigate = useNavigate();
  const [fromIndex, setFromIndex] = useState<number | null>(null);
  const [toIndex, setToIndex] = useState<number | null>(null);
  const [shuffle, setShuffle] = useState(false);

  function start() {
    const query = new URLSearchParams();
    if (fromIndex !== null) query.set("from", String(fromIndex));
    if (toIndex !== null) query.set("to", String(toIndex));
    if (shuffle) query.set("shuffle", "1");
    navigate(`/deck/${deck.id}/story?${query.toString()}`);
  }

  return (
    <Modal
      title="Train"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={start}>
            Start
          </button>
        </>
      }
    >
      <div className="notice">
        Story mode walks through the deck front to back, one card at a time.
      </div>
      <Field label={`Cards (of ${deck.cardCount}, blank means all)`}>
        <RangeFields
          fromIndex={fromIndex}
          toIndex={toIndex}
          onChange={(key, raw) => {
            const parsed = raw.trim() === "" ? null : Number(raw);
            const value = Number.isFinite(parsed) ? parsed : null;
            if (key === "fromIndex") setFromIndex(value);
            else setToIndex(value);
          }}
        />
      </Field>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={shuffle}
          onChange={(event) => setShuffle(event.target.checked)}
        />
        Shuffle the order
      </label>
    </Modal>
  );
}
