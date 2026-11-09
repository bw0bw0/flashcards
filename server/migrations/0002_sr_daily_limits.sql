-- New cards used to become due the instant they were added, which dumped an
-- entire deck into the queue at once. Decks now trickle new cards in and cap
-- reviews at a daily rate, the way Anki does.
ALTER TABLE deck ADD COLUMN new_per_day INTEGER NOT NULL DEFAULT 20;
ALTER TABLE deck ADD COLUMN review_per_day INTEGER NOT NULL DEFAULT 200;

-- A one-off bump to today's limits ("increase today's limit"). `extra_today_date`
-- pins the bump to the calendar day it was requested on; reading code treats it
-- as spent once that day has passed, so it needs no separate cleanup.
ALTER TABLE deck ADD COLUMN extra_new_today INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deck ADD COLUMN extra_review_today INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deck ADD COLUMN extra_today_date TEXT;

-- When a card first leaves the 'new' state, so the daily new-card limit can
-- tell how many have already been introduced today.
ALTER TABLE sr_card ADD COLUMN first_studied_at TEXT;
