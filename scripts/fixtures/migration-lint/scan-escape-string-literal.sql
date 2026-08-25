-- CONSTRUCTED PROBE — not a historical extract.
-- Proves: the scanner honours backslash escapes inside an `E'…'` escape-string literal.
--
-- Codex finding F7 against PR #423 head c6e9ff17: the literal loop treated `\'` as the END of the
-- literal. The real closing quote then opened a SECOND literal that ran on to the next quote,
-- masking every statement in between — here the `SET LOCAL`, which MI-004 therefore never saw.
-- Three statements were reduced to one apparent SELECT.

SELECT E'abc\'def';
SET LOCAL search_path = public;
SELECT 'x';
