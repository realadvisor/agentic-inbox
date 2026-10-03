CREATE INDEX CONCURRENTLY IF NOT EXISTS emails_thread_list
 ON emails(mailbox_id,thread_id,date DESC,id) INCLUDE(folder_id,delivery_status);
-- statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS classifier_reviews_mailbox
 ON conversation_classifications(mailbox_id,thread_id,classifier_id,revision) INCLUDE(priority)
 WHERE status IN ('review','error') AND (answer IS NULL OR error='group_conflict');
-- statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS conversation_tags_manual
 ON conversation_tags(mailbox_id,thread_id,tag_id) WHERE source='manual';
