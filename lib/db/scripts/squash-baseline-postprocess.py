#!/usr/bin/env python3
r"""
squash-baseline-postprocess.py

Read a `pg_dump --schema-only` dump on stdin and emit a fully idempotent
baseline SQL file on stdout.

This implements the exact rule-set used to produce
`lib/db/drizzle/0000_initial.sql` during Task #1716. It is the
checked-in replacement for the ad-hoc `/tmp/squash_make_idempotent.py`
that only existed inside the Task #1716 sandbox.

Idempotency rules (must match the header comment of the baseline):
  - CREATE TYPE                         → wrap in DO $do$ BEGIN ...
                                          EXCEPTION WHEN duplicate_object
                                          THEN null; END $do$
  - CREATE TRIGGER                      → wrap (same handler)
  - CREATE POLICY                       → wrap (same handler)
  - CREATE TABLE                        → CREATE TABLE IF NOT EXISTS
  - CREATE SEQUENCE                     → CREATE SEQUENCE IF NOT EXISTS
  - CREATE INDEX / CREATE UNIQUE INDEX  → CREATE [UNIQUE] INDEX IF NOT EXISTS
  - CREATE MATERIALIZED VIEW            → CREATE MATERIALIZED VIEW IF NOT EXISTS
  - CREATE VIEW                         → CREATE OR REPLACE VIEW
  - CREATE FUNCTION                     → CREATE OR REPLACE FUNCTION
  - ALTER TABLE ... ADD CONSTRAINT      → wrap in DO $do$ BEGIN ...
                                          EXCEPTION
                                            WHEN duplicate_object         THEN null;
                                            WHEN duplicate_table          THEN null;
                                            WHEN invalid_table_definition THEN null;
                                            WHEN unique_violation         THEN null;
                                          END $do$
                                          (the wider exception list
                                          matters because adding a
                                          duplicate PRIMARY KEY raises
                                          `invalid_table_definition`
                                          ("multiple primary keys for
                                          table … are not allowed"),
                                          NOT `duplicate_object`; and a
                                          duplicate UNIQUE constraint
                                          raises `unique_violation` if
                                          live data already conflicts
                                          mid-creation. Both have been
                                          observed during re-apply on
                                          existing prod.)

Lines stripped (session-local pg_dump preamble that breaks under
`ON_ERROR_STOP=1` on some psql ↔ pg_dump version mismatches):
  - `SET ...;` (statement_timeout, search_path, idle_in_transaction_..., etc.)
  - `SELECT pg_catalog.set_config(...);`
  - `\restrict`, `\unrestrict`, `\connect` directives
  - The pg_dump banner block at the top of the dump
    (`-- PostgreSQL database dump`, `-- Dumped from`, etc.)

Statements are split with a hand-rolled scanner that respects:
  - line / block comments
  - single-quoted string literals (with '' escapes)
  - dollar-quoted string literals ($$ … $$, $tag$ … $tag$) which is
    essential because pg_dump emits CREATE FUNCTION bodies inside
    dollar quotes that contain `;` characters that are NOT statement
    terminators.

Usage:
    pg_dump --schema-only "$DATABASE_URL" \\
      | python3 lib/db/scripts/squash-baseline-postprocess.py \\
      > lib/db/drizzle/0000_initial.sql
"""

from __future__ import annotations

import re
import sys
from typing import Iterable, List, Tuple

# ---------------------------------------------------------------------------
# Statement scanner
# ---------------------------------------------------------------------------

_DOLLAR_TAG_RE = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$")


def split_statements(sql: str) -> List[str]:
    """Split a SQL stream into top-level statements.

    Respects line comments (`-- …`), block comments (`/* … */`),
    single-quoted strings (with doubled-quote escapes), and
    dollar-quoted strings (the only PostgreSQL construct in which a
    bare `;` may appear without ending a statement).

    Returns a list of statement strings, each WITHOUT the trailing
    `;` and WITHOUT any leading/trailing whitespace. Empty entries
    are filtered out.
    """
    statements: List[str] = []
    buf: List[str] = []
    i = 0
    n = len(sql)
    in_single = False
    in_line_comment = False
    in_block_comment = False
    dollar_tag: str | None = None  # active dollar-quote tag, e.g. "" or "do"

    while i < n:
        c = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""

        if in_line_comment:
            buf.append(c)
            if c == "\n":
                in_line_comment = False
            i += 1
            continue

        if in_block_comment:
            buf.append(c)
            if c == "*" and nxt == "/":
                buf.append(nxt)
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue

        if dollar_tag is not None:
            # Inside a dollar-quoted literal — look for the matching close tag.
            close = f"${dollar_tag}$"
            if sql.startswith(close, i):
                buf.append(close)
                i += len(close)
                dollar_tag = None
                continue
            buf.append(c)
            i += 1
            continue

        if in_single:
            buf.append(c)
            if c == "'":
                # Doubled '' is an escape, not the end of the literal.
                if nxt == "'":
                    buf.append(nxt)
                    i += 2
                    continue
                in_single = False
            i += 1
            continue

        # Not inside any quoted/comment context.
        if c == "-" and nxt == "-":
            buf.append(c)
            buf.append(nxt)
            in_line_comment = True
            i += 2
            continue

        if c == "/" and nxt == "*":
            buf.append(c)
            buf.append(nxt)
            in_block_comment = True
            i += 2
            continue

        if c == "'":
            buf.append(c)
            in_single = True
            i += 1
            continue

        if c == "$":
            m = _DOLLAR_TAG_RE.match(sql, i)
            if m:
                tag = m.group(1) or ""
                buf.append(m.group(0))
                dollar_tag = tag
                i += len(m.group(0))
                continue

        if c == ";":
            stmt = "".join(buf).strip()
            if stmt:
                statements.append(stmt)
            buf = []
            i += 1
            continue

        buf.append(c)
        i += 1

    tail = "".join(buf).strip()
    if tail:
        statements.append(tail)
    return statements


# ---------------------------------------------------------------------------
# Per-statement classification + rewrite
# ---------------------------------------------------------------------------

# A statement may carry leading line comments (e.g. pg_dump's
# `-- Name: foo; Type: TABLE; ...` block). To classify we want to
# inspect the first non-comment, non-whitespace token.

_LINE_COMMENT_RE = re.compile(r"^[ \t]*--[^\n]*\n", re.MULTILINE)


def _strip_leading_comments(stmt: str) -> Tuple[str, str]:
    """Return (leading_comment_block, body) for a statement."""
    leading: List[str] = []
    rest = stmt
    while True:
        m = re.match(r"\A([ \t]*--[^\n]*(?:\n|$)|\s+)", rest)
        if not m:
            break
        leading.append(m.group(0))
        rest = rest[m.end():]
    return "".join(leading), rest


# Top-of-statement keyword extraction. We normalise the head so the
# match is whitespace-insensitive across multi-line statements.
def _head(body: str, n: int = 96) -> str:
    return re.sub(r"\s+", " ", body[:n]).strip().upper()


def _wrap_do(body: str, exceptions: str) -> str:
    """Wrap a single statement body in a DO block with the given EXCEPTION clause.

    `exceptions` is either a single PG error class (rendered inline) or a
    `\\n`-separated list of `WHEN <class>` lines (rendered as a multi-line
    EXCEPTION block — used for ADD CONSTRAINT where four classes can fire
    depending on what was duplicated).
    """
    if "\n" in exceptions:
        return (
            "DO $do$ BEGIN\n"
            f"  {body.strip()};\n"
            "EXCEPTION\n"
            f"{exceptions}\n"
            "END $do$"
        )
    return (
        "DO $do$ BEGIN\n"
        f"  {body.strip()};\n"
        f"EXCEPTION WHEN {exceptions} THEN null; END $do$"
    )


# Multi-line EXCEPTION block for ALTER TABLE ... ADD CONSTRAINT.
# See module docstring for the full rationale; in short, adding a
# duplicate PRIMARY KEY raises invalid_table_definition rather than
# duplicate_object, and a duplicate UNIQUE can race with conflicting
# data during re-apply, raising unique_violation. We catch all four.
_ADD_CONSTRAINT_EXCEPTIONS = (
    "  WHEN duplicate_object         THEN null;\n"
    "  WHEN duplicate_table          THEN null;\n"
    "  WHEN invalid_table_definition THEN null;\n"
    "  WHEN unique_violation         THEN null;"
)


# Targeted, anchored rewrites for the "CREATE X → CREATE X IF NOT EXISTS"
# and "CREATE X → CREATE OR REPLACE X" cases. We anchor at the start of
# the body so we never edit the inside of a CREATE TABLE column list
# (which can legally contain the substring "CREATE TABLE" in a comment).

_REWRITES: List[Tuple[re.Pattern[str], str]] = [
    (re.compile(r"\ACREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS\b)", re.IGNORECASE),
     "CREATE TABLE IF NOT EXISTS "),
    (re.compile(r"\ACREATE\s+SEQUENCE\s+(?!IF\s+NOT\s+EXISTS\b)", re.IGNORECASE),
     "CREATE SEQUENCE IF NOT EXISTS "),
    (re.compile(r"\ACREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS\b)",
                re.IGNORECASE),
     None),  # handled specially to preserve UNIQUE
    (re.compile(r"\ACREATE\s+MATERIALIZED\s+VIEW\s+(?!IF\s+NOT\s+EXISTS\b)",
                re.IGNORECASE),
     "CREATE MATERIALIZED VIEW IF NOT EXISTS "),
    (re.compile(r"\ACREATE\s+VIEW\s+(?!.*OR\s+REPLACE)", re.IGNORECASE),
     "CREATE OR REPLACE VIEW "),
    (re.compile(r"\ACREATE\s+FUNCTION\s+", re.IGNORECASE),
     "CREATE OR REPLACE FUNCTION "),
]


def transform_statement(stmt: str) -> str | None:
    """Apply the idempotency rules to a single statement.

    Returns the rewritten SQL (without trailing `;`), or None if the
    statement should be dropped from the output entirely (session
    SETs, pg_dump-only directives, etc.).
    """
    leading, body = _strip_leading_comments(stmt)
    if not body:
        return None

    head = _head(body)

    # ------- Drop session-local / pg_dump-only directives ------------------
    if head.startswith("SET "):
        return None
    if head.startswith("SELECT PG_CATALOG.SET_CONFIG"):
        return None
    if body.lstrip().startswith("\\"):
        # psql backslash directives: \restrict, \unrestrict, \connect, …
        return None
    if head.startswith("COMMENT ON EXTENSION"):
        # `COMMENT ON EXTENSION plpgsql IS '…'` requires owner privs and is
        # routinely not granted in managed Postgres environments. The
        # comment is harmless to drop — pg_dump only emits it because the
        # extension was preinstalled with a default comment.
        return None

    # ------- CREATE TYPE → DO/EXCEPTION duplicate_object -------------------
    if re.match(r"\ACREATE\s+TYPE\b", body, re.IGNORECASE):
        return leading + _wrap_do(body, "duplicate_object")

    # ------- CREATE TRIGGER → DO/EXCEPTION duplicate_object ----------------
    if re.match(r"\ACREATE\s+(CONSTRAINT\s+)?TRIGGER\b", body, re.IGNORECASE):
        return leading + _wrap_do(body, "duplicate_object")

    # ------- CREATE POLICY → DO/EXCEPTION duplicate_object -----------------
    if re.match(r"\ACREATE\s+POLICY\b", body, re.IGNORECASE):
        return leading + _wrap_do(body, "duplicate_object")

    # ------- ALTER TABLE … ADD CONSTRAINT → DO/EXCEPTION ------------------
    # pg_dump always emits one ADD CONSTRAINT per ALTER TABLE statement so
    # we can wrap the whole statement without splitting subclauses.
    if re.match(r"\AALTER\s+TABLE\b", body, re.IGNORECASE) and re.search(
        r"\bADD\s+CONSTRAINT\b", body, re.IGNORECASE
    ):
        return leading + _wrap_do(body, _ADD_CONSTRAINT_EXCEPTIONS)

    # ------- CREATE INDEX → CREATE [UNIQUE] INDEX IF NOT EXISTS -----------
    m = re.match(
        r"\ACREATE\s+(?P<u>UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS\b)(?P<rest>.*)",
        body,
        re.IGNORECASE | re.DOTALL,
    )
    if m:
        unique = "UNIQUE " if m.group("u") else ""
        return leading + f"CREATE {unique}INDEX IF NOT EXISTS {m.group('rest').lstrip()}"

    # ------- Other anchored rewrites --------------------------------------
    for pattern, replacement in _REWRITES:
        if replacement is None:
            continue  # CREATE INDEX handled above
        m2 = pattern.match(body)
        if m2:
            return leading + pattern.sub(replacement, body, count=1)

    # Anything else (INSERT, GRANT, REVOKE, CREATE EXTENSION IF NOT EXISTS,
    # CREATE SCHEMA, etc.) passes through unchanged. CREATE EXTENSION and
    # CREATE SCHEMA are emitted by pg_dump WITH `IF NOT EXISTS` already.
    return leading + body


# ---------------------------------------------------------------------------
# Output assembly
# ---------------------------------------------------------------------------

HEADER = """\
-- ──────────────────────────────────────────────────────────────────────────
-- Baseline schema snapshot (Task #1716; regen runbook: docs/db-migration-squash.md)
--
-- This single file replaces the historical numbered migrations that
-- previously lived in lib/db/drizzle/. Old per-PR migrations are
-- preserved under `lib/db/drizzle/archive/` for git-history reference;
-- they are NOT re-applied (the apply loops in `scripts/post-merge.sh`
-- and `scripts/apply-prod-migrations.sh` only pick up files matching
-- `[0-9][0-9][0-9][0-9]_*.sql` directly under `lib/db/drizzle/`).
--
-- Generated by `pg_dump --schema-only` against a temp DB seeded with
-- every numbered migration in `lib/db/drizzle/` as of the squash
-- commit, then post-processed for idempotency by
-- `lib/db/scripts/squash-baseline-postprocess.py` so it is a no-op on
-- any DB that already has the schema (existing prod) and a single fast
-- pass on a fresh DB (CI / new dev containers).
--
-- Idempotency rules applied:
--   * CREATE TYPE / CREATE TRIGGER / CREATE POLICY → wrapped in
--     DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN null END $$
--   * CREATE TABLE / SEQUENCE / INDEX / MATERIALIZED VIEW   → IF NOT EXISTS
--   * CREATE VIEW / FUNCTION                                → OR REPLACE
--   * ALTER TABLE ... ADD CONSTRAINT                        → wrapped in
--     DO $$ BEGIN ... EXCEPTION WHEN duplicate_object|duplicate_table
--     THEN null END $$
--   * pg_dump session SETs (statement_timeout, search_path, …) and
--     `\\restrict` / `\\connect` directives stripped — they are
--     session-local and break under `ON_ERROR_STOP=1` on some
--     psql ↔ pg_dump version mismatches.
--
-- DO NOT EDIT BY HAND. To regenerate after a future schema change,
-- write a numbered migration as usual; only re-squash when the file
-- count climbs back into the hundreds, following the runbook at
-- `docs/db-migration-squash.md`.
-- ──────────────────────────────────────────────────────────────────────────
"""


def render(statements: Iterable[str]) -> str:
    out: List[str] = [HEADER, ""]
    for s in statements:
        out.append(s + ";")
        out.append("")  # blank line between statements for readability
    # Strip the trailing blank.
    while out and out[-1] == "":
        out.pop()
    return "\n".join(out) + "\n"


def main(argv: List[str]) -> int:
    if len(argv) > 1 and argv[1] in {"-h", "--help"}:
        sys.stderr.write(__doc__ or "")
        return 0
    raw = sys.stdin.read()
    stmts = split_statements(raw)
    rewritten: List[str] = []
    for s in stmts:
        out = transform_statement(s)
        if out is None:
            continue
        rewritten.append(out)
    sys.stdout.write(render(rewritten))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
