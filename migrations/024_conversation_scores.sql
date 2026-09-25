ALTER TABLE conversation_classifications ADD COLUMN score double precision CHECK (score >= 0 AND score <= 9);
ALTER TABLE conversation_classifications ADD COLUMN confidence double precision CHECK (confidence >= 0 AND confidence <= 1);
