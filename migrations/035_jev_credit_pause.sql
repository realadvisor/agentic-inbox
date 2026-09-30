ALTER TABLE classifier_provider_state
 ADD COLUMN paused_at timestamptz,
 ADD COLUMN pause_version bigint NOT NULL DEFAULT 0,
 ADD COLUMN resume_token uuid,
 ADD COLUMN resume_until timestamptz,
 ADD COLUMN resume_error text;
ALTER TABLE conversation_classifications ADD COLUMN credit_pauses integer NOT NULL DEFAULT 0;
-- Attempt numbers remain monotonic for request history; credit pauses do not
-- spend the processing retry budget. A replacement job starts a fresh budget.
CREATE FUNCTION reset_classifier_credit_pauses() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.token IS DISTINCT FROM OLD.token THEN NEW.credit_pauses:=0; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reset_classifier_credit_pauses BEFORE UPDATE ON conversation_classifications
 FOR EACH ROW EXECUTE FUNCTION reset_classifier_credit_pauses();
