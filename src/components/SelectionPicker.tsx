import type { CardSelection, Deck } from "../types";

interface Props {
  /** Only normal decks can be drawn from. */
  decks: Deck[];
  value: CardSelection[];
  onChange: (selections: CardSelection[]) => void;
}

/**
 * Picks whole decks, or slices of them, to feed into a spaced repetition deck.
 * Leaving the two index boxes empty means "the whole deck".
 */
export function SelectionPicker({ decks, value, onChange }: Props) {
  const byDeck = new Map(value.map((selection) => [selection.deckId, selection]));

  function toggle(deck: Deck, on: boolean) {
    if (on) {
      onChange([...value, { deckId: deck.id, fromIndex: null, toIndex: null }]);
    } else {
      onChange(value.filter((selection) => selection.deckId !== deck.id));
    }
  }

  function setRange(deckId: number, key: "fromIndex" | "toIndex", raw: string) {
    const parsed = raw.trim() === "" ? null : Number(raw);
    onChange(
      value.map((selection) =>
        selection.deckId === deckId
          ? { ...selection, [key]: Number.isFinite(parsed) ? parsed : null }
          : selection,
      ),
    );
  }

  if (decks.length === 0) {
    return <div className="empty">There are no decks to draw cards from yet.</div>;
  }

  return (
    <div className="deck-list">
      {decks.map((deck) => {
        const selection = byDeck.get(deck.id);
        return (
          <div key={deck.id} className="selection-row">
            <input
              type="checkbox"
              checked={selection !== undefined}
              onChange={(event) => toggle(deck, event.target.checked)}
              aria-label={`Include ${deck.name}`}
            />
            <div className="name">
              {deck.name}
              <div className="small muted">{deck.cardCount} cards</div>
            </div>
            {selection && (
              <RangeFields
                fromIndex={selection.fromIndex}
                toIndex={selection.toIndex}
                onChange={(key, raw) => setRange(deck.id, key, raw)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

interface RangeProps {
  fromIndex: number | null;
  toIndex: number | null;
  onChange: (key: "fromIndex" | "toIndex", raw: string) => void;
}

/** The two index boxes that turn a whole deck into a slice. */
export function RangeFields({ fromIndex, toIndex, onChange }: RangeProps) {
  return (
    <div className="range-inputs">
      <input
        type="number"
        min={1}
        placeholder="first"
        value={fromIndex ?? ""}
        onChange={(event) => onChange("fromIndex", event.target.value)}
        aria-label="First card"
      />
      <span className="muted small">–</span>
      <input
        type="number"
        min={1}
        placeholder="last"
        value={toIndex ?? ""}
        onChange={(event) => onChange("toIndex", event.target.value)}
        aria-label="Last card"
      />
    </div>
  );
}
