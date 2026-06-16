-- 001_semantic_curated.sql
-- Adds semantic (vector) retrieval over a CURATED subset of knowledge_base_threads.
-- Run this in the Supabase SQL editor (the service-role REST key can't run DDL).
--
-- IMPORTANT — dimensions must match the embedding model:
--   The vector(768) below assumes an Ollama embedding model that outputs 768
--   dims (e.g. embeddinggemma / nomic-embed-text). If you switch models,
--   change 768 here AND set OLLAMA_EMBED_MODEL accordingly for the scripts and
--   the chat route. The number must match exactly or inserts will error.

-- 1. pgvector (no-op if already enabled — knowledge_base.embedding implies it is).
create extension if not exists vector;

-- 2. Embedding column on the existing table. NULL = not part of the curated,
--    searchable subset. "has an embedding" is the only searchable marker, so we
--    never have to run a risky full-table UPDATE to flag rows.
alter table knowledge_base_threads
  add column if not exists embedding vector(768);

-- 3. Partial HNSW index — only embedded (curated) rows are indexed, so the index
--    stays ~tens of thousands of entries instead of 1.1M.
create index if not exists knowledge_base_threads_embedding_hnsw
  on knowledge_base_threads
  using hnsw (embedding vector_cosine_ops)
  where embedding is not null;

-- 4. Candidate selector for the backfill script. Returns high-signal threads
--    (a real back-and-forth: message_count >= 2) plus all curated Q&A that still
--    need an embedding. Numeric cast avoids the lexical-comparison bug you'd hit
--    filtering metadata->>'message_count' as text over the REST API.
--    Naturally resumable: embedded rows drop out of the result set.
create or replace function embed_candidates(lim int)
returns table (id uuid, title text, content text)
language sql
stable
as $$
  select id, title, content
  from knowledge_base_threads
  where embedding is null
    and (
      source_type = 'curated_qa'
      or coalesce((metadata->>'message_count')::int, 0) >= 2
    )
  order by created_at
  limit lim;
$$;

-- 5. Semantic match function consumed by the chat route. Same output shape the
--    route already reads (source_type/title/source_url/content/score), so the
--    context-builder needs no changes. score = cosine similarity in [0,1].
create or replace function match_knowledge_base_threads_semantic(
  query_embedding vector(768),
  match_count int default 10
)
returns table (
  id uuid,
  source_type text,
  source_url text,
  title text,
  content text,
  score float
)
language sql
stable
as $$
  select
    id,
    source_type,
    source_url,
    title,
    content,
    1 - (embedding <=> query_embedding) as score
  from knowledge_base_threads
  where embedding is not null
  order by embedding <=> query_embedding
  limit match_count;
$$;
