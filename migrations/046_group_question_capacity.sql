-- Group classifiers include every option definition. Allow the full supported
-- catalogue without changing any tags, answers, or classification jobs.
ALTER TABLE classifiers DROP CONSTRAINT classifiers_question_check;
ALTER TABLE classifiers ADD CONSTRAINT classifiers_question_check
  CHECK(length(btrim(question)) BETWEEN 1 AND 30000);
