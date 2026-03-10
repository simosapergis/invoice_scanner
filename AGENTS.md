# AGENTS.md — Invoice Scanner

## 0. Guiding Principles

Think like a **Principal GCP Architect**. Evaluate every decision through GCP-native services, pricing, and limits.

- **Cost > Performance** (bootstrapped project). Cost wins unless degradation is user-facing and severe (> 2 s latency).
- Favour server-side orchestration over client-side workarounds.
- Consider cold-start latency, memory limits, execution timeouts, and regional co-location for Cloud Functions.
- Prefer streaming over buffering for large payloads (ZIP generation, PDF aggregation).
- Use signed URLs for all GCS client access — never expose buckets directly.
- Minimize invocations (batch, avoid fan-out), Firestore reads/writes (cache, denormalize), and GCS egress.
- Prefer `minInstances: 0`, smallest viable memory, short execution times.
- Question every per-request cost API call (OpenAI tokens, Vision API) — reduce payload/frequency first.
- Use `Promise.all` for independent I/O; lazy-load heavy deps; use Firestore composite indexes.
- Consider idempotency, retry safety, and at-least-once delivery for async work.
- **GDPR**: data privacy and secure handling must be considered in all solutions.

## 1. Project Overview

- **Greek invoice scanning backend** on Firebase Cloud Functions (Gen 2) + CLI tools.
- No frontend — the PWA client is a separate repo.
- **Runtime**: Node.js 22, ESM (`"type": "module"`).

## 2. Architecture

**Cloud Functions** in `functions/`, modularized:
- `index.js` — handler wiring, all Cloud Function exports.
- `lib/config.js` — `admin.initializeApp()`, `defineString` params, shared constants.
- `lib/auth.js` — `authenticateRequest`, `extractBearerToken`, `getUserDisplayName`.
- `lib/http-utils.js` — `HTTP_OPTS` (includes `invoker: 'public'` for CORS preflight; auth via `authenticateRequest`), `requireMethod`, `sendError`.
- `lib/invoice-upload.js` — `parseUploadObjectName`, `registerUploadedPage`, `ensureInvoiceDocument`.
- `lib/invoice-ocr.js` — `runInvoiceOcr`, `runInvoiceOcrAttempt`, OCR prompts/schema, `getOpenAIClient`, `getVisionClient`; image OCR (`documentTextDetection`) + PDF OCR (`batchAnnotateFiles` via GCS URI).
- `lib/invoice-pdf.js` — `convertBufferToPdf`, `buildCombinedPdfFromPages`.
- `lib/invoice-processor.js` — `processInvoiceDocumentHandler` (lock, OCR, dedup, supplier upsert, Firestore writes); PDF vs image branching.
- `lib/payments.js` — `validatePaymentRequest`, `derivePaymentStatus`, `validateUpdateFieldsRequest`.
- `lib/suppliers.js` — `validateUpdateSupplierRequest`, `validateDeliveryObject`, `validateTimeObject`.
- `lib/financial.js` — `ENTRY_TYPE`, `EXPENSE_CATEGORY`, `buildFinancialEntry`, `validateFinancialEntryRequest`, `validateUpdateFinancialEntryRequest`.
- `lib/recurring.js` — `validateRecurringExpenseRequest`.
- `lib/invoice-export.js` — `validateExportRequest`, `fetchInvoiceDocuments`, `recordDownloads`, `streamInvoicesZip`, `getExportDownloadUrl`.

**CLI tools** (project root): `auth_login.js` (sign-in, ID token), `upload_invoice.js` (auth → signed URL → upload), `signed_url_server.js` (local Express signed-URL server).

**Scripts**: `scripts/setup_new_client.sh` — end-to-end client provisioning: creates GCP project, links billing, adds Firebase, enables APIs, provisions Firestore/Storage, configures CORS, assigns IAM roles, generates `.env`, deploys functions. Resumable via per-project state file. Run via `npm run setup:client`. `scripts/set_display_names.js` — one-time script to set `displayName` on Firebase Auth accounts.

**Invoice processing pipeline**:
1. Client → `getSignedUploadUrl_v2` → signed URL → uploads page(s) to GCS.
2. Storage trigger (`processUploadedInvoice_v2`) → page metadata into `metadata_invoices`.
3. All pages uploaded → status becomes `ready`.
4. Firestore trigger (`processInvoiceDocument_v2`) → two paths:
   - **Images**: `buildCombinedPdfFromPages` → Vision `documentTextDetection` (first+last pages) → GPT-4o-mini → store under `suppliers/{id}/invoices/`.
   - **PDF** (single file): skip combining; Vision `batchAnnotateFiles` from GCS URI with `pages: [1, N]`; server-side `file.copy()` to final path.
5. **Status flow**: `pending → ready → processing → done | error`.

## 3. Firebase & Deployment

- **Region**: `europe-west3`.
- **Projects**: `.firebaserc` is gitignored (local working-state only); `firebase use <id>` sets the active project. New clients provisioned end-to-end via `npm run setup:client`.
- **Blue-green**: all functions use `_v2` suffix (Gen 1 → Gen 2 migration).
- **Env**: `functions/.env` written by `update-env-default.sh` / `update-env-prod.sh`; per-client snapshots as `functions/.env.<client>`. All matched by `.env*` in `.gitignore`. Functions use `defineString` — **not** `functions.config()`.
- **Deploy**: manual via Firebase CLI. `firebase.json` predeploy runs lint + tests; failures abort deploy.
- **Pre-commit**: `simple-git-hooks` + `lint-staged` run lint + tests on staged `functions/**/*.js`.
- **Emulators** (`firebase.json`): Auth 9099, Functions 5001, Firestore 5002, Storage 5003, UI 5004.

## 4. Firestore Data Model

| Collection | Description |
|---|---|
| `metadata_invoices` | Multi-page upload tracking: pages, status, owner UID |
| `suppliers` | Supplier profiles: name, AFM, category, delivery schedule |
| `suppliers/{id}/invoices` | Invoices with OCR data and payment history |
| `financial_entries` | Income/expense records (manual, invoice payments, recurring) |
| `recurring_expenses` | Monthly recurring expenses (rent, utilities, etc.) |

## 5. Code Conventions

- 2-space indent, single quotes, always semicolons.
- `camelCase` for vars/functions, `UPPER_SNAKE_CASE` for constants.
- Always `async/await`, never callbacks.
- Auth: `authenticateRequest(req)` → `{ user }` or `{ error, status }`.
- Validation: dedicated validator per endpoint.
- Errors: `sendError(res, status, message, { details?, code? })` from `lib/http-utils.js`.
- HTTP: `HTTP_OPTS` for `onRequest` options; `requireMethod(req, res, 'POST')` for method checks.
- Section markers in `index.js`: `// ═══...═══ SECTION TITLE ═══...═══` banner comments.
- Linting: ESLint 9+ (flat config) + Prettier. Run `npm run lint` / `npm run format`.
- Testing: Vitest in `functions/test/`, mocks in `setup.js`. Run `npm test` or `npm run test:watch`.
- All user-facing strings in **Greek**.

## 6. Key Patterns & Gotchas

- **Lazy init**: OpenAI (`getOpenAIClient()`) and Vision (`getVisionClient()`) created on first use.
- **Multi-page OCR optimization**: >2 pages → only first + last sent to OCR. Images: filtered in `runInvoiceOcr`. PDFs: via Vision `pages` parameter.
- **PDF dual-path**: single PDF upload → skip `buildCombinedPdfFromPages`; GCS `file.copy()` + `batchAnnotateFiles` from URI.
- **GCS CORS**: generated dynamically by `setup_new_client.sh` using `$PROJECT_ID` for origins; applied to both `.appspot.com` and `.firebasestorage.app` buckets.
- **Financial entry edits**: `editFinancialEntry_v2` — manual + recurring only; `invoice_payment` is read-only. Recurring cannot change `type`.
- **Dedup**: same supplier + invoice number with `processingStatus === 'uploaded'` = duplicate.
- **European decimals**: comma separator (e.g., `1.234,56`). `normalizeEuropeanDecimals` before parsing.
- **Secrets**: `.env` files and shell scripts — never commit.
- **Display name denormalization**: every UID audit field (e.g. `createdBy`) has a `*Name` companion via `getUserDisplayName(decodedToken)` (fallback: `name` → `email` → `uid`). Names ride the ID token; historical records are immutable.
- **Timezone**: For Athens-local dates use `getAthensToday()` / `formatAthensDate()` from `lib/config.js`. Store dates as UTC; convert to `Europe/Athens` only at boundaries.
- **Legacy**: `functions.config.json` is a v1 dump, unused by v2.

## 7. Security Rules

- Defined in `firestore.rules`. All paths denied by default.
- `suppliers` + `invoices` writes: backend-only.
- `metadata_invoices` updates: owner only, `notificationSeen` / `notificationSeenAt` fields only.

## 8. Do's and Don'ts

**Do:**
- ESM imports only (`import ... from '...'`).
- `authenticateRequest(req)` on every HTTP function. Use `getUserDisplayName(user)` for all `*Name` audit fields.
- `sendError(res, status, message)` for error responses.
- Greek user-facing strings.
- `defineString` for new env params.
- `_v2` suffix on new Cloud Functions.
- `// ═══` banner style for new `index.js` sections.
- Dedicated validator for each new endpoint.
- `getAthensToday()` / `formatAthensDate()` for any Athens-local date logic. Never derive calendar dates from raw `new Date()`.
- Unit tests for every new helper/validator/business-logic function (`functions/test/<module>.test.js`). New uncovered code MUST get tests.
- Run `npm run lint` + `npm test` in `functions/` after every change. Fix failures before completing.
- **Keep this file current**: after any addition or change, evaluate if `AGENTS.md` needs updating and do so in the same task.
- **Keep this file concise** (target ≤ 130 lines). When adding content, tighten or restructure to stay within the limit. Always adhere to the practices documented here.

**Don't:**
- `functions.config()` (Gen 1 API). Modify `update-env-*.sh` (secrets context). Commit `.env` files or API keys.
- `Co-authored-by` or other trailers in commit messages.

**When solving any problem, think always step by step and better be sure with your solution**
