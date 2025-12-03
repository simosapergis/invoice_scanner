# invoice_scanner
Scan invoices and extract fields using OCR.

## Prerequisites
- Node.js 18+ installed
- An OpenAI API key with access to GPT-4o / Responses API

## macOS / Linux
### Installation
```bash
npm install
```

### Usage
```bash
export OPENAI_API_KEY=sk-...
npm run invoice:ocr                 # uses invoice.JPG
# or OCR a specific file
node invoice_ocr.js my_invoice.pdf

# One-shot upload (auth → signed URL → PUT)
export FIREBASE_API_KEY=your-firebase-web-api-key
export FIREBASE_AUTH_EMAIL=your-user@example.com
export FIREBASE_AUTH_PASSWORD=super-secret
export FIREBASE_PROJECT_ID=level-approach-479119-b3          # or set SIGNED_URL_ENDPOINT directly
export FIREBASE_FUNCTION_REGION=europe-west8                 # default is us-central1
# Start a new invoice (page 1 of 3)
npm run upload:invoice -- ./invoice-page1.jpg --page 1 --total-pages 3 --content-type image/jpeg
# Reuse the invoiceId returned above for the remaining pages
npm run upload:invoice -- ./invoice-page2.jpg --page 2 --invoice-id <invoiceId>
npm run upload:invoice -- ./invoice-page3.jpg --page 3 --invoice-id <invoiceId>
```

The script uploads the invoice to GPT-4o, performs OCR in Greek, and prints the requested fields plus an `ΑΚΡΙΒΕΙΑ` confidence percentage. Uncomment the schema block in `invoice_ocr.js` if you want to enforce JSON output strictly.

### CLI Firebase Auth (Email/Password)
```bash
export FIREBASE_API_KEY=your-firebase-web-api-key
# optional: export FIREBASE_AUTH_EMAIL=...
# optional: export FIREBASE_AUTH_PASSWORD=...
npm run auth:login
```

The script calls Firebase Authentication’s REST API and prints the ID token and refresh token, which you can then use to request signed upload URLs from your backend.

### Signed URL API (Node server)
```bash
export FIREBASE_PROJECT_ID=your-project-id
export GCS_BUCKET=your-upload-bucket
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
npm run signed-url:server
```

Request an upload URL with the ID token you obtained earlier:

```bash
curl -X POST http://localhost:8080/signed-url \
  -H "Authorization: Bearer $FIREBASE_ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"filename":"invoice-page1.jpg","contentType":"image/jpeg","pageNumber":1,"totalPages":3}'
```

The response contains a `uploadUrl` (V4 signed URL) and `objectName`. Upload the file via HTTP PUT using the provided `uploadUrl`. Reuse the returned `invoiceId` for every subsequent page by including it (together with the new `pageNumber`) in later POST requests; `totalPages` only needs to be supplied once per invoice.

### Cloud Function (production)
Deploy the same logic to Firebase Functions:
1. Set the bucket config once:  
   `firebase functions:config:set uploads.bucket="your-upload-bucket"`
2. Deploy: `firebase deploy --only functions:getSignedUploadUrl`
3. Call the HTTPS endpoint (e.g. `https://<region>-<project>.cloudfunctions.net/getSignedUploadUrl`) with the same POST body and `Authorization: Bearer <Firebase ID token>`.

### Multi-page workflow overview
1. Request signed URLs per page using `getSignedUploadUrl`. The first page must include `totalPages`; the function returns a persistent `invoiceId`.
2. Upload each page to its signed URL. The Storage finalize trigger (`processUploadedInvoice`) automatically records the page inside Firestore at `invoices/{invoiceId}`.
3. When every page is present, the metadata document flips to `ready`, which triggers `processInvoiceDocument`.
4. `processInvoiceDocument` downloads all recorded pages, merges them into a single PDF, performs Vision + OpenAI OCR once, stores the normalized PDF under `suppliers/{supplierId}/invoices/{invoiceId}.pdf`, and writes the structured data back to Firestore.

Invoice document statuses flow as: `pending → ready → processing → done`. If something fails, the status becomes `error` with `errorMessage` so you can retry by resetting the status to `pending`.

## Windows (PowerShell)
### Installation
```powershell
npm install
```

### Usage
```powershell
$env:OPENAI_API_KEY = "sk-..."
npm run invoice:ocr                 # uses invoice.JPG
# or OCR a specific file
node invoice_ocr.js .\my_invoice.pdf

# Firebase email/password login (prints ID token)
$env:FIREBASE_API_KEY = "your-firebase-web-api-key"
npm run auth:login

# One-shot upload (auth → signed URL → PUT)
$env:FIREBASE_API_KEY = "your-firebase-web-api-key"
$env:FIREBASE_AUTH_EMAIL = "your-user@example.com"
$env:FIREBASE_AUTH_PASSWORD = "super-secret"
$env:FIREBASE_PROJECT_ID = "level-approach-479119-b3"   # or set SIGNED_URL_ENDPOINT
#$env:FIREBASE_FUNCTION_REGION = "europe-west8"
# Page 1 of a 2-page invoice
npm run upload:invoice -- .\invoice-page1.jpg --page 1 --total-pages 2 --content-type image/jpeg
# Subsequent pages reuse the invoiceId returned earlier
npm run upload:invoice -- .\invoice-page2.jpg --page 2 --invoice-id <invoiceId>

# Signed URL server
$env:FIREBASE_PROJECT_ID = "your-project-id"
$env:GCS_BUCKET = "your-upload-bucket"
$env:GOOGLE_APPLICATION_CREDENTIALS = "C:\path\to\service-account.json"
npm run signed-url:server

# Cloud Function config (one-time)
firebase functions:config:set uploads.bucket="your-upload-bucket"
firebase deploy --only functions:getSignedUploadUrl
```
