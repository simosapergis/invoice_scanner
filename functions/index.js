const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { Storage } = require('@google-cloud/storage');
const vision = require('@google-cloud/vision');
const { PDFDocument } = require('pdf-lib');
const OpenAI = require('openai');
const crypto = require('crypto');

const app = admin.initializeApp();

const storage = new Storage();
const visionClient = new vision.ImageAnnotatorClient();
const db = admin.firestore();
const UPLOADS_PREFIX = 'uploads/';
const METADATA_INVOICE_COLLECTION = 'metadata_invoices';
const SERVICE_ACCOUNT_EMAIL = 'mylogia@level-approach-479119-b3.iam.gserviceaccount.com';
const SIGNED_URL_TTL_MS = 15 * 60 * 1000;
const INVOICE_STATUS = {
  pending: 'pending',
  ready: 'ready',
  processing: 'processing',
  done: 'done',
  uploaded: 'uploaded',
  error: 'error'
};
const PAYMENT_STATUS = {
  unpaid: 'unpaid',
  paid: 'paid',
  partiallyPaid: 'partially_paid'
};
const serverTimestamp = admin.firestore.FieldValue.serverTimestamp;
const REQUIRED_FIELDS = [
  'ΗΜΕΡΟΜΗΝΙΑ',
  'ΑΡΙΘΜΟΣ ΤΙΜΟΛΟΓΙΟΥ',
  'ΠΡΟΜΗΘΕΥΤΗΣ',
  'ΑΦΜ ΠΡΟΜΗΘΕΥΤΗ',
  'ΚΑΘΑΡΗ ΑΞΙΑ',
  'ΦΠΑ',
  'ΠΛΗΡΩΤΕΟ',
  'ΑΚΡΙΒΕΙΑ'
];

const FIELD_LABELS = {
  'ΗΜΕΡΟΜΗΝΙΑ': 'invoiceDate',
  'ΑΡΙΘΜΟΣ ΤΙΜΟΛΟΓΙΟΥ': 'invoiceNumber',
  'ΠΡΟΜΗΘΕΥΤΗΣ': 'supplierName',
  'ΑΦΜ ΠΡΟΜΗΘΕΥΤΗ': 'supplierTaxNumber',
  'ΚΑΘΑΡΗ ΑΞΙΑ': 'netAmount',
  'ΦΠΑ': 'vat',
  'ΠΛΗΡΩΤΕΟ': 'totalAmount',
  'ΑΚΡΙΒΕΙΑ': 'confidence'
};

const openAiApiKey = process.env.OPENAI_API_KEY || functions.config().openai?.key;
const openaiClient = openAiApiKey ? new OpenAI({ apiKey: openAiApiKey }) : null;
const OCR_MAX_RETRIES = 3;

// ═══════════════════════════════════════════════════════════════════════════════
// FCM CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════
const USERS_COLLECTION = 'users';
const FCM_TOKEN_STALE_DAYS = 60;
const FCM_INVALID_TOKEN_ERRORS = [
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/mismatched-sender-id'
];

function extractBearerToken(headerValue) {
  if (!headerValue) return null;
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function sanitizeFilename(name) {
  return name ? name.replace(/[^a-zA-Z0-9._-]/g, '_') : crypto.randomUUID();
}

function sanitizeId(value, fallback) {
  if (!value) return fallback;
  return value
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 64) || fallback;
}

function parseAmount(value) {
  if (value === null || value === undefined) return null;

  // Remove everything except digits, dot, and minus (decimals already normalized before GPT)
  const str = value.toString().replace(/[^\d.\-]/g, '');
  if (!str) return null;

  const num = Number(str);
  return Number.isFinite(num) ? num : null;
}

/**
 * Normalize European decimal format in OCR text before sending to GPT.
 * Converts "2.383,13" → "2383.13" so GPT sees standard decimal notation.
 */
function normalizeEuropeanDecimals(text) {
  // Match European format: optional thousands separators (.) followed by comma decimal
  // Examples: 2.383,13 | 383,13 | 1.234.567,89
  return text.replace(
    /\b(\d{1,3}(?:\.\d{3})*),(\d{1,2})\b/g,
    (_, intPart, decPart) => intPart.replace(/\./g, '') + '.' + decPart
  );
}

function parseDate(value) {
  if (!value) return null;

  // European format: dd/mm/yyyy or dd-mm-yyyy
  const euMatch = value.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/);
  if (euMatch) {
    const [, day, month, year] = euMatch;
    const date = new Date(Date.UTC(
      parseInt(year, 10),
      parseInt(month, 10) - 1,
      parseInt(day, 10)
    ));
    if (!Number.isNaN(date.getTime())) {
      return admin.firestore.Timestamp.fromDate(date);
    }
  }

  // ISO format: yyyy-mm-dd
  const isoMatch = value.match(/^(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    const date = new Date(Date.UTC(
      parseInt(year, 10),
      parseInt(month, 10) - 1,
      parseInt(day, 10)
    ));
    if (!Number.isNaN(date.getTime())) {
      return admin.firestore.Timestamp.fromDate(date);
    }
  }

  // Fallback for other formats
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return admin.firestore.Timestamp.fromDate(date);
}

async function ensureSupplierProfile({
  supplierId,
  supplierName,
  supplierTaxNumber,
  supplierCategory
}) {
  if (!supplierId) {
    console.warn('Missing supplierId; skipping supplier profile update.');
    return;
  }

  const supplierRef = db.doc(`suppliers/${supplierId}`);

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(supplierRef);
      if (!snap.exists) {
        tx.set(supplierRef, {
          name: supplierName || null,
          supplierCategory: supplierCategory || null,
          supplierTaxNumber: supplierTaxNumber || null,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
        return;
      }

      const current = snap.data() || {};
      const updates = {};
      if (!current.name && supplierName) {
        updates.name = supplierName;
      }
      if (!current.supplierCategory && supplierCategory) {
        updates.supplierCategory = supplierCategory;
      }
      if (!current.supplierTaxNumber && supplierTaxNumber) {
        updates.supplierTaxNumber = supplierTaxNumber;
      }

      if (Object.keys(updates).length) {
        updates.updatedAt = serverTimestamp();
        tx.update(supplierRef, updates);
      }
    });
  } catch (error) {
    console.error(`Failed to upsert supplier profile for ${supplierId}`, error);
  }
}

/**
 * Sends FCM notification to a user when invoice processing completes.
 * Automatically cleans up invalid/expired tokens.
 * 
 * @param {string} userId - The user ID to notify
 * @param {Object} payload - Notification payload
 * @param {string} payload.invoiceId - Invoice ID
 * @param {string} payload.status - 'done' | 'error'
 * @param {string} [payload.supplierId] - Supplier ID (on success)
 * @param {string} [payload.supplierName] - Supplier name (on success)
 * @param {string} [payload.invoiceNumber] - Invoice number (on success)
 * @param {string} [payload.errorMessage] - Error message (on error)
 */
async function sendInvoiceNotification(userId, payload) {
  if (!userId) {
    console.warn('sendInvoiceNotification: No userId provided, skipping.');
    return { sent: 0, failed: 0, cleaned: 0 };
  }

  const userRef = db.doc(`${USERS_COLLECTION}/${userId}`);
  const userDoc = await userRef.get();

  if (!userDoc.exists) {
    console.warn(`sendInvoiceNotification: User ${userId} not found.`);
    return { sent: 0, failed: 0, cleaned: 0 };
  }

  const userData = userDoc.data();
  const fcmTokens = userData.fcmTokens || {};
  const tokenEntries = Object.entries(fcmTokens);

  if (!tokenEntries.length) {
    console.log(`sendInvoiceNotification: User ${userId} has no FCM tokens.`);
    return { sent: 0, failed: 0, cleaned: 0 };
  }

  // Build FCM data message (all values must be strings)
  const dataPayload = {
    type: 'invoice_processed',
    invoiceId: payload.invoiceId || '',
    status: payload.status || '',
    supplierId: payload.supplierId || '',
    supplierName: payload.supplierName || '',
    invoiceNumber: payload.invoiceNumber || '',
    errorMessage: payload.errorMessage || '',
    timestamp: new Date().toISOString()
  };

  const tokensToDelete = [];
  let sent = 0;
  let failed = 0;

  for (const [tokenId, tokenData] of tokenEntries) {
    const token = typeof tokenData === 'string' ? tokenData : tokenData?.token;
    if (!token) {
      tokensToDelete.push(tokenId);
      continue;
    }

    try {
      await admin.messaging().send({
        token,
        data: dataPayload,
        // Optional: Add notification for display when app is in background
        notification: payload.status === 'done'
          ? {
              title: 'Invoice Processed',
              body: payload.invoiceNumber
                ? `Invoice ${payload.invoiceNumber} from ${payload.supplierName || 'supplier'} is ready`
                : 'Your invoice has been processed successfully'
            }
          : {
              title: 'Invoice Processing Failed',
              body: payload.errorMessage || 'There was an error processing your invoice'
            },
        android: {
          priority: 'high',
          notification: { channelId: 'invoices' }
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              badge: 1
            }
          }
        }
      });

      sent++;

      // Update lastActiveAt for this token
      await userRef.update({
        [`fcmTokens.${tokenId}.lastActiveAt`]: admin.firestore.Timestamp.now()
      });

    } catch (error) {
      failed++;
      console.error(`FCM send failed for user ${userId}, token ${tokenId}:`, error.code || error.message);

      // Check if token is permanently invalid
      if (FCM_INVALID_TOKEN_ERRORS.includes(error.code)) {
        console.warn(`Marking invalid FCM token for deletion: ${tokenId}`);
        tokensToDelete.push(tokenId);
      }
    }
  }

  // Batch delete invalid tokens
  if (tokensToDelete.length > 0) {
    const updates = {};
    for (const tokenId of tokensToDelete) {
      updates[`fcmTokens.${tokenId}`] = admin.firestore.FieldValue.delete();
    }
    try {
      await userRef.update(updates);
      console.log(`Cleaned ${tokensToDelete.length} invalid FCM tokens for user ${userId}`);
    } catch (cleanupError) {
      console.error(`Failed to cleanup FCM tokens for user ${userId}:`, cleanupError);
    }
  }

  console.log(`FCM notification result for user ${userId}: sent=${sent}, failed=${failed}, cleaned=${tokensToDelete.length}`);
  return { sent, failed, cleaned: tokensToDelete.length };
}

function collectResponseText(response) {
  const chunks = [];
  if (Array.isArray(response?.output)) {
    for (const block of response.output) {
      if (!Array.isArray(block?.content)) continue;
      for (const part of block.content) {
        if (typeof part?.text === 'string') chunks.push(part.text);
        else if (typeof part?.output_text === 'string') chunks.push(part.output_text);
        else if (typeof part?.value === 'string') chunks.push(part.value);
      }
    }
  }
  if (Array.isArray(response?.output_text)) {
    chunks.push(...response.output_text);
  }
  return chunks.join('\n').trim();
}

function parseJsonFromResponse(text) {
  if (!text) throw new Error('Empty OCR response');
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found in OCR response');
    return JSON.parse(match[0]);
  }
}

function getBucketName() {
  return process.env.GCS_BUCKET || functions.config().uploads?.bucket;
}

function invoiceDocRef(invoiceId) {
  return db.collection(METADATA_INVOICE_COLLECTION).doc(invoiceId);
}

function normalizeInvoiceId(invoiceId) {
  return invoiceId || crypto.randomUUID();
}

function normalizeTotalPages(totalPages) {
  if (totalPages === undefined || totalPages === null) return null;
  const value = Number(totalPages);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('totalPages must be a positive integer');
  }
  return value;
}

function normalizePageNumber(pageNumber) {
  const value = Number(pageNumber);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('pageNumber must be a positive integer');
  }
  return value;
}

function padPageNumber(pageNumber) {
  return String(pageNumber).padStart(3, '0');
}

async function ensureInvoiceDocument({ invoiceId, uid, bucketName, totalPages }) {
  const resolvedInvoiceId = normalizeInvoiceId(invoiceId);
  const normalizedTotalPages = normalizeTotalPages(totalPages);
  const docRef = invoiceDocRef(resolvedInvoiceId);

  const metadata = await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) {
      if (normalizedTotalPages === null) {
        throw new Error('totalPages must be provided when starting a new invoice.');
      }

      tx.set(docRef, {
        invoiceId: resolvedInvoiceId,
        ownerUid: uid,
        bucket: bucketName,
        storageFolder: `${UPLOADS_PREFIX}${resolvedInvoiceId}`,
        status: INVOICE_STATUS.pending,
        totalPages: normalizedTotalPages,
        uploadedPages: [],
        uploadedCount: 0,
        pages: [],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });

      return {
        invoiceId: resolvedInvoiceId,
        totalPages: normalizedTotalPages,
        bucket: bucketName,
        status: INVOICE_STATUS.pending
      };
    }

    const existing = snap.data();
    if (
      existing.totalPages &&
      normalizedTotalPages &&
      existing.totalPages !== normalizedTotalPages
    ) {
      throw new Error('totalPages does not match the existing invoice metadata');
    }

    tx.update(docRef, {
      totalPages: existing.totalPages || normalizedTotalPages || null,
      bucket: existing.bucket || bucketName,
      ownerUid: existing.ownerUid || uid,
      updatedAt: serverTimestamp()
    });

    return {
      ...existing,
      invoiceId: resolvedInvoiceId,
      totalPages: existing.totalPages || normalizedTotalPages || null,
      bucket: existing.bucket || bucketName,
      status: existing.status || INVOICE_STATUS.pending
    };
  });

  return metadata;
}

async function registerUploadedPage({
  invoiceId,
  pageNumber,
  objectName,
  bucketName,
  contentType,
  totalPages,
  uid
}) {
  const normalizedPageNumber = normalizePageNumber(pageNumber);
  const normalizedTotalPages = normalizeTotalPages(totalPages);
  const docRef = invoiceDocRef(invoiceId);

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) {
      throw new Error(`Invoice ${invoiceId} metadata not found`);
    }

    const data = snap.data();
    if (data.ownerUid && uid && data.ownerUid !== uid) {
      throw new Error('You do not have access to this invoice.');
    }

    const resolvedTotalPages = data.totalPages || normalizedTotalPages;
    if (!resolvedTotalPages) {
      throw new Error('totalPages must be specified before uploading pages');
    }

    if (normalizedTotalPages && resolvedTotalPages !== normalizedTotalPages) {
      throw new Error('totalPages does not match existing metadata');
    }

    if (normalizedPageNumber > resolvedTotalPages) {
      throw new Error('pageNumber cannot exceed totalPages');
    }

    const uploadedPages = new Set(Array.isArray(data.uploadedPages) ? data.uploadedPages : []);
    uploadedPages.add(normalizedPageNumber);

    const pages = Array.isArray(data.pages)
      ? data.pages.filter((entry) => entry?.pageNumber !== normalizedPageNumber)
      : [];
    pages.push({
      pageNumber: normalizedPageNumber,
      objectName,
      bucket: bucketName,
      contentType: contentType || 'application/octet-stream',
      recordedAt: admin.firestore.Timestamp.now()
    });
    pages.sort((a, b) => a.pageNumber - b.pageNumber);

    const shouldMarkReady =
      uploadedPages.size === resolvedTotalPages && data.status === INVOICE_STATUS.pending;

    tx.update(docRef, {
      totalPages: resolvedTotalPages,
      uploadedPages: Array.from(uploadedPages).sort((a, b) => a - b),
      uploadedCount: uploadedPages.size,
      pages,
      bucket: bucketName || data.bucket,
      ownerUid: data.ownerUid || uid,
      status: shouldMarkReady ? INVOICE_STATUS.ready : data.status,
      readyAt: shouldMarkReady ? serverTimestamp() : data.readyAt || null,
      updatedAt: serverTimestamp()
    });

    return {
      invoiceId,
      status: shouldMarkReady ? INVOICE_STATUS.ready : data.status,
      uploadedPages: Array.from(uploadedPages),
      totalPages: resolvedTotalPages
    };
  });

  return result;
}

function parseUploadObjectName(objectName) {
  if (!objectName || !objectName.startsWith(UPLOADS_PREFIX)) {
    return null;
}

  const remainder = objectName.slice(UPLOADS_PREFIX.length);
  const [invoiceId, rest] = remainder.split('/', 2);
  if (!invoiceId || !rest) return null;

  const pageMatch = rest.match(/^page-(\d{1,4})-/i);
  if (!pageMatch) return null;

  const pageNumber = Number(pageMatch[1]);
  const originalFilename = rest.slice(pageMatch[0].length);

  return {
    invoiceId,
    pageNumber,
    originalFilename
  };
}

async function convertBufferToPdf(buffer, mimeType = 'image/jpeg') {
  if (mimeType === 'application/pdf') {
    return buffer;
  }

  const pdfDoc = await PDFDocument.create();
  let embeddedImage;

  if (mimeType === 'image/png') {
    embeddedImage = await pdfDoc.embedPng(buffer);
  } else {
    // pdf-lib supports JPEG/JPG via embedJpg; fall back to it for other bitmap formats
    embeddedImage = await pdfDoc.embedJpg(buffer);
  }

  const { width, height } = embeddedImage;
  const page = pdfDoc.addPage([width, height]);
  page.drawImage(embeddedImage, { x: 0, y: 0, width, height });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

async function buildCombinedPdfFromPages(pageEntries, defaultBucket) {
  if (!Array.isArray(pageEntries) || pageEntries.length === 0) {
    throw new Error('No invoice pages were provided for OCR.');
  }

  const combinedPdf = await PDFDocument.create();
  const downloadedPages = [];

  for (const entry of pageEntries) {
    const bucketName = entry.bucket || defaultBucket;
    if (!bucketName) {
      throw new Error(`Missing bucket configuration for page ${entry.pageNumber}`);
    }

    if (!entry.objectName) {
      throw new Error(`Missing object name for page ${entry.pageNumber}`);
    }

    const [buffer] = await storage.bucket(bucketName).file(entry.objectName).download();
    const mimeType = entry.contentType || 'application/octet-stream';
    downloadedPages.push({
      pageNumber: entry.pageNumber,
      buffer,
      mimeType,
      objectName: entry.objectName,
      bucketName
    });

    if (mimeType === 'application/pdf') {
      const pdfDoc = await PDFDocument.load(buffer);
      const pageIndices = Array.from({ length: pdfDoc.getPageCount() }, (_, index) => index);
      const copiedPages = await combinedPdf.copyPages(pdfDoc, pageIndices);
      copiedPages.forEach((page) => combinedPdf.addPage(page));
      continue;
    }

    const singlePagePdfBuffer = await convertBufferToPdf(buffer, mimeType);
    const singlePageDoc = await PDFDocument.load(singlePagePdfBuffer);
    const [copiedPage] = await combinedPdf.copyPages(singlePageDoc, [0]);
    combinedPdf.addPage(copiedPage);
  }

  const combinedBuffer = await combinedPdf.save();
  return {
    combinedPdfBuffer: Buffer.from(combinedBuffer),
    downloadedPages
  };
}

async function runInvoiceOcr(pageBuffers) {
  if (!openaiClient) {
    console.warn('OPENAI_API_KEY not configured; skipping OCR.');
    return null;
  }

  if (!Array.isArray(pageBuffers) || !pageBuffers.length) {
    console.warn('No page buffers provided for OCR.');
    return null;
  }

  let lastError = null;
  for (let attempt = 1; attempt <= OCR_MAX_RETRIES; attempt++) {
    try {
      const result = await runInvoiceOcrAttempt(pageBuffers);
      if (result) {
        if (attempt > 1) {
          console.log(`OCR succeeded on retry attempt ${attempt}.`);
        }
        return result;
      }
      lastError = new Error('OCR attempt produced no result.');
      console.warn(`OCR attempt ${attempt} produced no result; retrying...`);
    } catch (error) {
      lastError = error;
      console.error(`OCR attempt ${attempt} failed`, error);
    }
  }

  throw lastError || new Error(`OCR failed after ${OCR_MAX_RETRIES} attempts`);
}

async function runInvoiceOcrAttempt(pageBuffers) {
  const aggregatedText = [];
  for (const page of pageBuffers) {
    const mimeType = page.mimeType || 'application/octet-stream';
    if (mimeType === 'application/pdf') {
      console.warn(
        `Skipping PDF page ${page.pageNumber} for Vision OCR; expected image formats.`,
        { mimeType }
      );
      continue;
    }

    try {
      const [visionResult] = await visionClient.documentTextDetection({
        image: { content: page.buffer }
      });
      const pageText = visionResult?.fullTextAnnotation?.text?.trim();
      if (pageText) {
        aggregatedText.push(`=== PAGE ${page.pageNumber} ===\n${pageText}`);
      } else {
        console.warn(`Vision returned empty text for page ${page.pageNumber}`);
      }
    } catch (visionError) {
      console.error('Vision API failed to read invoice text', { mimeType }, visionError);
      throw visionError;
    }
  }

  const ocrText = aggregatedText.join('\n\n');
  if (!ocrText) {
    throw new Error('Vision API did not return any text for this invoice.');
  }

  // Normalize European decimals (2.383,13 → 2383.13) before GPT
  const fullText = normalizeEuropeanDecimals(ocrText);

  console.log('Vision API returned BELOW TEXT******************* for this invoice.');
  console.log(fullText);
  console.log('Vision API returned ABOVE TEXT******************* for this invoice.');

  const systemPrompt = [
    'You are an expert accountant and document-analysis specialist for Greek invoices.',
    'You ALWAYS output strictly valid JSON following the schema provided by the user.',
    '',
    'You will be given the FULL multi-page OCR text of a Greek invoice.',
    'The OCR may be noisy, misordered, or contain junk text from headers, footers, or page numbers.',
    'The OCR you receive contains multiple pages in the format',
    '=== PAGE 1 ===',
    '... page 1 text ...',
    '=== PAGE 2 ===',
    '... page 2 text ...',
    '=== PAGE N ===',
    '... page N text ...',
    '',
    '===========================',
    'GENERAL EXTRACTION RULES',
    '===========================',
    '0. Treat each page independently. Do not mix data from different pages.',
    '1. Extract ONLY data from the actual invoice content. Ignore:',
    '   - phone numbers',
    '   - website URLs',
    '   - footer disclaimers',
    '   - repeated totals from intermediate sections',
    '',
    '2. Multi-page logic:',
    '   - Supplier information ALWAYS appears on page 1.',
    '   - Financial totals (Net, VAT, Payable) ALWAYS appear on the LAST page.',
    '   - Do NOT mix totals from earlier pages.',
    '   - If multiple candidates appear, prefer the last page\'s values.',
    '',
    '3. Supplier (ΠΡΟΜΗΘΕΥΤΗΣ):',
    '   - The supplier is the ISSUING company shown in the document header (top area of page 1).',
    '   - Supplier info typically appears BEFORE any "ΣΤΟΙΧΕΙΑ ΠΕΛΑΤΗ" or "ΣΤΟΙΧΕΙΑ ΑΠΟΣΤΟΛΗΣ" sections.',
    '   - The supplier block contains: company name/logo, address, phone, ΑΦΜ, ΔΟΥ.',
    '   - NEVER confuse supplier with customer. The customer appears AFTER sections like:',
    '     "ΣΤΟΙΧΕΙΑ ΠΕΛΑΤΗ", "ΕΠΩΝΥΜΙΑ ΠΕΛΑΤΗ", "ΠΕΛΑΤΗΣ", "ΑΠΟΔΕΚΤΗΣ", "ΠΑΡΑΛΗΠΤΗΣ".',
    '   - If no name is clearly in the header, return null.',
    '',
    '4. Supplier TAX ID (ΑΦΜ ΠΡΟΜΗΘΕΥΤΗ):',
    '   - The supplier ΑΦΜ is the 9-digit number in the document HEADER BLOCK (top of page).',
    '   - It appears near/below the supplier company name, often with ΔΟΥ nearby.',
    '   - CRITICAL EXCLUSION RULE:',
    '     * Scan the OCR text for keywords: "ΣΤΟΙΧΕΙΑ ΠΕΛΑΤΗ", "ΣΤΟΙΧΕΙΑ ΑΠΟΣΤΟΛΗΣ", "ΕΠΩΝΥΜΙΑ ΠΕΛΑΤΗ", "ΠΕΛΑΤΗΣ".',
    '     * Any ΑΦΜ appearing AFTER these keywords is the CUSTOMER ΑΦΜ - do NOT use it.',
    '     * Only use an ΑΦΜ that appears BEFORE any customer section.',
    '   - If there more than 1 ΑΦΜ or Α.Φ.Μ. values, the FIRST one (reading top-to-bottom) is almost always the supplier.',
    '   - Supplier ΑΦΜ must be exactly 9 digits.',
    '',
    '5. Invoice Number (ΑΡΙΘΜΟΣ ΤΙΜΟΛΟΓΙΟΥ):',
    '   - Look for a table/row with columns: ΣΕΙΡΑ | ΑΡΙΘΜΟΣ | ΗΜΕΡΟΜΗΝΙΑ (or similar).',
    '   - The invoice number is the value under the "ΑΡΙΘΜΟΣ" column header.',
    '   - CRITICAL EXCLUSION RULE:',
    '     * NEVER use numbers from rows labeled "Σχετικά Παραστατικά", "Παραστατικά", or "Αριθ. Παραστ.".',
    '     * These are reference/related document numbers, NOT the main invoice number.',
    '   - The invoice number often has 5-7 digits (e.g., 090748) and may include a series prefix.',
    '   - Accept typical suffixes: ΤΔΑ, Τ-ΔΑ, ΤΙΜ, ΤΙΜΟΛ, INV, ΤΠΥ, etc.',
    '   - Remove spaces and non-alphanumeric garbage.',
    '',
    '6. Date (ΗΜΕΡΟΜΗΝΙΑ):',
    '   - Must match dd/mm/yyyy or dd-mm-yyyy or yyyy-mm-dd.',
    '   - If multiple dates appear, choose the one closest to the invoice header.',
    '',
    '7. Net Amount (ΚΑΘΑΡΗ ΑΞΙΑ):',
    '   - Labeled "ΚΑΘΑΡΗ ΑΞΙΑ" or "ΣΥΝΟΛΟ ΧΩΡΙΣ ΦΠΑ" or "ΚΑΘΑΡΗ".',
    '   - Extract ONLY the final net amount (last page).',
    '   - The CORRECT final net amount is the one that appears closest to the final payable amount (final amount Labeled "ΠΛΗΡΩΤΕΟ", "ΤΕΛΙΚΟ", "ΣΥΝΟΛΟ", "ΣΥΝΟΛΙΚΟ").',
    '',
    '8. VAT Amount (ΦΠΑ):',
    '   - Labeled "ΦΠΑ", "Φ.Π.Α.", or shows VAT percentage.',
    '   - Select the final VAT amount (last page).',
    '   - Must not include the percentage symbol.',
    '',
    '9. Payable Amount (ΠΛΗΡΩΤΕΟ):',
    '   - Labeled "ΠΛΗΡΩΤΕΟ", "ΤΕΛΙΚΟ", "ΣΥΝΟΛΟ", "ΣΥΝΟΛΙΚΟ".',
    '   - Select the highest valid amount among final totals.',
    '',
    '10. Amount formats:',
    '    - Always return dot-decimal (1234.56).',
    '    - Never include € symbols.',
    '',
    '11. If a field is uncertain or missing, set it to null.',
    '',
    '===========================',
    'ACCURACY FIELD ("ΑΚΡΙΒΕΙΑ")',
    '===========================',
    'Return a value 0–100 representing confidence:',
    '- 100 = all fields clearly present and correctly mapped',
    '- 60–90 = some ambiguities',
    '- < 60 = large uncertainty',
    '',
    '===========================',
    'REASONING',
    '===========================',
    'Think step-by-step INTERNALLY.',
    'Do NOT include reasoning in the output.',
    'Output ONLY the final JSON.'
  ].join('\n');

  const extractionPrompt =
    'Παρακάτω σου δίνω ΟΛΟ το κείμενο ενός (πιθανόν πολυσέλιδου) τιμολογίου όπως προέκυψε από OCR.\n\n' +
    'Εντόπισε και επέστρεψε τα παρακάτω πεδία αυστηρά σε JSON, σύμφωνα με το schema:\n\n' +
    REQUIRED_FIELDS.map((field, idx) => `${idx + 1}. ${field}`).join('\n') +
    '\n\n⚠️ ΚΡΙΣΙΜΟΙ ΚΑΝΟΝΕΣ:\n' +
    '- ΑΦΜ ΠΡΟΜΗΘΕΥΤΗ: Χρησιμοποίησε ΜΟΝΟ το ΑΦΜ που εμφανίζεται ΠΡΙΝ από οποιοδήποτε "ΣΤΟΙΧΕΙΑ ΠΕΛΑΤΗ" ΚΑΙ ΣΤΟΙΧΕΙΑ ΑΠΟΣΤΟΛΗΣ.\n' +
    'Αν υπάρχουν πανω απο 1 ΑΦΜ, το ΠΡΩΤΟ (από πάνω προς τα κάτω) είναι του προμηθευτή.\n' +
    '- ΑΡΙΘΜΟΣ ΤΙΜΟΛΟΓΙΟΥ: Χρησιμοποίησε τον αριθμό από τη στήλη "ΑΡΙΘΜΟΣ" (συνήθως δίπλα σε ΣΕΙΡΑ/ΗΜΕΡΟΜΗΝΙΑ). ' +
    'ΠΟΤΕ μην χρησιμοποιήσεις αριθμούς από "Σχετικά Παραστατικά" - αυτοί είναι αριθμοί αναφοράς.\n' +
    '\nΘυμήσου:\n' +
    '- Ο προμηθευτής βρίσκεται μόνο στην πρώτη σελίδα, στην κορυφή της σελίδας.\n' +
    '- Τα οικονομικά σύνολα βρίσκονται μόνο στην τελευταία σελίδα.\n' +
    '- Αν κάποιο πεδίο δεν είναι βέβαιο, βάλε null.\n' +
    '- Χρησιμοποίησε δεκαδικό με τελεία.\n\n' +
    'Ακολουθεί το κείμενο του τιμολογίου:\n\n' +
    fullText;
    

  const response = await openaiClient.responses.create({
    model: 'gpt-4o-mini',
    input: [
      {
        role: 'system',
        content: [{ type: 'input_text', text: systemPrompt }]
      },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: extractionPrompt }
        ]
      }
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'greek_invoice_ocr_format',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            'ΗΜΕΡΟΜΗΝΙΑ': { type: ['string', 'null'] },
            'ΑΡΙΘΜΟΣ ΤΙΜΟΛΟΓΙΟΥ': { type: ['string', 'null'] },
            'ΑΦΜ ΠΡΟΜΗΘΕΥΤΗ': { type: ['string', 'null'] },
            'ΠΡΟΜΗΘΕΥΤΗΣ': { type: ['string', 'null'] },
            'ΚΑΘΑΡΗ ΑΞΙΑ': { type: ['string', 'null'] },
            'ΦΠΑ': { type: ['string', 'null'] },
            'ΠΛΗΡΩΤΕΟ': { type: ['string', 'null'] },
            'ΑΚΡΙΒΕΙΑ': { type: ['string', 'null'] }
          },
          required: REQUIRED_FIELDS
        },
        strict: true
      }
    },
    max_output_tokens: 800
  });

  const rawText = collectResponseText(response);
  return parseJsonFromResponse(rawText);
}

//exports.getSignedUploadUrl = functions.region('europe-west8').https.onRequest(async (req, res) => {
exports.getSignedUploadUrl = functions
  .runWith({ serviceAccount: SERVICE_ACCOUNT_EMAIL })
  .https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const bucketName = getBucketName();
  if (!bucketName) {
    return res.status(500).json({ error: 'Missing GCS bucket configuration' });
  }

  const idToken = extractBearerToken(req.header('Authorization'));
  if (!idToken) {
    return res.status(401).json({ error: 'Missing Authorization: Bearer <token>' });
  }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (error) {
    return res.status(401).json({
      error: 'Invalid or expired Firebase ID token',
      details: error.message
    });
  }

  const {
    filename,
    contentType = 'application/octet-stream',
    invoiceId,
    pageNumber,
    totalPages = null
  } = req.body || {};

  if (!filename) {
    return res.status(400).json({ error: 'filename is required in the request body' });
  }

  try {
    const normalizedTotalPages = normalizeTotalPages(totalPages);
    const normalizedPageNumber = normalizePageNumber(pageNumber);
    const sanitizedFilename = sanitizeFilename(filename);
    const invoiceMetadata = await ensureInvoiceDocument({
      invoiceId,
      uid: decoded.uid,
      bucketName,
      totalPages: normalizedTotalPages
    });
    const resolvedInvoiceId = invoiceMetadata.invoiceId;
    const resolvedTotalPages = invoiceMetadata.totalPages || normalizedTotalPages;
    if (!resolvedTotalPages) {
      throw new Error('totalPages must be specified for the invoice');
    }
    const objectName = `${UPLOADS_PREFIX}${resolvedInvoiceId}/page-${padPageNumber(
      normalizedPageNumber
    )}-${sanitizedFilename}`;
    const expiresAtMs = Date.now() + SIGNED_URL_TTL_MS;

    const [signedUrl] = await storage
      .bucket(bucketName)
      .file(objectName)
      .getSignedUrl({
        version: 'v4',
        action: 'write',
        expires: expiresAtMs,
        contentType
      });

    return res.json({
      invoiceId: resolvedInvoiceId,
      pageNumber: normalizedPageNumber,
      totalPages: resolvedTotalPages,
      uploadUrl: signedUrl,
      bucket: bucketName,
      objectName,
      contentType,
      expiresAt: new Date(expiresAtMs).toISOString()
    });
  } catch (error) {
    console.error('Failed to create signed URL:', error);
    return res.status(400).json({ error: error.message });
  }
});

exports.processUploadedInvoice = functions
  .runWith({ serviceAccount: SERVICE_ACCOUNT_EMAIL })
  .storage.object()
  .onFinalize(async (object) => {
  const { name: objectName, bucket, contentType } = object;
  if (!objectName) {
    console.warn('Finalize event missing object name');
    return;
  }

  if (!objectName.startsWith(UPLOADS_PREFIX)) {
    console.log(`Skipping ${objectName} because it is outside ${UPLOADS_PREFIX}`);
    return;
  }

  const parsed = parseUploadObjectName(objectName);
  if (!parsed) {
    console.warn(`Unable to parse invoice metadata from object name: ${objectName}`);
    return;
  }

  try {
    await registerUploadedPage({
      invoiceId: parsed.invoiceId,
      pageNumber: parsed.pageNumber,
      objectName,
      bucketName: bucket,
      contentType: contentType || 'application/octet-stream'
    });
    console.log(
      `Registered page ${parsed.pageNumber} for invoice ${parsed.invoiceId} (${objectName})`
    );
  } catch (error) {
    console.error(
      `Failed to register page ${parsed.pageNumber} for invoice ${parsed.invoiceId}`,
      error
    );
  }
});

exports.processInvoiceDocument = functions
  .runWith({ serviceAccount: SERVICE_ACCOUNT_EMAIL })
  .firestore.document(`${METADATA_INVOICE_COLLECTION}/{invoiceId}`)
  .onWrite(async (change, context) => {
    const after = change.after.exists ? change.after.data() : null;
    if (!after) {
      return;
    }

    const before = change.before.exists ? change.before.data() : null;
    if (before && before.status === after.status) {
      return;
    }

    if (after.status !== INVOICE_STATUS.ready) {
      return;
    }

    if (!openaiClient) {
      console.warn('OPENAI_API_KEY not configured; unable to run OCR.');
      await change.after.ref.update({
        status: INVOICE_STATUS.error,
        errorMessage: 'OCR is disabled because OPENAI_API_KEY is missing.',
        updatedAt: serverTimestamp()
      });
      return;
    }

    let lockedSnapshot;
    try {
      lockedSnapshot = await db.runTransaction(async (tx) => {
        const lockedSnap = await tx.get(change.after.ref);
        const lockedData = lockedSnap.data();
        if (lockedData.status !== INVOICE_STATUS.ready) {
          return null;
        }

        tx.update(change.after.ref, {
          status: INVOICE_STATUS.processing,
          processingStartedAt: serverTimestamp(),
          errorMessage: null,
          updatedAt: serverTimestamp()
        });

        return lockedData;
      });
    } catch (error) {
      console.error('Failed to lock invoice document for processing', error);
      return;
    }

    if (!lockedSnapshot) {
      return;
    }

    const invoiceId = context.params.invoiceId;
    const invoiceData = lockedSnapshot;
    const bucketName = invoiceData.bucket || getBucketName();
    if (!bucketName) {
      await change.after.ref.update({
        status: INVOICE_STATUS.error,
        errorMessage: 'Missing bucket configuration for invoice processing.',
        updatedAt: serverTimestamp()
      });
      return;
    }

    const pages = Array.isArray(invoiceData.pages)
      ? [...invoiceData.pages].sort((a, b) => a.pageNumber - b.pageNumber)
      : [];

    if (!pages.length) {
      await change.after.ref.update({
        status: INVOICE_STATUS.error,
        errorMessage: 'No pages were uploaded for this invoice.',
        updatedAt: serverTimestamp()
      });
      return;
    }

    if (invoiceData.totalPages && pages.length !== invoiceData.totalPages) {
      await change.after.ref.update({
        status: INVOICE_STATUS.error,
        errorMessage: `Expected ${invoiceData.totalPages} pages but found ${pages.length}.`,
        updatedAt: serverTimestamp()
      });
      return;
    }

    try {
      const { combinedPdfBuffer, downloadedPages } = await buildCombinedPdfFromPages(
        pages,
        bucketName
      );

      // At this stage of the app, in order to avoid noise and extra charges from the Vision API
      // and GPT, we will only OCR the first and last page of the invoice 
      // since the supplier info, invoice number, date are on the first page 
      // and the totals, amounts are on the last page. (MVP)
      // For invoices with more than 2 pages, OCR only first and last page
      // Page 1 = supplier info, invoice number, date
      // Page N = totals, amounts
      let pagesToOcr = downloadedPages;
      if (downloadedPages.length > 2) {
        const sortedPages = [...downloadedPages].sort((a, b) => a.pageNumber - b.pageNumber);
        const firstPage = sortedPages[0];
        const lastPage = sortedPages[sortedPages.length - 1];
        pagesToOcr = [firstPage, lastPage];
        console.log(
          `Invoice has ${downloadedPages.length} pages; OCR will process only page ${firstPage.pageNumber} and page ${lastPage.pageNumber}`
        );
      }

      const ocrResult = await runInvoiceOcr(pagesToOcr);
      if (!ocrResult) {
        throw new Error('OCR result was empty.');
      }

      const mappedResult = Object.entries(ocrResult).reduce((acc, [key, value]) => {
        const englishKey = FIELD_LABELS[key] || key;
        acc[englishKey] = value;
        return acc;
      }, {});

      console.log('OCR extraction (GR):', JSON.stringify(ocrResult, null, 2));
      console.log('OCR extraction (EN):', JSON.stringify(mappedResult, null, 2));

      const supplierName = mappedResult.supplierName || 'Unknown Supplier';
      const supplierTaxNumber = mappedResult.supplierTaxNumber || null;
      const supplierId = sanitizeId(
        supplierTaxNumber,
        sanitizeId(supplierName, 'unknown-supplier')
      );
      const invoiceNumber =
        mappedResult.invoiceNumber?.toString().match(/\d+/g)?.join('') || null;
      const uploadedBy = invoiceData.ownerUid || null;
      await ensureSupplierProfile({
        supplierId,
        supplierName,
        supplierTaxNumber,
        supplierCategory: mappedResult.supplierCategory || null
      });

      const pdfObjectPath = `suppliers/${supplierId}/invoices/${invoiceId}.pdf`;
      try {
        await storage
          .bucket(bucketName)
          .file(pdfObjectPath)
          .save(combinedPdfBuffer, {
            resumable: false,
            contentType: 'application/pdf',
            metadata: {
              pages: pages.length,
              originalFolder: invoiceData.storageFolder || `${UPLOADS_PREFIX}${invoiceId}`
            }
          });
        console.log(`Stored normalized PDF at gs://${bucketName}/${pdfObjectPath}`);
      } catch (pdfError) {
        console.error(`Failed to store combined PDF for invoice ${invoiceId}:`, pdfError);
      }

      const invoiceDocRef = db.doc(`suppliers/${supplierId}/invoices/${invoiceId}`);
      const invoicePayload = {
        invoiceId,
        rawFilePaths: pages.map((p) => p.objectName),
        filePath: pdfObjectPath,
        bucket: bucketName,
        uploadedBy,
        supplierId,
        supplierName,
        supplierTaxNumber,
        invoiceNumber,
        invoiceDate: parseDate(mappedResult.invoiceDate),
        dueDate: parseDate(mappedResult.dueDate),
        totalAmount: parseAmount(mappedResult.totalAmount),
        currency: mappedResult.currency || 'EUR',
        netAmount: parseAmount(mappedResult.netAmount),
        vatAmount: parseAmount(mappedResult.vat),
        vatRate: parseAmount(mappedResult.vatRate),
        processingStatus: INVOICE_STATUS.uploaded,
        paymentStatus: PAYMENT_STATUS.unpaid,
        unpaidAmount: parseAmount(mappedResult.totalAmount),
        errorMessage: null,
        confidence: mappedResult.confidence ? Number(mappedResult.confidence) : null,
        createdAt: invoiceData.createdAt || serverTimestamp(),
        uploadedAt: serverTimestamp()
      };

      await invoiceDocRef.set(invoicePayload, { merge: true });

      await change.after.ref.update({
        status: INVOICE_STATUS.done,
        uploadedAt: serverTimestamp(),
        processedInvoicePath: invoiceDocRef.path,
        confidence: invoicePayload.confidence,
        errorMessage: null,
        updatedAt: serverTimestamp()
      });

      console.log(`Stored invoice data at ${invoiceDocRef.path}`);

      // Send FCM notification on success
      if (uploadedBy) {
        await sendInvoiceNotification(uploadedBy, {
          invoiceId,
          status: 'done',
          supplierId,
          supplierName,
          invoiceNumber: invoiceNumber || ''
        });
      }
    } catch (error) {
      console.error(`Failed to process invoice ${invoiceId}:`, error);
      await change.after.ref.update({
        status: INVOICE_STATUS.error,
        errorMessage: error.message,
        updatedAt: serverTimestamp()
      });

      // Send FCM notification on error
      const ownerUid = invoiceData?.ownerUid;
      if (ownerUid) {
        await sendInvoiceNotification(ownerUid, {
          invoiceId,
          status: 'error',
          errorMessage: error.message
        });
      }
    }
  });

// ═══════════════════════════════════════════════════════════════════════════════
// PAYMENT STATUS UPDATE FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════
//
// Securely updates the payment status of an invoice with full audit trail.
//
// Request Body:
// {
//   supplierId: string,         // Required - supplier identifier
//   invoiceId: string,          // Required - invoice document ID
//   action: "pay" | "partial",  // Required - payment action type
//   amount?: number,            // Required for "partial", optional for "pay" (defaults to full)
//   paymentMethod?: string,     // Optional - cash, bank_transfer, card, etc.
//   paymentDate?: string,       // Optional - ISO date string, defaults to now
//   notes?: string              // Optional - payment notes
// }
//
// Security:
// - Requires Firebase Authentication
// - User must be the invoice owner (uploadedBy === uid)
// - Input validation: positive amounts, no overpayment
// - Atomic updates via Firestore transaction
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validates and extracts the authenticated user from the request
 */
async function authenticateRequest(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { error: 'Missing or invalid Authorization header', status: 401 };
  }

  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    return { user: decodedToken };
  } catch (error) {
    console.error('Token verification failed:', error);
    return { error: 'Invalid or expired token', status: 401 };
  }
}

/**
 * Validates payment request body
 */
function validatePaymentRequest(body) {
  const errors = [];

  if (!body.supplierId || typeof body.supplierId !== 'string') {
    errors.push('supplierId is required and must be a string');
  }

  if (!body.invoiceId || typeof body.invoiceId !== 'string') {
    errors.push('invoiceId is required and must be a string');
  }

  if (!['pay', 'partial'].includes(body.action)) {
    errors.push('action must be "pay" or "partial"');
  }

  if (body.action === 'partial') {
    if (typeof body.amount !== 'number' || body.amount <= 0) {
      errors.push('amount is required and must be a positive number for partial payments');
    }
  }

  if (body.amount !== undefined && (typeof body.amount !== 'number' || body.amount < 0)) {
    errors.push('amount must be a non-negative number');
  }

  if (body.paymentDate) {
    const date = new Date(body.paymentDate);
    if (isNaN(date.getTime())) {
      errors.push('paymentDate must be a valid ISO date string');
    }
  }

  if (body.notes && typeof body.notes !== 'string') {
    errors.push('notes must be a string');
  }

  return errors;
}

/**
 * Derives payment status from amounts
 */
function derivePaymentStatus(paidAmount, totalAmount) {
  if (!totalAmount || totalAmount <= 0) {
    // If totalAmount is unknown, we can't determine status accurately
    return paidAmount > 0 ? PAYMENT_STATUS.partiallyPaid : PAYMENT_STATUS.unpaid;
  }

  if (paidAmount >= totalAmount) {
    return PAYMENT_STATUS.paid;
  }
  if (paidAmount > 0) {
    return PAYMENT_STATUS.partiallyPaid;
  }
  return PAYMENT_STATUS.unpaid;
}

exports.updatePaymentStatus = functions
  .runWith({ serviceAccount: SERVICE_ACCOUNT_EMAIL })
  .https.onRequest(async (req, res) => {
    // CORS headers
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      return res.status(204).send('');
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed. Use POST.' });
    }

    // 1. Authenticate
    const authResult = await authenticateRequest(req);
    if (authResult.error) {
      return res.status(authResult.status).json({ error: authResult.error });
    }
    const user = authResult.user;

    // 2. Validate request body
    const body = req.body || {};
    const validationErrors = validatePaymentRequest(body);
    if (validationErrors.length > 0) {
      return res.status(400).json({ 
        error: 'Validation failed', 
        details: validationErrors 
      });
    }

    const { supplierId, invoiceId, action, paymentMethod, notes } = body;
    const paymentDate = body.paymentDate 
      ? admin.firestore.Timestamp.fromDate(new Date(body.paymentDate))
      : admin.firestore.FieldValue.serverTimestamp();

    const invoiceRef = db
      .collection('suppliers')
      .doc(supplierId)
      .collection('invoices')
      .doc(invoiceId);

    try {
      const result = await db.runTransaction(async (tx) => {
        const invoiceSnap = await tx.get(invoiceRef);

        // 3. Check invoice exists
        if (!invoiceSnap.exists) {
          throw Object.assign(
            new Error(`Invoice not found: suppliers/${supplierId}/invoices/${invoiceId}`),
            { httpStatus: 404 }
          );
        }

        const invoiceData = invoiceSnap.data();

        // 4. Authorization check - only owner can update
        if (invoiceData.uploadedBy && invoiceData.uploadedBy !== user.uid) {
          throw Object.assign(
            new Error('You are not authorized to update this invoice'),
            { httpStatus: 403 }
          );
        }

        // 5. Get current payment state
        const totalAmount = invoiceData.totalAmount || 0;
        const currentPaidAmount = invoiceData.paidAmount || 0;
        const currentUnpaidAmount = totalAmount - currentPaidAmount;

        // 6. Calculate payment amount
        let paymentAmount;
        if (action === 'pay') {
          // Full payment - pay remaining balance
          paymentAmount = body.amount !== undefined ? body.amount : currentUnpaidAmount;
        } else {
          // Partial payment - use specified amount
          paymentAmount = body.amount;
        }

        // 7. Validate payment doesn't exceed remaining balance
        if (totalAmount > 0 && paymentAmount > currentUnpaidAmount + 0.01) {
          throw Object.assign(
            new Error(
              `Payment amount (${paymentAmount.toFixed(2)}) exceeds unpaid balance (${currentUnpaidAmount.toFixed(2)})`
            ),
            { httpStatus: 400 }
          );
        }

        // 8. Validate not already fully paid
        if (invoiceData.paymentStatus === PAYMENT_STATUS.paid) {
          throw Object.assign(
            new Error('Invoice is already fully paid'),
            { httpStatus: 400 }
          );
        }

        // 9. Calculate new amounts
        const newPaidAmount = currentPaidAmount + paymentAmount;
        const newUnpaidAmount = Math.max(0, totalAmount - newPaidAmount);
        const newPaymentStatus = derivePaymentStatus(newPaidAmount, totalAmount);

        // 10. Build payment history entry
        const paymentEntry = {
          amount: paymentAmount,
          paymentDate,
          paymentMethod: paymentMethod || 'other',
          notes: notes || null,
          recordedAt: admin.firestore.Timestamp.now(),
          recordedBy: user.uid
        };

        // 11. Update invoice document
        tx.update(invoiceRef, {
          paymentStatus: newPaymentStatus,
          paidAmount: newPaidAmount,
          unpaidAmount: newUnpaidAmount,
          lastPaymentAt: admin.firestore.FieldValue.serverTimestamp(),
          paymentHistory: admin.firestore.FieldValue.arrayUnion(paymentEntry),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return {
          invoiceId,
          supplierId,
          previousStatus: invoiceData.paymentStatus || PAYMENT_STATUS.unpaid,
          newStatus: newPaymentStatus,
          paymentAmount,
          totalAmount,
          paidAmount: newPaidAmount,
          unpaidAmount: newUnpaidAmount
        };
      });

      console.log(`Payment recorded for invoice ${invoiceId}:`, result);

      return res.status(200).json({
        success: true,
        message: result.newStatus === PAYMENT_STATUS.paid 
          ? 'Invoice marked as fully paid' 
          : `Partial payment of ${result.paymentAmount.toFixed(2)} recorded`,
        data: result
      });

    } catch (error) {
      console.error('Payment update failed:', error);

      const httpStatus = error.httpStatus || 500;
      return res.status(httpStatus).json({
        error: error.message,
        code: httpStatus === 500 ? 'INTERNAL_ERROR' : 'PAYMENT_ERROR'
      });
    }
  });

// ═══════════════════════════════════════════════════════════════════════════════
// FCM TOKEN REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════
//
// Registers or updates an FCM token for push notifications.
//
// Request Body:
// {
//   token: string,              // Required - FCM registration token
//   platform: string            // Optional - "ios" | "android" | "web"
// }
//
// Response:
// { success: true, tokenId: "abc123" }
//
// ═══════════════════════════════════════════════════════════════════════════════

exports.registerFcmToken = functions
  .runWith({ serviceAccount: SERVICE_ACCOUNT_EMAIL })
  .https.onRequest(async (req, res) => {
    // CORS
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');

    if (req.method === 'OPTIONS') {
      return res.status(204).send('');
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // Authenticate
    const idToken = extractBearerToken(req.header('Authorization'));
    if (!idToken) {
      return res.status(401).json({ error: 'Missing Authorization: Bearer <token>' });
    }

    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(idToken);
    } catch (error) {
      return res.status(401).json({ error: 'Invalid or expired token', details: error.message });
    }

    const userId = decodedToken.uid;

    // Validate input
    const { token, platform } = req.body || {};
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'token is required and must be a string' });
    }

    // Generate a stable token ID (hash of the token)
    const tokenId = crypto.createHash('sha256').update(token).digest('hex').substring(0, 16);

    const userRef = db.doc(`${USERS_COLLECTION}/${userId}`);

    try {
      await db.runTransaction(async (tx) => {
        const userDoc = await tx.get(userRef);

        const tokenData = {
          token,
          platform: platform || 'unknown',
          createdAt: admin.firestore.Timestamp.now(),
          lastActiveAt: admin.firestore.Timestamp.now()
        };

        if (!userDoc.exists) {
          // Create user document with FCM token
          tx.set(userRef, {
            fcmTokens: { [tokenId]: tokenData },
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          });
        } else {
          // Update existing user with new/updated token
          tx.update(userRef, {
            [`fcmTokens.${tokenId}`]: tokenData,
            updatedAt: serverTimestamp()
          });
        }
      });

      console.log(`FCM token registered for user ${userId}: ${tokenId}`);
      return res.status(200).json({ success: true, tokenId });

    } catch (error) {
      console.error(`Failed to register FCM token for user ${userId}:`, error);
      return res.status(500).json({ error: 'Failed to register token', details: error.message });
    }
  });

// ═══════════════════════════════════════════════════════════════════════════════
// FCM TOKEN CLEANUP (Scheduled - Weekly)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Removes FCM tokens that haven't been active in the last 60 days.
// Runs every Sunday at 3:00 AM UTC.
//
// ═══════════════════════════════════════════════════════════════════════════════

exports.cleanupStaleTokens = functions
  .runWith({ serviceAccount: SERVICE_ACCOUNT_EMAIL })
  .pubsub.schedule('0 3 * * 0') // Every Sunday at 3:00 AM UTC
  .timeZone('UTC')
  .onRun(async () => {
    const cutoffDate = new Date(Date.now() - FCM_TOKEN_STALE_DAYS * 24 * 60 * 60 * 1000);
    const cutoffTimestamp = admin.firestore.Timestamp.fromDate(cutoffDate);

    console.log(`Starting FCM token cleanup. Removing tokens inactive since ${cutoffDate.toISOString()}`);

    let totalUsersProcessed = 0;
    let totalTokensRemoved = 0;

    // Process users in batches
    let lastDoc = null;
    const batchSize = 100;

    while (true) {
      let query = db.collection(USERS_COLLECTION)
        .orderBy('__name__')
        .limit(batchSize);

      if (lastDoc) {
        query = query.startAfter(lastDoc);
      }

      const snapshot = await query.get();

      if (snapshot.empty) {
        break;
      }

      const batch = db.batch();
      let batchHasUpdates = false;

      for (const doc of snapshot.docs) {
        const userData = doc.data();
        const fcmTokens = userData.fcmTokens || {};
        const tokensToDelete = [];

        for (const [tokenId, tokenData] of Object.entries(fcmTokens)) {
          const lastActiveAt = tokenData?.lastActiveAt;
          
          // Delete if no lastActiveAt or if it's older than cutoff
          if (!lastActiveAt || lastActiveAt.toDate() < cutoffDate) {
            tokensToDelete.push(tokenId);
          }
        }

        if (tokensToDelete.length > 0) {
          const updates = {};
          for (const tokenId of tokensToDelete) {
            updates[`fcmTokens.${tokenId}`] = admin.firestore.FieldValue.delete();
          }
          updates.updatedAt = serverTimestamp();

          batch.update(doc.ref, updates);
          batchHasUpdates = true;
          totalTokensRemoved += tokensToDelete.length;
        }

        totalUsersProcessed++;
        lastDoc = doc;
      }

      if (batchHasUpdates) {
        await batch.commit();
      }

      // If we got fewer than batchSize, we're done
      if (snapshot.docs.length < batchSize) {
        break;
      }
    }

    console.log(`FCM token cleanup complete. Processed ${totalUsersProcessed} users, removed ${totalTokensRemoved} stale tokens.`);
    return null;
  });
