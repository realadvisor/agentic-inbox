# RealAdvisor inbox

A Postgres-backed fork of [Cloudflare Agentic Inbox](https://github.com/cloudflare/agentic-inbox), based on commit `48039bb6785af34e592c2966f87cde2b255c4c80`.
The upstream React inbox UI and shared helpers retain their Apache-2.0 copyright notices and [license](./LICENSE). The backend, migrations, fixtures, and local runners are new.

This is an intentionally standalone pnpm workspace with its own lockfile: the upstream React 19 application does not inherit the monorepo's React 18 overrides. This repository is the RealAdvisor fork of Cloudflare Agentic Inbox. Clone it beside the RealAdvisor monorepo and run all commands from this repository. It has its own commits, pull requests, dependencies, and manual deployment.

## Scope

- Postgres stores mailboxes, messages, folder state, drafts, thread identifiers and attachment metadata.
- Privacy and Info are separate logical mailboxes in one database. Live mailboxes use `ingest.realadvisor.com`; local seed mailboxes remain synthetic.
- The original UI supports browsing, search operators, reading, starring, folders, composing, drafts and replies.
- Local **Simulate send** stores a simulated message. Hosted live mode sends through Cloudflare Email Sending using approved public From addresses. The app contains no SMTP or Google credentials.
- Attachment bytes live outside Postgres: `.local/attachments` locally and a private R2 bucket on Cloudflare. Live raw MIME is retained privately in R2.
- Google Groups, Probo, classification, historical imports, and the upstream AI/MCP features are not connected. The hosted inbox uses Cloudflare Workers, Hyperdrive, Neon Postgres, and private R2 attachments.

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

The hosted inbox runs on Cloudflare Workers with Neon Postgres through Hyperdrive and private R2 storage. All HTTP routes, including static assets, validate Cloudflare Access JWTs in live mode. Configure permitted people in the editable **Inbox team** Access policy; all permitted people share both mailboxes.

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
3. Onboard **only `ingest.realadvisor.com`** for Email Routing and route the two exact addresses to this Worker's email handler. Preserve the apex domain's Google Workspace MX records. Unknown mailbox addresses are rejected by the handler.
4. Onboard `realadvisor.com` for Cloudflare Email Sending and verify the required authentication DNS records. Preserve existing SPF/DMARC and other providers' DKIM records. Add a `send_email` binding named `EMAIL`, restricted to the two configured senders where supported. Sending domain approval is separate from receiving MX configuration.
5. Set `MAIL_MODE=live` and `INBOUND_ENABLED=true` only after Access, database migrations, and email bindings are configured. Deploy manually and verify login, a controlled inbound message, its attachment, and a reply with the expected From/Reply-To and authentication headers. Do not seed synthetic messages into live mailboxes.
6. To receive copies of group mail later, add each ingest address as a member of its corresponding Google Group with each-email delivery. Replies to the public address continue through the Group.

Inbound MIME is limited to 10 MiB and stored privately in R2 before parsing. Postgres stores mailbox-scoped messages, threading, attachment metadata, and the raw object key. Duplicate Message-IDs are ignored within a mailbox. Failed processing leaves raw MIME for recovery; automated replay and object-retention cleanup are not implemented yet.

Outbound requests require an idempotency key and persist the authenticated actor and send state. Provider acceptance is recorded as `sent`, not proof of final recipient delivery. An ambiguous provider error is recorded as `unknown` and is not automatically retried. Check provider logs before resending. Delivery/bounce webhook reconciliation and outbound attachment uploads remain follow-up work. A live test must be completed before treating this rollout as operational.

Sent messages retain their outbound audit/idempotency record and can be moved to Trash but not permanently deleted through the API. Object retention cleanup, mailbox-level permissions, classification and Probo integration are not implemented.

## API reference

[Scalar API documentation](https://inbox.realadvisor.com/api/docs) and the [OpenAPI document](https://inbox.realadvisor.com/api/openapi.json) are protected by the same Cloudflare Access login as the inbox. The versioned contract is [`openapi.json`](./openapi.json); update it alongside API changes. Scalar assets are bundled from the locked npm package and served locally, without a CDN or request proxy.

Run `pnpm dev` and open <http://127.0.0.1:4311/api/docs> for synthetic local requests. Hosted interactive requests use your browser session and affect real mail. Send/reply retries must retain the same UUID `Idempotency-Key` and identical request body; do not blindly retry an ambiguous send.

**n8n status:** service identities and mailbox/action permissions are not implemented. A Cloudflare service token alone is insufficient with the current human-identity validator. Do not export browser cookies into workflows. Future automation should use dedicated expiring service credentials stored in n8n's credential manager, with permissions enforced by the API.
