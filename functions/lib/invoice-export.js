import archiver from 'archiver';
import { PassThrough } from 'stream';
import { pipeline } from 'stream/promises';
import { admin, db, storage, getBucketName, SIGNED_URL_TTL_MS, serverTimestamp, formatAthensDate } from './config.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const EXPORTS_PREFIX = 'exports/';
const MAX_EXPORT_INVOICES = 500;

// ═══════════════════════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validates a single invoice entry inside the invoices array.
 * Returns an error string or null if valid.
 */
function validateInvoiceEntry(entry, index) {
  if (!entry || typeof entry !== 'object') {
    return `invoices[${index}] must be an object`;
  }
  if (!entry.supplierId || typeof entry.supplierId !== 'string') {
    return `invoices[${index}].supplierId is required and must be a string`;
  }
  if (!entry.invoiceId || typeof entry.invoiceId !== 'string') {
    return `invoices[${index}].invoiceId is required and must be a string`;
  }
  return null;
}

/**
 * Validates the export invoices request body.
 * Expects { invoices: [{ supplierId, invoiceId }, ...] }.
 * Returns an array of error strings (empty if valid).
 */
function validateExportRequest(body) {
  const errors = [];

  if (!Array.isArray(body.invoices)) {
    errors.push('invoices is required and must be an array');
    return errors;
  }

  if (body.invoices.length === 0) {
    errors.push('invoices must contain at least one entry');
    return errors;
  }

  if (body.invoices.length > MAX_EXPORT_INVOICES) {
    errors.push(`invoices must not exceed ${MAX_EXPORT_INVOICES} entries`);
    return errors;
  }

  for (let i = 0; i < body.invoices.length; i++) {
    const error = validateInvoiceEntry(body.invoices[i], i);
    if (error) {
      errors.push(error);
    }
  }

  return errors;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FETCH INVOICE DOCUMENTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Batch-fetches invoice documents by their direct Firestore paths.
 * Returns an array of invoice data objects (only those that exist).
 *
 * @param {Array<{ supplierId: string, invoiceId: string }>} invoicePairs
 * @returns {Promise<Array<{ invoiceId: string, supplierId: string, ...data }>>}
 */
async function fetchInvoiceDocuments(invoicePairs) {
  const refs = invoicePairs.map(({ supplierId, invoiceId }) =>
    db.collection('suppliers').doc(supplierId).collection('invoices').doc(invoiceId)
  );

  const snapshots = await db.getAll(...refs);

  const results = [];
  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i];
    if (snap.exists) {
      results.push({
        invoiceId: invoicePairs[i].invoiceId,
        supplierId: invoicePairs[i].supplierId,
        ...snap.data(),
      });
    } else {
      console.warn(
        `Invoice not found: suppliers/${invoicePairs[i].supplierId}/invoices/${invoicePairs[i].invoiceId}`
      );
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOWNLOAD TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Records a download event on each exported invoice document.
 * Updates the `downloadedBy` map with the accountant's UID, last download
 * timestamp, and an incremented download count.
 *
 * Uses batched writes (max 500 per batch, matching MAX_EXPORT_INVOICES).
 */
async function recordDownloads({ invoicePairs, uid, userName }) {
  const batch = db.batch();

  for (const { supplierId, invoiceId } of invoicePairs) {
    const ref = db.collection('suppliers').doc(supplierId).collection('invoices').doc(invoiceId);
    const updates = {
      [`downloadedBy.${uid}.lastDownloadedAt`]: serverTimestamp(),
      [`downloadedBy.${uid}.downloadCount`]: admin.firestore.FieldValue.increment(1),
    };
    if (userName) {
      updates[`downloadedBy.${uid}.name`] = userName;
    }
    batch.update(ref, updates);
  }

  await batch.commit();
  console.log(`Recorded download by ${userName || uid} on ${invoicePairs.length} invoices`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ZIP ENTRY NAMING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Builds a human-readable ZIP entry name from invoice metadata.
 * Format: SupplierName_InvoiceNumber_Date.pdf
 * Falls back to the invoiceId when metadata is missing.
 */
function sanitizeZipEntryName(invoice) {
  const parts = [];

  if (invoice.supplierName) {
    parts.push(invoice.supplierName.replace(/[^a-zA-Z0-9\u0370-\u03FF\u1F00-\u1FFF_-]/g, '_'));
  }

  if (invoice.invoiceNumber) {
    parts.push(invoice.invoiceNumber.toString().replace(/[^a-zA-Z0-9_-]/g, '_'));
  }

  if (invoice.invoiceDate) {
    const date = invoice.invoiceDate.toDate
      ? invoice.invoiceDate.toDate()
      : new Date(invoice.invoiceDate);
    if (!isNaN(date.getTime())) {
      parts.push(formatAthensDate(date));
    }
  }

  if (parts.length === 0) {
    parts.push(invoice.invoiceId || 'unknown');
  }

  return `${parts.join('_')}.pdf`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STREAMING ZIP BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Streams invoice PDFs from GCS into a ZIP archive and uploads the result
 * back to GCS. Returns the GCS object path of the generated ZIP.
 *
 * Uses streaming throughout: GCS read → archiver → GCS write.
 * Peak memory stays bounded regardless of invoice count.
 */
async function streamInvoicesZip({ invoices, uid }) {
  const bucketName = getBucketName();
  const bucket = storage.bucket(bucketName);
  const timestamp = Date.now();
  const zipObjectPath = `${EXPORTS_PREFIX}${uid}/${timestamp}.zip`;
  const zipFile = bucket.file(zipObjectPath);

  // Set up archiver in streaming mode
  const archive = archiver('zip', { zlib: { level: 5 } });

  // Create a passthrough stream to bridge archiver → GCS write stream
  const passThrough = new PassThrough();

  // Pipe archiver output through passthrough to GCS
  archive.pipe(passThrough);

  // Start the GCS upload (consumes the passthrough stream)
  const uploadPromise = pipeline(
    passThrough,
    zipFile.createWriteStream({
      resumable: false,
      contentType: 'application/zip',
      metadata: {
        invoiceCount: invoices.length.toString(),
        createdBy: uid,
      },
    })
  );

  // Track used filenames to avoid collisions within the ZIP
  const usedNames = new Set();

  for (const invoice of invoices) {
    const filePath = invoice.filePath;
    if (!filePath) {
      console.warn(`Invoice ${invoice.invoiceId} has no filePath, skipping`);
      continue;
    }

    let entryName = sanitizeZipEntryName(invoice);

    // Deduplicate filenames within the ZIP
    if (usedNames.has(entryName)) {
      const base = entryName.replace(/\.pdf$/, '');
      let counter = 2;
      while (usedNames.has(`${base}_${counter}.pdf`)) {
        counter++;
      }
      entryName = `${base}_${counter}.pdf`;
    }
    usedNames.add(entryName);

    const invoiceBucket = invoice.bucket || bucketName;
    const sourceFile = storage.bucket(invoiceBucket).file(filePath);

    // Stream directly from GCS into the archive — no buffering
    const readStream = sourceFile.createReadStream();
    archive.append(readStream, { name: entryName });
  }

  // Signal that all files have been appended
  await archive.finalize();

  // Wait for the GCS upload to complete
  await uploadPromise;

  console.log(`ZIP archive created at gs://${bucketName}/${zipObjectPath} with ${invoices.length} invoices`);

  return zipObjectPath;
}

/**
 * Generates a signed download URL for a ZIP export.
 */
async function getExportDownloadUrl(zipObjectPath) {
  const bucketName = getBucketName();
  const file = storage.bucket(bucketName).file(zipObjectPath);
  const expiresAtMs = Date.now() + SIGNED_URL_TTL_MS;

  const [downloadUrl] = await file.getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: expiresAtMs,
  });

  return {
    downloadUrl,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

export {
  EXPORTS_PREFIX,
  MAX_EXPORT_INVOICES,
  validateInvoiceEntry,
  validateExportRequest,
  fetchInvoiceDocuments,
  recordDownloads,
  sanitizeZipEntryName,
  streamInvoicesZip,
  getExportDownloadUrl,
};
