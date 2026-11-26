CREATE OR REPLACE TRIGGER classifier_job_outbox AFTER INSERT OR DELETE OR UPDATE OF token,status,priority
 ON conversation_classifications FOR EACH ROW EXECUTE FUNCTION sync_classifier_outbox();
