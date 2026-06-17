import { Ollama } from "ollama";
import OpenAI from "openai";

// Single source of truth for text embeddings, used by the chat route and the
// backfill script. Switch providers with EMBED_PROVIDER:
//   - "ollama" (default): OLLAMA_EMBED_MODEL, 768-dim (e.g. embeddinggemma).
//   - "openai":           OPENAI_EMBED_MODEL, forced to OPENAI_EMBED_DIMS (768).
//   - "voyage":           VOYAGE_EMBED_MODEL at VOYAGE_OUTPUT_DIM (1024 default).
//
// The vector() dimension in the DB must match the active provider's output:
//   ollama/openai -> 768  (001_semantic_curated.sql)
//   voyage        -> 1024 (003_voyage_1024.sql)
// Switching providers across a dimension boundary requires that migration plus
// a full re-backfill (vectors from different models aren't comparable).

export const EMBED_PROVIDER = (process.env.EMBED_PROVIDER || "ollama").toLowerCase();
export const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "embeddinggemma";
export const OPENAI_EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";
export const OPENAI_EMBED_DIMS = Number(process.env.OPENAI_EMBED_DIMS || 768);
export const VOYAGE_EMBED_MODEL = process.env.VOYAGE_EMBED_MODEL || "voyage-3.5";
export const VOYAGE_OUTPUT_DIM = Number(process.env.VOYAGE_OUTPUT_DIM || 1024);

// "document" when embedding stored knowledge, "query" when embedding a user
// question. Voyage uses this to specialize retrieval (asymmetric search); other
// providers ignore it.
export type InputType = "document" | "query";

let ollamaClient: Ollama | null = null;
let openaiClient: OpenAI | null = null;

function getOllama() {
  if (!ollamaClient) {
    // Embeddings can run on a different host than chat — e.g. local Ollama
    // (embeddinggemma) for dev/backfill while chat stays on Ollama Cloud
    // (gemma4:31b). Falls back to OLLAMA_HOST, then Cloud.
    const host =
      process.env.OLLAMA_EMBED_HOST || process.env.OLLAMA_HOST || "https://ollama.com";
    ollamaClient = new Ollama({
      host,
      ...(process.env.OLLAMA_API_KEY
        ? { headers: { Authorization: `Bearer ${process.env.OLLAMA_API_KEY}` } }
        : {}),
    });
  }
  return ollamaClient;
}

function getOpenAI() {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

async function embedVoyage(inputs: string[], inputType: InputType): Promise<number[][]> {
  // Retry on rate limits (429) and transient 5xx with simple backoff — Voyage's
  // free tier in particular throttles aggressively during the backfill.
  const maxAttempts = 6;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: inputs,
        model: VOYAGE_EMBED_MODEL,
        input_type: inputType,
        output_dimension: VOYAGE_OUTPUT_DIM,
      }),
    });

    if (res.ok) {
      const json: any = await res.json();
      // Voyage returns data sorted by index, but sort defensively.
      return (json.data as any[])
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding as number[]);
    }

    const retryable = res.status === 429 || res.status >= 500;
    const detail = await res.text().catch(() => "");
    if (!retryable || attempt >= maxAttempts) {
      throw new Error(`Voyage embeddings ${res.status}: ${detail.slice(0, 200)}`);
    }
    const waitMs = 1000 * 2 ** (attempt - 1); // 1s, 2s, 4s, 8s, 16s
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

/** Embed a batch of strings. Returns one vector per input, in order. */
export async function embed(
  inputs: string[],
  inputType: InputType = "document"
): Promise<number[][]> {
  if (inputs.length === 0) return [];

  if (EMBED_PROVIDER === "voyage") {
    return embedVoyage(inputs, inputType);
  }

  if (EMBED_PROVIDER === "openai") {
    const res = await getOpenAI().embeddings.create({
      model: OPENAI_EMBED_MODEL,
      input: inputs,
      dimensions: OPENAI_EMBED_DIMS,
    });
    return res.data.map((d) => d.embedding as number[]);
  }

  // default: ollama
  const res: any = await getOllama().embed({
    model: OLLAMA_EMBED_MODEL,
    input: inputs,
  });
  return res.embeddings as number[][];
}

/** Embed a single string. Returns undefined if nothing came back. */
export async function embedOne(
  input: string,
  inputType: InputType = "query"
): Promise<number[] | undefined> {
  const [vector] = await embed([input], inputType);
  return vector;
}

/** Human-readable label for logs. */
export function embedModelLabel() {
  if (EMBED_PROVIDER === "voyage") return `voyage:${VOYAGE_EMBED_MODEL}@${VOYAGE_OUTPUT_DIM}d`;
  if (EMBED_PROVIDER === "openai") return `openai:${OPENAI_EMBED_MODEL}@${OPENAI_EMBED_DIMS}d`;
  return `ollama:${OLLAMA_EMBED_MODEL}`;
}
