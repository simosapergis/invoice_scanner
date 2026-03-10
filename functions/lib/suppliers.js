import { db, storage, serverTimestamp, getBucketName, METADATA_INVOICE_COLLECTION } from './config.js';
import { FINANCIAL_ENTRIES_COLLECTION } from './financial.js';

const EDITABLE_SUPPLIER_FIELDS = ['name', 'supplierCategory', 'supplierTaxNumber', 'delivery'];

const MAX_BATCH_OPS = 500;

async function ensureSupplierProfile({ supplierId, supplierName, supplierTaxNumber, supplierCategory, missingTaxNumber }) {
  if (!supplierId) {
    console.warn('Missing supplierId; skipping supplier profile update.');
    return { canonicalName: undefined };
  }

  const supplierRef = db.doc(`suppliers/${supplierId}`);

  try {
    const canonicalName = await db.runTransaction(async (tx) => {
      const snap = await tx.get(supplierRef);
      if (!snap.exists) {
        tx.set(supplierRef, {
          name: supplierName || null,
          supplierCategory: supplierCategory || null,
          supplierTaxNumber: supplierTaxNumber || null,
          missingTaxNumber: missingTaxNumber || false,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        return supplierName;
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
      if (missingTaxNumber && !current.supplierTaxNumber) {
        updates.missingTaxNumber = true;
      }

      if (Object.keys(updates).length) {
        updates.updatedAt = serverTimestamp();
        tx.update(supplierRef, updates);
      }

      return current.name || supplierName;
    });

    return { canonicalName };
  } catch (error) {
    console.error(`Failed to upsert supplier profile for ${supplierId}`, error);
    return { canonicalName: supplierName };
  }
}

/**
 * Validates a time object { hour, minute }
 */
function validateTimeObject(time, fieldName, errors) {
  if (typeof time !== 'object' || time === null) {
    errors.push(`${fieldName} must be an object with hour and minute`);
    return false;
  }

  if (typeof time.hour !== 'number' || !Number.isInteger(time.hour) || time.hour < 0 || time.hour > 23) {
    errors.push(`${fieldName}.hour must be an integer between 0 and 23`);
  }

  if (typeof time.minute !== 'number' || !Number.isInteger(time.minute) || time.minute < 0 || time.minute > 59) {
    errors.push(`${fieldName}.minute must be an integer between 0 and 59`);
  }

  return true;
}

/**
 * Validates the delivery object
 */
function validateDeliveryObject(delivery, errors) {
  if (typeof delivery !== 'object' || delivery === null) {
    errors.push('fields.delivery must be an object');
    return;
  }

  // Validate dayOfWeek (1-7, ISO 8601)
  if (delivery.dayOfWeek !== undefined) {
    if (
      typeof delivery.dayOfWeek !== 'number' ||
      !Number.isInteger(delivery.dayOfWeek) ||
      delivery.dayOfWeek < 1 ||
      delivery.dayOfWeek > 7
    ) {
      errors.push('fields.delivery.dayOfWeek must be an integer between 1 (Monday) and 7 (Sunday)');
    }
  }

  // Validate from time
  if (delivery.from !== undefined) {
    validateTimeObject(delivery.from, 'fields.delivery.from', errors);
  }

  // Validate to time
  if (delivery.to !== undefined) {
    validateTimeObject(delivery.to, 'fields.delivery.to', errors);
  }
}

/**
 * Validates update supplier fields request body
 */
function validateUpdateSupplierRequest(body) {
  const errors = [];

  if (!body.supplierId || typeof body.supplierId !== 'string') {
    errors.push('supplierId is required and must be a string');
  }

  if (!body.fields || typeof body.fields !== 'object') {
    errors.push('fields is required and must be an object');
    return errors;
  }

  const fields = body.fields;

  // Validate name
  if (fields.name !== undefined && typeof fields.name !== 'string') {
    errors.push('fields.name must be a string');
  }

  // Validate supplierCategory
  if (fields.supplierCategory !== undefined && typeof fields.supplierCategory !== 'string') {
    errors.push('fields.supplierCategory must be a string');
  }

  // Validate supplierTaxNumber (alphanumeric, 2-17 chars — covers Greek AFM + EU VAT with country prefix)
  if (fields.supplierTaxNumber !== undefined) {
    if (typeof fields.supplierTaxNumber !== 'string') {
      errors.push('fields.supplierTaxNumber must be a string');
    } else if (!/^[A-Za-z0-9]{2,17}$/.test(fields.supplierTaxNumber)) {
      errors.push('fields.supplierTaxNumber must be 2-17 alphanumeric characters');
    }
  }

  // Validate delivery object
  if (fields.delivery !== undefined) {
    validateDeliveryObject(fields.delivery, errors);
  }

  // Check for unknown fields
  const providedFields = Object.keys(fields);
  const unknownFields = providedFields.filter((f) => !EDITABLE_SUPPLIER_FIELDS.includes(f));
  if (unknownFields.length > 0) {
    errors.push(`Unknown fields: ${unknownFields.join(', ')}. Allowed: ${EDITABLE_SUPPLIER_FIELDS.join(', ')}`);
  }

  return errors;
}

/**
 * Migrates a supplier to a new document ID (triggered by tax number change).
 * Copies all invoices, GCS PDFs, and updates cross-references.
 *
 * @param {Object} params
 * @param {string} params.oldSupplierId - Current Firestore document ID
 * @param {string} params.newSupplierId - Target Firestore document ID
 * @param {Object} params.supplierUpdates - Fields to set/merge on the new supplier doc
 * @returns {Promise<{ migratedInvoices: number }>}
 */
async function migrateSupplier({ oldSupplierId, newSupplierId, supplierUpdates }) {
  const bucketName = getBucketName();
  const bucket = storage.bucket(bucketName);

  const oldSupplierRef = db.collection('suppliers').doc(oldSupplierId);
  const newSupplierRef = db.collection('suppliers').doc(newSupplierId);

  // 1. Read old supplier data, target supplier (if exists), and all invoices
  const [oldSupplierSnap, newSupplierSnap, invoicesSnap] = await Promise.all([
    oldSupplierRef.get(),
    newSupplierRef.get(),
    oldSupplierRef.collection('invoices').get(),
  ]);

  if (!oldSupplierSnap.exists) {
    throw Object.assign(
      new Error(`Supplier not found: suppliers/${oldSupplierId}`),
      { httpStatus: 404 }
    );
  }

  const oldSupplierData = oldSupplierSnap.data();
  const invoiceDocs = invoicesSnap.docs;

  // 2. Copy GCS files (server-side, parallel) — collect results for cleanup
  const gcsOps = invoiceDocs.map(async (invoiceDoc) => {
    const data = invoiceDoc.data();
    if (!data.filePath) return { oldPath: null, newPath: null };

    const newFilePath = data.filePath.replace(
      `suppliers/${oldSupplierId}/`,
      `suppliers/${newSupplierId}/`
    );

    try {
      await bucket.file(data.filePath).copy(bucket.file(newFilePath));
    } catch (err) {
      console.warn(
        `GCS copy failed for ${data.filePath} → ${newFilePath}:`,
        err.message
      );
    }

    return { oldPath: data.filePath, newPath: newFilePath };
  });

  const gcsPaths = await Promise.all(gcsOps);

  // 3. Batched Firestore write: create/merge target supplier, copy invoices, delete old docs
  const targetExists = newSupplierSnap.exists;

  let mergedSupplierData;
  const PROFILE_FIELDS = ['name', 'supplierCategory', 'delivery'];

  if (targetExists) {
    // Target exists — preserve its profile; only apply audit metadata + tax number
    const auditOnly = Object.fromEntries(
      Object.entries(supplierUpdates).filter(([k]) => !PROFILE_FIELDS.includes(k))
    );
    mergedSupplierData = {
      ...newSupplierSnap.data(),
      ...auditOnly,
      missingTaxNumber: false,
      updatedAt: serverTimestamp(),
    };
  } else {
    mergedSupplierData = {
      ...oldSupplierData,
      ...supplierUpdates,
      missingTaxNumber: false,
      updatedAt: serverTimestamp(),
    };
  }
  delete mergedSupplierData.createdAt;

  const canonicalName = targetExists
    ? (newSupplierSnap.data().name || oldSupplierData.name)
    : (supplierUpdates.name || oldSupplierData.name);

  const allOps = [];
  allOps.push({ type: 'set', ref: newSupplierRef, data: mergedSupplierData, opts: { merge: true } });

  for (let i = 0; i < invoiceDocs.length; i++) {
    const invoiceDoc = invoiceDocs[i];
    const data = invoiceDoc.data();
    const newFilePath = gcsPaths[i].newPath || data.filePath;
    const newInvoiceRef = newSupplierRef.collection('invoices').doc(invoiceDoc.id);

    allOps.push({
      type: 'set',
      ref: newInvoiceRef,
      data: {
        ...data,
        supplierId: newSupplierId,
        supplierTaxNumber: supplierUpdates.supplierTaxNumber ?? data.supplierTaxNumber,
        supplierName: canonicalName,
        filePath: newFilePath,
      },
    });
    allOps.push({ type: 'delete', ref: oldSupplierRef.collection('invoices').doc(invoiceDoc.id) });
  }

  allOps.push({ type: 'delete', ref: oldSupplierRef });

  await commitInBatches(allOps);

  // 4. Update cross-references in metadata_invoices and financial_entries
  await Promise.all([
    updateMetadataInvoiceRefs(oldSupplierId, newSupplierId),
    updateFinancialEntryRefs(oldSupplierId, newSupplierId),
  ]);

  // 5. Clean up old GCS files (best-effort, after Firestore is consistent)
  const deletions = gcsPaths
    .filter((p) => p.oldPath && p.newPath && p.oldPath !== p.newPath)
    .map((p) => bucket.file(p.oldPath).delete().catch((err) => {
      console.warn(`GCS delete failed for ${p.oldPath}:`, err.message);
    }));
  await Promise.all(deletions);

  return { migratedInvoices: invoiceDocs.length };
}

/**
 * Commits an array of { type, ref, data, opts } operations in batches of 500.
 */
async function commitInBatches(ops) {
  for (let i = 0; i < ops.length; i += MAX_BATCH_OPS) {
    const batch = db.batch();
    const chunk = ops.slice(i, i + MAX_BATCH_OPS);

    for (const op of chunk) {
      if (op.type === 'set') {
        batch.set(op.ref, op.data, op.opts || {});
      } else if (op.type === 'delete') {
        batch.delete(op.ref);
      }
    }

    await batch.commit();
  }
}

async function updateMetadataInvoiceRefs(oldId, newId) {
  const oldPathPrefix = `suppliers/${oldId}/`;
  const newPathPrefix = `suppliers/${newId}/`;

  // Update docs where detectedSupplierId matches
  const detectedQuery = await db
    .collection(METADATA_INVOICE_COLLECTION)
    .where('detectedSupplierId', '==', oldId)
    .get();

  // Update docs where processedInvoicePath starts with old prefix.
  // Firestore has no startsWith — use range query on string ordering.
  const pathQuery = await db
    .collection(METADATA_INVOICE_COLLECTION)
    .where('processedInvoicePath', '>=', oldPathPrefix)
    .where('processedInvoicePath', '<', oldPathPrefix + '\uf8ff')
    .get();

  // De-duplicate in case the same doc matches both queries
  const docsById = new Map();
  for (const snap of [...detectedQuery.docs, ...pathQuery.docs]) {
    if (!docsById.has(snap.id)) docsById.set(snap.id, snap);
  }

  if (docsById.size === 0) return;

  const ops = [];
  for (const [, snap] of docsById) {
    const data = snap.data();
    const updates = {};

    if (data.detectedSupplierId === oldId) {
      updates.detectedSupplierId = newId;
    }
    if (data.processedInvoicePath?.startsWith(oldPathPrefix)) {
      updates.processedInvoicePath = newPathPrefix + data.processedInvoicePath.slice(oldPathPrefix.length);
    }

    if (Object.keys(updates).length > 0) {
      ops.push({ type: 'set', ref: snap.ref, data: updates, opts: { merge: true } });
    }
  }

  await commitInBatches(ops);
}

async function updateFinancialEntryRefs(oldId, newId) {
  const querySnap = await db
    .collection(FINANCIAL_ENTRIES_COLLECTION)
    .where('supplierId', '==', oldId)
    .get();

  if (querySnap.empty) return;

  const ops = querySnap.docs.map((snap) => ({
    type: 'set',
    ref: snap.ref,
    data: { supplierId: newId },
    opts: { merge: true },
  }));

  await commitInBatches(ops);
}

export {
  EDITABLE_SUPPLIER_FIELDS,
  ensureSupplierProfile,
  validateTimeObject,
  validateDeliveryObject,
  validateUpdateSupplierRequest,
  migrateSupplier,
};
