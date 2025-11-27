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
  -d '{"filename":"invoice.jpg","contentType":"image/jpeg"}'
```

The response contains a `uploadUrl` (V4 signed URL) and `objectName`. Upload the file via HTTP PUT using the provided `uploadUrl`.

### Cloud Function (production)
Deploy the same logic to Firebase Functions:
1. Set the bucket config once:  
   `firebase functions:config:set uploads.bucket="your-upload-bucket"`
2. Deploy: `firebase deploy --only functions:getSignedUploadUrl`
3. Call the HTTPS endpoint (e.g. `https://<region>-<project>.cloudfunctions.net/getSignedUploadUrl`) with the same POST body and `Authorization: Bearer <Firebase ID token>`.

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

# Signed URL server
$env:FIREBASE_PROJECT_ID = "your-project-id"
$env:GCS_BUCKET = "your-upload-bucket"
$env:GOOGLE_APPLICATION_CREDENTIALS = "C:\path\to\service-account.json"
npm run signed-url:server

# Cloud Function config (one-time)
firebase functions:config:set uploads.bucket="your-upload-bucket"
firebase deploy --only functions:getSignedUploadUrl
```
