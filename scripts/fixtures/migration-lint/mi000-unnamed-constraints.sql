-- CONSTRUCTED PROBE — not a historical extract.
-- Proves: the constraint inventory enumerates EVERY constraint form, not only `CONSTRAINT "name" kind`.
--
-- Codex finding F5 against PR #423 head c6e9ff17: the inventory regex required a DOUBLE-QUOTED
-- explicit name. Every form below is ordinary PostgreSQL and every one was omitted entirely,
-- yielding an empty inventory and a clean MI-000 — the total-classification backstop reporting
-- "I classified everything" about a file it had not read. Constraint-specific rules are bypassed
-- by writing the constraint the way PostgreSQL's own documentation writes it.

CREATE TABLE IF NOT EXISTS public."Decoy" (
  "id"   TEXT NOT NULL,
  a      INT CHECK (a > 0),
  b      INT UNIQUE,
  c      INT REFERENCES public."Other" ("id"),
  d      INT,
  CONSTRAINT ck CHECK (a > 0),
  CONSTRAINT decoy_pk PRIMARY KEY ("id"),
  UNIQUE (a),
  CHECK (b > a),
  FOREIGN KEY (d) REFERENCES public."Other" ("id")
);

ALTER TABLE public."Decoy" ADD CONSTRAINT decoy_b_positive CHECK (b > 0);
