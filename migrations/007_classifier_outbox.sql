-- Additive: the old Worker can finish in-flight jobs during the deployment.
ALTER TABLE conversation_classifications ADD COLUMN lease_id uuid;
CREATE UNIQUE INDEX classifier_job_token ON conversation_classifications(token);
CREATE TABLE classifier_outbox (
 job_token uuid PRIMARY KEY,
 created_at timestamptz NOT NULL DEFAULT now(),
 published_at timestamptz
);
CREATE INDEX classifier_outbox_unpublished ON classifier_outbox(created_at) WHERE published_at IS NULL;
CREATE TABLE classifier_provider_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 cooldown_until timestamptz
);
INSERT INTO classifier_provider_state(singleton) VALUES(true);
CREATE FUNCTION sync_classifier_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  DELETE FROM classifier_outbox WHERE job_token=OLD.token;
  RETURN NULL;
 END IF;
 IF TG_OP='UPDATE' AND OLD.token IS DISTINCT FROM NEW.token THEN
  DELETE FROM classifier_outbox WHERE job_token=OLD.token;
 END IF;
 IF NEW.status='pending' THEN
  INSERT INTO classifier_outbox(job_token) VALUES(NEW.token) ON CONFLICT DO NOTHING;
 ELSE
  DELETE FROM classifier_outbox WHERE job_token=NEW.token;
 END IF;
 RETURN NULL;
END; $$;
CREATE TRIGGER classifier_job_outbox AFTER INSERT OR DELETE OR UPDATE OF token,status
 ON conversation_classifications FOR EACH ROW EXECUTE FUNCTION sync_classifier_outbox();
INSERT INTO classifier_outbox(job_token) SELECT token FROM conversation_classifications WHERE status='pending';
COMMENT ON TABLE classifier_outbox IS 'Transactional dispatch intent. Queue messages contain only a stable job token. Published rows remain until the job finishes, enabling recovery after queue retention expiry.';
COMMENT ON TABLE classifier_worker_slots IS 'Legacy cron-runner slots, retained only for rollback compatibility. Cloudflare Queues now bounds consumer concurrency.';
