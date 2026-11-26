ALTER TABLE classifier_outbox ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0;
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
