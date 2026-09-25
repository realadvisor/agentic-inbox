ALTER TABLE classifiers ADD COLUMN decision_rules jsonb NOT NULL DEFAULT '{}';
ALTER TABLE tag_groups ADD COLUMN decision_rules jsonb NOT NULL DEFAULT '{}';
ALTER TABLE classifier_provider_run_items ADD COLUMN decision_rules jsonb NOT NULL DEFAULT '{}';
