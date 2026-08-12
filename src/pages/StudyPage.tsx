import { useNavigate } from "react-router-dom";

import { api } from "../api";
import { ErrorBanner, Screen } from "../components/Screen";
import { useLoader } from "../hooks";

/** Both training modes in one place: what is due, and what can be walked. */
export function StudyPage() {
  const navigate = useNavigate();
  const decks = useLoader(() => api.listDecks(), []);

  const all = decks.data ?? [];
  const srDecks = all.filter((deck) => deck.kind === "sr");
  const normalDecks = all.filter((deck) => deck.kind === "normal" && deck.cardCount > 0);
  const totalDue = srDecks.reduce((sum, deck) => sum + deck.dueCount, 0);

  return (
    <Screen
      title="Study"
      subtitle={totalDue > 0 ? `${totalDue} cards due` : "Nothing due"}
    >
      <ErrorBanner message={decks.error} />

      <div className="section-title">Spaced repetition</div>
      {srDecks.length === 0 ? (
        <div className="empty">
          No spaced repetition decks yet.
          <br />
          Build one from your decks on the Decks tab.
        </div>
      ) : (
        <div className="deck-list">
          {srDecks.map((deck) => (
            <div
              key={deck.id}
              className="deck-row"
              onClick={() =>
                navigate(deck.dueCount > 0 ? `/deck/${deck.id}/review` : `/deck/${deck.id}`)
              }
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="name">{deck.name}</div>
                <div className="meta">
                  {deck.cardCount} cards · {deck.newCount} new
                </div>
              </div>
              {deck.dueCount > 0 ? (
                <span className="badge due">{deck.dueCount} due</span>
              ) : (
                <span className="badge">up to date</span>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="section-title">Story mode</div>
      {normalDecks.length === 0 ? (
        <div className="empty">No decks with cards yet.</div>
      ) : (
        <div className="deck-list">
          {normalDecks.map((deck) => (
            <div
              key={deck.id}
              className="deck-row"
              onClick={() => navigate(`/deck/${deck.id}/story`)}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="name">{deck.name}</div>
                <div className="meta">{deck.cardCount} cards</div>
              </div>
              <span className="badge">walk through</span>
            </div>
          ))}
        </div>
      )}
    </Screen>
  );
}
