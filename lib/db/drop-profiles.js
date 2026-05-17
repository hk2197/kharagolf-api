import pkg from 'pg';
const { Client } = pkg;

const client = new Client({
  connectionString: 'postgresql://postgres:KharaGolfDB_2026!@db.vabyqmdmjtkfueyoczem.supabase.co:5432/postgres'
});

async function run() {
  await client.connect();
  console.log("Connected to DB, dropping profiles table...");
  await client.query('DROP TABLE IF EXISTS profiles CASCADE;');
  console.log("Table dropped successfully.");
  await client.end();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
