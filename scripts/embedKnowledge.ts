import "dotenv/config";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  const { data: rows, error } = await supabase
    .from("knowledge_base")
    .select("id, content")
    .is("embedding", null);

  if (error) throw error;

  if (!rows || rows.length === 0) {
    console.log("No rows need embeddings.");
    return;
  }

  for (const row of rows) {
    console.log("Embedding:", row.id);

    const embedding = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: row.content
    });

    const vector = embedding.data[0].embedding;

    await supabase
      .from("knowledge_base")
      .update({ embedding: vector })
      .eq("id", row.id);
  }

  console.log("Done generating embeddings.");
}

main();
