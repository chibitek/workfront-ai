-- 002_embed_candidates_index.sql
-- Fixes statement timeouts during backfill. The original embed_candidates()
-- ordered by created_at and filtered message_count with no supporting index, so
-- each call scanned all ~1.1M rows. This adds a partial index containing ONLY
-- the un-embedded curated subset (~38k rows), and reorders the function by the
-- primary key so the scan is pure index order with no sort.
--
-- Run this in the Supabase SQL editor (after 001_semantic_curated.sql).

-- Partial index = exactly the rows still needing an embedding. Rows drop out of
-- the index automatically as they get embedded, so the backfill walks a
-- shrinking set and re-runs are instant.
create index if not exists knowledge_base_threads_embed_queue_idx
  on knowledge_base_threads (id)
  where embedding is null
    and (
      source_type = 'curated_qa'
      or coalesce((metadata->>'message_count')::int, 0) >= 2
    );

-- Same selector, ordered by id so it reads straight off the partial index
-- (no created_at sort) and stops after `lim` rows.
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
  order by id
  limit lim;
$$;
