CREATE INDEX CONCURRENTLY IF NOT EXISTS classifier_outbox_ready
 ON classifier_outbox(priority,created_at,job_token) WHERE published_at IS NULL;
-- statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS classifier_outbox_stale
 ON classifier_outbox(published_at,priority,created_at) WHERE published_at IS NOT NULL;
-- statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS conversation_classifications_classifier_errors
 ON conversation_classifications(classifier_id) WHERE status='error';
-- statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS classifier_runs_classifier_latest
 ON classifier_runs(classifier_id,created_at DESC);
