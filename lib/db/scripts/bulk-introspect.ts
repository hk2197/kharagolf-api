/**
 * Bulk-fetch shim for `drizzle-kit/api`'s `pushSchema` introspection.
 *
 * `pushSchema` calls drizzle-kit's `pgPushIntrospect`, which fires a
 * handful of per-table queries against `information_schema` —
 * specifically a join between `table_constraints`,
 * `constraint_column_usage`, and `columns` for UNIQUE / PRIMARY KEY
 * rows, and a join between `table_constraints` and `pg_constraint`
 * for CHECK constraints. On the current 300+ table dev/test schema
 * each of those calls costs ~50 s — `information_schema` views cannot
 * use the per-table WHERE filter to prune work, so the cost is paid
 * for the whole catalog every time. With ~400 tables that adds up to
 * tens of minutes of wall time even though the rows themselves are
 * small.
 *
 * The fix (carried over from `sync-schema.ts` — see Task #1199's
 * post-mortem there): intercept the per-table query strings, run a
 * SINGLE bulk variant that returns the same rows for every table at
 * once, group them by `table_name` in memory, and answer every
 * subsequent per-table call from the cache. ~400 queries × ~50 s
 * collapses to 2 queries × a few seconds.
 *
 * The two intercepted queries are equivalent to direct `pg_constraint`
 * / `pg_attribute` lookups, which return the same rows in <100 ms on
 * the dev catalog. Drizzle filters the result for UNIQUE / PRIMARY
 * KEY (FKs are fetched via a different upstream query) and for CHECK,
 * so the bulk variants reproduce exactly that filtered shape and
 * include `__table_name` so we can group by table.
 *
 * Anything not matching those two query shapes (a brand-new probe
 * drizzle adds in a future release, an unrelated `realDb.execute(...)`
 * call) falls through to a direct `pool.query(text)` — same posture
 * `sync-schema.ts` uses, which preserves correctness when drizzle's
 * introspect surface changes.
 */

type Row = Record<string, unknown>;

interface PoolLike {
  query: (s: string) => Promise<{ rows: unknown[] }>;
}

interface DbLike {
  execute: (q: unknown) => Promise<{ rows: unknown[] }>;
}

// Drizzle interpolates the schema/table names directly into these
// strings; the regex must match the exact template so we don't
// accidentally rewrite an unrelated query.
const TABLE_CONSTRAINTS_RE =
  /^\s*SELECT c\.column_name, c\.data_type, constraint_type, constraint_name, constraint_schema\s+FROM information_schema\.table_constraints tc\s+JOIN information_schema\.constraint_column_usage AS ccu USING \(constraint_schema, constraint_name\)\s+JOIN information_schema\.columns AS c ON c\.table_schema = tc\.constraint_schema\s+AND tc\.table_name = c\.table_name AND ccu\.column_name = c\.column_name\s+WHERE tc\.table_name = '([^']+)' and constraint_schema = '([^']+)';\s*$/;

const TABLE_CHECKS_RE =
  /WHERE\s+tc\.table_name = '([^']+)'\s+AND tc\.constraint_schema = '([^']+)'\s+AND tc\.constraint_type = 'CHECK'\s+AND con\.contype = 'c';\s*$/;

/**
 * Extract the raw SQL text from a drizzle `sql.raw(text)` value.
 * `pgPushIntrospect` only ever passes a single-chunk `sql.raw(...)`, so
 * a structural read is enough and avoids drizzle's parameter-binding
 * pipeline. Returns null if the shape is unfamiliar.
 */
export function extractRawSql(sqlObj: unknown): string | null {
  const chunks = (sqlObj as { queryChunks?: Array<{ value?: unknown }> })
    ?.queryChunks;
  if (!Array.isArray(chunks) || chunks.length !== 1) return null;
  const v = chunks[0]?.value;
  if (Array.isArray(v) && v.length === 1 && typeof v[0] === "string") {
    return v[0];
  }
  return null;
}

/**
 * Replace `realDb.execute` with a wrapper that intercepts the two
 * per-table introspect probes and answers them from a single bulk
 * query. Mutates `realDb` in place. Safe to call once per drizzle
 * instance; calling it multiple times would stack wrappers (don't).
 */
export function installBulkIntrospectShim(
  realDb: DbLike,
  pool: PoolLike,
): void {
  const bulkCache = new Map<string, Map<string, Row[]>>();
  const bulkPromises = new Map<string, Promise<Map<string, Row[]>>>();

  async function bulkFetch(
    key: string,
    bulkSql: string,
  ): Promise<Map<string, Row[]>> {
    const cached = bulkCache.get(key);
    if (cached) return cached;
    let p = bulkPromises.get(key);
    if (!p) {
      p = (async () => {
        const res = await pool.query(bulkSql);
        const grouped = new Map<string, Row[]>();
        for (const row of res.rows as Row[]) {
          const tn = row.__table_name as string;
          let arr = grouped.get(tn);
          if (!arr) {
            arr = [];
            grouped.set(tn, arr);
          }
          arr.push(row);
        }
        bulkCache.set(key, grouped);
        return grouped;
      })();
      bulkPromises.set(key, p);
    }
    return p;
  }

  const realExecute = realDb.execute.bind(realDb);
  realDb.execute = async (q: unknown): Promise<{ rows: unknown[] }> => {
    const text = extractRawSql(q);
    if (text === null) {
      return realExecute(q);
    }

    const m1 = TABLE_CONSTRAINTS_RE.exec(text);
    if (m1) {
      const [, tableName, tableSchema] = m1;
      const key = `tc1:${tableSchema}`;
      // Equivalent pg_catalog query — `information_schema.table_constraints`
      // joined with `constraint_column_usage` and `columns` is intrinsically
      // O(constraints × tables) on this catalog and takes ~50 s per call.
      // Going through `pg_constraint` / `pg_attribute` directly returns the
      // same UNIQUE / PRIMARY-KEY rows drizzle filters for in <100 ms total.
      // FOREIGN-KEY rows are intentionally omitted — drizzle only filters
      // this result set for UNIQUE and PRIMARY KEY (FKs are fetched via a
      // dedicated upstream query).
      const bulkSql =
        `SELECT cl.relname AS __table_name, c.conname AS constraint_name, ` +
        `CASE c.contype WHEN 'p' THEN 'PRIMARY KEY' ` +
        `WHEN 'u' THEN 'UNIQUE' END AS constraint_type, ` +
        `a.attname AS column_name, ` +
        `pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type ` +
        `FROM pg_constraint c ` +
        `JOIN pg_class cl ON cl.oid = c.conrelid ` +
        `JOIN pg_namespace n ON n.oid = cl.relnamespace ` +
        `JOIN unnest(c.conkey) WITH ORDINALITY u(attnum, ord) ON true ` +
        `JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum = u.attnum ` +
        `WHERE n.nspname = '${tableSchema}' AND c.contype IN ('p','u') ` +
        `ORDER BY cl.relname, c.conname, u.ord;`;
      const grouped = await bulkFetch(key, bulkSql);
      const rows = (grouped.get(tableName) ?? []).map((r) => {
        const { __table_name: _omit, ...rest } = r;
        return rest;
      });
      return { rows };
    }

    const m2 = TABLE_CHECKS_RE.exec(text);
    if (m2) {
      const [, tableName, tableSchema] = m2;
      const key = `tc2:${tableSchema}`;
      const bulkSql =
        `SELECT cl.relname AS __table_name, c.conname AS constraint_name, ` +
        `'CHECK' AS constraint_type, ` +
        `pg_get_constraintdef(c.oid) AS constraint_definition ` +
        `FROM pg_constraint c ` +
        `JOIN pg_class cl ON cl.oid = c.conrelid ` +
        `JOIN pg_namespace n ON n.oid = cl.relnamespace ` +
        `WHERE n.nspname = '${tableSchema}' AND c.contype = 'c';`;
      const grouped = await bulkFetch(key, bulkSql);
      const rows = (grouped.get(tableName) ?? []).map((r) => {
        const { __table_name: _omit, ...rest } = r;
        return rest;
      });
      return { rows };
    }

    try {
      const res = await pool.query(text);
      return { rows: res.rows };
    } catch (err) {
      console.error("[bulk-introspect] FAILING SQL:\n", text);
      throw err;
    }
  };
}
