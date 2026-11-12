-- Highlights database. Idempotent: safe to run on every start.

CREATE TABLE IF NOT EXISTS documents (
  id           SERIAL PRIMARY KEY,
  source_app   TEXT NOT NULL,              -- readeck | bookorbit | readwise | kindle
  external_id  TEXT NOT NULL,              -- the source's own id for the document
  kind         TEXT NOT NULL,              -- article | book | podcast | video
  title        TEXT,
  author       TEXT,
  url          TEXT,
  published_at TIMESTAMPTZ,
  language     TEXT,
  UNIQUE (source_app, external_id)
);

CREATE TABLE IF NOT EXISTS highlights (
  id             SERIAL PRIMARY KEY,
  document_id    INTEGER NOT NULL REFERENCES documents(id),
  source_app     TEXT NOT NULL,
  external_id    TEXT NOT NULL,
  text           TEXT NOT NULL,            -- the highlighted passage only, never the article body
  note           TEXT,
  color          TEXT,
  tags           TEXT[] NOT NULL DEFAULT '{}',
  location       TEXT,                     -- chapter / page / percent / CFI for books
  deep_link      TEXT,
  highlighted_at TIMESTAMPTZ,
  imported_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ,
  text_hash      TEXT NOT NULL,
  UNIQUE (source_app, external_id)
);

CREATE INDEX IF NOT EXISTS highlights_text_hash ON highlights (text_hash);
CREATE INDEX IF NOT EXISTS highlights_live ON highlights (id) WHERE deleted_at IS NULL;

-- One row per calendar day: which highlight that day showed.
CREATE TABLE IF NOT EXISTS surfacings (
  day          DATE PRIMARY KEY,
  highlight_id INTEGER NOT NULL REFERENCES highlights(id),
  chosen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ratings on the 1–7 scale, kept as history: the current rating of a highlight by a rater is its newest row.
-- `reader` comes from the reader's note marker (C13; score NULL means the marker was removed), `model` from the rating
-- job (with its one-line reason, model and rubric version). The reader's rating always wins.
CREATE TABLE IF NOT EXISTS ratings (
  id             SERIAL PRIMARY KEY,
  highlight_id   INTEGER NOT NULL REFERENCES highlights(id),
  rater          TEXT NOT NULL CHECK (rater IN ('reader', 'model')),
  score          SMALLINT CHECK (score BETWEEN 1 AND 7),
  reason         TEXT,
  model          TEXT,
  rubric_version TEXT,
  rated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (rater = 'reader' OR score IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ratings_current ON ratings (highlight_id, rater, id DESC);

-- The rating in force per highlight: the reader's if set, else the model's.
CREATE OR REPLACE VIEW current_ratings AS
SELECT h.id AS highlight_id,
       COALESCE(r.score, m.score) AS score,
       CASE WHEN r.score IS NOT NULL THEN 'reader' WHEN m.score IS NOT NULL THEN 'model' END AS rated_by
FROM highlights h
LEFT JOIN LATERAL (SELECT score FROM ratings WHERE highlight_id = h.id AND rater = 'reader' ORDER BY id DESC LIMIT 1) r ON true
LEFT JOIN LATERAL (SELECT score FROM ratings WHERE highlight_id = h.id AND rater = 'model' ORDER BY id DESC LIMIT 1) m ON true;
