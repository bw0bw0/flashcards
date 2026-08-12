import { useParams } from "react-router-dom";

import { api } from "../api";
import { ErrorBanner, Screen } from "../components/Screen";
import { useLoader } from "../hooks";
import { NormalDeckView } from "./NormalDeckView";
import { SrDeckView } from "./SrDeckView";

/** Loads a deck and hands off to the view for its kind. */
export function DeckPage() {
  const { deckId } = useParams();
  const id = Number(deckId);
  const deck = useLoader(() => api.getDeck(id), [id]);

  if (!deck.data) {
    return (
      <Screen title="Deck" back>
        <ErrorBanner message={deck.error} />
        {deck.loading && <div className="empty">Loading…</div>}
      </Screen>
    );
  }

  return deck.data.kind === "sr" ? (
    <SrDeckView deck={deck.data} reloadDeck={deck.reload} />
  ) : (
    <NormalDeckView deck={deck.data} reloadDeck={deck.reload} />
  );
}
