ALTER TABLE classifier_outbox ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0;
UPDATE classifier_outbox o
SET priority = j.priority
FROM classifier_run_items i
JOIN classifier_runs r ON r.id = i.run_id
JOIN conversation_classifications j
  ON j.mailbox_id = i.mailbox_id AND j.thread_id = i.thread_id AND j.classifier_id = r.classifier_id
WHERE r.status = 'running' AND i.status = 'pending' AND i.enqueued
  AND j.token = o.job_token AND o.priority IS DISTINCT FROM j.priority;
CREATE OR REPLACE FUNCTION sync_classifier_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  DELETE FROM classifier_outbox WHERE job_token=OLD.token;
  RETURN NULL;
 END IF;
 IF TG_OP='UPDATE' AND OLD.token IS DISTINCT FROM NEW.token THEN
  DELETE FROM classifier_outbox WHERE job_token=OLD.token;
 END IF;
 IF NEW.status='pending' THEN
  INSERT INTO classifier_outbox(job_token,priority) VALUES(NEW.token,NEW.priority)
  ON CONFLICT (job_token) DO UPDATE SET priority=EXCLUDED.priority;
 ELSE
  DELETE FROM classifier_outbox WHERE job_token=NEW.token;
 END IF;
 RETURN NULL;
END; $$;
DROP TRIGGER IF EXISTS classifier_job_outbox ON conversation_classifications;
CREATE TRIGGER classifier_job_outbox AFTER INSERT OR DELETE OR UPDATE OF token,status,priority
 ON conversation_classifications FOR EACH ROW EXECUTE FUNCTION sync_classifier_outbox();
