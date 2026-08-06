-- Reference DDL. server/src/analytics.ts runs this itself on first use (once
-- per process), so nothing has to be applied by hand — this file exists so the
-- schema is readable without reading the code.
--
-- One row per client event: the same `{t, type, data}` items /api/log already
-- appends to logs/events-YYYYMMDD.jsonl, kept somewhere a redeploy cannot
-- delete. `session` is the client's per-page-load id, not a person.

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  session TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  type TEXT NOT NULL,
  props JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_session_idx ON events (session);
CREATE INDEX IF NOT EXISTS events_type_ts_idx ON events (type, ts);
