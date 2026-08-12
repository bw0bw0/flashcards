import type { Card } from "../types";

interface Props {
  card: Card;
  revealed: boolean;
  onReveal: () => void;
}

/**
 * The card as the user sees it while training: the front alone until it is
 * revealed, then the back, the comment and the story.
 */
export function CardFace({ card, revealed, onReveal }: Props) {
  return (
    <div
      className="flashcard"
      onClick={() => {
        if (!revealed) onReveal();
      }}
    >
      <div className="face">{card.front}</div>

      {revealed ? (
        <>
          {card.back && (
            <>
              <div className="divider" />
              <div className="answer">{card.back}</div>
            </>
          )}
          {card.comment && <div className="comment">{card.comment}</div>}
          {card.story && <div className="story">{card.story}</div>}
        </>
      ) : (
        <div className="hint">Tap the card to reveal</div>
      )}
    </div>
  );
}
