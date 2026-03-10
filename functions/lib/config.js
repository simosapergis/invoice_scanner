import admin from 'firebase-admin';
import { Storage } from '@google-cloud/storage';
import vision from '@google-cloud/vision';
import { defineString } from 'firebase-functions/params';

admin.initializeApp();

const storage = new Storage();
const db = admin.firestore();

// Lazy-initialize Vision client — only processInvoiceDocument_v2 uses it
let _visionClient = null;
function getVisionClient() {
  if (!_visionClient) {
    _visionClient = new vision.ImageAnnotatorClient();
  }
  return _visionClient;
}

// Define environment parameters (type-safe, validated at deploy time)
const SERVICE_ACCOUNT_EMAIL = defineString('SERVICE_ACCOUNT_EMAIL');
const REGION = defineString('REGION', { default: 'europe-west3' });
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
  error: 'error',
};
const PAYMENT_STATUS = {
  unpaid: 'unpaid',
  paid: 'paid',
  partiallyPaid: 'partially_paid',
};

const serverTimestamp = admin.firestore.FieldValue.serverTimestamp;

function getBucketName() {
  return GCS_BUCKET.value();
}

const ATHENS_TZ = 'Europe/Athens';
const athensDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: ATHENS_TZ,
});

function getAthensToday() {
  const dateStr = athensDateFormatter.format(new Date());
  const [y, m, d] = dateStr.split('-').map(Number);
  return { utcDate: new Date(Date.UTC(y, m - 1, d)), dayOfMonth: d };
}

function formatAthensDate(date) {
  return athensDateFormatter.format(date);
}

export {
  admin,
  db,
  storage,
  getVisionClient,
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
  getAthensToday,
  formatAthensDate,
};
