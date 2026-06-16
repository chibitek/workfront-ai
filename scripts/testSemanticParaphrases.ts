import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { embedOne } from "../lib/embeddings";

// Verifies semantic retrieval: each paraphrase below deliberately AVOIDS the
// keywords in the curated entry's title, so keyword/FTS search would miss it.
// A passing run means vector similarity surfaced the right curated entry.
//
// Prereq: 001_semantic_curated.sql applied, embedCuratedKnowledge.ts run, and
// the embedding provider (see lib/embeddings.ts) reachable.

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// paraphrase -> slug we expect to surface as the top curated match
const CASES = [
  { q: "how do I let someone log their hours", expect: "add-timesheets-to-user" },
  { q: "can a PTO requester submit time", expect: "pto-requester-timesheet-access" },
  { q: "route an employee's hours to their supervisor for sign-off", expect: "assign-timesheet-approver-manager" },
];

async function main() {
  let pass = 0;
  for (const c of CASES) {
    const queryEmbedding = await embedOne(c.q);

    const { data, error } = await supabase.rpc(
      "match_knowledge_base_threads_semantic",
      { query_embedding: queryEmbedding, match_count: 3 }
    );
    if (error) {
      console.error("RPC error:", error.message);
      process.exit(1);
    }

    const top = (data ?? [])[0];
    const topSlug = top?.source_url?.split("/").pop();
    const ok = topSlug === c.expect;
    if (ok) pass++;

    console.log(`\nParaphrase: "${c.q}"`);
    console.log(`  expected slug: ${c.expect}`);
    console.log(`  top match:     ${top?.source_type} | ${top?.title?.slice(0, 60)} [score ${top?.score?.toFixed?.(3)}]`);
    console.log(`  ${ok ? "PASS" : "FAIL"}`);
  }

  console.log(`\nSemantic paraphrase check: ${pass}/${CASES.length} passed.`);
  if (pass < CASES.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
