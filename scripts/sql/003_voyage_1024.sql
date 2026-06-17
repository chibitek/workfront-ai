-- 003_voyage_1024.sql
-- Switches embeddings from 768-dim (Ollama embeddinggemma) to 1024-dim (Voyage
-- voyage-3.5). Vectors from different models aren't comparable, so this clears
-- the existing column and a full re-backfill MUST follow (embedCuratedKnowledge.ts
-- with EMBED_PROVIDER=voyage).
--
-- Run in the Supabase SQL editor (after 001 and 002).

-- The semantic match function is typed to the old dimension; drop it first.
-- (typmod isn't part of the function signature, so vector matches either size.)
drop function if exists match_knowledge_base_threads_semantic(vector, int);

-- Recreate the embedding column at 1024 dims. Dropping it cascades to the HNSW
-- and queue partial indexes that reference it, so we rebuild those below.
alter table knowledge_base_threads drop column if exists embedding cascade;
alter table knowledge_base_threads add column embedding vector(1024);

-- Backfill queue index (from 002) — un-embedded curated subset only.
create index if not exists knowledge_base_threads_embed_queue_idx
  on knowledge_base_threads (id)
  where embedding is null
    and (
      source_type = 'curated_qa'
      or coalesce((metadata->>'message_count')::int, 0) >= 2
    );

-- Vector similarity index (from 001) — embedded rows only.
create index if not exists knowledge_base_threads_embedding_hnsw
  on knowledge_base_threads
  using hnsw (embedding vector_cosine_ops)
  where embedding is not null;

-- Semantic match function, now at 1024 dims.
create or replace function match_knowledge_base_threads_semantic(
  query_embedding vector(1024),
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
