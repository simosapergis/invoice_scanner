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
const DEFAULT_FOLDER = 'invoices';
const UPLOADS_PREFIX = 'uploads/';
const METADATA_INVOICE_COLLECTION = 'metadata_invoices';
const SERVICE_ACCOUNT_EMAIL = 'mylogia@level-approach-479119-b3.iam.gserviceaccount.com';
const SIGNED_URL_TTL_MS = 15 * 60 * 1000;
const INVOICE_STATUS = {
  pending: 'pending',
  ready: 'ready',
  processing: 'processing',
  done: 'done',
  error: 'error'
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
      return null;
    }
  }

  const fullText = aggregatedText.join('\n\n');
  if (!fullText) {
    console.warn('Vision API did not return any text for this invoice.');
    return null;
  }

  const systemPrompt = [
    'You are an expert accountant specializing in OCR for European invoices.',
    '',
    'You will receive the raw Greek text of an invoice that was extracted via OCR.',
    '',
    'IMPORTANT RULES:',
    '1. The supplier/vendor (ΠΡΟΜΗΘΕΥΤΗΣ) is ALWAYS the entity printed at the top of the invoice.',
    '2. The supplier TAX ID (ΑΦΜ ΠΡΟΜΗΘΕΥΤΗ) is ALWAYS located near the supplier’s address/logo.',
    '3. The customer/buyer (ΠΕΛΑΤΗΣ) appears under sections such as "ΠΡΟΣ", “ΠΕΛΑΤΗΣ", or “ΑΠΟΔΕΚΤΗΣ".',
    '4. NEVER confuse the customer with the supplier.',
    '5. If more than one TAX ID (ΑΦΜ) is detected, choose the one closest to the supplier section.',
    '6. Extract ONLY the supplier TAX ID — NOT the customer TAX ID.',
    '7. Locate the final payable amount on the last page of the document. It will appear under or near a label such as "ΠΛΗΡΩΤΕΟ", "ΣΥΝΟΛΟ", or "ΤΕΛΙΚΟ". The final amount will always be shown as a number. If multiple final amounts are present, select the highest one.',
    '8. Locate the VAT amount on the last page of the document. It appears near or under the final amount and is labeled "ΦΠΑ" or "Φ.Π.Α.". If multiple VAT amounts are present, always select the highest one',
    '9. Locate the net amount (ΚΑΘΑΡΗ ΑΞΙΑ) on the last page of the document, near or under the VAT amount. It is labeled "ΚΑΘΑΡΗ ΑΞΙΑ" or "ΣΥΝΟΛΟ ΧΩΡΙΣ ΦΠΑ". If multiple net amounts appear, always select the highest one. The net amount represents the total before VAT is added.',
    '',
    'Respond strictly in JSON that follows the provided schema.',
    'If a value is missing or uncertain, return null.',
    'Use dot-decimal notation for all amounts (e.g. 1234.56) and omit currency symbols.'
  ].join('\n');

  const extractionPrompt =
    'Παρακάτω σου δίνω ΟΛΟ το κείμενο ενός τιμολογίου όπως προέκυψε από OCR. ' +
    'Παρακαλώ εντόπισε και επέστρεψε τα παρακάτω πεδία στα ελληνικά. ' +
    'Επιπλέον, πρόσθεσε και ένα πεδίο «ΑΚΡΙΒΕΙΑ» με ποσοστιαία εκτίμηση (0-100%) ' +
    'για το πόσο βέβαιος είσαι ότι όλα τα υπόλοιπα δεδομένα είναι σωστά:\n' +
    REQUIRED_FIELDS.map((field, idx) => `${idx + 1}. ${field}`).join('\n') +
    '\n\nΑκολουθεί το κείμενο του τιμολογίου:\n\n' +
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
        status: 'completed',
        errorMessage: null,
        confidence: mappedResult.confidence ? Number(mappedResult.confidence) : null,
        createdAt: invoiceData.createdAt || serverTimestamp(),
        processedAt: serverTimestamp()
      };

      await invoiceDocRef.set(invoicePayload, { merge: true });

      await change.after.ref.update({
        status: INVOICE_STATUS.done,
        processedAt: serverTimestamp(),
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
