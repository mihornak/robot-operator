-- Reference DDL. server/src/wishlist.ts runs this itself on first use (once
-- per process), so nothing has to be applied by hand — this file exists so the
-- schema is readable without reading the code.

CREATE TABLE IF NOT EXISTS wishlist (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  floor INTEGER,
  robot_name TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
