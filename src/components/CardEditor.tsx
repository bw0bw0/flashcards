import { useState } from "react";

import { api } from "../api";
import { useAction } from "../hooks";
import type { Card } from "../types";
import { Field, Modal } from "./Modal";
import { ErrorBanner } from "./Screen";

interface Props {
  deckId: number;
  /** Omitted when adding a new card. */
  card?: Card;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

export function CardEditor({ deckId, card, onClose, onSaved }: Props) {
  const [front, setFront] = useState(card?.front ?? "");
  const [back, setBack] = useState(card?.back ?? "");
  const [comment, setComment] = useState(card?.comment ?? "");
  const [story, setStory] = useState(card?.story ?? "");
  const action = useAction();

  async function save() {
    const saved = await action.run(() =>
      card
        ? api.updateCard(card.id, front, back, comment, story)
        : api.createCard(deckId, front, back, comment, story),
    );
    if (!saved) return;
    await onSaved();
    onClose();
  }

  return (
    <Modal
      title={card ? `Card ${card.index}` : "New card"}
      onClose={onClose}
      footer={
        <>
          {card && (
            <button
              className="btn danger"
              onClick={async () => {
                if (!confirm("Delete this card?")) return;
                const done = await action.run(() => api.deleteCard(card.id));
                if (done === undefined) return;
                await onSaved();
                onClose();
              }}
            >
              Delete
            </button>
          )}
          <div className="spacer" />
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={action.busy}>
            Save
          </button>
        </>
      }
    >
      <ErrorBanner message={action.error} />
      <Field label="Front">
        <input
          type="text"
          value={front}
          autoFocus
          onChange={(event) => setFront(event.target.value)}
        />
      </Field>
      <Field label="Back">
        <input
          type="text"
          value={back}
          onChange={(event) => setBack(event.target.value)}
        />
      </Field>
      <Field label="Comment">
        <textarea
          value={comment}
          rows={2}
          onChange={(event) => setComment(event.target.value)}
        />
      </Field>
      <Field label="Story">
        <textarea
          value={story}
          rows={4}
          onChange={(event) => setStory(event.target.value)}
        />
      </Field>
    </Modal>
  );
}
