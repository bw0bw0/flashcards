-- The state a card was in when it was answered. The daily review limit counts
-- answers to cards that were in the review state at the time, like Anki,
-- instead of looking at whatever state the card has moved to since (which
-- counted every learning step of a freshly graduated card as a review, and
-- missed lapsed cards). Older rows stay NULL and are not counted.
ALTER TABLE review_log ADD COLUMN state TEXT;
