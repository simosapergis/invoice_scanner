const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { Storage } = require('@google-cloud/storage');
const OpenAI = require('openai');

admin.initializeApp();

const storage = new Storage();
const DEFAULT_FOLDER = 'invoices';
const REQUIRED_FIELDS = [
  'ΗΜΕΡΟΜΗΝΙΑ',
  'ΑΡΙΘΜΟΣ ΤΙΜΟΛΟΓΙΟΥ',
  'ΠΡΟΜΗΘΕΥΤΗΣ',
  'ΣΥΝΟΛΟ ΧΩΡΙΣ ΦΠΑ',
  'ΦΠΑ',
  'ΤΕΛΙΚΟ ΠΟΣΟ',
  'ΑΚΡΙΒΕΙΑ'
];

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

async function runInvoiceOcr(buffer, mimeType) {
  if (!openaiClient) {
    console.warn('OPENAI_API_KEY not configured; skipping OCR.');
    return null;
  }

  const base64 = buffer.toString('base64');
  const systemPrompt =
    'You are an expert accountant specializing in OCR for European invoices. ' +
    'Read the provided invoice (which may contain Greek text) and extract the requested fields. ' +
    'Respond strictly in JSON that matches the provided schema. ' +
    'If a value is missing, return null. Amounts must use dot-decimal notation (e.g. 1234.56) and omit currency symbols.';

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

    if (!openaiClient) {
      console.warn('Skipping OCR because OPENAI_API_KEY is not configured.');
      return;
    }

    try {
      console.log(`Processing uploaded invoice: gs://${bucket}/${objectName}`);
      const [buffer] = await storage.bucket(bucket).file(objectName).download();
      const mimeType = contentType || 'application/octet-stream';

      const ocrResult = await runInvoiceOcr(buffer, mimeType);
      if (ocrResult) {
        console.log('OCR extraction result:', JSON.stringify(ocrResult, null, 2));
      } else {
        console.warn('OCR result was empty.');
      }
    } catch (error) {
      console.error(`Failed to process invoice ${objectName}:`, error);
    }
  });
