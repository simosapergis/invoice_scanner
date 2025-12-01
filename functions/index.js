const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { Storage } = require('@google-cloud/storage');
const { PDFDocument } = require('pdf-lib');
const OpenAI = require('openai');

const app = admin.initializeApp();

const storage = new Storage();
const db = admin.firestore();
const DEFAULT_FOLDER = 'invoices';
const UPLOADS_PREFIX = 'uploads/';
const REQUIRED_FIELDS = [
  'ΗΜΕΡΟΜΗΝΙΑ',
  'ΑΡΙΘΜΟΣ ΤΙΜΟΛΟΓΙΟΥ',
  'ΠΡΟΜΗΘΕΥΤΗΣ',
  'ΑΦΜ ΠΡΟΜΗΘΕΥΤΗ',
  'ΣΥΝΟΛΟ ΧΩΡΙΣ ΦΠΑ',
  'ΦΠΑ',
  'ΤΕΛΙΚΟ ΠΟΣΟ',
  'ΑΚΡΙΒΕΙΑ'
];

const FIELD_LABELS = {
  'ΗΜΕΡΟΜΗΝΙΑ': 'invoiceDate',
  'ΑΡΙΘΜΟΣ ΤΙΜΟΛΟΓΙΟΥ': 'invoiceNumber',
  'ΠΡΟΜΗΘΕΥΤΗΣ': 'supplierName',
  'ΑΦΜ ΠΡΟΜΗΘΕΥΤΗ': 'supplierTaxNumber',
  'ΣΥΝΟΛΟ ΧΩΡΙΣ ΦΠΑ': 'subtotal',
  'ΦΠΑ': 'vat',
  'ΤΕΛΙΚΟ ΠΟΣΟ': 'totalAmount',
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
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
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

async function runInvoiceOcr(buffer, mimeType) {
  if (!openaiClient) {
    console.warn('OPENAI_API_KEY not configured; skipping OCR.');
    return null;
  }

  const base64 = buffer.toString('base64');
  const systemPrompt = [
    'You are an expert accountant specializing in OCR for European invoices.',
    '',
    'Your task is to extract fields from invoices that may contain Greek text.',
    '',
    'IMPORTANT RULES:',
    '1. The supplier/vendor (ΠΡΟΜΗΘΕΥΤΗΣ) is ALWAYS the entity printed at the top of the invoice.',
    '2. The supplier VAT number (ΑΦΜ ΠΡΟΜΗΘΕΥΤΗ) is ALWAYS located near the supplier’s address/logo.',
    '3. The customer/buyer (ΠΕΛΑΤΗΣ) appears typically under a section titled “ΠΡΟΣ”, “ΠΕΛΑΤΗΣ”, “ΑΠΟΔΕΚΤΗΣ”.',
    '4. NEVER confuse the customer with the supplier.',
    '5. If more than one VAT number (ΑΦΜ) is detected, choose the one closest to the supplier section.',
    '6. Extract ONLY the supplier VAT number — NOT the customer VAT number.',
    '',
    'Respond strictly in JSON.',
    'If a value is missing or uncertain, return null.',
    'Use dot-decimal notation for amounts (e.g. 1234.56).'
  ].join('\n');

  const extractionPrompt =
    'Παρακαλώ κάνε OCR στο συνημμένο τιμολόγιο και επέστρεψε τα παρακάτω πεδία στα ελληνικά. ' +
    'Εκτός από τα αριθμητικά/κειμενικά πεδία, πρόσθεσε και ένα πεδίο «ΑΚΡΙΒΕΙΑ» με ποσοστιαία εκτίμηση (0-100%) ' +
    'για το πόσο βέβαιος είσαι ότι όλα τα υπόλοιπα δεδομένα είναι σωστά:\n' +
    REQUIRED_FIELDS.map((field, idx) => `${idx + 1}. ${field}`).join('\n');

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
          { type: 'input_text', text: extractionPrompt },
          { type: 'input_image', image_url: `data:${mimeType};base64,${base64}` }
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
            'ΣΥΝΟΛΟ ΧΩΡΙΣ ΦΠΑ': { type: ['string', 'null'] },
            'ΦΠΑ': { type: ['string', 'null'] },
            'ΤΕΛΙΚΟ ΠΟΣΟ': { type: ['string', 'null'] },
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
exports.getSignedUploadUrl = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const bucketName = process.env.GCS_BUCKET || functions.config().uploads?.bucket;
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

  const { filename, contentType = 'application/octet-stream', folder = DEFAULT_FOLDER } = req.body || {};
  if (!filename) {
    return res.status(400).json({ error: 'filename is required in the request body' });
  }

  const sanitizedFilename = sanitizeFilename(filename);
  const objectName = `${folder}/${decoded.uid}/${Date.now()}-${sanitizedFilename}`;
  const expiresAtMs = Date.now() + 15 * 60 * 1000;

  try {
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
      uploadUrl: signedUrl,
      bucket: bucketName,
      objectName,
      contentType,
      expiresAt: new Date(expiresAtMs).toISOString()
    });
  } catch (error) {
    console.error('Failed to create signed URL:', error);
    return res.status(500).json({ error: 'Failed to create signed URL' });
  }
});

exports.processUploadedInvoice = functions.storage.object().onFinalize(async (object) => {
  const { name: objectName, bucket, contentType } = object;
  if (!objectName) {
    console.warn('Finalize event missing object name');
    return;
  }

  if (!objectName.startsWith(UPLOADS_PREFIX)) {
    console.log(`Skipping ${objectName} because it is outside ${UPLOADS_PREFIX}`);
    return;
  }

  if (!openaiClient) {
    console.warn('Skipping OCR because OPENAI_API_KEY is not configured.');
    return;
  }

  try {
    console.log(`Processing uploaded invoice: gs://${bucket}/${objectName}`);
    const [buffer] = await storage.bucket(bucket).file(objectName).download();
    const mimeType = contentType || 'application/octet-stream';

    const ocrResult = await runInvoiceOcr(buffer, mimeType);
    if (!ocrResult) {
      console.warn('OCR result was empty.');
      return;
    }

    const mappedResult = Object.entries(ocrResult).reduce((acc, [key, value]) => {
      const englishKey = FIELD_LABELS[key] || key;
      acc[englishKey] = value;
      return acc;
    }, {});

    console.log('OCR extraction (GR):', JSON.stringify(ocrResult, null, 2));
    console.log('OCR extraction (EN):', JSON.stringify(mappedResult, null, 2));

    const pathParts = objectName.split('/');
    const fileBase = pathParts[pathParts.length - 1] || '';
    const uploadId = pathParts.length >= 2 ? pathParts[1] : fileBase.split('.')[0];
    const uploadedBy = null;

    const supplierName = mappedResult.supplierName || 'Unknown Supplier';
    const supplierTaxNumber = mappedResult.supplierTaxNumber || null;
    const supplierId = sanitizeId(
      supplierTaxNumber,
      sanitizeId(supplierName, 'unknown-supplier')
    );
    const invoiceNumber =
      mappedResult.invoiceNumber?.toString().match(/\d+/g)?.join('') || null;
    const invoiceId = sanitizeId(uploadId, 'unknown-invoice');

    const invoiceDocRef = db.doc(`suppliers/${supplierId}/invoices/${invoiceId}`);
    const pdfObjectPath = `suppliers/${supplierId}/invoices/${invoiceId}.pdf`;

    // Convert the uploaded file to PDF (if needed) and store alongside the processed invoice
    try {
      const pdfBuffer = await convertBufferToPdf(buffer, mimeType);
      await storage
        .bucket(bucket)
        .file(pdfObjectPath)
        .save(pdfBuffer, {
          resumable: false,
          contentType: 'application/pdf',
          metadata: {
            originalContentType: mimeType
          }
        });
      console.log(`Stored normalized PDF at gs://${bucket}/${pdfObjectPath}`);
    } catch (pdfError) {
      console.error(`Failed to store PDF version of ${objectName}:`, pdfError);
    }

    const invoicePayload = {
      invoiceId,
      rawFilePath: objectName,
      filePath: pdfObjectPath,
      uploadedBy,
      supplierId,
      supplierName,
      supplierTaxNumber,
      invoiceNumber,
      invoiceDate: parseDate(mappedResult.invoiceDate),
      dueDate: parseDate(mappedResult.dueDate),
      totalAmount: parseAmount(mappedResult.totalAmount),
      currency: mappedResult.currency || 'EUR',
      subtotal: parseAmount(mappedResult.subtotal),
      vatAmount: parseAmount(mappedResult.vat),
      vatRate: parseAmount(mappedResult.vatRate),
      status: 'completed',
      errorMessage: null,
      confidence: mappedResult.confidence ? Number(mappedResult.confidence) : null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      processedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await invoiceDocRef.set(invoicePayload, { merge: true });
  
    console.log(`Stored invoice data at ${invoiceDocRef.path}`);
  } catch (error) {
    console.error(`Failed to process invoice ${objectName}:`, error);
  }
  });
