const { Client } = require('pg');
const c = new Client({ connectionString: 'postgresql://postgres:KharaGolfDB_2026!@db.vabyqmdmjtkfueyoczem.supabase.co:5432/postgres' });
c.connect().then(async () => {
  const r = await c.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'organizations' ORDER BY ordinal_position");
  console.log(r.rows.map(x => x.column_name).join(', '));
  await c.end();
});
