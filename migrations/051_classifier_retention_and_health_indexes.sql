CREATE INDEX CONCURRENTLY IF NOT EXISTS classification_attempts_active
 ON classification_attempts(started_at,id) WHERE status IN ('queued','running');
-- statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS classifier_provider_run_items_pending
 ON classifier_provider_run_items(run_id) WHERE disposition='pending';
-- statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS classifier_provider_runs_running
 ON classifier_provider_runs(started_at) WHERE status='running';
-- statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS classifier_outbox_live_age
 ON classifier_outbox(created_at) WHERE priority=0;
