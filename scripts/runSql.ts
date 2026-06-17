import "dotenv/config";
import fs from "fs";
import { Client } from "pg";

// Runs a .sql file against the database using SUPABASE_DB_URL — a bypass for
// when the Supabase dashboard SQL editor is unreachable. The whole file is sent
// as one batch (Postgres handles the multiple statements and $$-quoted bodies).
//
// Usage: npx tsx scripts/runSql.ts scripts/sql/003_voyage_1024.sql

const file = process.argv[2];
if (!file) {
  console.error("Usage: npx tsx scripts/runSql.ts <path-to.sql>");
  process.exit(1);
}
if (!process.env.SUPABASE_DB_URL) {
  console.error("Missing SUPABASE_DB_URL in environment (.env.local).");
  process.exit(1);
}

async function main() {
  const sql = fs.readFileSync(file, "utf8");
  const client = new Client({
    connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log(`Connected. Running ${file} ...`);
  await client.query(sql);
  console.log("Success — statements applied.");
  await client.end();
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
