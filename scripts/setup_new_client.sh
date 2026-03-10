#!/bin/bash
set -e

# Logging setup
LOG_FILE="setup_client.log"
> "$LOG_FILE"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Error handling
handle_error() {
    local exit_code=$?
    local line_no=$1
    local command="$2"
    echo -e "\n${RED}❌ Error occurred at line $line_no${NC}"
    echo -e "${RED}Command: ${command}${NC}"
    echo -e "${RED}Exit code: $exit_code${NC}"
    echo -e "\n${YELLOW}Last 20 lines of log ($LOG_FILE):${NC}"
    tail -n 20 "$LOG_FILE"
    echo -e "\n${YELLOW}Possible fixes:${NC}"
    echo "1. Ensure you are logged in: 'gcloud auth login' and 'firebase login'"
    echo "2. Ensure the Firebase project is on the Blaze (Pay-as-you-go) plan."
    echo "3. Ensure you have the necessary IAM permissions on the project."
    exit $exit_code
}
trap 'handle_error ${LINENO} "$BASH_COMMAND"' ERR

TOTAL_STEPS=14

echo -e "${CYAN}=== Invoice Scanner - New Client Setup ===${NC}"
echo -e "This script will create and provision a new Firebase/GCP project in europe-west3."
echo -e "Detailed logs are written to ${LOG_FILE}\n"

# ── 1. Collect Inputs ──────────────────────────────────────────────────────────

echo -e "${YELLOW}Enter the new Project ID (lowercase, 6-30 chars, letters/digits/hyphens):${NC} \c"
read -r PROJECT_ID

if [ -z "$PROJECT_ID" ]; then
    echo -e "${RED}Project ID cannot be empty. Exiting.${NC}"
    exit 1
fi

if [[ ! "$PROJECT_ID" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; then
    echo -e "${RED}Invalid Project ID format. Must be 6-30 chars: lowercase letters, digits, hyphens. Cannot start/end with a hyphen.${NC}"
    exit 1
fi

echo -e "${YELLOW}Enter a display name for the project (e.g. 'My Client Invoices'):${NC} \c"
read -r DISPLAY_NAME

if [ -z "$DISPLAY_NAME" ]; then
    DISPLAY_NAME="$PROJECT_ID"
    echo -e "  ${YELLOW}-> No display name provided. Using project ID: ${DISPLAY_NAME}${NC}"
fi

echo -e "${YELLOW}Please enter the OpenAI API Key for this project:${NC} \c"
read -s OPENAI_API_KEY
echo ""

if [ -z "$OPENAI_API_KEY" ]; then
    echo -e "${RED}OpenAI API Key cannot be empty. Exiting.${NC}"
    exit 1
fi

echo -e "\n${GREEN}Starting setup for project: $PROJECT_ID ($DISPLAY_NAME)${NC}"

# ── State file for resumability ─────────────────────────────────────────────────

STATE_FILE=".setup_state_${PROJECT_ID}"
touch "$STATE_FILE"

function mark_step_done() {
    echo "$1" >> "$STATE_FILE"
}

function is_step_done() {
    grep -q "^$1$" "$STATE_FILE" 2>/dev/null
}

# ── 2. Create GCP Project ──────────────────────────────────────────────────────

if is_step_done "create_project"; then
    echo -e "[1/${TOTAL_STEPS}] GCP project already created. Skipping..."
else
    echo -e "[1/${TOTAL_STEPS}] Creating GCP project..."
    if gcloud projects describe "$PROJECT_ID" >> "$LOG_FILE" 2>&1; then
        echo -e "  ${YELLOW}-> Project '$PROJECT_ID' already exists. Skipping creation.${NC}"
    else
        gcloud projects create "$PROJECT_ID" --name="$DISPLAY_NAME" >> "$LOG_FILE" 2>&1
        echo -e "  -> Created project: $PROJECT_ID"
    fi
    mark_step_done "create_project"
fi

# ── 3. Link Billing Account ────────────────────────────────────────────────────

if is_step_done "link_billing"; then
    echo -e "[2/${TOTAL_STEPS}] Billing account already linked. Skipping..."
else
    echo -e "[2/${TOTAL_STEPS}] Linking billing account..."

    BILLING_ACCOUNTS=$(gcloud billing accounts list --filter="open=true" --format="value(name)")
    BILLING_COUNT=$(echo "$BILLING_ACCOUNTS" | grep -c . || true)

    if [ "$BILLING_COUNT" -eq 0 ]; then
        echo -e "${RED}No active billing accounts found. Create one at https://console.cloud.google.com/billing${NC}"
        exit 1
    elif [ "$BILLING_COUNT" -eq 1 ]; then
        BILLING_ACCOUNT_ID="$BILLING_ACCOUNTS"
        echo -e "  -> Auto-selected billing account: ${CYAN}${BILLING_ACCOUNT_ID}${NC}"
    else
        echo -e "\n${CYAN}Available billing accounts:${NC}"
        gcloud billing accounts list --filter="open=true"
        echo -e "\n${YELLOW}Enter the Billing Account ID from the list above:${NC} \c"
        read -r BILLING_ACCOUNT_ID
        if [ -z "$BILLING_ACCOUNT_ID" ]; then
            echo -e "${RED}Billing Account ID cannot be empty. Exiting.${NC}"
            exit 1
        fi
    fi

    gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT_ID" >> "$LOG_FILE" 2>&1
    echo -e "  -> Linked billing account ${BILLING_ACCOUNT_ID} to project ${PROJECT_ID}"
    mark_step_done "link_billing"
fi

# ── 4. Add Firebase ─────────────────────────────────────────────────────────────

if is_step_done "add_firebase"; then
    echo -e "[3/${TOTAL_STEPS}] Firebase already added. Skipping..."
else
    echo -e "[3/${TOTAL_STEPS}] Adding Firebase to GCP project..."
    firebase projects:addfirebase "$PROJECT_ID" >> "$LOG_FILE" 2>&1
    mark_step_done "add_firebase"
fi

# ── 5. Set Active Project ──────────────────────────────────────────────────────

echo -e "[4/${TOTAL_STEPS}] Setting active Firebase project..."
firebase use "$PROJECT_ID" >> "$LOG_FILE" 2>&1
gcloud config set project "$PROJECT_ID" >> "$LOG_FILE" 2>&1

# ── 6. Enable GCP APIs ─────────────────────────────────────────────────────────

if is_step_done "enable_apis"; then
    echo -e "[5/${TOTAL_STEPS}] GCP APIs already enabled. Skipping..."
else
    echo -e "[5/${TOTAL_STEPS}] Enabling necessary GCP APIs (this may take a minute)..."
    gcloud services enable \
        cloudfunctions.googleapis.com \
        firestore.googleapis.com \
        storage.googleapis.com \
        vision.googleapis.com \
        cloudbuild.googleapis.com \
        eventarc.googleapis.com \
        run.googleapis.com \
        artifactregistry.googleapis.com \
        identitytoolkit.googleapis.com \
        pubsub.googleapis.com \
        cloudscheduler.googleapis.com \
        --project "$PROJECT_ID" >> "$LOG_FILE" 2>&1

    echo -e "  -> Provisioning service identities for Gen 2 Cloud Functions..."
    gcloud beta services identity create --service=pubsub.googleapis.com --project="$PROJECT_ID" --quiet >> "$LOG_FILE" 2>&1
    gcloud beta services identity create --service=eventarc.googleapis.com --project="$PROJECT_ID" --quiet >> "$LOG_FILE" 2>&1

    mark_step_done "enable_apis"
fi

# ── 7. Provision Firestore ──────────────────────────────────────────────────────

if is_step_done "provision_firestore"; then
    echo -e "[6/${TOTAL_STEPS}] Firestore Database already provisioned. Skipping..."
else
    echo -e "[6/${TOTAL_STEPS}] Provisioning Firestore Database in europe-west3..."
    if gcloud firestore databases describe --database="(default)" --project "$PROJECT_ID" >> "$LOG_FILE" 2>&1; then
        echo -e "  ${YELLOW}-> Firestore database already exists. Skipping creation.${NC}"
    else
        gcloud firestore databases create --location=europe-west3 --type=firestore-native --project "$PROJECT_ID" >> "$LOG_FILE" 2>&1
    fi
    sleep 5
    echo -e "  -> Deploying Firestore Rules and Indexes..."
    firebase deploy --only firestore --project "$PROJECT_ID" >> "$LOG_FILE" 2>&1

    echo -e "  -> Verifying and deploying specific Firestore Indexes..."
    firebase deploy --only firestore:indexes --project "$PROJECT_ID" >> "$LOG_FILE" 2>&1

    mark_step_done "provision_firestore"
fi

# ── 8. Provision Storage ────────────────────────────────────────────────────────

if is_step_done "provision_storage"; then
    echo -e "[7/${TOTAL_STEPS}] Default Storage bucket already provisioned. Skipping..."
else
    echo -e "[7/${TOTAL_STEPS}] Provisioning Default Storage Bucket in europe-west3..."
    BUCKET_NAME="gs://${PROJECT_ID}.appspot.com"

    if gcloud storage buckets describe "$BUCKET_NAME" --project "$PROJECT_ID" >> "$LOG_FILE" 2>&1; then
        echo -e "  ${YELLOW}-> Storage bucket already exists. Skipping creation.${NC}"
    else
        gcloud app create --region=europe-west3 --project "$PROJECT_ID" >> "$LOG_FILE" 2>&1
        echo -e "  -> Created default bucket via App Engine initialization: $BUCKET_NAME"
    fi

    echo -e "  -> Provisioning Firebase Storage default bucket..."
    FB_BUCKET_RESPONSE=$(curl -s -X POST \
        "https://firebasestorage.googleapis.com/v1alpha/projects/${PROJECT_ID}/defaultBucket" \
        -H "Authorization: Bearer $(gcloud auth print-access-token)" \
        -H "Content-Type: application/json" \
        -d "{\"location\":\"europe-west3\"}")
    if [[ "$FB_BUCKET_RESPONSE" == *'"name"'* ]]; then
        echo -e "  -> Provisioned Firebase Storage bucket: ${CYAN}gs://${PROJECT_ID}.firebasestorage.app${NC}"
    else
        echo -e "  ${YELLOW}-> Could not provision .firebasestorage.app bucket (may already exist or require console setup).${NC}"
    fi

    mark_step_done "provision_storage"
fi

# ── 9. Configure CORS ──────────────────────────────────────────────────────────

if is_step_done "cors_config"; then
    echo -e "[8/${TOTAL_STEPS}] Storage CORS already configured. Skipping..."
else
    echo -e "[8/${TOTAL_STEPS}] Configuring CORS on Storage Buckets..."
    CORS_TEMP=$(mktemp)
    trap 'rm -f "$CORS_TEMP"' EXIT
    cat > "$CORS_TEMP" << EOF
[
  {
    "maxAgeSeconds": 3600,
    "method": ["GET", "PUT", "POST", "HEAD", "OPTIONS", "DELETE"],
    "origin": [
      "http://localhost:5173",
      "https://${PROJECT_ID}.web.app",
      "https://${PROJECT_ID}.firebaseapp.com"
    ],
    "responseHeader": [
      "Content-Type",
      "Authorization",
      "Content-Length",
      "x-goog-resumable",
      "x-goog-meta-*",
      "Access-Control-Allow-Origin"
    ]
  }
]
EOF
    gsutil cors set "$CORS_TEMP" "gs://${PROJECT_ID}.appspot.com" >> "$LOG_FILE" 2>&1

    if gsutil cors set "$CORS_TEMP" "gs://${PROJECT_ID}.firebasestorage.app" >> "$LOG_FILE" 2>&1; then
        FIREBASE_STORAGE_CORS_OK=true
    else
        FIREBASE_STORAGE_CORS_OK=false
        echo -e "  ${YELLOW}-> gs://${PROJECT_ID}.firebasestorage.app bucket not found. CORS skipped for it.${NC}"
    fi
    rm -f "$CORS_TEMP"

    echo -e "  -> Verifying CORS configuration..."
    echo -e "  ${CYAN}gs://${PROJECT_ID}.appspot.com:${NC}"
    gsutil cors get "gs://${PROJECT_ID}.appspot.com"
    if [ "$FIREBASE_STORAGE_CORS_OK" = true ]; then
        echo -e "  ${CYAN}gs://${PROJECT_ID}.firebasestorage.app:${NC}"
        gsutil cors get "gs://${PROJECT_ID}.firebasestorage.app"
    fi
    mark_step_done "cors_config"
fi

# ── 10. IAM Role Assignments ───────────────────────────────────────────────────

if is_step_done "iam_roles"; then
    echo -e "[9/${TOTAL_STEPS}] IAM Roles already assigned. Skipping..."
else
    echo -e "[9/${TOTAL_STEPS}] Assigning IAM Roles..."

    echo -e "  -> Finding service account email..."
    SA_EMAIL=$(gcloud iam service-accounts list --project "$PROJECT_ID" --format="value(email)" --filter="email:firebase-adminsdk")

    if [ -z "$SA_EMAIL" ]; then
        echo -e "${RED}Error: Firebase Admin SDK service account not found.${NC}"
        echo -e "${YELLOW}You may need to open the Firebase Console -> Project Settings -> Service Accounts to trigger its creation.${NC}"
        exit 1
    fi

    echo -e "  -> Resolving project number..."
    PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)")

    echo -e "  ${CYAN}Firebase Admin SDK SA roles:${NC}"
    ROLES=(
        "roles/datastore.user"
        "roles/cloudfunctions.admin"
        "roles/cloudfunctions.developer"
        "roles/cloudfunctions.invoker"
        "roles/firebasestorage.admin"
        "roles/firebasestorage.serviceAgent"
        "roles/firebase.sdkAdminServiceAgent"
        "roles/firebaseauth.admin"
        "roles/firebaserules.firestoreServiceAgent"
        "roles/iam.serviceAccountTokenCreator"
        "roles/iam.serviceAccountUser"
        "roles/storage.admin"
    )

    for ROLE in "${ROLES[@]}"; do
        echo -e "  -> Assigning $ROLE ..."
        gcloud projects add-iam-policy-binding "$PROJECT_ID" \
            --member="serviceAccount:${SA_EMAIL}" \
            --role="$ROLE" \
            --condition=None \
            >> "$LOG_FILE" 2>&1 || echo -e "  ${YELLOW}-> Warning: Failed to assign $ROLE. Check log for details.${NC}"
    done

    echo -e "  ${CYAN}Gen 2 Cloud Functions service agent roles:${NC}"

    echo -e "  -> Cloud Build SA: roles/cloudbuild.builds.builder ..."
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" \
        --role="roles/cloudbuild.builds.builder" \
        --condition=None \
        >> "$LOG_FILE" 2>&1 || echo -e "  ${YELLOW}-> Warning: Failed to assign Cloud Build builder role.${NC}"

    echo -e "  -> Compute default SA: roles/artifactregistry.reader ..."
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
        --role="roles/artifactregistry.reader" \
        --condition=None \
        >> "$LOG_FILE" 2>&1 || echo -e "  ${YELLOW}-> Warning: Failed to assign Artifact Registry reader role.${NC}"

    echo -e "  -> Eventarc SA: roles/eventarc.serviceAgent ..."
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-eventarc.iam.gserviceaccount.com" \
        --role="roles/eventarc.serviceAgent" \
        --condition=None \
        >> "$LOG_FILE" 2>&1 || echo -e "  ${YELLOW}-> Warning: Failed to assign Eventarc service agent role.${NC}"

    echo -e "  -> Cloud Functions SA: roles/run.invoker ..."
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member="serviceAccount:service-${PROJECT_NUMBER}@gcf-admin-robot.iam.gserviceaccount.com" \
        --role="roles/run.invoker" \
        --condition=None \
        >> "$LOG_FILE" 2>&1 || echo -e "  ${YELLOW}-> Warning: Failed to assign Cloud Run invoker role.${NC}"

    echo -e "  ${CYAN}Gen 2 Storage-trigger & Pub/Sub roles:${NC}"

    echo -e "  -> GCS SA: roles/pubsub.publisher ..."
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member="serviceAccount:service-${PROJECT_NUMBER}@gs-project-accounts.iam.gserviceaccount.com" \
        --role="roles/pubsub.publisher" \
        --condition=None \
        >> "$LOG_FILE" 2>&1 || echo -e "  ${YELLOW}-> Warning: Failed to assign Pub/Sub publisher role to GCS SA.${NC}"

    echo -e "  -> Pub/Sub SA: roles/iam.serviceAccountTokenCreator ..."
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com" \
        --role="roles/iam.serviceAccountTokenCreator" \
        --condition=None \
        >> "$LOG_FILE" 2>&1 || echo -e "  ${YELLOW}-> Warning: Failed to assign token creator role to Pub/Sub SA.${NC}"

    echo -e "  -> Compute default SA: roles/run.invoker ..."
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
        --role="roles/run.invoker" \
        --condition=None \
        >> "$LOG_FILE" 2>&1 || echo -e "  ${YELLOW}-> Warning: Failed to assign Cloud Run invoker role to compute SA.${NC}"

    echo -e "  -> Compute default SA: roles/eventarc.eventReceiver ..."
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
        --role="roles/eventarc.eventReceiver" \
        --condition=None \
        >> "$LOG_FILE" 2>&1 || echo -e "  ${YELLOW}-> Warning: Failed to assign Eventarc event receiver role.${NC}"

    echo -e "  -> Waiting 30s for IAM propagation..."
    sleep 30

    mark_step_done "iam_roles"
fi

# ── 11. Environment Configuration ──────────────────────────────────────────────

if is_step_done "env_config"; then
    echo -e "[10/${TOTAL_STEPS}] Environment configuration already generated. Skipping..."
else
    echo -e "[10/${TOTAL_STEPS}] Generating .env configuration..."
    if [ -z "$SA_EMAIL" ]; then
        SA_EMAIL=$(gcloud iam service-accounts list --project "$PROJECT_ID" --format="value(email)" --filter="email:firebase-adminsdk")
    fi
    cat > "functions/.env.${PROJECT_ID}" << EOF
SERVICE_ACCOUNT_EMAIL=${SA_EMAIL}
REGION=europe-west3
OPENAI_API_KEY=${OPENAI_API_KEY}
GCS_BUCKET=${PROJECT_ID}.appspot.com
EOF
    echo -e "  -> Created functions/.env.${PROJECT_ID}"
    mark_step_done "env_config"
fi

# ── 12. Authentication Setup ────────────────────────────────────────────────────

if is_step_done "auth_setup"; then
    echo -e "[11/${TOTAL_STEPS}] Authentication already configured. Skipping..."
else
    echo -e "[11/${TOTAL_STEPS}] Configuring Email/Password authentication..."
    ACCESS_TOKEN=$(gcloud auth print-access-token)

    echo -e "  -> Initializing Identity Platform..."
    curl -s -X POST \
        "https://identitytoolkit.googleapis.com/v2/projects/${PROJECT_ID}/identityPlatform:initializeAuth" \
        -H "Authorization: Bearer ${ACCESS_TOKEN}" \
        -H "X-Goog-User-Project: ${PROJECT_ID}" \
        -H "Content-Type: application/json" >> "$LOG_FILE" 2>&1

    echo -e "  -> Enabling Email/Password sign-in..."
    AUTH_RESPONSE=$(curl -s -X PATCH \
        "https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT_ID}/config?updateMask=signIn.email" \
        -H "Authorization: Bearer ${ACCESS_TOKEN}" \
        -H "X-Goog-User-Project: ${PROJECT_ID}" \
        -H "Content-Type: application/json" \
        -d '{"signIn":{"email":{"enabled":true,"passwordRequired":true}}}')

    if [[ "$AUTH_RESPONSE" == *'"email"'* ]]; then
        echo -e "  -> Email/Password sign-in enabled."
    else
        echo -e "  ${YELLOW}-> Warning: Could not enable Email/Password sign-in automatically.${NC}"
        echo -e "  ${YELLOW}   Enable it manually at: https://console.firebase.google.com/project/${PROJECT_ID}/authentication/providers${NC}"
    fi

    echo -e "\n${YELLOW}Would you like to create an initial admin user? (y/N):${NC} \c"
    read -r CREATE_USER

    if [[ "$CREATE_USER" =~ ^[Yy]$ ]]; then
        echo -e "${YELLOW}Enter admin email:${NC} \c"
        read -r ADMIN_EMAIL
        echo -e "${YELLOW}Enter admin password (min 6 chars):${NC} \c"
        read -s ADMIN_PASSWORD
        echo ""
        echo -e "${YELLOW}Enter admin display name:${NC} \c"
        read -r ADMIN_DISPLAY_NAME

        if [ -z "$ADMIN_EMAIL" ] || [ -z "$ADMIN_PASSWORD" ]; then
            echo -e "  ${YELLOW}-> Email and password required. Skipping user creation.${NC}"
        else
            RESPONSE=$(curl -s -X POST \
                "https://identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts" \
                -H "Authorization: Bearer ${ACCESS_TOKEN}" \
                -H "X-Goog-User-Project: ${PROJECT_ID}" \
                -H "Content-Type: application/json" \
                -d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\",\"displayName\":\"${ADMIN_DISPLAY_NAME}\"}")

            if [[ "$RESPONSE" == *'"localId"'* ]]; then
                LOCAL_ID=$(echo "$RESPONSE" | grep -o '"localId":"[^"]*"' | cut -d'"' -f4)
                echo -e "  -> Created admin user: ${ADMIN_EMAIL} (UID: ${LOCAL_ID})"
            else
                ERROR_MSG=$(echo "$RESPONSE" | grep -o '"message":"[^"]*"' | cut -d'"' -f4)
                echo -e "  ${YELLOW}-> Warning: Failed to create user: ${ERROR_MSG:-unknown error}${NC}"
                echo -e "  ${YELLOW}   You can create the user manually in the Firebase Console.${NC}"
            fi
        fi
    fi

    mark_step_done "auth_setup"
fi

# ── 13. Artifact Registry Cleanup Policy ──────────────────────────────────────

if is_step_done "artifact_cleanup"; then
    echo -e "[12/${TOTAL_STEPS}] Artifact Registry cleanup policy already set. Skipping..."
else
    echo -e "[12/${TOTAL_STEPS}] Configuring Artifact Registry cleanup policy..."

    if ! gcloud artifacts repositories describe gcf-artifacts --location=europe-west3 --project="$PROJECT_ID" >> "$LOG_FILE" 2>&1; then
        gcloud artifacts repositories create gcf-artifacts \
            --repository-format=docker \
            --location=europe-west3 \
            --project="$PROJECT_ID" \
            --quiet >> "$LOG_FILE" 2>&1
        echo -e "  -> Created gcf-artifacts repository in europe-west3"
    fi

    CLEANUP_POLICY_TEMP=$(mktemp)
    cat > "$CLEANUP_POLICY_TEMP" << 'POLICY_EOF'
[
  {
    "name": "delete-old-images",
    "action": {"type": "Delete"},
    "condition": {
      "olderThan": "86400s"
    }
  }
]
POLICY_EOF
    gcloud artifacts repositories set-cleanup-policies gcf-artifacts \
        --location=europe-west3 \
        --project="$PROJECT_ID" \
        --policy="$CLEANUP_POLICY_TEMP" \
        --quiet >> "$LOG_FILE" 2>&1
    rm -f "$CLEANUP_POLICY_TEMP"
    echo -e "  -> Cleanup policy set: images older than 1 day auto-deleted"

    mark_step_done "artifact_cleanup"
fi

# ── 14. Deployment ─────────────────────────────────────────────────────────────

if is_step_done "deployment"; then
    echo -e "[13/${TOTAL_STEPS}] Deployment already completed. Skipping..."
else
    echo -e "[13/${TOTAL_STEPS}] Deploying Cloud Functions (this may take a few minutes)..."
    DEPLOY_MAX_RETRIES=3
    DEPLOY_ATTEMPT=0
    DEPLOY_OK=false
    while [ "$DEPLOY_ATTEMPT" -lt "$DEPLOY_MAX_RETRIES" ]; do
        DEPLOY_ATTEMPT=$((DEPLOY_ATTEMPT + 1))
        if firebase deploy --only functions --project "$PROJECT_ID" --non-interactive --force >> "$LOG_FILE" 2>&1; then
            DEPLOY_OK=true
            break
        fi
        if [ "$DEPLOY_ATTEMPT" -lt "$DEPLOY_MAX_RETRIES" ]; then
            echo -e "  ${YELLOW}-> Deploy attempt ${DEPLOY_ATTEMPT}/${DEPLOY_MAX_RETRIES} had errors. Retrying in 30s (partial deploys will be skipped)...${NC}"
            sleep 30
        fi
    done
    if [ "$DEPLOY_OK" = false ]; then
        echo -e "  ${RED}-> All ${DEPLOY_MAX_RETRIES} deploy attempts failed. Check ${LOG_FILE} for details.${NC}"
        exit 1
    fi
    mark_step_done "deployment"
fi

# ── 15. Register Firebase Web App & Export Config ──────────────────────────────

if is_step_done "register_web_app"; then
    echo -e "[14/${TOTAL_STEPS}] Firebase Web App already registered. Skipping..."
else
    echo -e "[14/${TOTAL_STEPS}] Registering Firebase Web App & exporting config..."

    EXISTING_APP=$(firebase apps:list WEB --project "$PROJECT_ID" 2>/dev/null | grep -c "App ID" || true)
    if [ "$EXISTING_APP" -gt 0 ]; then
        echo -e "  ${YELLOW}-> Web App already exists. Skipping creation.${NC}"
    else
        firebase apps:create WEB "${DISPLAY_NAME:-$PROJECT_ID}" --project "$PROJECT_ID" >> "$LOG_FILE" 2>&1
        echo -e "  -> Created Web App: ${DISPLAY_NAME:-$PROJECT_ID}"
    fi

    echo -e "  -> Exporting Firebase SDK config..."
    CONFIG_FILE="firebase-config.${PROJECT_ID}.json"
    firebase apps:sdkconfig WEB --project "$PROJECT_ID" --json | node -e "
        const chunks = [];
        process.stdin.on('data', c => chunks.push(c));
        process.stdin.on('end', () => {
            const raw = JSON.parse(chunks.join(''));
            const cfg = raw.result.sdkConfig;
            console.log(JSON.stringify(cfg, null, 2));
        });
    " > "$CONFIG_FILE"

    echo -e "  -> Saved to ${CYAN}${CONFIG_FILE}${NC}"
    echo -e "\n  ${CYAN}Firebase SDK config for frontend:${NC}"
    cat "$CONFIG_FILE"
    echo ""

    mark_step_done "register_web_app"
fi

# ── Done ────────────────────────────────────────────────────────────────────────

echo -e "\n${GREEN}=== Setup Complete! ===${NC}"
echo -e "Your new project ${CYAN}${PROJECT_ID}${NC} has been successfully created, provisioned, and deployed."
echo -e "\n${YELLOW}NEXT STEPS:${NC}"
echo -e "1. To deploy the frontend client, navigate to your frontend repository and run:"
echo -e "   ${CYAN}firebase use ${PROJECT_ID} && firebase deploy --only hosting${NC}"
echo -e "2. To sign in and get an ID token, run: ${CYAN}npm run auth:login${NC}"
echo -e "\n${CYAN}Output files:${NC}"
echo -e "  Backend env:    ${CYAN}functions/.env.${PROJECT_ID}${NC}"
echo -e "  Frontend config: ${CYAN}firebase-config.${PROJECT_ID}.json${NC}"
