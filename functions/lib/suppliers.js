import { db, serverTimestamp } from './config.js';

const EDITABLE_SUPPLIER_FIELDS = ['name', 'supplierCategory', 'supplierTaxNumber', 'delivery'];

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

  // Validate supplierTaxNumber (string with numbers only)
  if (fields.supplierTaxNumber !== undefined) {
    if (typeof fields.supplierTaxNumber !== 'string') {
      errors.push('fields.supplierTaxNumber must be a string');
    } else if (!/^\d+$/.test(fields.supplierTaxNumber)) {
      errors.push('fields.supplierTaxNumber must contain only digits');
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

export {
  EDITABLE_SUPPLIER_FIELDS,
  ensureSupplierProfile,
  validateTimeObject,
  validateDeliveryObject,
  validateUpdateSupplierRequest,
};
