-- Keep agent-directed corrections distinct from human-reviewed training data.
ALTER TABLE conversation_classifications DROP CONSTRAINT conversation_classifications_source_check;
ALTER TABLE conversation_classifications ADD CONSTRAINT conversation_classifications_source_check CHECK(source IN ('jev','human','agent'));
