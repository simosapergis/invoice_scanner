# AGENTS.md — Invoice Scanner

## 1. Project Overview

- **Greek invoice scanning backend** built on Firebase Cloud Functions (Gen 2) with CLI utilities.
- No frontend in this repo — the PWA client lives in a separate project.
- **Runtime**: Node.js 20, ESM modules (`"type": "module"` in `package.json`).

## 2. Architecture

- **Cloud Functions** live in a single file: `functions/index.js` (~2800 lines).
- **CLI tools** at the project root:
  - `auth_login.js` — Firebase email/password sign-in, returns ID token.
  - `invoice_ocr.js` / `invoice_ocr_2.js` — Local OCR via GPT-4o.
  - `upload_invoice.js` — CLI for auth → signed URL → upload of invoice pages.
  - `signed_url_server.js` — Local Express server for generating signed upload URLs.
- **Invoice processing pipeline**:
  1. Client calls `getSignedUploadUrl_v2` → receives a signed URL → uploads page(s) to GCS.
  2. Storage trigger (`processUploadedInvoice_v2`) writes page metadata into `metadata_invoices`.
  3. Once all pages are uploaded, document status becomes `ready`.
  4. Firestore trigger (`processInvoiceDocument_v2`) downloads pages, merges into a PDF, runs Vision OCR + GPT-4o-mini, and stores the result under `suppliers/{supplierId}/invoices/`.
- **Status flow**: `pending → ready → processing → done | error`.

## 3. Firebase and Deployment

- **Region**: `europe-west6`.
- **Two Firebase projects**:
  - Default: `clean-abacus-482115-a1`
  - Prod: `level-approach-479119-b3`
- **Blue-green deployment**: all functions use a `_v2` suffix during the Gen 1 → Gen 2 migration.
- **Env config**: `functions/.env` is written by `update-env-default.sh` or `update-env-prod.sh`. Functions use `defineString` params — **not** `functions.config()`.
- **Deployment is manual** via the Firebase CLI; there is no CI/CD pipeline.
- **Emulators** are configured in `firebase.json`:
  - Auth: port 9099
  - Functions: port 5001
  - Firestore: port 5002
  - Storage: port 5003
  - Emulator UI: port 5004

## 4. Firestore Data Model

| Collection | Description |
|---|---|
| `metadata_invoices` | Multi-page upload tracking: pages, status, owner UID |
| `suppliers` | Supplier profiles: name, tax number (AFM), category, delivery schedule |
| `suppliers/{id}/invoices` | Individual invoices with OCR-extracted data and payment history |
| `financial_entries` | Income and expense records (manual entries, invoice payments, recurring) |
| `recurring_expenses` | Monthly recurring expenses (rent, utilities, etc.) |

## 5. Code Conventions

- **Indentation**: 2 spaces.
- **Quotes**: single quotes (`'`), double quotes only inside JSON schemas.
- **Semicolons**: always.
- **Naming**: `camelCase` for variables and functions, `UPPER_SNAKE_CASE` for constants.
- **Async**: always use `async/await`. No callbacks.
- **Auth pattern**: `authenticateRequest(req)` returns `{ user }` or `{ error, status }`.
- **Validation**: dedicated validator function per endpoint (e.g., `validatePaymentRequest`, `validateFinancialEntryRequest`).
- **Error handling**: `try/catch` blocks; errors thrown with `Object.assign(new Error(...), { httpStatus })`; errors returned as JSON.
- **Section markers** in `functions/index.js` use banner comments:
  ```
  // ═══════════════════════════════════════════════════════════════════════════════
  // SECTION TITLE
  // ═══════════════════════════════════════════════════════════════════════════════
  ```
- **No linting config**: ESLint and Prettier are not set up.
- **No tests**: no test framework is configured.
- **Greek text** is used in all user-facing strings (error messages, expense categories, field labels).

## 6. Key Patterns and Gotchas

- **Lazy OpenAI init**: the OpenAI client is created on first use via `getOpenAIClient()`, not at module load.
- **Multi-page OCR optimization**: when an invoice has more than 2 pages, only the first and last pages are sent to OCR to reduce cost.
- **Duplicate detection**: same supplier + invoice number with `processingStatus === 'uploaded'` is treated as a duplicate.
- **European decimals**: numbers use comma as decimal separator (e.g., `1.234,56`). `normalizeEuropeanDecimals` is called before OCR parsing.
- **Secrets**: `OPENAI_API_KEY` and other credentials live in `.env` files and shell scripts — these must never be committed.
- **Legacy config**: `functions.config.json` is a dump from the v1 era and is not used by v2 functions.

## 7. Security Rules

- Firestore access control is defined in `firestore.rules`.
- `suppliers` and `invoices` writes are **backend-only** (blocked by security rules).
- `metadata_invoices` updates are restricted to the document owner (`ownerUid`) and only for the `notificationSeen` / `notificationSeenAt` fields.
- All other paths are denied by default.

## 8. Do's and Don'ts

**Do:**
- Use ESM imports (`import ... from '...'`), never CommonJS `require()`.
- Authenticate every HTTP function with `authenticateRequest(req)`.
- Return errors as `{ error: "message" }` JSON with the appropriate HTTP status code.
- Keep user-facing strings in Greek.
- Use `defineString` from `firebase-functions/params` for new environment parameters.
- Follow the `_v2` suffix convention when adding new Cloud Functions.
- Use the `// ═══` banner comment style when adding new sections to `functions/index.js`.
- Write a dedicated validator function for any new endpoint.

**Don't:**
- Don't use `functions.config()` — it is a Gen 1 API.
- Don't modify `update-env-default.sh` or `update-env-prod.sh` (they contain secrets context).
- Don't commit `.env` files or API keys.
- Don't use callback-style async code.
