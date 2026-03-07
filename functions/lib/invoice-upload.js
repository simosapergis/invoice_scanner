import crypto from 'node:crypto';
import { admin, db, UPLOADS_PREFIX, METADATA_INVOICE_COLLECTION, INVOICE_STATUS, serverTimestamp } from './config.js';

function sanitizeFilename(name) {
  return name ? name.replace(/[^a-zA-Z0-9._-]/g, '_') : crypto.randomUUID();
}

function sanitizeId(value, fallback) {
  if (!value) return fallback;
  return (
    value
      .toString()
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 64) || fallback
  );
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

async function ensureInvoiceDocument({ invoiceId, uid, userName, bucketName, totalPages }) {
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
        ownerName: userName || null,
        bucket: bucketName,
        storageFolder: `${UPLOADS_PREFIX}${resolvedInvoiceId}`,
        status: INVOICE_STATUS.pending,
        totalPages: normalizedTotalPages,
        uploadedPages: [],
        uploadedCount: 0,
        pages: [],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        notificationSeen: false,
      });

      return {
        invoiceId: resolvedInvoiceId,
        totalPages: normalizedTotalPages,
        bucket: bucketName,
        status: INVOICE_STATUS.pending,
      };
    }

    const existing = snap.data();
    if (existing.totalPages && normalizedTotalPages && existing.totalPages !== normalizedTotalPages) {
      throw new Error('totalPages does not match the existing invoice metadata');
    }

    tx.update(docRef, {
      totalPages: existing.totalPages || normalizedTotalPages || null,
      bucket: existing.bucket || bucketName,
      ownerUid: existing.ownerUid || uid,
      ownerName: existing.ownerName || userName || null,
      updatedAt: serverTimestamp(),
    });

    return {
      ...existing,
      invoiceId: resolvedInvoiceId,
      totalPages: existing.totalPages || normalizedTotalPages || null,
      bucket: existing.bucket || bucketName,
      status: existing.status || INVOICE_STATUS.pending,
    };
  });

  return metadata;
}

async function registerUploadedPage({ invoiceId, pageNumber, objectName, bucketName, contentType, totalPages, uid }) {
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
      recordedAt: admin.firestore.Timestamp.now(),
    });
    pages.sort((a, b) => a.pageNumber - b.pageNumber);

    const shouldMarkReady = uploadedPages.size === resolvedTotalPages && data.status === INVOICE_STATUS.pending;

    tx.update(docRef, {
      totalPages: resolvedTotalPages,
      uploadedPages: Array.from(uploadedPages).sort((a, b) => a - b),
      uploadedCount: uploadedPages.size,
      pages,
      bucket: bucketName || data.bucket,
      ownerUid: data.ownerUid || uid,
      status: shouldMarkReady ? INVOICE_STATUS.ready : data.status,
      readyAt: shouldMarkReady ? serverTimestamp() : data.readyAt || null,
      updatedAt: serverTimestamp(),
    });

    return {
      invoiceId,
      status: shouldMarkReady ? INVOICE_STATUS.ready : data.status,
      uploadedPages: Array.from(uploadedPages),
      totalPages: resolvedTotalPages,
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

  return {
    invoiceId,
    pageNumber,
  };
}

export {
  sanitizeFilename,
  sanitizeId,
  invoiceDocRef,
  normalizeInvoiceId,
  normalizeTotalPages,
  normalizePageNumber,
  padPageNumber,
  ensureInvoiceDocument,
  registerUploadedPage,
  parseUploadObjectName,
};
