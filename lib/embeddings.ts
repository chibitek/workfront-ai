import { Ollama } from "ollama";
import OpenAI from "openai";

// Single source of truth for text embeddings, used by the chat route and the
// backfill script. Switch providers with EMBED_PROVIDER:
//   - "ollama" (default): uses OLLAMA_EMBED_MODEL on Ollama Cloud.
//   - "openai":           uses OPENAI_EMBED_MODEL, forced to OPENAI_EMBED_DIMS.
//
// Both providers are configured to output 768-dim vectors so the same
// vector(768) column / migration works for either — no schema change to switch.
// (OpenAI's text-embedding-3-small supports dimension reduction; Ollama models
// like embeddinggemma / nomic-embed-text are natively 768.)

export const EMBED_PROVIDER = (process.env.EMBED_PROVIDER || "ollama").toLowerCase();
export const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "embeddinggemma";
export const OPENAI_EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";
export const OPENAI_EMBED_DIMS = Number(process.env.OPENAI_EMBED_DIMS || 768);

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

/** Embed a batch of strings. Returns one vector per input, in order. */
export async function embed(inputs: string[]): Promise<number[][]> {
  if (inputs.length === 0) return [];

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
export async function embedOne(input: string): Promise<number[] | undefined> {
  const [vector] = await embed([input]);
  return vector;
}

/** Human-readable label for logs. */
export function embedModelLabel() {
  return EMBED_PROVIDER === "openai"
    ? `openai:${OPENAI_EMBED_MODEL}@${OPENAI_EMBED_DIMS}d`
    : `ollama:${OLLAMA_EMBED_MODEL}`;
}
