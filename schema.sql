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
