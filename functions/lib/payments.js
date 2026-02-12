import { PAYMENT_STATUS } from './config.js';

/**
 * Validates payment request body
 */
function validatePaymentRequest(body) {
  const errors = [];

  if (!body.supplierId || typeof body.supplierId !== 'string') {
    errors.push('supplierId is required and must be a string');
  }

  if (!body.invoiceId || typeof body.invoiceId !== 'string') {
    errors.push('invoiceId is required and must be a string');
  }

  if (!['pay', 'partial'].includes(body.action)) {
    errors.push('action must be "pay" or "partial"');
  }

  if (body.action === 'partial') {
    if (typeof body.amount !== 'number' || body.amount <= 0) {
      errors.push('amount is required and must be a positive number for partial payments');
    }
  }

  if (body.amount !== undefined && (typeof body.amount !== 'number' || body.amount < 0)) {
    errors.push('amount must be a non-negative number');
  }

  if (body.paymentDate) {
    const date = new Date(body.paymentDate);
    if (isNaN(date.getTime())) {
      errors.push('paymentDate must be a valid ISO date string');
    }
  }

  if (body.notes && typeof body.notes !== 'string') {
    errors.push('notes must be a string');
  }

  return errors;
}

/**
 * Derives payment status from amounts
 */
function derivePaymentStatus(paidAmount, totalAmount) {
  if (!totalAmount || totalAmount <= 0) {
    // If totalAmount is unknown, we can't determine status accurately
    return paidAmount > 0 ? PAYMENT_STATUS.partiallyPaid : PAYMENT_STATUS.unpaid;
  }

  if (paidAmount >= totalAmount) {
    return PAYMENT_STATUS.paid;
  }
  if (paidAmount > 0) {
    return PAYMENT_STATUS.partiallyPaid;
  }
  return PAYMENT_STATUS.unpaid;
}

// Allowed fields that can be edited by the user
const EDITABLE_INVOICE_FIELDS = [
  'supplierName',
  'supplierTaxNumber',
  'invoiceNumber',
  'invoiceDate',
  'dueDate',
  'totalAmount',
  'netAmount',
  'vatAmount',
  'vatRate',
  'paidAmount',
  'currency',
];

/**
 * Validates update invoice fields request body
 */
function validateUpdateFieldsRequest(body) {
  const errors = [];

  if (!body.supplierId || typeof body.supplierId !== 'string') {
    errors.push('supplierId is required and must be a string');
  }

  if (!body.invoiceId || typeof body.invoiceId !== 'string') {
    errors.push('invoiceId is required and must be a string');
  }

  if (!body.fields || typeof body.fields !== 'object') {
    errors.push('fields is required and must be an object');
    return errors;
  }

  const fields = body.fields;

  // Validate field types
  if (fields.supplierName !== undefined && typeof fields.supplierName !== 'string') {
    errors.push('fields.supplierName must be a string');
  }

  if (fields.supplierTaxNumber !== undefined && typeof fields.supplierTaxNumber !== 'string') {
    errors.push('fields.supplierTaxNumber must be a string');
  }

  if (fields.invoiceNumber !== undefined && typeof fields.invoiceNumber !== 'string') {
    errors.push('fields.invoiceNumber must be a string');
  }

  if (fields.currency !== undefined && typeof fields.currency !== 'string') {
    errors.push('fields.currency must be a string');
  }

  // Validate date fields
  if (fields.invoiceDate !== undefined) {
    const date = new Date(fields.invoiceDate);
    if (isNaN(date.getTime())) {
      errors.push('fields.invoiceDate must be a valid ISO date string');
    }
  }

  if (fields.dueDate !== undefined) {
    const date = new Date(fields.dueDate);
    if (isNaN(date.getTime())) {
      errors.push('fields.dueDate must be a valid ISO date string');
    }
  }

  // Validate numeric fields
  const numericFields = ['totalAmount', 'netAmount', 'vatAmount', 'vatRate', 'paidAmount'];
  for (const field of numericFields) {
    if (fields[field] !== undefined) {
      if (typeof fields[field] !== 'number' || isNaN(fields[field])) {
        errors.push(`fields.${field} must be a valid number`);
      } else if (fields[field] < 0) {
        errors.push(`fields.${field} must be non-negative`);
      }
    }
  }

  // Check for unknown fields
  const providedFields = Object.keys(fields);
  const unknownFields = providedFields.filter((f) => !EDITABLE_INVOICE_FIELDS.includes(f));
  if (unknownFields.length > 0) {
    errors.push(`Unknown fields: ${unknownFields.join(', ')}. Allowed: ${EDITABLE_INVOICE_FIELDS.join(', ')}`);
  }

  return errors;
}

export { validatePaymentRequest, derivePaymentStatus, EDITABLE_INVOICE_FIELDS, validateUpdateFieldsRequest };
