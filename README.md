# RealAdvisor inbox

A Postgres-backed fork of [Cloudflare Agentic Inbox](https://github.com/cloudflare/agentic-inbox), based on commit `48039bb6785af34e592c2966f87cde2b255c4c80`.
The upstream React inbox UI and shared helpers retain their Apache-2.0 copyright notices and [license](./LICENSE). The backend, migrations, fixtures, and local runners are new.

This is an intentionally standalone pnpm workspace with its own lockfile: the upstream React 19 application does not inherit the monorepo's React 18 overrides. This repository is the RealAdvisor fork of Cloudflare Agentic Inbox. Clone it beside the RealAdvisor monorepo and run all commands from this repository. It has its own commits, pull requests, dependencies, and manual deployment.

## Scope

- Postgres stores mailboxes, messages, folder state, drafts, thread identifiers and attachment metadata.
- Privacy and Info are separate logical mailboxes in one database. Live mailboxes use `ingest.realadvisor.com`; local seed mailboxes remain synthetic.
- The UI supports browsing, search operators, reading, starring, folders, composing, drafts, replies and manual conversation tags.
- Local **Simulate send** stores a simulated message. Hosted live mode sends through Cloudflare Email Sending using approved public From addresses. The app contains no SMTP or Google credentials.
- Attachment bytes live outside Postgres: `.local/attachments` locally and a private R2 bucket on Cloudflare. Live raw MIME is retained privately in R2.
- Probo, historical imports, and the upstream MCP server are not connected. The hosted inbox uses Cloudflare Workers, Hyperdrive, Neon Postgres, and private R2 attachments.

## Composer AI assistance

The composer offers Quick Draft, an Advanced prompt/model dialog, and Improve / Shorten / Formal actions through
Vercel AI SDK `generateText`. It reuses the agent's model catalog, mailbox model
and writing instructions, and server-side provider credentials. The model picker
can override the model for the current composer without changing mailbox settings.
Composer model choices use Vercel AI Gateway when configured via `AI_GATEWAY_API_KEY`, including in the Worker. The agent retains its existing provider setup.
Generation returns an editable suggestion without saving or sending an email.
Existing text, including edits made during generation, is retained until the user
chooses Use suggestion. Draft saving and sending remain manual.

## Conversation status

Conversations have an Open or Done status, independent of tags and classification.
Inbox defaults to Open; Open, Done, and All filters work alongside tag filters
and Needs review. The conversation panel offers Mark done and Reopen, with the
latest 50 status transitions behind the information icon next to the status.

Migration 018 adds workflow state; migration 019 moves previous Waiting
conversations to Open, preserving their history. Waiting and scheduled reopening
are disabled. New received messages reopen Done conversations; duplicate ingestion,
drafts, and outgoing messages do not. Status writes require the current revision
and record the authenticated actor in live mode. Stale actions are rejected.
Classification and email-agent execution remain independent of completion.

Run `pnpm db:migrate` before deploying this version. No live data is changed by
building or testing. For a separate built local preview, use
`PORT=4392 PUBLIC_ORIGIN=http://127.0.0.1:4392 pnpm start`.

## Run locally

Requires Node 22, pnpm 10, and either Docker or native PostgreSQL 17 (`pg_config` on PATH, or `PG_BIN` set to its binary directory).

```sh
cd agentic-inbox
pnpm install --frozen-lockfile
pnpm setup:local

# Choose one database runner:
docker compose up -d --wait
# Or, without Docker:
pnpm db:local

pnpm db:migrate
pnpm db:seed
pnpm dev
```

Open <http://127.0.0.1:4310>. The API listens on port 4311, and Postgres on port 55439. Both app servers and the database bind only to loopback.

`setup:local` generates credentials in gitignored `.env` and preserves an existing file. The native runner creates its own cluster under `.local/postgres`, separate from any CRM database. The Docker runner uses its own named volume. Do not run both database runners simultaneously.

Migrations are transactional and versioned. Seeding is repeatable: it inserts missing fixture messages without resetting existing messages, read flags or replies. The seed includes deletion/access requests, an ordinary enquiry, an existing reply thread, a spam example and a downloadable text attachment.

Stop the app with Ctrl-C. Stop the native database with `pnpm db:stop`, or the Docker database with `docker compose stop`. Neither removes stored data.

## Connect directly to Postgres

Use the `DATABASE_URL` from `.env` in your SQL client or another local service:

| Field    | Value                                   |
| -------- | --------------------------------------- |
| Host     | `127.0.0.1`                             |
| Port     | `55439`                                 |
| Database | `agentic_inbox_prototype`               |
| User     | `inbox`                                 |
| Password | Generated `POSTGRES_PASSWORD` in `.env` |
| TLS      | Off for this loopback-only prototype    |

```sql
SELECT mailbox_id, subject, sender, date, folder_id, delivery_status
FROM emails
ORDER BY date DESC;

SELECT id, thread_id, in_reply_to, body
FROM emails
WHERE mailbox_id = 'privacy@realadvisor.com'
ORDER BY date;
```

The UI reads this same database; there is no SQLite or Durable Object mailbox store. The backend uses parameterized Postgres.js queries. All message queries are mailbox-scoped; composite foreign keys prevent cross-mailbox folder and attachment associations. This is structural isolation, not user-level authorization: the local prototype user can access both inboxes.

## Verification

```sh
pnpm check
pnpm test
pnpm build
# Requires Google Chrome; starts the dev app if it isn't already running:
pnpm test:browser
```

Integration tests create and drop a uniquely named schema in the prototype database. They cover concurrent duplicate ingestion, mailbox isolation, attachment access, persisted replies, draft updates, search, folder protection and input/origin validation. The browser test creates and removes its own synthetic mailbox and exercises search → read → save draft twice → reopen → simulate reply. It leaves `.local/inbox-preview.png` for visual inspection.

To serve the built SPA through the API server, stop `pnpm dev` and run `pnpm start`; open <http://127.0.0.1:4311>.

## Cloudflare deployment

The hosted inbox runs on Cloudflare Workers with Neon Postgres through Hyperdrive and private R2 storage. All HTTP routes, including static assets, validate Cloudflare Access JWTs in live mode. Configure permitted people in the editable **Inbox team** Access policy; all permitted people share registered mailboxes.

Deployment remains manual from this fork: `pnpm install --frozen-lockfile`, then `pnpm run deploy`. Run database migrations separately first with `pnpm exec tsx --env-file=.env.cloud scripts/migrate.ts`. Credentials belong in ignored `.env.cloud` (permissions 0600), never in git. Local `.env` stays pointed at the local database. `pnpm deploy:check` builds and bundles without publishing.

The existing Neon project is `email-inbox` (`jolly-rain-30890362`) in the RealAdvisor organization, Frankfurt (`aws-eu-central-1`). Hyperdrive query caching is disabled. The Worker and private R2 bucket retain the infrastructure name `realadvisor-email-inbox-prototype` to preserve the existing resources and data. The public hostname is `inbox.realadvisor.com`; workers.dev and preview URLs are disabled.

Hosted URL: <https://inbox.realadvisor.com>.

## Upstream updates

The `upstream` remote is `https://github.com/cloudflare/agentic-inbox.git`; `origin` is `https://github.com/realadvisor/agentic-inbox.git`. Our port starts from the upstream commit named above. Fetch upstream and review changes on a dedicated update branch before merging them into the Postgres port. Backend and AI/MCP changes can require manual adaptation; syncing upstream is not an automatic database upgrade.

## Real-mail configuration

The Worker supports `MAIL_MODE=live`. Live HTTP routes require a signed Cloudflare Access application JWT, verified against `ACCESS_ISSUER` and `ACCESS_AUDIENCE`; the prototype password is not accepted in this mode. Manage people in Cloudflare One → Access controls → Applications → RealAdvisor Inbox → Policies. The application does not embed a user allowlist.

Receiving and sending identities are separate:

| Receive address                | Outbound From / Reply-To |
| ------------------------------ | ------------------------ |
| privacy@ingest.realadvisor.com | privacy@realadvisor.com  |
| info@ingest.realadvisor.com    | info@realadvisor.com     |

For a fresh deployment:

1. Create a self-hosted Access application covering the entire app hostname and configure the approved users. Set `ACCESS_ISSUER=https://realadvisor.cloudflareaccess.com` and the application's audience in Wrangler. Verify all public app hostnames are protected; disable unused workers.dev/preview URLs if deploying on a custom hostname.
2. Run the migrations with `.env.cloud`, then `pnpm exec tsx --env-file=.env.cloud scripts/setup-mailboxes.ts`. This adds separate live mailboxes without deleting synthetic data. Live mode hides the synthetic mailboxes.
3. Onboard **only `ingest.realadvisor.com`** for Email Routing and route unmatched mail to this Worker through the zone catch-all; the Worker accepts only registered ingest addresses. Preserve the apex domain's Google Workspace MX records. Unknown mailbox addresses are rejected by the handler.
4. Onboard `realadvisor.com` for Cloudflare Email Sending and verify the required authentication DNS records. Preserve existing SPF/DMARC and other providers' DKIM records. Add a `send_email` binding named `EMAIL`, using the verified sending domain. The server derives the sender exclusively from registered ingest mailboxes. Sending domain approval is separate from receiving MX configuration.
5. Set `MAIL_MODE=live` and `INBOUND_ENABLED=true` only after Access, database migrations, and email bindings are configured. Deploy manually and verify login, a controlled inbound message, its attachment, and a reply with the expected From/Reply-To and authentication headers. Do not seed synthetic messages into live mailboxes.
6. To receive copies of group mail later, add each ingest address as a member of its corresponding Google Group with each-email delivery. Replies to the public address continue through the Group.

Inbound MIME is limited to 10 MiB and stored privately in R2 before parsing. Postgres stores mailbox-scoped messages, threading, attachment metadata, and the raw object key. Duplicate Message-IDs are ignored within a mailbox. Failed processing leaves raw MIME for recovery; automated replay and object-retention cleanup are not implemented yet.

Outbound requests require an idempotency key and persist the authenticated actor and send state. Provider acceptance is recorded as `sent`, not proof of final recipient delivery. An ambiguous provider error is recorded as `unknown` and is not automatically retried. Check provider logs before resending. Delivery/bounce webhook reconciliation and outbound attachment uploads remain follow-up work. A live test must be completed before treating this rollout as operational.

Sent messages retain their outbound audit/idempotency record and can be moved to Trash but not permanently deleted through the API. Object retention cleanup, mailbox-level permissions, classification and Probo integration are not implemented.

## API reference

[Scalar API documentation](https://inbox.realadvisor.com/api/docs) and the [OpenAPI document](https://inbox.realadvisor.com/api/openapi.json) are protected by the same Cloudflare Access login as the inbox. The versioned contract is [`openapi.json`](./openapi.json); update it alongside API changes. Scalar assets are bundled from the locked npm package and served locally, without a CDN or request proxy.

Run `pnpm dev` and open <http://127.0.0.1:4311/api/docs> for synthetic local requests. Hosted interactive requests use your browser session and affect real mail. Send/reply retries must retain the same UUID `Idempotency-Key` and identical request body; do not blindly retry an ambiguous send.

**n8n status:** service identities and mailbox/action permissions are not implemented. A Cloudflare service token alone is insufficient with the current human-identity validator. Do not export browser cookies into workflows. Future automation should use dedicated expiring service credentials stored in n8n's credential manager, with permissions enforced by the API.

## Creating live mailboxes

Administrators see **New Mailbox** on the homepage. `MAILBOX_ADMINS` is a comma-separated list of verified Access email identities (initially Jonas). `MAILBOX_CREATION_ENABLED=true` and `INBOUND_ENABLED=true` enable creation. The API checks the same permissions; hiding the button is not the security boundary. Creation records `created_by` and `created_at`, and commits the mailbox and its folders in one transaction. Duplicate addresses return 409. Live deletion remains disabled.

Mailboxes use `name@ingest.realadvisor.com` and send as `name@realadvisor.com`. The zone catch-all sends otherwise unmatched mail to the inbox Worker; only registered ingest recipients are accepted, before writing MIME to R2. Existing explicit Privacy/Info routes still work. The apex Google MX stays unchanged. The Send Email binding permits the verified domain; the backend authorizes the specific sender by its Postgres mailbox registration. No Cloudflare administrative API credential is stored in the application.

Creating an ingest mailbox does not create a Google Group or Workspace address. Configure the corresponding public address and forwarding separately if replies to `name@realadvisor.com` should return to this inbox. All Access-authorized users can read and send from registered mailboxes; creation is administrator-only.

## Conversation tags

Create, rename, recolor and delete shared tags in **Settings → Tags**. Inbox rows show colored chips; **Tag filter** narrows the current folder. The **Tags** section below Folders in the sidebar opens tagged conversations across all folders in the current mailbox, including Archive. Tag filters are included in the URL for bookmarking and reloads. Open a conversation to use **+ Tag** or remove a chip. Select rows (or the current page) for bulk add/remove. Selections reset when changing mailbox, folder, filter or page. Deleting a shared tag requires confirmation and removes its assignments everywhere; removing a conversation chip keeps the tag catalog entry.

Tags use stable UUIDs and case-insensitively unique names. Assignments are keyed by `(mailbox_id, thread_id, tag_id)`, independently of folders and individual messages. Replies, incoming messages and archiving retain a conversation's tags. Database triggers register conversations for every ingestion/send path, including existing messages backfilled by migration 005. Conversation identity persists even if its last message is deleted; assignment endpoints require an existing message in that mailbox.

The authenticated Access email is recorded as the manual actor (local mode uses `local-synthetic-user`). Each assignment stores source, creation/update times and a nullable `removed_at`. Removing a chip writes a manual removal record, including when the chip is already absent. These rows are the latest explicit decisions, not a full event history: future classifiers must respect **all** manual rows, including removals. New messages never clear manual choices. No classifier, model calls or background classification are implemented by tags.

Scalar documents tag CRUD, individual thread assignment/removal, atomic bulk changes (up to 100 thread IDs), and `tag_id` filtering on email/search endpoints. Filtering happens before conversation grouping, counting and pagination. All authenticated inbox users share the tag catalog; assignment routes enforce the existing registered-mailbox rules. Migration 005 is independent of migration 004 reserved by classifier PR #4. The versioned runner checks each migration individually, 004 belongs to the superseded hardcoded reply-classifier proposal and must not be merged over the configurable classifier implementation.

## Local classifier preview

Run `pnpm build` then `pnpm preview:classifiers` with the normal local `.env`. Open http://127.0.0.1:4313/mailbox/privacy@example.test/settings?tab=classifiers. The server refuses remote database hosts and creates an isolated `classifier_preview` schema in local Postgres. Settings, tag choices, runs and corrections persist there; the normal database schema is not modified.

This is a UI/workflow preview, not the production Jev classifier. It seeds three presets and 18 synthetic conversations across Privacy, Info and Bot. Run on existing uses fixed fixture answers for unedited presets, one conversation per second. New or edited questions go to Needs review. Runs support mailbox scope, unprocessed/all selection, preserving/resetting classifier corrections, progress and cancellation. Existing manual tag decisions always win. No provider requests or real email sending occur. Automatic processing of newly received messages, production conversation-version checks and live Jev evaluation are not implemented by this fixture driver.

The preview APIs mount only in the local Node entrypoint with `CLASSIFIER_PREVIEW=1`; the Cloudflare Worker does not mount them. No production migration or deployment is needed.

## Live Jev classifiers

Settings → Tags configures Jev instructions within each tag or group editor. Migration 006 seeds Needs reply, Privacy: Deletion and Privacy: Data access, all **inactive**. Only `MAILBOX_ADMINS` can create/edit/enable classifiers or run/cancel batches. All authenticated inbox users can review uncertain results. Activating a classifier applies to new mail and confirmed sent replies; it never starts a historical scan. **Apply to existing conversations** explicitly queues active conversations (up to 5,000 per batch), with scope, unprocessed/all and optional reset of classifier corrections. Spam/trash/archive-only conversations are excluded.

Cloudflare Queues delivers classifier work. New mail and confirmed sent replies use `inbox-classifications`; explicit historical runs use `inbox-classifier-backfills`. Each queue permits one concurrent consumer with batch size one, so backfills cannot occupy the new-mail consumer and at most two Jev requests run concurrently. Queue messages contain only `{version: 1, token: "uuid"}`, never email bodies or addresses. Neon remains the source of truth for configuration, results, corrections and run progress.

Migration 007 adds a transactional `classifier_outbox`: changes to pending job versions record dispatch intent in the same database transaction. Ingestion and successful API mutations publish promptly after commit; consumers continue draining large unpublished batches. The published marker is committed only after broker acceptance, so an ambiguous publish may duplicate a message but cannot silently lose work. Stable version tokens and short per-job leases make retries/duplicate deliveries safe. Completion and tag changes are atomic. New mail, configuration edits, cancellation and human review invalidate stale messages.

Cloudflare performs delivery and three retries (up to four deliveries), respecting provider backoff and a shared 429 cooldown. Exhausted deliveries go to `inbox-classifications-dead`; its consumer records failures in Neon for review or **Run on existing → Not yet processed**. The dead-letter consumer retries database outages. All three queues retain messages for 24 hours; outbox intent survives broker expiry and can republish still-pending jobs after 25 hours. A recovery cron checks unpublished/expired delivery intent every 15 minutes, so idle Neon can suspend between checks. The cron does not run Jev. A disabled feature parks deliveries in the outbox without burning retries. Existing manual choices and cancellation behavior are unchanged.

Jev receives chronological received/confirmed-sent conversation text and metadata via `POST https://api.typesafe.ai/v1/systemone`, model `jev-latest`, question type `noul`. Responses ≥0.85 apply the tag; ≤0.15 remove the automatic tag; intermediate results need human review. Full attachments/raw MIME are not submitted. Classification budgets apply after HTML-to-text conversion, including every message. A conservative UTF-8 ceiling leaves headroom under Jev’s 32k per-question and 64k per-request token limits; it is not an exact token count. Optional examples are dropped before rejecting a request. Token-limit responses split distinct questions and, if necessary, remove examples once; conversation content is never truncated. Conversations exceeding the 1,000-message/10-million-raw-character resource guard or the prepared request budget require review. Provider failures never become a confident No. New messages, configuration revisions, human corrections and cancellation invalidate in-flight result tokens. Manual tag additions/removals always win. Editing or disabling clears only classifier-owned tags. This labels conversations; it never sends replies or performs deletion.

First provision the queues in the existing Cloudflare account (skip creation if they already exist):

```sh
pnpm exec wrangler queues create inbox-classifications --message-retention-period-secs 86400
pnpm exec wrangler queues create inbox-classifier-backfills --message-retention-period-secs 86400
pnpm exec wrangler queues create inbox-classifications-dead --message-retention-period-secs 86400
```

Queue retention is set during provisioning; when adopting existing queues, use `wrangler queues update <name> --message-retention-period-secs 86400`. Producer bindings, consumers, retry limits and the recovery cron are versioned in `wrangler.jsonc`.

Release: run migrations against Neon, set Worker secret `TYPESAFE_API_KEY` with `pnpm exec wrangler secret put TYPESAFE_API_KEY`, retain `CLASSIFIERS_ENABLED=true` and the cron in `wrangler.jsonc`, then deploy. The key is server-only and never stored in Postgres, browser code or the repository. Existing configured secrets survive a deploy. Set `CLASSIFIERS_ENABLED=false` to pause processing and hide the UI without discarding queued work. Migration 007 is additive and seeds dispatch intent for existing pending work. Legacy worker-slot rows remain only for rollout compatibility. A rollback must also detach the Queue consumers before restoring the old cron-only Worker; do not leave consumers pointed at code without a queue handler. Database rows and outbox intent remain available for recovery. Scalar documents `/api/v1/classification/*`.

Classifier editors offer **Use recent human examples** (off by default). When enabled, Jev receives up to three yes and three no examples from the same mailbox and question, labeled within the last 30 days. New manual tag additions/removals and classifier reviews capture frozen conversation snapshots; automatic predictions and unlabeled conversations are never examples. Existing labels are not backfilled because their historical message state is unknown. Examples omit drafts and unsent messages, exclude the current conversation, and are size-limited. Editing the question or tag clears its examples. Turning the setting on affects future processing; use Run on existing to reevaluate completed conversations. This supplies request context, not model training.

Ready classifier questions for the same conversation are grouped into one Jev request without a classifier-count cap. Each question retains its own examples, probability, manual overrides and retry token. Different conversation snapshots and requests exceeding the batching payload budget are sent separately. A delivery time budget keeps split requests within job leases; deferred jobs retry through their existing broker deliveries. Historical processing uses up to five concurrent consumers; new-mail processing keeps one dedicated consumer; later broker deliveries for already completed sibling jobs are acknowledged without another provider call.

## Classifier request logs

Inbox administrators can open **Settings → Runs** or use the **Classification** button on a conversation to open its latest run directly in a side drawer. Earlier runs are available from the run history selector without leaving the email. Each entry is one actual Jev request, including batched questions and retries. The drawer contains per-question probabilities and application outcomes, the request JSON, and the raw response (including malformed/non-JSON errors). Reading logs does not run classifiers. Logs start at migration `010_classifier_provider_runs.sql`; older raw payloads cannot be reconstructed.

The provider-call tables are separate from backfill `classifier_runs`. Requests snapshot questions, revisions, conversation content and any reviewed examples. Authorization headers are never stored. Both list and detail APIs require classifier-management permissions and return `Cache-Control: no-store`. Payloads remain private email data.

The scheduled Worker removes logs after 30 days; `CLASSIFIER_LOG_RETENTION_DAYS` accepts an integer from 1 to 365. Conversation deletion cascades to its logs. Calls still running after five minutes are marked interrupted, and unfinished application outcomes are marked failed. Apply the database migration before deploying the Worker and UI.

## Email agent

Open **Agent** in a mailbox to chat, search mail, organize incoming messages, or save a draft reply to the selected email. **Settings → Models** lists models, refreshes the gateway catalog, and saves a default per mailbox. The chat dropdown can override that default for the current browser session without changing automatic drafts. Each turn records the model actually used.

Workers AI choices use the `AI` binding through `workers-ai-provider`: Kimi K2.6 (initial default), GLM 4.7 Flash, and Qwen3 30B. Anthropic, OpenAI, and other compatible providers use **Vercel AI Gateway**, matching Mako and the CRM, via AI SDK 6. **Refresh model list** imports tool-capable language models supporting the installed SDK from `https://ai-gateway.vercel.sh/v1/models` into Postgres. Removed models remain visible as unavailable; failed refreshes preserve the previous list. Defaults never silently fall back. Gateway models are selectable only when `AI_GATEWAY_API_KEY` is configured server-side. The public catalog can be refreshed without a key; inference requires a funded gateway account with access to the chosen model. Keys are never exposed to the browser.

**Settings → Models** also provides additional writing instructions and an opt-in **Automatically draft replies to new emails** toggle. It starts disabled and only enqueues future received inbox messages. Existing drafts and superseded conversations are skipped. Automatic tools can only read the triggering conversation and draft a reply to its original sender/Reply-To; interactive tools can also search, compose a new draft, mark read/unread, archive, move to spam/trash, and discard drafts. Neither mode has a send tool. Review draft links open the existing composer for editing and manual sending.

The chat follows the CRM/Mako Vercel AI SDK architecture: `@ai-sdk/react` `useChat`, `DefaultChatTransport`, and server `streamText` → `toUIMessageStreamResponse`. It renders Markdown and expandable tool activity with draft review links. Native UI messages (including tool results) persist in Postgres and are converted back to model messages for bounded follow-up context. A client disconnect aborts generation; the server drains the remaining stream to persist partial progress and release the mailbox lease within Cloudflare’s cleanup window. Changes already saved remain available. Legacy turns remain readable. Postgres stores chat history, the selected model for each turn, actor, and tool results. The panel displays the 30 most recent turns. The model sees up to 30 prior turns within a conservative model-aware context budget and bounded email text; attachments are listed but not submitted. Email content is treated as untrusted. Only one agent turn can write per mailbox at a time. Runs time out after two minutes with a three-minute mutation lease; disconnected or interrupted runs are not automatically replayed. Check history and saved drafts before retrying. Automatic jobs are deduplicated by incoming email and never replay a model run that might already have created a draft. Turning automatic drafting off prevents further writes by active automatic runs.

Deployment requires migrations **009–017**, the Workers AI `AI` binding, and a dedicated queue created with `pnpm exec wrangler queues create inbox-agent-drafts` before deploying the checked-in Wrangler configuration. Enable Anthropic/OpenAI with `pnpm exec wrangler secret put AI_GATEWAY_API_KEY`, then refresh the model list in settings. Existing CRM/Mako gateway credentials can be supplied through the deployment secret store; do not commit keys. The ingestion event dispatches its durable Postgres outbox; the existing 15-minute cron recovers unpublished or exhausted deliveries. Chat does not depend on the automatic queue. The local Node server supports gateway chat when `AI_GATEWAY_API_KEY` is in `.env`; automatic drafting requires the Worker queue. Integration tests exercise catalogs, model overrides, streaming, draft tools and queue processing using deterministic models and isolated local Postgres schemas, with no external email delivery.

The assistant normalizes historical tool calls across providers, including failed and interrupted turns. Old context is omitted as complete turns when its budget is exceeded; there is no automatic summary generation. **Stop** revokes a specific run’s write lease, retaining earlier saved changes; generation observes cancellation within its polling interval. Refreshing reconnects the UI to persisted progress through polling, not SSE replay. Completed turns record token usage and, when catalog pricing exists, an approximate model cost excluding caching adjustments, discounts and additional fees. Failed or stopped turns do not display a potentially incomplete cost estimate.

For a local preview of the complete classifier UI (including Runs and Needs review),
set `CLASSIFIERS_ENABLED=1` in `.env` and restart `pnpm dev`. This exposes the
existing database-backed classifier routes; the local server does not run the
hosted Jev queue worker.

## Tag groups

Settings → Tags extends the shared tag catalogue with groups. Each group has a
name, single or multiple selection, editable options and one instruction for Jev.
Urgency, Importance and Topic start with automatic classification disabled. Enable
it in the group editor to classify new mail through the existing Jev queue and
batching pipeline. Saving a group updates its managed per-option classifiers,
cancels obsolete jobs/runs and clears automatic results; manual choices remain.
Existing conversations are not silently reclassified. Use “Apply to existing conversations” in the tag or group editor for explicit
historical runs. The Tags page is the only configuration surface: standalone
tags retain their existing Jev prompts, mailbox scope, and reviewed-example
settings. Manual groups do not require a prompt. The former Classifiers tab
opens Tags for compatibility; Runs remains the execution history.

Single-select conversation badges open a picker that replaces the current choice
atomically. Manual edits take precedence for the group on later mail. Contradictory
positive Jev answers in an exclusive group clear the automatic selection and enter
the existing review queue. Removed options are retired, preserving classifier run
history. Existing standalone tags and classifiers keep their current behavior.
Group configuration requires inbox administrator access in live mode. Apply
migration 014 before deploying this change.

In a tag or group editor, **Try on emails** searches the current mailbox and selects up to five conversations. **Preview requests** shows the exact batched payloads with conversation content. **Test with Jev** sends those conversations using unsaved instructions and shows probabilities without saving configuration, assigning tags, or creating historical runs. Received and confirmed-sent messages are included; attachments are excluded. Local testing requires `TYPESAFE_API_KEY` in `.env`; hosted testing uses the existing Worker secret. Uncertain answers and conflicting positive answers in a single-selection group require review.

Single-selection groups compile to one native Jev Choice with per-tag descriptions and an `insufficient_evidence` fallback. Multiple-selection groups and standalone tags remain Noul questions. Production and tests share request construction, conversation text normalization, batching, and answer validation. Choice initially requires confidence ≥0.60, winning probability ≥0.75, and a ≥0.20 margin; otherwise every option goes to review. These are provisional thresholds, separate from Noul's 0.85/0.15 policy, and require validation on reviewed mail. Manual overrides and stale-job fencing still apply. Provider logs retain the raw Choice distribution and associate the shared question with each affected classifier job.

Migration 015 adds optional tag descriptions and allows multiple classifier audit items per provider question. Migration 016 refines only untouched, disabled default Urgency/Importance groups; customized or enabled groups retain their instructions. Review their definitions in Settings before enabling. Message state includes readable text, UTC evaluation time, direction and attachment counts. Only exact previously seen `>`-quoted lines are deduplicated; unique quoted evidence remains. Deadline arithmetic is not delegated to Jev, and no deadline extraction is added here.

Run `pnpm eval:jev --live` to compare native Choice with independent Noul questions on eight synthetic multilingual triage fixtures using the local key. This sends only synthetic text and does not access mailboxes. It holds revised instructions constant to compare request types, reports correct/review/incorrect outcomes, and is a smoke evaluation rather than a real-mail accuracy benchmark. Use separate, held-out reviewed emails to tune thresholds and measure production accuracy.

The assistant supports separate saved conversations. Use **New conversation** (+) for fresh context and **Conversation history** to search titles and resume earlier chats. History and messages are paginated; the selected conversation is remembered in this browser per mailbox. Each conversation retains its model choice through its latest turn. Existing pre-conversation history is preserved under **Previous conversations**; automatic draft runs get separate conversations. Conversations are shared with users who can access the mailbox, like existing inbox history. One run can write per mailbox at a time.
Curated examples live in the tag/group drawer under **Examples** (migration 020). Administrators can also adjust the conversation’s tags and click **Save as example** directly in the inbox. This confirms the visible tags as labels for assigned groups and configured standalone tags; unassigned groups are skipped. Multi-select groups save all selected options together, with other options treated as negative. Re-saving updates the conversation snapshot and labels without duplicates, preserves an existing test-only role, and defaults new examples to teaching. Example use can be changed in Settings → Tags → Examples. New examples are added only from the inbox. Setup displays saved examples with an **Open inbox** link; administrators can review or edit existing labels, remove examples, and choose **Teach Jev** or **Test only**. Labels belong to a group as a whole, or a standalone yes/no classifier, and are scoped to a mailbox. Saving freezes the conversation; changing a label preserves that snapshot and does not assign inbox tags. Store at most 50 examples per configuration/mailbox.

Teaching uses at most six compatible examples, balanced across labels, within the request context budget. The current conversation and duplicate evidence are excluded. Test-only examples are never teaching context. Curated datasets replace the legacy recent-human-example source for that mailbox. Semantic edits preserve examples but mark their labels for review; reconfirm labels before using them as teaching context. Cosmetic color edits do not invalidate labels. **Run test set** evaluates frozen held-out cases using the draft instructions, shows expected/predicted labels and review/error counts, and exposes the actual requests. Results stay in the drawer and never modify inbox tags. These examples provide in-context guidance, not model training.

The conversation panel’s **Reclassify** action queues all saved Jev classifiers in mailbox scope for that thread, including those with automatic assignment disabled and refreshes tags after completion. Manual tags and reviewed human answers are preserved. Explicit reruns support archived/sent conversations as well as inbox mail, excluding spam/trash and draft-only threads. Ready questions for the same conversation are batched into shared Jev requests, splitting only when payload limits require it. Automatic new-mail processing continues to honor the enabled switches. Hosted requests use the durable Queue outbox; local explicit reruns use the same batching worker with the configured Jev key.

Tag and group editors expose **Automatic decision rules** (migration 021). Thresholds control post-response decisions and are never sent to Jev. Defaults retain existing behavior: yes/no 85%/15%; Choice confidence 60%, winning probability 75%, and a 20 percentage-point margin. Tests use draft thresholds; production and audit interpretation use the saved rules. Threshold edits follow existing configuration revision invalidation and preserve curated labels. **Full instructions** shows shared email-handling rules plus the current prompt; actual conversation previews include selected teaching examples.

Migration 022 records classification attempt states transactionally, including queued work and failures before a Jev request. Runs shows these alongside provider requests without duplicating attempts that have a request log. Existing current states are marked as recovered history, with no invented request payloads. Attempt details remain accessible after dispatch and link to the physical requests. Completed attempt history follows the same 30-day retention as provider logs.

Manual reclassification starts the existing leased worker immediately in a request-scoped background task; the transactional outbox and hosted queues remain the recovery path. Enqueue writes are batched, and sibling classifiers reuse one prepared conversation per generation within a processing call. The conversation UI refreshes tags as completed-result counts change.
