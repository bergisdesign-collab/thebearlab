#!/usr/bin/env bash
# One-time Google Cloud setup for the Bear Lab Bot. Run in Cloud Shell (console.cloud.google.com → >_):
#   bash gcp_setup.sh <PROJECT_ID>
# Creates: APIs, Firestore (europe-west1), permissions, a deploy service account + its key for GitHub.
set -euo pipefail

PROJECT="${1:-$(gcloud config get-value project 2>/dev/null)}"
REGION="europe-west1"
[ -n "$PROJECT" ] || { echo "Usage: bash gcp_setup.sh <PROJECT_ID>"; exit 1; }
gcloud config set project "$PROJECT" >/dev/null

echo "== APIs"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  firestore.googleapis.com cloudscheduler.googleapis.com iam.googleapis.com

echo "== Firestore ($REGION)"
gcloud firestore databases create --location="$REGION" --type=firestore-native 2>/dev/null \
  || echo "   уже есть — ок"

NUM=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
RUNTIME_SA="$NUM-compute@developer.gserviceaccount.com"
bind() { gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$1" --role "$2" \
           --condition=None --quiet >/dev/null; }

echo "== Права сервиса бота (Firestore, сборка)"
for r in roles/datastore.user roles/run.builder roles/logging.logWriter roles/artifactregistry.writer; do
  bind "$RUNTIME_SA" "$r"
done

echo "== Аккаунт для выкладки из GitHub"
gcloud iam service-accounts create tbl-deployer --display-name "TheBearLab GitHub deploy" 2>/dev/null || true
DEPLOYER="tbl-deployer@$PROJECT.iam.gserviceaccount.com"
for r in roles/run.admin roles/iam.serviceAccountUser roles/cloudbuild.builds.editor roles/artifactregistry.admin \
         roles/storage.admin roles/serviceusage.serviceUsageConsumer roles/cloudscheduler.admin roles/viewer; do
  bind "$DEPLOYER" "$r"
done

KEY="$HOME/tbl-deployer-key.json"
gcloud iam service-accounts keys create "$KEY" --iam-account "$DEPLOYER" --quiet

cat <<EOF

Готово.
  GCP_PROJECT = $PROJECT
  GCP_SA_KEY  = содержимое файла ниже (скопируй целиком, от { до }), затем удали файл:
                cat $KEY
                rm $KEY
EOF
