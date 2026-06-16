import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { Ollama } from "ollama";

// Verifies semantic retrieval: each paraphrase below deliberately AVOIDS the
// keywords in the curated entry's title, so keyword/FTS search would miss it.
// A passing run means vector similarity surfaced the right curated entry.
//
// Prereq: 001_semantic_curated.sql applied, embedCuratedKnowledge.ts run, and
// Ollama Cloud embeddings access enabled.

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const ollama = new Ollama({
  host: process.env.OLLAMA_HOST || "https://ollama.com",
  ...(process.env.OLLAMA_API_KEY
    ? { headers: { Authorization: `Bearer ${process.env.OLLAMA_API_KEY}` } }
    : {}),
});

const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "embeddinggemma";

// paraphrase -> slug we expect to surface as the top curated match
const CASES = [
  { q: "how do I let someone log their hours", expect: "add-timesheets-to-user" },
  { q: "can a PTO requester submit time", expect: "pto-requester-timesheet-access" },
  { q: "route an employee's hours to their supervisor for sign-off", expect: "assign-timesheet-approver-manager" },
];

async function main() {
  if (!process.env.OLLAMA_API_KEY) {
    console.error("Missing OLLAMA_API_KEY.");
    process.exit(1);
  }

  let pass = 0;
  for (const c of CASES) {
    const emb: any = await ollama.embed({ model: EMBED_MODEL, input: c.q });
    const queryEmbedding = emb?.embeddings?.[0];

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
