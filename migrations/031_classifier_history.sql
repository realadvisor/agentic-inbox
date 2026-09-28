-- A lifecycle record is handed off to the detailed provider item when sent.
-- Keep its ID so a link opened while queued still resolves after dispatch.
ALTER TABLE classifier_provider_run_items ADD COLUMN lifecycle_id uuid;
CREATE INDEX classifier_provider_items_lifecycle ON classifier_provider_run_items(lifecycle_id) WHERE lifecycle_id IS NOT NULL;
CREATE INDEX classifier_provider_runs_mailbox_page ON classifier_provider_runs(mailbox_id,started_at DESC,id DESC);
CREATE INDEX classification_attempts_mailbox_page ON classification_attempts(mailbox_id,started_at DESC,id DESC);

CREATE FUNCTION handoff_classification_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- Serialize with job updates, whose AFTER trigger writes the lifecycle row.
 PERFORM 1 FROM conversation_classifications WHERE token=NEW.job_token FOR UPDATE;
 DELETE FROM classification_attempts WHERE job_token=NEW.job_token AND attempt=NEW.attempt RETURNING id INTO NEW.lifecycle_id;
 RETURN NEW;
END; $$;
CREATE TRIGGER provider_item_handoff BEFORE INSERT ON classifier_provider_run_items
 FOR EACH ROW EXECUTE FUNCTION handoff_classification_attempt();

CREATE OR REPLACE FUNCTION record_classification_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND OLD.token IS DISTINCT FROM NEW.token) THEN
  UPDATE classification_attempts SET status='skipped',finished_at=clock_timestamp(),error=coalesce(error,'job_superseded')
   WHERE job_token=OLD.token AND status IN ('queued','running');
 END IF;
 IF TG_OP='DELETE' THEN RETURN NULL; END IF;
 -- Configuration saves can rotate a completed job token without running Jev.
 -- They must not create a new synthetic attempt for the unchanged result.
 IF TG_OP='UPDATE' AND NEW.status<>'pending' AND NEW.status=OLD.status
  AND ROW(NEW.attempts,NEW.answer,NEW.probability,NEW.error,NEW.source,NEW.actor,NEW.model,NEW.generation)
   IS NOT DISTINCT FROM ROW(OLD.attempts,OLD.answer,OLD.probability,OLD.error,OLD.source,OLD.actor,OLD.model,OLD.generation) THEN RETURN NULL; END IF;
 -- Unrelated/no-op writes must not recreate expired history.
 IF TG_OP='UPDATE' AND ROW(NEW.token,NEW.attempts,NEW.status,NEW.answer,NEW.probability,NEW.error,NEW.lease_until)
  IS NOT DISTINCT FROM ROW(OLD.token,OLD.attempts,OLD.status,OLD.answer,OLD.probability,OLD.error,OLD.lease_until) THEN RETURN NULL; END IF;
 -- The provider item now owns the attempt and its application outcome.
 IF EXISTS(SELECT 1 FROM classifier_provider_run_items WHERE job_token=NEW.token AND attempt=greatest(1,NEW.attempts)) THEN RETURN NULL; END IF;
 INSERT INTO classification_attempts(job_token,attempt,mailbox_id,thread_id,classifier_id,classifier_name,question,subject,revision,generation,started_at,finished_at,status,answer,probability,error)
 SELECT NEW.token,greatest(1,NEW.attempts),NEW.mailbox_id,NEW.thread_id,NEW.classifier_id,t.name,c.question,
 coalesce((SELECT subject FROM emails WHERE mailbox_id=NEW.mailbox_id AND thread_id=NEW.thread_id ORDER BY date DESC,id DESC LIMIT 1),'Conversation'),
 NEW.revision,NEW.generation,clock_timestamp(),CASE WHEN NEW.status<>'pending' OR (NEW.error IS NOT NULL AND NEW.lease_until IS NULL) THEN clock_timestamp() END,
 CASE WHEN NEW.status='pending' THEN CASE WHEN NEW.lease_until>now() THEN 'running' WHEN NEW.error IS NOT NULL THEN 'failed' ELSE 'queued' END
 WHEN NEW.status='complete' THEN 'succeeded' WHEN NEW.status='error' THEN 'failed'
 WHEN NEW.status='review' AND NEW.error IS NOT NULL THEN 'blocked' ELSE NEW.status END,
 NEW.answer,NEW.probability,NEW.error FROM classifiers c JOIN tags t ON t.id=c.tag_id WHERE c.id=NEW.classifier_id
 ON CONFLICT(job_token,attempt) DO UPDATE SET finished_at=excluded.finished_at,status=excluded.status,answer=excluded.answer,probability=excluded.probability,error=excluded.error;
 RETURN NULL;
END; $$;
DROP TRIGGER classification_attempt_changed ON conversation_classifications;
CREATE TRIGGER classification_attempt_changed AFTER INSERT OR UPDATE OR DELETE ON conversation_classifications
 FOR EACH ROW EXECUTE FUNCTION record_classification_attempt();
