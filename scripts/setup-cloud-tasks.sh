#!/usr/bin/env bash
# Provision only the inbox resources. Does not deploy the Worker or alter other queues.
set -euo pipefail
project="${CLOUD_TASKS_PROJECT:-realadvisor-prod}"
location="${CLOUD_TASKS_LOCATION:-europe-west1}"
account="inbox-classifications@${project}.iam.gserviceaccount.com"
gcloud services enable cloudtasks.googleapis.com --project="$project"
if ! gcloud iam service-accounts describe "$account" --project="$project" >/dev/null 2>&1; then
 gcloud iam service-accounts create inbox-classifications --display-name="Inbox classification delivery" --project="$project"
fi
for queue in inbox-classifications inbox-classifier-backfills; do
 concurrency=10
 if [[ "$queue" == "inbox-classifier-backfills" ]]; then concurrency=5; fi
 action=update
 if ! gcloud tasks queues describe "$queue" --location="$location" --project="$project" >/dev/null 2>&1; then action=create; fi
 gcloud tasks queues "$action" "$queue" --location="$location" --project="$project" \
  --max-concurrent-dispatches="$concurrency" --max-dispatches-per-second=10 \
  --max-attempts=-1 --min-backoff=30s --max-backoff=3600s --max-doublings=7
 gcloud tasks queues add-iam-policy-binding "$queue" --location="$location" --project="$project" \
  --member="serviceAccount:$account" --role=roles/cloudtasks.enqueuer
 done
# Producer may attach this identity; Cloud Tasks service agent mints delivery tokens.
gcloud iam service-accounts add-iam-policy-binding "$account" --project="$project" \
 --member="serviceAccount:$account" --role=roles/iam.serviceAccountUser
number=$(gcloud projects describe "$project" --format='value(projectNumber)')
gcloud iam service-accounts add-iam-policy-binding "$account" --project="$project" \
 --member="serviceAccount:service-${number}@gcp-sa-cloudtasks.iam.gserviceaccount.com" --role=roles/iam.serviceAccountTokenCreator
printf 'Queues ready. Configure Worker variables and its private-key secret as described in README before switching transport.\n'
