# invoice_scanner

Greek invoice scanning backend on Firebase Cloud Functions (Gen 2) with CLI tools.

## Prerequisites

- Node.js 22+
- Firebase CLI (`npm install -g firebase-tools`)
- A GCP project with Cloud Vision API enabled
- An OpenAI API key (GPT-4o-mini)

## Quick Start

```bash
npm install
cd functions && npm install && cd ..
```

### New Client Provisioning

The `setup:client` script handles end-to-end project setup: GCP project creation, billing, Firebase, APIs, Firestore/Storage, CORS, IAM, `.env` generation, and function deployment.

```bash
npm run setup:client
```

## CLI Tools

### Firebase Auth (`auth_login.js`)

Sign in with email/password and obtain an ID token for authenticated API calls.

```bash
export FIREBASE_API_KEY=<your-firebase-web-api-key>
# optional: export FIREBASE_AUTH_EMAIL=<email>
# optional: export FIREBASE_AUTH_PASSWORD=<password>
npm run auth:login
```

### Invoice Upload (`upload_invoice.js`)

One-shot upload: authenticates, requests a signed URL, and PUTs the file.

```bash
export FIREBASE_API_KEY=<your-firebase-web-api-key>
export FIREBASE_AUTH_EMAIL=<email>
export FIREBASE_AUTH_PASSWORD=<password>
export FIREBASE_PROJECT_ID=<your-project-id>
export FIREBASE_FUNCTION_REGION=europe-west3

# Start a new invoice (page 1 of 3)
npm run upload:invoice -- ./page1.jpg --page 1 --total-pages 3 --content-type image/jpeg
# Subsequent pages reuse the invoiceId returned above
npm run upload:invoice -- ./page2.jpg --page 2 --invoice-id <invoiceId>
npm run upload:invoice -- ./page3.jpg --page 3 --invoice-id <invoiceId>
```

### Signed URL Server (`signed_url_server.js`)

Local Express server for requesting signed upload URLs during development.

```bash
export FIREBASE_PROJECT_ID=<your-project-id>
export GCS_BUCKET=<your-upload-bucket>
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
npm run signed-url:server
```

```bash
curl -X POST http://localhost:8080/signed-url \
  -H "Authorization: Bearer $FIREBASE_ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"filename":"page1.jpg","contentType":"image/jpeg","pageNumber":1,"totalPages":3}'
```

The response contains `uploadUrl` (V4 signed URL), `objectName`, and `invoiceId`. Reuse the `invoiceId` for subsequent pages; `totalPages` only needs to be supplied once.

## Cloud Functions

All functions are exported from `functions/index.js` with a `_v2` suffix (Gen 2). Region: `europe-west3`.

| Function | Type | Description |
|---|---|---|
| `getSignedUploadUrl_v2` | HTTP | Returns a signed GCS upload URL for a single page |
| `processUploadedInvoice_v2` | Storage trigger | Registers an uploaded page in `metadata_invoices` |
| `processInvoiceDocument_v2` | Firestore trigger | Runs OCR pipeline when all pages are uploaded |
| `updatePaymentStatus_v2` | HTTP | Records a payment against an invoice |
| `updateInvoiceFields_v2` | HTTP | Updates editable fields on an invoice |
| `updateSupplierFields_v2` | HTTP | Updates supplier profile fields |
| `getSignedDownloadUrl_v2` | HTTP | Returns a signed GCS download URL for a stored invoice |
| `addFinancialEntry_v2` | HTTP | Creates a financial entry (income/expense) |
| `deleteFinancialEntry_v2` | HTTP | Deletes a financial entry |
| `getFinancialReport_v2` | HTTP | Returns aggregated financial data for a period |
| `addRecurringExpense_v2` | HTTP | Creates a recurring expense definition |
| `updateRecurringExpense_v2` | HTTP | Updates an existing recurring expense |
| `processRecurringExpenses_v2` | Scheduled | Generates monthly financial entries from recurring expenses |
| `getRecurringExpenses_v2` | HTTP | Lists recurring expenses |
| `exportInvoices_v2` | HTTP | Streams a ZIP of invoices matching filter criteria |

## Invoice Processing Pipeline

1. Client requests signed URLs via `getSignedUploadUrl_v2` and uploads page(s) to GCS.
2. Storage trigger (`processUploadedInvoice_v2`) registers each page in the `metadata_invoices` Firestore document.
3. When all pages arrive, the document status flips to `ready`.
4. Firestore trigger (`processInvoiceDocument_v2`) picks it up with two paths:
   - **Images**: combines pages into a single PDF, runs Vision `documentTextDetection` on first + last pages, sends text to GPT-4o-mini for structured extraction, stores the PDF under `suppliers/{id}/invoices/`.
   - **PDF** (single file): runs Vision `batchAnnotateFiles` from the GCS URI, sends text to GPT-4o-mini, copies the file to its final path via `file.copy()`.
5. Post-OCR: dedup check (supplier + invoice number), supplier upsert, invoice document creation.

**Status flow**: `pending` → `ready` → `processing` → `done` | `error`

## Deployment

```bash
# Deploy all functions
firebase deploy --only functions

# Deploy a specific function
firebase deploy --only functions:getSignedUploadUrl_v2

# Deploy Firestore rules and indexes
firebase deploy --only firestore:rules,firestore:indexes
```

`firebase.json` predeploy runs lint + tests; failures abort the deploy.

## Development

```bash
# Lint
npm run lint --prefix functions

# Format
npm run format --prefix functions

# Run tests
npm test --prefix functions

# Watch mode
npm run test:watch --prefix functions
```

### Emulators

```bash
firebase emulators:start
```

| Service | Port |
|---|---|
| Auth | 9099 |
| Functions | 5001 |
| Firestore | 5002 |
| Storage | 5003 |
| Emulator UI | 5004 |

### Pre-commit Hooks

`simple-git-hooks` + `lint-staged` automatically run lint and tests on staged `functions/**/*.js` files before each commit.

## Environment

Functions use `defineString` parameters (Gen 2). Per-client env files are stored as `functions/.env.<client>` (gitignored). The `setup:client` script generates these automatically.
