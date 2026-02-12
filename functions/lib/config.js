const admin = require('firebase-admin');
const { Storage } = require('@google-cloud/storage');
const vision = require('@google-cloud/vision');
const { defineString } = require('firebase-functions/params');

admin.initializeApp();

const storage = new Storage();
const visionClient = new vision.ImageAnnotatorClient();
const db = admin.firestore();

// Define environment parameters (type-safe, validated at deploy time)
const SERVICE_ACCOUNT_EMAIL = defineString('SERVICE_ACCOUNT_EMAIL');
const REGION = defineString('REGION', { default: 'europe-west6' });
const OPENAI_API_KEY = defineString('OPENAI_API_KEY');
const GCS_BUCKET = defineString('GCS_BUCKET');

const UPLOADS_PREFIX = 'uploads/';
const METADATA_INVOICE_COLLECTION = 'metadata_invoices';

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

function getBucketName() {
  return GCS_BUCKET.value();
}

module.exports = {
  admin,
  db,
  storage,
  visionClient,
  SERVICE_ACCOUNT_EMAIL,
  REGION,
  OPENAI_API_KEY,
  GCS_BUCKET,
  UPLOADS_PREFIX,
  METADATA_INVOICE_COLLECTION,
  SIGNED_URL_TTL_MS,
  INVOICE_STATUS,
  PAYMENT_STATUS,
  serverTimestamp,
  getBucketName,
};
