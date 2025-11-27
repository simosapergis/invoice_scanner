const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { Storage } = require('@google-cloud/storage');

admin.initializeApp();

const storage = new Storage();
const DEFAULT_FOLDER = 'invoices';

function extractBearerToken(headerValue) {
  if (!headerValue) return null;
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

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
