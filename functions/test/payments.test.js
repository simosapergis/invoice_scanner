import { describe, it, expect } from 'vitest';
import { validatePaymentRequest, derivePaymentStatus, validateUpdateFieldsRequest } from '../lib/payments.js';

// ═══════════════════════════════════════════════════════════════════════════════
// validatePaymentRequest
// ═══════════════════════════════════════════════════════════════════════════════

describe('validatePaymentRequest', () => {
  const validFullPayment = {
    supplierId: 'supplier-1',
    invoiceId: 'invoice-1',
    action: 'pay',
  };

  const validPartialPayment = {
    supplierId: 'supplier-1',
    invoiceId: 'invoice-1',
    action: 'partial',
    amount: 50,
  };

  it('returns no errors for valid full payment', () => {
    expect(validatePaymentRequest(validFullPayment)).toEqual([]);
  });

  it('returns no errors for valid partial payment', () => {
    expect(validatePaymentRequest(validPartialPayment)).toEqual([]);
  });

  it('returns no errors for full payment with explicit amount', () => {
    expect(validatePaymentRequest({ ...validFullPayment, amount: 100 })).toEqual([]);
  });

  it('requires supplierId to be a non-empty string', () => {
    const errors = validatePaymentRequest({ ...validFullPayment, supplierId: '' });
    expect(errors).toContain('supplierId is required and must be a string');
  });

  it('rejects non-string supplierId', () => {
    const errors = validatePaymentRequest({ ...validFullPayment, supplierId: 123 });
    expect(errors).toContain('supplierId is required and must be a string');
  });

  it('requires invoiceId to be a non-empty string', () => {
    const errors = validatePaymentRequest({ ...validFullPayment, invoiceId: '' });
    expect(errors).toContain('invoiceId is required and must be a string');
  });

  it('rejects null invoiceId', () => {
    const errors = validatePaymentRequest({ ...validFullPayment, invoiceId: null });
    expect(errors).toContain('invoiceId is required and must be a string');
  });

  it('requires action to be "pay" or "partial"', () => {
    const errors = validatePaymentRequest({ ...validFullPayment, action: 'refund' });
    expect(errors).toContain('action must be "pay" or "partial"');
  });

  it('rejects missing action', () => {
    const errors = validatePaymentRequest({ supplierId: 's', invoiceId: 'i' });
    expect(errors).toContain('action must be "pay" or "partial"');
  });

  it('requires positive amount for partial payments', () => {
    const errors = validatePaymentRequest({ ...validFullPayment, action: 'partial' });
    expect(errors.some((e) => e.includes('amount is required') && e.includes('partial'))).toBe(true);
  });

  it('rejects zero amount for partial payments', () => {
    const errors = validatePaymentRequest({ ...validFullPayment, action: 'partial', amount: 0 });
    expect(errors.some((e) => e.includes('amount is required') && e.includes('partial'))).toBe(true);
  });

  it('rejects negative amount', () => {
    const errors = validatePaymentRequest({ ...validFullPayment, amount: -10 });
    expect(errors.some((e) => e.includes('non-negative'))).toBe(true);
  });

  it('validates paymentDate is a valid ISO date', () => {
    const errors = validatePaymentRequest({ ...validFullPayment, paymentDate: 'not-a-date' });
    expect(errors).toContain('paymentDate must be a valid ISO date string');
  });

  it('accepts valid paymentDate', () => {
    const errors = validatePaymentRequest({ ...validFullPayment, paymentDate: '2024-12-25' });
    expect(errors).toEqual([]);
  });

  it('validates notes is a string if provided', () => {
    const errors = validatePaymentRequest({ ...validFullPayment, notes: 123 });
    expect(errors).toContain('notes must be a string');
  });

  it('accepts string notes', () => {
    const errors = validatePaymentRequest({ ...validFullPayment, notes: 'Payment by bank transfer' });
    expect(errors).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// derivePaymentStatus
// ═══════════════════════════════════════════════════════════════════════════════

describe('derivePaymentStatus', () => {
  it('returns "paid" when paidAmount equals totalAmount', () => {
    expect(derivePaymentStatus(100, 100)).toBe('paid');
  });

  it('returns "paid" when paidAmount exceeds totalAmount', () => {
    expect(derivePaymentStatus(150, 100)).toBe('paid');
  });

  it('returns "partially_paid" when 0 < paidAmount < totalAmount', () => {
    expect(derivePaymentStatus(50, 100)).toBe('partially_paid');
  });

  it('returns "partially_paid" for small partial payments', () => {
    expect(derivePaymentStatus(0.01, 100)).toBe('partially_paid');
  });

  it('returns "unpaid" when paidAmount is 0', () => {
    expect(derivePaymentStatus(0, 100)).toBe('unpaid');
  });

  it('returns "unpaid" when both amounts are 0', () => {
    expect(derivePaymentStatus(0, 0)).toBe('unpaid');
  });

  it('returns "partially_paid" when paidAmount > 0 but totalAmount is 0', () => {
    // Unknown total — can only say something was paid
    expect(derivePaymentStatus(50, 0)).toBe('partially_paid');
  });

  it('handles null totalAmount as unknown', () => {
    expect(derivePaymentStatus(0, null)).toBe('unpaid');
    expect(derivePaymentStatus(10, null)).toBe('partially_paid');
  });

  it('handles undefined totalAmount as unknown', () => {
    expect(derivePaymentStatus(0, undefined)).toBe('unpaid');
    expect(derivePaymentStatus(10, undefined)).toBe('partially_paid');
  });

  it('returns "unpaid" for negative totalAmount with zero paid', () => {
    expect(derivePaymentStatus(0, -10)).toBe('unpaid');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// validateUpdateFieldsRequest
// ═══════════════════════════════════════════════════════════════════════════════

describe('validateUpdateFieldsRequest', () => {
  const validBody = {
    supplierId: 'sup-1',
    invoiceId: 'inv-1',
    fields: { supplierName: 'New Name' },
  };

  it('returns no errors for valid request', () => {
    expect(validateUpdateFieldsRequest(validBody)).toEqual([]);
  });

  it('requires supplierId', () => {
    const errors = validateUpdateFieldsRequest({ ...validBody, supplierId: '' });
    expect(errors.some((e) => e.includes('supplierId'))).toBe(true);
  });

  it('requires invoiceId', () => {
    const errors = validateUpdateFieldsRequest({ ...validBody, invoiceId: null });
    expect(errors.some((e) => e.includes('invoiceId'))).toBe(true);
  });

  it('requires fields to be an object', () => {
    const errors = validateUpdateFieldsRequest({ ...validBody, fields: null });
    expect(errors.some((e) => e.includes('fields is required'))).toBe(true);
  });

  it('returns early when fields is missing (no field-level errors)', () => {
    const errors = validateUpdateFieldsRequest({ supplierId: 'sup', invoiceId: 'inv', fields: 'not-object' });
    expect(errors).toEqual(['fields is required and must be an object']);
  });

  // String field type validation
  it('validates supplierName must be a string', () => {
    const errors = validateUpdateFieldsRequest({ ...validBody, fields: { supplierName: 123 } });
    expect(errors).toContain('fields.supplierName must be a string');
  });

  it('validates supplierTaxNumber must be a string', () => {
    const errors = validateUpdateFieldsRequest({ ...validBody, fields: { supplierTaxNumber: 999 } });
    expect(errors).toContain('fields.supplierTaxNumber must be a string');
  });

  it('validates invoiceNumber must be a string', () => {
    const errors = validateUpdateFieldsRequest({ ...validBody, fields: { invoiceNumber: true } });
    expect(errors).toContain('fields.invoiceNumber must be a string');
  });

  it('validates currency must be a string', () => {
    const errors = validateUpdateFieldsRequest({ ...validBody, fields: { currency: 42 } });
    expect(errors).toContain('fields.currency must be a string');
  });

  // Date field validation
  it('validates invoiceDate is a valid date', () => {
    const errors = validateUpdateFieldsRequest({ ...validBody, fields: { invoiceDate: 'not-a-date' } });
    expect(errors).toContain('fields.invoiceDate must be a valid ISO date string');
  });

  it('validates dueDate is a valid date', () => {
    const errors = validateUpdateFieldsRequest({ ...validBody, fields: { dueDate: 'invalid' } });
    expect(errors).toContain('fields.dueDate must be a valid ISO date string');
  });

  it('accepts valid date strings', () => {
    const errors = validateUpdateFieldsRequest({
      ...validBody,
      fields: { invoiceDate: '2024-01-15', dueDate: '2024-02-15' },
    });
    expect(errors).toEqual([]);
  });

  // Numeric field validation
  it('validates numeric fields must be valid numbers', () => {
    const errors = validateUpdateFieldsRequest({ ...validBody, fields: { totalAmount: 'abc' } });
    expect(errors).toContain('fields.totalAmount must be a valid number');
  });

  it('validates numeric fields must be non-negative', () => {
    const errors = validateUpdateFieldsRequest({ ...validBody, fields: { totalAmount: -10 } });
    expect(errors).toContain('fields.totalAmount must be non-negative');
  });

  it('accepts zero for numeric fields', () => {
    const errors = validateUpdateFieldsRequest({ ...validBody, fields: { paidAmount: 0 } });
    expect(errors).toEqual([]);
  });

  // Unknown fields
  it('rejects unknown fields', () => {
    const errors = validateUpdateFieldsRequest({ ...validBody, fields: { unknownField: 'value' } });
    expect(errors.some((e) => e.includes('Unknown fields'))).toBe(true);
  });

  // All editable fields accepted
  it('accepts all editable fields at once', () => {
    const errors = validateUpdateFieldsRequest({
      ...validBody,
      fields: {
        supplierName: 'Name',
        supplierTaxNumber: '123456789',
        invoiceNumber: 'INV-001',
        invoiceDate: '2024-01-15',
        dueDate: '2024-02-15',
        totalAmount: 100,
        netAmount: 80,
        vatAmount: 20,
        vatRate: 24,
        paidAmount: 50,
        currency: 'EUR',
      },
    });
    expect(errors).toEqual([]);
  });
});
