-- Adds `icon_url` to `tokens` so sync-tokens can store the token logo URL
-- returned by Blockscout's /api/v2/tokens response (`icon_url` field),
-- for the frontend to render alongside name/ticker.
alter table public.tokens
  add column if not exists icon_url text;
