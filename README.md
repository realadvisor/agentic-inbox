# RealAdvisor inbox prototype

A synthetic-email fork of [Cloudflare Agentic Inbox](https://github.com/cloudflare/agentic-inbox), based on commit `48039bb6785af34e592c2966f87cde2b255c4c80`.
The upstream React inbox UI and shared helpers retain their Apache-2.0 copyright notices and [license](./LICENSE). The backend, migrations, fixtures, and local runners are new.

This is an intentionally standalone pnpm workspace with its own lockfile: the upstream React 19 application does not inherit the monorepo's React 18 overrides. This repository is the RealAdvisor fork of Cloudflare Agentic Inbox. Clone it beside the RealAdvisor monorepo and run all commands from this repository. It has its own commits, pull requests, dependencies, and manual deployment.

## Scope

- Postgres stores mailboxes, messages, folder state, drafts, thread identifiers and attachment metadata.
- Privacy and Info are separate logical mailboxes in one database. Seed data is entirely synthetic, even though the mailbox labels use the intended RealAdvisor addresses.
- The original UI supports browsing, search operators, reading, starring, folders, composing, drafts and replies.
- **Simulate send** stores an outbound message in Postgres with `delivery_status = 'simulated'`. It never calls an email provider. The app contains no SMTP or Google credentials.
- Attachment bytes live outside Postgres: `.local/attachments` locally and a private R2 bucket on Cloudflare. Raw MIME ingestion is deferred.
- Google Groups, Probo, classification, historical imports, and the upstream AI/MCP features are not connected. The hosted prototype uses Cloudflare Workers, Hyperdrive, Neon Postgres, and private R2 attachments.

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

## Before Google Groups testing

Add real ingestion as a separate adapter into the mailbox store. Replace the prototype shared password with individual authentication and mailbox authorization before handling real mail; add raw-message retention and processing retries, and configure a real outbound provider explicitly. There is deliberately no switch that enables real sending in this prototype.

Prototype limitations: deleting a message removes attachment metadata but leaves local fixture files; there is no automated retention job. There is no cross-mailbox SQL row-level security or production connection-role setup. Sending a draft uses separate save/delete requests. These are prototype constraints, not production guarantees.

## Cloudflare deployment

`server/worker.ts` runs the same inbox API on Cloudflare Workers. Static UI assets are served through the Worker, and **every route, including static assets, requires HTTP Basic authentication**. The username is `prototype`; the password is a generated secret of at least 24 characters, stored in the `PROTOTYPE_PASSWORD` Worker secret. This shared password is intended only for the synthetic prototype. The Worker fails closed if protection is unconfigured.

The deployment targets the RealAdvisor account with a dedicated `realadvisor-email-inbox-prototype` Worker and R2 bucket. It does not modify existing Workers, domain MX records or Google Groups.

The existing hosted prototype is available at <https://realadvisor-email-inbox-prototype.rodriguezjoan.workers.dev>. For a code-only update, run `pnpm install --frozen-lockfile` and `pnpm run deploy` from this directory using an authenticated Wrangler session. The existing bindings and Worker secret are retained. Database changes must be migrated separately before deploying code that depends on them.

For a fresh deployment:

1. Create a separate Neon Postgres project. Store its direct TLS connection URL in gitignored `.env.cloud` as `DATABASE_URL` with file permissions `0600`. Keep `.env` pointing at the local database. The existing prototype project is named `email-inbox` (ID `jolly-rain-30890362`) in the RealAdvisor organization, Frankfurt (`aws-eu-central-1`), with 0.25 CU compute and a 300-second idle suspension timeout.
2. Run `pnpm exec tsx --env-file=.env.cloud scripts/migrate.ts` and `pnpm exec tsx --env-file=.env.cloud scripts/seed.ts` against that new database only.
3. Create a Hyperdrive binding for the new database, with query caching disabled so inbox mutations are immediately visible. Set its ID in `wrangler.jsonc`; the committed ID points to the existing prototype. Postgres remains directly accessible independently of Hyperdrive.
4. Create the R2 bucket named in `wrangler.jsonc` and upload the synthetic attachment from `.local/attachments/30000000-0000-4000-8000-000000000001` under that same key. The bucket must remain private.
5. Set `PROTOTYPE_PASSWORD` with `pnpm exec wrangler secret put PROTOTYPE_PASSWORD`. Confirm `PUBLIC_ORIGIN` matches the deployed hostname.
6. Run `pnpm run deploy`. The preflight refuses to publish with a placeholder database binding.
7. Verify that anonymous UI and API requests return 401; with authentication, check health, both seeded inboxes, a saved simulated reply, and the attachment download.

`pnpm deploy:check` builds and bundles the Worker without publishing. Worker authentication tests are included in `pnpm test`. Credentials and Wrangler state are gitignored.

## Upstream updates

The `upstream` remote is `https://github.com/cloudflare/agentic-inbox.git`; `origin` is `https://github.com/realadvisor/agentic-inbox.git`. Our port starts from the upstream commit named above. Fetch upstream and review changes on a dedicated update branch before merging them into the Postgres port. Backend and AI/MCP changes can require manual adaptation; syncing upstream is not an automatic database upgrade.
