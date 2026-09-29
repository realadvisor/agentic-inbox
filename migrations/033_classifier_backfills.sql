ALTER TABLE conversations ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE classifier_runs ADD COLUMN request jsonb;
ALTER TABLE classifier_runs ADD COLUMN prepared boolean NOT NULL DEFAULT true;
ALTER TABLE classifier_runs ADD COLUMN batch_id uuid;
ALTER TABLE classifier_runs ADD COLUMN last_dispatch_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE classifier_runs ADD COLUMN last_progress_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE classifier_run_items ADD COLUMN enqueued boolean NOT NULL DEFAULT true;
ALTER TABLE classifier_run_items ADD COLUMN cached boolean NOT NULL DEFAULT false;
ALTER TABLE classifier_run_items ADD COLUMN skip_reason text;
ALTER TABLE conversation_classifications ADD COLUMN cache_hit boolean NOT NULL DEFAULT false;
CREATE INDEX classifier_run_waiting ON classifier_run_items(run_id,mailbox_id,thread_id) WHERE status='pending' AND NOT enqueued;
CREATE INDEX classifier_run_status ON classifier_run_items(run_id,status);
CREATE INDEX classifier_runs_recent ON classifier_runs(created_at DESC,id);
CREATE TABLE classifier_result_cache (
 key text PRIMARY KEY,
 lease uuid NOT NULL,
 lease_until timestamptz NOT NULL,
 result jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX classifier_result_cache_age ON classifier_result_cache(created_at);
-- A replaced/deleted job must never leave a historical run pending forever.
CREATE FUNCTION reconcile_classifier_run_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.run_id IS NULL THEN RETURN NULL; END IF;
 IF TG_OP='DELETE' THEN
  UPDATE classifier_run_items SET status='skipped',skip_reason='superseded' WHERE run_id=OLD.run_id AND mailbox_id=OLD.mailbox_id AND thread_id=OLD.thread_id AND status='pending';
 ELSIF OLD.token IS DISTINCT FROM NEW.token OR OLD.run_id IS DISTINCT FROM NEW.run_id THEN
  UPDATE classifier_run_items SET status='skipped',skip_reason='superseded' WHERE run_id=OLD.run_id AND mailbox_id=OLD.mailbox_id AND thread_id=OLD.thread_id AND status='pending';
 ELSIF NEW.status<>'pending' THEN
  UPDATE classifier_run_items SET status=CASE NEW.status WHEN 'error' THEN 'failed' ELSE NEW.status END,cached=NEW.cache_hit WHERE run_id=OLD.run_id AND mailbox_id=OLD.mailbox_id AND thread_id=OLD.thread_id AND status='pending';
 END IF;
 IF FOUND THEN UPDATE classifier_runs SET last_progress_at=now() WHERE id=OLD.run_id; END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER reconcile_classifier_run AFTER UPDATE OR DELETE ON conversation_classifications FOR EACH ROW EXECUTE FUNCTION reconcile_classifier_run_item();
ALTER TABLE conversation_classifications ADD COLUMN evaluation_key text;
-- Include example additions, edits and removals, without making test-only labels
-- or cosmetic tag colors invalidate an evaluation. Bump the engine marker when
-- changing the effective model/prompt contract in a future release.
CREATE FUNCTION classifier_config_key(cid uuid,m text) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT md5(jsonb_build_object('engine',1,'model','jev-latest','revision',c.revision,
 'teach',(SELECT jsonb_agg(jsonb_build_object('id',x.id,'updated_at',extract(epoch FROM x.updated_at)) ORDER BY x.updated_at DESC,x.id) FROM jev_examples x WHERE x.mailbox_id=m AND x.role='teach' AND (x.classifier_id=c.id OR x.group_id=t.group_id)),
 'legacy',CASE WHEN c.include_reviewed_examples THEN (SELECT jsonb_agg(jsonb_build_object('thread',x.thread_id,'labeled_at',extract(epoch FROM x.labeled_at)) ORDER BY x.labeled_at DESC,x.thread_id) FROM classifier_examples x WHERE x.classifier_id=c.id AND x.mailbox_id=m) ELSE NULL END)::text)
 FROM classifiers c JOIN tags t ON t.id=c.tag_id WHERE c.id=cid;
$$;
