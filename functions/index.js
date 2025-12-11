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
  partiallyPaid: 'partiallyPaid'
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
  const normalized = value.toString().replace(/[^\d,.-]/g, '').replace(',', '.');
  const num = Number(normalized);
  return Number.isFinite(num) ? num : null;
}

function parseDate(value) {
  if (!value) return null;
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
        aggregatedText.push(`--- page ${page.pageNumber} ---\n${pageText}`);
      } else {
        console.warn(`Vision returned empty text for page ${page.pageNumber}`);
      }
    } catch (visionError) {
      console.error('Vision API failed to read invoice text', { mimeType }, visionError);
      throw visionError;
    }
  }

  const fullText = aggregatedText.join('\n\n');
  if (!fullText) {
    throw new Error('Vision API did not return any text for this invoice.');
  }

  const systemPrompt = [
    'You are an expert accountant and document-analysis specialist for Greek invoices.',
    'You ALWAYS output strictly valid JSON following the schema provided by the user.',
    '',
    'You will be given the FULL multi-page OCR text of a Greek invoice.',
    'The OCR may be noisy, misordered, or contain junk text from headers, footers, or page numbers.',
    '',
    '===========================',
    'GENERAL EXTRACTION RULES',
    '===========================',
    '1. Extract ONLY data from the actual invoice content. Ignore:',
    '   - phone numbers',
    '   - website URLs',
    '   - footer disclaimers',
    '   - page numbers',
    '   - repeated totals from intermediate sections',
    '',
    '2. Multi-page logic:',
    '   - Supplier information ALWAYS appears on page 1.',
    '   - Financial totals (Net, VAT, Payable) ALWAYS appear on the LAST page.',
    '   - Do NOT mix totals from earlier pages.',
    '   - If multiple candidates appear, prefer the last page\'s values.',
    '',
    '3. Supplier (ΠΡΟΜΗΘΕΥΤΗΣ):',
    '   - Must be the entity printed at the top of page 1.',
    '   - Ignore buyer/customer fields such as "ΠΡΟΣ", "ΠΕΛΑΤΗΣ", "ΑΠΟΔΕΚΤΗΣ".',
    '   - If multiple business names appear, select the one positioned before the customer block.',
    '',
    '4. Supplier TAX ID (ΑΦΜ ΠΡΟΜΗΘΕΥΤΗ):',
    '   - Must be 9 digits.',
    '   - Must be located near the supplier\'s address/logo.',
    '   - If multiple ΑΦΜ values appear, choose the one closest to the supplier name.',
    '',
    '5. Invoice Number (ΑΡΙΘΜΟΣ ΤΙΜΟΛΟΓΙΟΥ):',
    '   - Accept typical prefixes: ΤΙΜ, ΤΙΜΟΛ, INV, ΤΠΥ, etc.',
    '   - Remove spaces and non-alphanumeric garbage.',
    '',
    '6. Date (ΗΜΕΡΟΜΗΝΙΑ):',
    '   - Must match dd/mm/yyyy or dd-mm-yyyy or yyyy-mm-dd.',
    '   - If multiple dates appear, choose the one closest to the invoice header.',
    '',
    '7. Net Amount (ΚΑΘΑΡΗ ΑΞΙΑ):',
    '   - Labeled "ΚΑΘΑΡΗ ΑΞΙΑ" or "ΣΥΝΟΛΟ ΧΩΡΙΣ ΦΠΑ" or "ΚΑΘΑΡΗ".',
    '   - Extract ONLY the final net amount (last page).',
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
    '\n\nΘυμήσου:\n' +
    '- Ο προμηθευτής βρίσκεται μόνο στην πρώτη σελίδα.\n' +
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
      const ocrResult = await runInvoiceOcr(downloadedPages);
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
    } catch (error) {
      console.error(`Failed to process invoice ${invoiceId}:`, error);
      await change.after.ref.update({
        status: INVOICE_STATUS.error,
        errorMessage: error.message,
        updatedAt: serverTimestamp()
      });
    }
  });
