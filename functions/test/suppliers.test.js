import { describe, it, expect, vi } from 'vitest';
import {
  ensureSupplierProfile,
  validateTimeObject,
  validateDeliveryObject,
  validateUpdateSupplierRequest,
} from '../lib/suppliers.js';
import { db } from '../lib/config.js';

// ═══════════════════════════════════════════════════════════════════════════════
// ensureSupplierProfile
// ═══════════════════════════════════════════════════════════════════════════════

describe('ensureSupplierProfile', () => {
  function mockTransaction(snapData) {
    const txGet = vi.fn().mockResolvedValue({
      exists: snapData !== null,
      data: () => snapData,
    });
    const txSet = vi.fn();
    const txUpdate = vi.fn();

    db.doc = vi.fn().mockReturnValue({ path: 'suppliers/test-id' });
    db.runTransaction = vi.fn(async (cb) =>
      cb({ get: txGet, set: txSet, update: txUpdate })
    );

    return { txGet, txSet, txUpdate };
  }

  it('returns OCR name as canonical when supplier is new', async () => {
    mockTransaction(null);

    const result = await ensureSupplierProfile({
      supplierId: 'sup-1',
      supplierName: 'OCR Name',
      supplierTaxNumber: '123',
      supplierCategory: 'food',
    });

    expect(result).toEqual({ canonicalName: 'OCR Name' });
  });

  it('returns existing Firestore name as canonical when supplier exists', async () => {
    mockTransaction({ name: 'Existing Name', supplierCategory: 'food', supplierTaxNumber: '123' });

    const result = await ensureSupplierProfile({
      supplierId: 'sup-1',
      supplierName: 'OCR Different Name',
      supplierTaxNumber: '123',
      supplierCategory: 'food',
    });

    expect(result).toEqual({ canonicalName: 'Existing Name' });
  });

  it('returns OCR name when existing supplier has no name', async () => {
    mockTransaction({ name: null, supplierCategory: 'food', supplierTaxNumber: '123' });

    const result = await ensureSupplierProfile({
      supplierId: 'sup-1',
      supplierName: 'OCR Name',
      supplierTaxNumber: '123',
      supplierCategory: null,
    });

    expect(result).toEqual({ canonicalName: 'OCR Name' });
  });

  it('returns undefined canonical name when supplierId is missing', async () => {
    const result = await ensureSupplierProfile({
      supplierId: '',
      supplierName: 'Some Name',
      supplierTaxNumber: null,
      supplierCategory: null,
    });

    expect(result).toEqual({ canonicalName: undefined });
  });

  it('returns null canonical name when new supplier has no name', async () => {
    mockTransaction(null);

    const result = await ensureSupplierProfile({
      supplierId: 'sup-1',
      supplierName: null,
      supplierTaxNumber: '123',
      supplierCategory: 'food',
    });

    expect(result).toEqual({ canonicalName: null });
  });

  it('returns OCR name when existing supplier has empty string name', async () => {
    mockTransaction({ name: '', supplierCategory: 'food', supplierTaxNumber: '123' });

    const result = await ensureSupplierProfile({
      supplierId: 'sup-1',
      supplierName: 'OCR Name',
      supplierTaxNumber: '123',
      supplierCategory: null,
    });

    expect(result).toEqual({ canonicalName: 'OCR Name' });
  });

  it('stores missingTaxNumber flag when creating a new supplier', async () => {
    const { txSet } = mockTransaction(null);

    await ensureSupplierProfile({
      supplierId: 'acme-corp',
      supplierName: 'ACME Corp',
      supplierTaxNumber: null,
      supplierCategory: 'food',
      missingTaxNumber: true,
    });

    const setPayload = txSet.mock.calls[0][1];
    expect(setPayload.missingTaxNumber).toBe(true);
    expect(setPayload.name).toBe('ACME Corp');
    expect(setPayload.supplierTaxNumber).toBeNull();
  });

  it('does not set missingTaxNumber flag when VAT is present', async () => {
    const { txSet } = mockTransaction(null);

    await ensureSupplierProfile({
      supplierId: '123456789',
      supplierName: 'ACME Corp',
      supplierTaxNumber: '123456789',
      supplierCategory: 'food',
      missingTaxNumber: false,
    });

    const setPayload = txSet.mock.calls[0][1];
    expect(setPayload.missingTaxNumber).toBe(false);
    expect(setPayload.supplierTaxNumber).toBe('123456789');
  });

  it('sets missingTaxNumber on existing supplier without a tax number', async () => {
    const { txUpdate } = mockTransaction({
      name: 'ACME Corp',
      supplierCategory: 'food',
      supplierTaxNumber: null,
    });

    await ensureSupplierProfile({
      supplierId: 'acme-corp',
      supplierName: 'ACME Corp',
      supplierTaxNumber: null,
      supplierCategory: null,
      missingTaxNumber: true,
    });

    const updatePayload = txUpdate.mock.calls[0][1];
    expect(updatePayload.missingTaxNumber).toBe(true);
  });

  it('does not overwrite missingTaxNumber when existing supplier already has a tax number', async () => {
    const { txUpdate } = mockTransaction({
      name: 'ACME Corp',
      supplierCategory: 'food',
      supplierTaxNumber: '999888777',
    });

    await ensureSupplierProfile({
      supplierId: 'acme-corp',
      supplierName: 'ACME Corp',
      supplierTaxNumber: null,
      supplierCategory: null,
      missingTaxNumber: true,
    });

    expect(txUpdate).not.toHaveBeenCalled();
  });

  it('returns OCR name as canonical when transaction fails', async () => {
    db.doc = vi.fn().mockReturnValue({ path: 'suppliers/test-id' });
    db.runTransaction = vi.fn().mockRejectedValue(new Error('TX failed'));

    const result = await ensureSupplierProfile({
      supplierId: 'sup-1',
      supplierName: 'OCR Name',
      supplierTaxNumber: '123',
      supplierCategory: null,
    });

    expect(result).toEqual({ canonicalName: 'OCR Name' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// validateTimeObject
// ═══════════════════════════════════════════════════════════════════════════════

describe('validateTimeObject', () => {
  it('accepts valid time with hour 0-23 and minute 0-59', () => {
    const errors = [];
    validateTimeObject({ hour: 10, minute: 30 }, 'from', errors);
    expect(errors).toEqual([]);
  });

  it('accepts boundary values (0:00)', () => {
    const errors = [];
    validateTimeObject({ hour: 0, minute: 0 }, 'from', errors);
    expect(errors).toEqual([]);
  });

  it('accepts boundary values (23:59)', () => {
    const errors = [];
    validateTimeObject({ hour: 23, minute: 59 }, 'from', errors);
    expect(errors).toEqual([]);
  });

  it('rejects non-object input', () => {
    const errors = [];
    validateTimeObject('10:30', 'from', errors);
    expect(errors.some((e) => e.includes('must be an object'))).toBe(true);
  });

  it('rejects null', () => {
    const errors = [];
    validateTimeObject(null, 'from', errors);
    expect(errors.some((e) => e.includes('must be an object'))).toBe(true);
  });

  it('rejects hour > 23', () => {
    const errors = [];
    validateTimeObject({ hour: 24, minute: 0 }, 'time', errors);
    expect(errors.some((e) => e.includes('hour'))).toBe(true);
  });

  it('rejects hour < 0', () => {
    const errors = [];
    validateTimeObject({ hour: -1, minute: 0 }, 'time', errors);
    expect(errors.some((e) => e.includes('hour'))).toBe(true);
  });

  it('rejects non-integer hour', () => {
    const errors = [];
    validateTimeObject({ hour: 10.5, minute: 0 }, 'time', errors);
    expect(errors.some((e) => e.includes('hour'))).toBe(true);
  });

  it('rejects minute > 59', () => {
    const errors = [];
    validateTimeObject({ hour: 10, minute: 60 }, 'time', errors);
    expect(errors.some((e) => e.includes('minute'))).toBe(true);
  });

  it('rejects minute < 0', () => {
    const errors = [];
    validateTimeObject({ hour: 10, minute: -1 }, 'time', errors);
    expect(errors.some((e) => e.includes('minute'))).toBe(true);
  });

  it('rejects non-integer minute', () => {
    const errors = [];
    validateTimeObject({ hour: 10, minute: 30.5 }, 'time', errors);
    expect(errors.some((e) => e.includes('minute'))).toBe(true);
  });

  it('includes the field name in error messages', () => {
    const errors = [];
    validateTimeObject({ hour: 25, minute: 70 }, 'delivery.from', errors);
    expect(errors[0]).toContain('delivery.from');
  });

  it('returns false for non-object input', () => {
    const errors = [];
    const result = validateTimeObject(null, 'from', errors);
    expect(result).toBe(false);
  });

  it('returns true for valid object (even if fields are invalid)', () => {
    const errors = [];
    const result = validateTimeObject({ hour: 25, minute: 0 }, 'from', errors);
    expect(result).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// validateDeliveryObject
// ═══════════════════════════════════════════════════════════════════════════════

describe('validateDeliveryObject', () => {
  it('accepts a valid complete delivery object', () => {
    const errors = [];
    validateDeliveryObject(
      {
        dayOfWeek: 1,
        from: { hour: 9, minute: 0 },
        to: { hour: 17, minute: 0 },
      },
      errors
    );
    expect(errors).toEqual([]);
  });

  it('accepts partial delivery (only dayOfWeek)', () => {
    const errors = [];
    validateDeliveryObject({ dayOfWeek: 3 }, errors);
    expect(errors).toEqual([]);
  });

  it('rejects non-object input', () => {
    const errors = [];
    validateDeliveryObject('monday', errors);
    expect(errors).toContain('fields.delivery must be an object');
  });

  it('rejects null', () => {
    const errors = [];
    validateDeliveryObject(null, errors);
    expect(errors).toContain('fields.delivery must be an object');
  });

  it('rejects dayOfWeek < 1', () => {
    const errors = [];
    validateDeliveryObject({ dayOfWeek: 0 }, errors);
    expect(errors.some((e) => e.includes('dayOfWeek'))).toBe(true);
  });

  it('rejects dayOfWeek > 7', () => {
    const errors = [];
    validateDeliveryObject({ dayOfWeek: 8 }, errors);
    expect(errors.some((e) => e.includes('dayOfWeek'))).toBe(true);
  });

  it('accepts dayOfWeek 1 (Monday) through 7 (Sunday)', () => {
    for (let day = 1; day <= 7; day++) {
      const errors = [];
      validateDeliveryObject({ dayOfWeek: day }, errors);
      expect(errors).toEqual([]);
    }
  });

  it('rejects non-integer dayOfWeek', () => {
    const errors = [];
    validateDeliveryObject({ dayOfWeek: 2.5 }, errors);
    expect(errors.some((e) => e.includes('dayOfWeek'))).toBe(true);
  });

  it('validates from and to time objects', () => {
    const errors = [];
    validateDeliveryObject(
      {
        from: { hour: 25, minute: 0 },
        to: { hour: 10, minute: 70 },
      },
      errors
    );
    expect(errors.length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// validateUpdateSupplierRequest
// ═══════════════════════════════════════════════════════════════════════════════

describe('validateUpdateSupplierRequest', () => {
  const validBody = {
    supplierId: 'sup-1',
    fields: { name: 'New Name' },
  };

  it('returns no errors for valid request', () => {
    expect(validateUpdateSupplierRequest(validBody)).toEqual([]);
  });

  it('requires supplierId to be a non-empty string', () => {
    const errors = validateUpdateSupplierRequest({ ...validBody, supplierId: '' });
    expect(errors.some((e) => e.includes('supplierId'))).toBe(true);
  });

  it('rejects non-string supplierId', () => {
    const errors = validateUpdateSupplierRequest({ ...validBody, supplierId: 123 });
    expect(errors.some((e) => e.includes('supplierId'))).toBe(true);
  });

  it('requires fields to be an object', () => {
    const errors = validateUpdateSupplierRequest({ ...validBody, fields: null });
    expect(errors.some((e) => e.includes('fields is required'))).toBe(true);
  });

  it('returns early when fields is missing', () => {
    const errors = validateUpdateSupplierRequest({ supplierId: 'sup', fields: 'not-object' });
    expect(errors).toEqual(['fields is required and must be an object']);
  });

  it('validates name must be a string', () => {
    const errors = validateUpdateSupplierRequest({ ...validBody, fields: { name: 123 } });
    expect(errors).toContain('fields.name must be a string');
  });

  it('validates supplierCategory must be a string', () => {
    const errors = validateUpdateSupplierRequest({ ...validBody, fields: { supplierCategory: true } });
    expect(errors).toContain('fields.supplierCategory must be a string');
  });

  it('validates supplierTaxNumber must be a string', () => {
    const errors = validateUpdateSupplierRequest({ ...validBody, fields: { supplierTaxNumber: 123456789 } });
    expect(errors).toContain('fields.supplierTaxNumber must be a string');
  });

  it('validates supplierTaxNumber contains only digits', () => {
    const errors = validateUpdateSupplierRequest({ ...validBody, fields: { supplierTaxNumber: '12345abc' } });
    expect(errors).toContain('fields.supplierTaxNumber must contain only digits');
  });

  it('accepts valid supplierTaxNumber (digits only)', () => {
    const errors = validateUpdateSupplierRequest({ ...validBody, fields: { supplierTaxNumber: '123456789' } });
    expect(errors).toEqual([]);
  });

  it('rejects unknown fields', () => {
    const errors = validateUpdateSupplierRequest({ ...validBody, fields: { email: 'test@example.com' } });
    expect(errors.some((e) => e.includes('Unknown fields'))).toBe(true);
    expect(errors.some((e) => e.includes('email'))).toBe(true);
  });

  it('validates nested delivery object', () => {
    const errors = validateUpdateSupplierRequest({
      ...validBody,
      fields: { delivery: { dayOfWeek: 0 } },
    });
    expect(errors.some((e) => e.includes('dayOfWeek'))).toBe(true);
  });

  it('accepts valid delivery object', () => {
    const errors = validateUpdateSupplierRequest({
      ...validBody,
      fields: {
        delivery: {
          dayOfWeek: 2,
          from: { hour: 8, minute: 0 },
          to: { hour: 14, minute: 30 },
        },
      },
    });
    expect(errors).toEqual([]);
  });

  it('accepts all editable fields at once', () => {
    const errors = validateUpdateSupplierRequest({
      supplierId: 'sup-1',
      fields: {
        name: 'Supplier Name',
        supplierCategory: 'food',
        supplierTaxNumber: '123456789',
        delivery: {
          dayOfWeek: 5,
          from: { hour: 7, minute: 0 },
          to: { hour: 12, minute: 0 },
        },
      },
    });
    expect(errors).toEqual([]);
  });
});
