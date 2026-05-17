import pg from 'pg';
const { Client } = pg;

const DATABASE_URL = 'postgresql://postgres:KharaGolfDB_2026!@db.vabyqmdmjtkfueyoczem.supabase.co:5432/postgres';

async function run() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const res = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND (table_name = 'sessions' OR table_name = 'app_users' OR table_name = 'users')");
    console.log('Tables found:');
    res.rows.forEach(row => console.log(` - ${row.table_name}`));
    
    if (res.rows.length === 0) {
        console.log('No matching tables found.');
    }
  } catch (err) {
    console.error('Error listing tables:', err);
  } finally {
    await client.end();
  }
}

run();
