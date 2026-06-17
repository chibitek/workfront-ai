import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { Ollama } from "ollama";

// End-to-end smoke test for the curated knowledge entries. Mirrors the RAG
// pipeline in app/api/chat/route.ts (query simplification -> search RPC ->
// context -> Ollama), skipping only auth and DB writes, so we can confirm the
// assistant actually answers the seeded questions from curated content.

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

const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "gemma4:31b";

function simplifySearchQuery(input: string) {
  return input
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\b(for|the|do|we|when|what|is|are|to|can|just|be|or|being|sent|a|an|of|in|on|with|how)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const QUESTIONS = [
  "How do I add the ability of timesheets to a user?",
  "Does the access level PTO Requester include timesheet access?",
  "How do I add a user so they appear under a manager?",
];

async function ask(question: string) {
  const searchQuery = simplifySearchQuery(question);

  const { data: matches, error } = await supabase.rpc(
    "match_knowledge_base_threads_hybrid",
    { query_text: searchQuery, match_count: 10 }
  );
  if (error) throw new Error(error.message);

  const strong = (matches ?? []).filter(
    (m: any) => (m.score ?? m.rank ?? 0) > 0.05
  );

  const top = strong[0];
  const curatedRetrieved = top?.source_type === "curated_qa";

  const context = strong
    .map((m: any, i: number) =>
      `SOURCE ${i + 1}\nTYPE: ${m.source_type}\nTITLE: ${m.title}\nCONTENT:\n${m.content}`
    )
    .join("\n\n---\n\n");

  const systemPrompt = `You are an expert Adobe Workfront support assistant for an internal MSP team at Chibitek. Use the INTERNAL CONTEXT to answer. Give step-by-step instructions. Never cite the context or mention sources.\n\nINTERNAL CONTEXT:\n${context}`;

  const res = await ollama.chat({
    model: OLLAMA_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: question },
    ],
  });

  return { searchQuery, curatedRetrieved, topTitle: top?.title, answer: res.message.content };
}

async function main() {
  if (!process.env.OLLAMA_API_KEY) {
    console.error("Missing OLLAMA_API_KEY — cannot run the model step.");
    process.exit(1);
  }

  let pass = 0;
  for (const q of QUESTIONS) {
    console.log("\n============================================================");
    console.log("Q:", q);
    const { searchQuery, curatedRetrieved, topTitle, answer } = await ask(q);
    console.log(`Retrieved curated entry as #1: ${curatedRetrieved ? "YES" : "NO"} (top: "${topTitle}")`);
    if (curatedRetrieved) pass++;
    console.log("--- Assistant answer ---");
    console.log(answer.trim());
  }

  console.log("\n============================================================");
  console.log(`Retrieval check: ${pass}/${QUESTIONS.length} questions matched a curated entry as #1.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
