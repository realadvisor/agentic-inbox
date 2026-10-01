CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
-- statement-breakpoint
-- Preserve literal case-insensitive substring search, including sender/subject operators.
CREATE INDEX CONCURRENTLY IF NOT EXISTS emails_substring_search ON emails USING gin
 (subject public.gin_trgm_ops, sender public.gin_trgm_ops,
  recipient public.gin_trgm_ops, body public.gin_trgm_ops);
-- statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS emails_mailbox_date ON emails(mailbox_id,date DESC,id);
