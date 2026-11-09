CREATE TABLE category (
    id       INTEGER PRIMARY KEY,
    name     TEXT    NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
);

-- `kind` is 'normal' for hand-built decks and 'sr' for spaced repetition decks,
-- which hold references to cards owned by normal decks.
CREATE TABLE deck (
    id          INTEGER PRIMARY KEY,
    category_id INTEGER REFERENCES category(id) ON DELETE SET NULL,
    name        TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    kind        TEXT    NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal', 'sr')),
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL
);

CREATE INDEX deck_category ON deck(category_id);

-- `idx` is the card's position within its deck, 1-based. Slices of a deck are
-- expressed as inclusive ranges over it.
CREATE TABLE card (
    id      INTEGER PRIMARY KEY,
    deck_id INTEGER NOT NULL REFERENCES deck(id) ON DELETE CASCADE,
    idx     INTEGER NOT NULL,
    front   TEXT    NOT NULL,
    back    TEXT    NOT NULL DEFAULT '',
    comment TEXT    NOT NULL DEFAULT '',
    story   TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX card_deck_idx ON card(deck_id, idx);

-- Membership of a card in a spaced repetition deck, plus its schedule for that
-- deck. The same card may sit in several SR decks with independent schedules.
CREATE TABLE sr_card (
    id               INTEGER PRIMARY KEY,
    sr_deck_id       INTEGER NOT NULL REFERENCES deck(id) ON DELETE CASCADE,
    card_id          INTEGER NOT NULL REFERENCES card(id) ON DELETE CASCADE,
    added_at         TEXT    NOT NULL,
    state            TEXT    NOT NULL DEFAULT 'new'
                     CHECK (state IN ('new', 'learning', 'review', 'relearning')),
    due_at           TEXT    NOT NULL,
    interval_days    REAL    NOT NULL DEFAULT 0,
    ease             REAL    NOT NULL DEFAULT 2.5,
    reps             INTEGER NOT NULL DEFAULT 0,
    lapses           INTEGER NOT NULL DEFAULT 0,
    step             INTEGER NOT NULL DEFAULT 0,
    last_reviewed_at TEXT,
    UNIQUE (sr_deck_id, card_id)
);

CREATE INDEX sr_card_due ON sr_card(sr_deck_id, due_at);

CREATE TABLE review_log (
    id           INTEGER PRIMARY KEY,
    sr_card_id   INTEGER NOT NULL REFERENCES sr_card(id) ON DELETE CASCADE,
    reviewed_at  TEXT    NOT NULL,
    grade        INTEGER NOT NULL,
    interval_days REAL   NOT NULL
);

CREATE INDEX review_log_time ON review_log(reviewed_at);

CREATE TABLE story_prompt (
    id         INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    prompt     TEXT    NOT NULL,
    created_at TEXT    NOT NULL
);
