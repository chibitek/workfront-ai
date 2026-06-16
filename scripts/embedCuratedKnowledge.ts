import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { Ollama } from "ollama";

// Backfills vector embeddings for the curated subset of knowledge_base_threads
// (high-signal threads + curated Q&A), via Ollama Cloud. Idempotent and
// resumable: embed_candidates() only returns rows where embedding IS NULL, so
// re-running picks up where it left off (and re-runs after adding new curated
// entries will embed just those).
//
// Prereq: Ollama Cloud embeddings access must be enabled for OLLAMA_API_KEY,
// and 001_semantic_curated.sql must have been applied with a vector dimension
// matching OLLAMA_EMBED_MODEL's output.

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

// Must output the same dimension as the vector() column in the migration.
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "embeddinggemma";
const BATCH = Number(process.env.EMBED_BATCH || 200); // rows fetched + embedded per loop
const UPDATE_CONCURRENCY = 20; // parallel row updates per batch

function embedInput(title: string | null, content: string | null) {
  // Title carries the question/topic; prepend it so it influences the vector.
  return [title, content].filter(Boolean).join("\n\n");
}

async function embedBatch(inputs: string[]): Promise<number[][]> {
  const res: any = await ollama.embed({ model: EMBED_MODEL, input: inputs });
  const vectors = res.embeddings as number[][] | undefined;
  if (!vectors || vectors.length !== inputs.length) {
    throw new Error(
      `Embedding count mismatch: sent ${inputs.length}, got ${vectors?.length ?? 0}`
    );
  }
  return vectors;
}

async function updateRows(rows: { id: string }[], vectors: number[][]) {
  let i = 0;
  let failures = 0;
  while (i < rows.length) {
    const slice = rows.slice(i, i + UPDATE_CONCURRENCY);
    const sliceVecs = vectors.slice(i, i + UPDATE_CONCURRENCY);
    const results = await Promise.all(
      slice.map((row, j) =>
        supabase
          .from("knowledge_base_threads")
          .update({ embedding: sliceVecs[j] })
          .eq("id", row.id)
      )
    );
    for (const r of results) if (r.error) failures++;
    i += UPDATE_CONCURRENCY;
  }
  return failures;
}

async function main() {
  if (!process.env.OLLAMA_API_KEY) {
    console.error("Missing OLLAMA_API_KEY.");
    process.exit(1);
  }

  console.log(`Embedding curated rows with model "${EMBED_MODEL}" (batch ${BATCH})...`);

  let totalEmbedded = 0;
  let totalFailures = 0;

  for (;;) {
    const { data: candidates, error } = await supabase.rpc("embed_candidates", {
      lim: BATCH,
    });

    if (error) {
      console.error("embed_candidates error:", error.message);
      process.exit(1);
    }
    if (!candidates || candidates.length === 0) {
      break;
    }

    const inputs = candidates.map((r: any) => embedInput(r.title, r.content));

    let vectors: number[][];
    try {
      vectors = await embedBatch(inputs);
    } catch (e: any) {
      console.error("Embedding call failed:", String(e?.message || e).slice(0, 200));
      process.exit(1);
    }

    const failures = await updateRows(candidates, vectors);
    totalFailures += failures;
    totalEmbedded += candidates.length - failures;

    console.log(
      `Embedded ${totalEmbedded} so far (${failures} update failures this batch)...`
    );

    // Safety valve: if a whole batch failed to write, the candidate set won't
    // shrink and we'd loop forever. Stop and surface it.
    if (failures === candidates.length) {
      console.error("Entire batch failed to update — stopping to avoid an infinite loop.");
      process.exit(1);
    }
  }

  console.log(`Done. Embedded ${totalEmbedded} rows. ${totalFailures} update failures total.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
