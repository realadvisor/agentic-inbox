CREATE INDEX CONCURRENTLY IF NOT EXISTS classifier_provider_runs_mailbox_page
 ON classifier_provider_runs(mailbox_id,started_at DESC,id DESC);
-- statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS classification_attempts_mailbox_page
 ON classification_attempts(mailbox_id,started_at DESC,id DESC);
