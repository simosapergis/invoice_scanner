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

echo -e "${CYAN}=== Invoice Scanner - New Client Setup ===${NC}"
echo -e "This script will provision a new Firebase/GCP project in europe-west3."
echo -e "Detailed logs are written to ${LOG_FILE}\n"

# 1. Select Project
echo -e "${CYAN}Fetching available Firebase projects...${NC}"
firebase projects:list
echo -e "\n${YELLOW}Please enter the Project ID from the list above:${NC} \c"
read -r PROJECT_ID

if [ -z "$PROJECT_ID" ]; then
    echo -e "${RED}Project ID cannot be empty. Exiting.${NC}"
    exit 1
fi

echo -e "${YELLOW}Please enter the OpenAI API Key for this project:${NC} \c"
read -s OPENAI_API_KEY
echo ""

if [ -z "$OPENAI_API_KEY" ]; then
    echo -e "${RED}OpenAI API Key cannot be empty. Exiting.${NC}"
    exit 1
fi

echo -e "\n${GREEN}Starting setup for project: $PROJECT_ID${NC}"

# 2. Set Active Project
echo -e "\n[1/7] Setting active Firebase project..."
firebase use "$PROJECT_ID" >> "$LOG_FILE" 2>&1
gcloud config set project "$PROJECT_ID" >> "$LOG_FILE" 2>&1

STATE_FILE=".setup_state_${PROJECT_ID}"
touch "$STATE_FILE"

function mark_step_done() {
    echo "$1" >> "$STATE_FILE"
}

function is_step_done() {
    grep -q "^$1$" "$STATE_FILE" 2>/dev/null
}

# 3. Enable GCP APIs
if is_step_done "enable_apis"; then
    echo -e "[2/7] GCP APIs already enabled. Skipping..."
else
    echo -e "[2/7] Enabling necessary GCP APIs (this may take a minute)..."
    gcloud services enable \
        cloudfunctions.googleapis.com \
        firestore.googleapis.com \
        storage.googleapis.com \
        vision.googleapis.com \
        cloudbuild.googleapis.com \
        --project "$PROJECT_ID" >> "$LOG_FILE" 2>&1
    mark_step_done "enable_apis"
fi

# 4. Resource Provisioning
if is_step_done "provision_firestore"; then
    echo -e "[3/7] Firestore Database already provisioned. Skipping..."
else
    echo -e "[3/7] Provisioning Firestore Database in europe-west3..."
    # Check if database already exists first
    if gcloud firestore databases describe --database="(default)" --project "$PROJECT_ID" >> "$LOG_FILE" 2>&1; then
        echo -e "  ${YELLOW}-> Firestore database already exists. Skipping creation.${NC}"
    else
        gcloud firestore databases create --location=europe-west3 --type=firestore-native --project "$PROJECT_ID" >> "$LOG_FILE" 2>&1
    fi
    # Wait briefly to ensure database is fully ready
    sleep 5
    # Deploy indexes immediately after database creation so it's guaranteed to happen
    echo -e "  -> Deploying Firestore Rules and Indexes..."
    firebase deploy --only firestore --project "$PROJECT_ID" >> "$LOG_FILE" 2>&1
    
    # Also explicitly run firestore:indexes to ensure all composite indexes and overrides are applied
    echo -e "  -> Verifying and deploying specific Firestore Indexes..."
    firebase deploy --only firestore:indexes --project "$PROJECT_ID" >> "$LOG_FILE" 2>&1
    
    mark_step_done "provision_firestore"
fi

if is_step_done "provision_storage"; then
    echo -e "  -> Default Storage bucket already provisioned. Skipping..."
else
    echo -e "  -> Provisioning Default Storage Bucket in europe-west3..."
    BUCKET_NAME="gs://${PROJECT_ID}.appspot.com"
    
    # Check if bucket exists
    if gcloud storage buckets describe "$BUCKET_NAME" --project "$PROJECT_ID" >> "$LOG_FILE" 2>&1; then
        echo -e "    ${YELLOW}-> Storage bucket already exists. Skipping creation.${NC}"
    else
        # For the default <project-id>.appspot.com bucket, we must initialize the App Engine app 
        # because creating it directly via "storage buckets create" results in a domain ownership error.
        gcloud app create --region=europe-west3 --project "$PROJECT_ID" >> "$LOG_FILE" 2>&1
        echo -e "    -> Created default bucket via App Engine initialization: $BUCKET_NAME"
    fi
    mark_step_done "provision_storage"
fi

if is_step_done "cors_config"; then
    echo -e "  -> Storage CORS already configured. Skipping..."
else
    echo -e "  -> Configuring CORS on Storage Buckets..."
    CORS_FILE="$(cd "$(dirname "$0")/.." && pwd)/cors.json"
    gsutil cors set "$CORS_FILE" "gs://${PROJECT_ID}.firebasestorage.app" >> "$LOG_FILE" 2>&1
    gsutil cors set "$CORS_FILE" "gs://${PROJECT_ID}.appspot.com" >> "$LOG_FILE" 2>&1
    echo -e "  -> Verifying CORS configuration..."
    echo -e "  ${CYAN}gs://${PROJECT_ID}.firebasestorage.app:${NC}"
    gsutil cors get "gs://${PROJECT_ID}.firebasestorage.app"
    echo -e "  ${CYAN}gs://${PROJECT_ID}.appspot.com:${NC}"
    gsutil cors get "gs://${PROJECT_ID}.appspot.com"
    mark_step_done "cors_config"
fi

# 5. IAM Role Assignments
if is_step_done "iam_roles"; then
    echo -e "[5/7] IAM Roles already assigned. Skipping..."
else
    echo -e "[5/7] Assigning IAM Roles to Firebase Admin SDK service account..."
    echo -e "  -> Finding service account email..."
    SA_EMAIL=$(gcloud iam service-accounts list --project "$PROJECT_ID" --format="value(email)" --filter="email:firebase-adminsdk")

    if [ -z "$SA_EMAIL" ]; then
        echo -e "${RED}Error: Firebase Admin SDK service account not found.${NC}"
        echo -e "${YELLOW}You may need to open the Firebase Console -> Project Settings -> Service Accounts to trigger its creation.${NC}"
        exit 1
    fi

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
        # Use || true to prevent the script from failing if a specific role assignment fails
        gcloud projects add-iam-policy-binding "$PROJECT_ID" \
            --member="serviceAccount:${SA_EMAIL}" \
            --role="$ROLE" \
            --condition=None \
            >> "$LOG_FILE" 2>&1 || echo -e "  ${YELLOW}-> Warning: Failed to assign $ROLE. Check log for details.${NC}"
    done
    
    # Try the Vision AI Service Agent role, but don't fail if it's not supported
    echo -e "  -> Assigning roles/vision.serviceAgent ..."
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member="serviceAccount:${SA_EMAIL}" \
        --role="roles/vision.serviceAgent" \
        --condition=None \
        >> "$LOG_FILE" 2>&1 || echo -e "  ${YELLOW}-> Warning: roles/vision.serviceAgent not supported for this resource. Skipping.${NC}"

    mark_step_done "iam_roles"
fi

# 6. Environment Configuration
if is_step_done "env_config"; then
    echo -e "[6/7] Environment configuration already generated. Skipping..."
else
    echo -e "[6/7] Generating .env configuration..."
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

# 7. Deployment
if is_step_done "deployment"; then
    echo -e "[7/7] Deployment already completed. Skipping..."
else
    echo -e "[7/7] Deploying Cloud Functions (this may take a few minutes)..."
    firebase deploy --only functions --project "$PROJECT_ID" --non-interactive --force >> "$LOG_FILE" 2>&1
    mark_step_done "deployment"
fi

echo -e "\n${GREEN}=== Setup Complete! ===${NC}"
echo -e "Your new project ${CYAN}${PROJECT_ID}${NC} has been successfully provisioned and deployed."
echo -e "\n${YELLOW}ACTION REQUIRED:${NC}"
echo -e "1. Go to: https://console.firebase.google.com/project/${PROJECT_ID}/authentication/providers"
echo -e "2. Enable 'Email/Password' authentication."
echo -e "3. Once enabled, you can run 'npm run auth:login' to create the initial admin user."
echo -e "4. To deploy the frontend client, navigate to your frontend repository and run:"
echo -e "   ${CYAN}firebase use ${PROJECT_ID} && firebase deploy --only hosting${NC}"
echo -e "\nA copy of the environment variables was saved to ${CYAN}functions/.env.${PROJECT_ID}${NC}"
