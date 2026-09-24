-- Keep historical Waiting transitions, but retire Waiting as an active status.
WITH reopened AS (
 UPDATE conversations
 SET status = 'open', waiting_reason = NULL, follow_up_at = NULL,
     revision = revision + 1, updated_at = now(), updated_by = 'System'
 WHERE status = 'waiting'
 RETURNING mailbox_id, thread_id, revision
)
INSERT INTO thread_activity (id, mailbox_id, thread_id, from_status, to_status, actor, reason, revision)
SELECT gen_random_uuid(), mailbox_id, thread_id, 'waiting', 'open', 'System',
       'Waiting status removed', revision
FROM reopened;
ALTER TABLE conversations DROP CONSTRAINT conversations_status_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_status_check CHECK (status IN ('open', 'done'));
DROP INDEX conversations_follow_up;
