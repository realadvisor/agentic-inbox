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
- Probo, historical imports, and the upstream AI/MCP features are not connected. The hosted inbox uses Cloudflare Workers, Hyperdrive, Neon Postgres, and private R2 attachments.

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

Settings → Classifiers configures one yes/no question per shared tag. Migration 006 seeds Needs reply, Privacy: Deletion and Privacy: Data access, all **inactive**. Only `MAILBOX_ADMINS` can create/edit/enable classifiers or run/cancel batches. All authenticated inbox users can review uncertain results. Activating a classifier applies to new mail and confirmed sent replies; it never starts a historical scan. **Run on existing** explicitly queues active conversations (up to 5,000 per batch), with scope, unprocessed/all and optional reset of classifier corrections. Spam/trash/archive-only conversations are excluded.

Cloudflare Queues delivers classifier work. New mail and confirmed sent replies use `inbox-classifications`; explicit historical runs use `inbox-classifier-backfills`. Each queue permits one concurrent consumer with batch size one, so backfills cannot occupy the new-mail consumer and at most two Jev requests run concurrently. Queue messages contain only `{version: 1, token: "uuid"}`, never email bodies or addresses. Neon remains the source of truth for configuration, results, corrections and run progress.

Migration 007 adds a transactional `classifier_outbox`: changes to pending job versions record dispatch intent in the same database transaction. Ingestion and successful API mutations publish promptly after commit; consumers continue draining large unpublished batches. The published marker is committed only after broker acceptance, so an ambiguous publish may duplicate a message but cannot silently lose work. Stable version tokens and short per-job leases make retries/duplicate deliveries safe. Completion and tag changes are atomic. New mail, configuration edits, cancellation and human review invalidate stale messages.

Cloudflare performs delivery and three retries (up to four deliveries), respecting provider backoff and a shared 429 cooldown. Exhausted deliveries go to `inbox-classifications-dead`; its consumer records failures in Neon for review or **Run on existing → Not yet processed**. The dead-letter consumer retries database outages. All three queues retain messages for 24 hours; outbox intent survives broker expiry and can republish still-pending jobs after 25 hours. A recovery cron checks unpublished/expired delivery intent every 15 minutes, so idle Neon can suspend between checks. The cron does not run Jev. A disabled feature parks deliveries in the outbox without burning retries. Existing manual choices and cancellation behavior are unchanged.

Jev receives chronological received/confirmed-sent conversation text and metadata via `POST https://api.typesafe.ai/v1/systemone`, model `jev-latest`, question type `noul`. Responses ≥0.85 apply the tag; ≤0.15 remove the automatic tag; intermediate results need human review. Full attachments/raw MIME are not submitted. Threads exceeding 30 messages or 100,000 body/subject characters go to review instead of being silently truncated. Provider failures never become a confident No. New messages, configuration revisions, human corrections and cancellation invalidate in-flight result tokens. Manual tag additions/removals always win. Editing or disabling clears only classifier-owned tags. This labels conversations; it never sends replies or performs deletion.

First provision the queues in the existing Cloudflare account (skip creation if they already exist):

```sh
pnpm exec wrangler queues create inbox-classifications --message-retention-period-secs 86400
pnpm exec wrangler queues create inbox-classifier-backfills --message-retention-period-secs 86400
pnpm exec wrangler queues create inbox-classifications-dead --message-retention-period-secs 86400
```

Queue retention is set during provisioning; when adopting existing queues, use `wrangler queues update <name> --message-retention-period-secs 86400`. Producer bindings, consumers, retry limits and the recovery cron are versioned in `wrangler.jsonc`.

Release: run migrations against Neon, set Worker secret `TYPESAFE_API_KEY` with `pnpm exec wrangler secret put TYPESAFE_API_KEY`, retain `CLASSIFIERS_ENABLED=true` and the cron in `wrangler.jsonc`, then deploy. The key is server-only and never stored in Postgres, browser code or the repository. Existing configured secrets survive a deploy. Set `CLASSIFIERS_ENABLED=false` to pause processing and hide the UI without discarding queued work. Migration 007 is additive and seeds dispatch intent for existing pending work. Legacy worker-slot rows remain only for rollout compatibility. A rollback must also detach the Queue consumers before restoring the old cron-only Worker; do not leave consumers pointed at code without a queue handler. Database rows and outbox intent remain available for recovery. Scalar documents `/api/v1/classification/*`.
