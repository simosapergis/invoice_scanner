import { describe, it, expect, vi } from 'vitest';
import {
  ensureSupplierProfile,
  validateTimeObject,
  validateDeliveryObject,
  validateUpdateSupplierRequest,
  migrateSupplier,
} from '../lib/suppliers.js';
import { db, storage } from '../lib/config.js';

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

  it('rejects supplierTaxNumber with special characters', () => {
    const errors = validateUpdateSupplierRequest({ ...validBody, fields: { supplierTaxNumber: '123-456' } });
    expect(errors).toContain('fields.supplierTaxNumber must be 2-17 alphanumeric characters');
  });

  it('rejects supplierTaxNumber shorter than 2 characters', () => {
    const errors = validateUpdateSupplierRequest({ ...validBody, fields: { supplierTaxNumber: '1' } });
    expect(errors).toContain('fields.supplierTaxNumber must be 2-17 alphanumeric characters');
  });

  it('rejects supplierTaxNumber longer than 17 characters', () => {
    const errors = validateUpdateSupplierRequest({ ...validBody, fields: { supplierTaxNumber: 'A'.repeat(18) } });
    expect(errors).toContain('fields.supplierTaxNumber must be 2-17 alphanumeric characters');
  });

  it('accepts Greek AFM (digits only)', () => {
    const errors = validateUpdateSupplierRequest({ ...validBody, fields: { supplierTaxNumber: '123456789' } });
    expect(errors).toEqual([]);
  });

  it('accepts EU VAT with country prefix', () => {
    expect(validateUpdateSupplierRequest({ ...validBody, fields: { supplierTaxNumber: 'FR392303JD' } })).toEqual([]);
    expect(validateUpdateSupplierRequest({ ...validBody, fields: { supplierTaxNumber: 'IE3668997OH' } })).toEqual([]);
    expect(validateUpdateSupplierRequest({ ...validBody, fields: { supplierTaxNumber: 'DE123456789' } })).toEqual([]);
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

// ═══════════════════════════════════════════════════════════════════════════════
// migrateSupplier
// ═══════════════════════════════════════════════════════════════════════════════

describe('migrateSupplier', () => {
  let mockBatch;
  let mockCopy;
  let mockDelete;
  let mockFileRef;

  function makeDocSnap(id, data, exists = true) {
    return {
      id,
      exists,
      data: () => (exists ? data : undefined),
      ref: { path: `mock/${id}`, id },
    };
  }

  function mockQueryResult(docs) {
    return { empty: docs.length === 0, docs };
  }

  function setupMocks({ oldSupplierData, newSupplierData = null, invoices = [], metadataDocs = [], financialDocs = [] }) {
    mockCopy = vi.fn().mockResolvedValue();
    mockDelete = vi.fn().mockResolvedValue();
    mockFileRef = vi.fn().mockReturnValue({ copy: mockCopy, delete: mockDelete });

    storage.bucket = vi.fn().mockReturnValue({ file: mockFileRef });

    mockBatch = { set: vi.fn(), delete: vi.fn(), commit: vi.fn().mockResolvedValue() };
    db.batch = vi.fn().mockReturnValue(mockBatch);

    const invoiceSnaps = invoices.map((inv) => makeDocSnap(inv.id, inv.data));

    const oldSupplierRef = {
      path: 'suppliers/old-id',
      get: vi.fn().mockResolvedValue(makeDocSnap('old-id', oldSupplierData, !!oldSupplierData)),
      collection: vi.fn().mockReturnValue({
        get: vi.fn().mockResolvedValue({ docs: invoiceSnaps }),
        doc: vi.fn((id) => ({ path: `suppliers/old-id/invoices/${id}`, id })),
      }),
    };

    const newSupplierRef = {
      path: 'suppliers/new-id',
      get: vi.fn().mockResolvedValue(makeDocSnap('new-id', newSupplierData, !!newSupplierData)),
      collection: vi.fn().mockReturnValue({
        doc: vi.fn((id) => ({ path: `suppliers/new-id/invoices/${id}`, id })),
      }),
    };

    // Wire up where().get() chains for cross-reference queries
    const whereChains = [];

    function makeWhereChain(resultDocs) {
      const chain = {
        where: vi.fn().mockReturnThis(),
        get: vi.fn().mockResolvedValue(mockQueryResult(resultDocs)),
      };
      whereChains.push(chain);
      return chain;
    }

    const metadataDetectedChain = makeWhereChain(metadataDocs);
    const metadataPathChain = makeWhereChain(metadataDocs);
    const financialChain = makeWhereChain(financialDocs);

    let metadataCallCount = 0;
    db.collection = vi.fn((name) => {
      if (name === 'suppliers') {
        return {
          doc: vi.fn((id) => {
            if (id === 'old-id') return oldSupplierRef;
            if (id === 'new-id') return newSupplierRef;
            return { path: `suppliers/${id}` };
          }),
        };
      }
      if (name === 'metadata_invoices') {
        metadataCallCount++;
        return metadataCallCount <= 1 ? metadataDetectedChain : metadataPathChain;
      }
      if (name === 'financial_entries') {
        return financialChain;
      }
      return { where: vi.fn().mockReturnThis(), get: vi.fn().mockResolvedValue(mockQueryResult([])) };
    });

    return { oldSupplierRef, newSupplierRef, mockBatch };
  }

  it('migrates supplier doc, invoices, and GCS files to new ID', async () => {
    setupMocks({
      oldSupplierData: { name: 'ACME', supplierTaxNumber: '111', supplierCategory: 'food' },
      invoices: [
        {
          id: 'inv-1',
          data: {
            supplierId: 'old-id',
            supplierTaxNumber: '111',
            filePath: 'suppliers/old-id/invoices/inv-1.pdf',
            invoiceNumber: '001',
          },
        },
      ],
    });

    const result = await migrateSupplier({
      oldSupplierId: 'old-id',
      newSupplierId: 'new-id',
      supplierUpdates: { supplierTaxNumber: '999', lastEditedBy: 'uid-1' },
    });

    expect(result.migratedInvoices).toBe(1);

    // GCS copy was called with old → new path
    expect(mockCopy).toHaveBeenCalledTimes(1);

    // Batch operations: 1 supplier set + 1 invoice set + 1 invoice delete + 1 supplier delete = 4
    expect(mockBatch.set).toHaveBeenCalledTimes(2);
    expect(mockBatch.delete).toHaveBeenCalledTimes(2);
    expect(mockBatch.commit).toHaveBeenCalled();

    // Verify the invoice was written with updated supplierId, filePath, and supplierName
    const invoiceSetCall = mockBatch.set.mock.calls[1];
    expect(invoiceSetCall[1].supplierId).toBe('new-id');
    expect(invoiceSetCall[1].filePath).toBe('suppliers/new-id/invoices/inv-1.pdf');
    expect(invoiceSetCall[1].supplierTaxNumber).toBe('999');
    expect(invoiceSetCall[1].supplierName).toBe('ACME');
  });

  it('throws 404 when old supplier does not exist', async () => {
    setupMocks({ oldSupplierData: null });

    await expect(
      migrateSupplier({
        oldSupplierId: 'old-id',
        newSupplierId: 'new-id',
        supplierUpdates: { supplierTaxNumber: '999' },
      })
    ).rejects.toThrow('Supplier not found');
  });

  it('works when supplier has no invoices', async () => {
    setupMocks({
      oldSupplierData: { name: 'Empty Supplier', supplierTaxNumber: '111' },
      invoices: [],
    });

    const result = await migrateSupplier({
      oldSupplierId: 'old-id',
      newSupplierId: 'new-id',
      supplierUpdates: { supplierTaxNumber: '222' },
    });

    expect(result.migratedInvoices).toBe(0);
    // Only supplier set + supplier delete
    expect(mockBatch.set).toHaveBeenCalledTimes(1);
    expect(mockBatch.delete).toHaveBeenCalledTimes(1);
  });

  it('handles invoice without filePath gracefully', async () => {
    setupMocks({
      oldSupplierData: { name: 'Test', supplierTaxNumber: '111' },
      invoices: [
        { id: 'inv-no-file', data: { supplierId: 'old-id', supplierTaxNumber: '111', invoiceNumber: '002' } },
      ],
    });

    const result = await migrateSupplier({
      oldSupplierId: 'old-id',
      newSupplierId: 'new-id',
      supplierUpdates: { supplierTaxNumber: '999' },
    });

    expect(result.migratedInvoices).toBe(1);
    // No GCS copy for invoices without filePath
    expect(mockCopy).not.toHaveBeenCalled();
  });

  it('uses old supplier data as base when target does not exist', async () => {
    setupMocks({
      oldSupplierData: {
        name: 'Original',
        supplierCategory: 'food',
        supplierTaxNumber: '111',
        delivery: { dayOfWeek: 2 },
        createdAt: 'old-ts',
      },
      invoices: [],
    });

    await migrateSupplier({
      oldSupplierId: 'old-id',
      newSupplierId: 'new-id',
      supplierUpdates: { supplierTaxNumber: '999', name: 'Renamed' },
    });

    const setCall = mockBatch.set.mock.calls[0];
    const mergedData = setCall[1];
    expect(mergedData.name).toBe('Renamed');
    expect(mergedData.supplierTaxNumber).toBe('999');
    expect(mergedData.supplierCategory).toBe('food');
    expect(mergedData.delivery).toEqual({ dayOfWeek: 2 });
    expect(mergedData.createdAt).toBeUndefined();
    expect(mergedData.missingTaxNumber).toBe(false);
    expect(setCall[2]).toEqual({ merge: true });
  });

  it('preserves target supplier profile when target already exists', async () => {
    setupMocks({
      oldSupplierData: {
        name: 'Supplier A',
        supplierCategory: 'cleaning',
        supplierTaxNumber: '111',
      },
      newSupplierData: {
        name: 'Supplier B',
        supplierCategory: 'food',
        supplierTaxNumber: '999',
        delivery: { dayOfWeek: 3 },
      },
      invoices: [],
    });

    await migrateSupplier({
      oldSupplierId: 'old-id',
      newSupplierId: 'new-id',
      supplierUpdates: {
        supplierTaxNumber: '999',
        name: 'Supplier A',
        supplierCategory: 'cleaning',
        lastEditedBy: 'uid-1',
      },
    });

    const setCall = mockBatch.set.mock.calls[0];
    const mergedData = setCall[1];
    // Target's profile fields preserved — name/category/delivery from supplierUpdates ignored
    expect(mergedData.name).toBe('Supplier B');
    expect(mergedData.supplierCategory).toBe('food');
    expect(mergedData.delivery).toEqual({ dayOfWeek: 3 });
    // Audit + tax number still applied
    expect(mergedData.supplierTaxNumber).toBe('999');
    expect(mergedData.lastEditedBy).toBe('uid-1');
    expect(mergedData.missingTaxNumber).toBe(false);
  });

  it('updates supplierName on migrated invoices to target name', async () => {
    setupMocks({
      oldSupplierData: {
        name: 'Supplier A',
        supplierTaxNumber: '111',
      },
      newSupplierData: {
        name: 'Supplier B',
        supplierTaxNumber: '999',
      },
      invoices: [
        {
          id: 'inv-1',
          data: {
            supplierId: 'old-id',
            supplierName: 'Supplier A',
            supplierTaxNumber: '111',
            filePath: 'suppliers/old-id/invoices/inv-1.pdf',
          },
        },
      ],
    });

    await migrateSupplier({
      oldSupplierId: 'old-id',
      newSupplierId: 'new-id',
      supplierUpdates: { supplierTaxNumber: '999' },
    });

    const invoiceSetCall = mockBatch.set.mock.calls[1];
    expect(invoiceSetCall[1].supplierName).toBe('Supplier B');
    expect(invoiceSetCall[1].supplierId).toBe('new-id');
  });

  it('updates metadata_invoices cross-references', async () => {
    const metaSnap = makeDocSnap('meta-1', {
      detectedSupplierId: 'old-id',
      processedInvoicePath: 'suppliers/old-id/invoices/inv-1',
    });

    setupMocks({
      oldSupplierData: { name: 'Test', supplierTaxNumber: '111' },
      invoices: [],
      metadataDocs: [metaSnap],
    });

    await migrateSupplier({
      oldSupplierId: 'old-id',
      newSupplierId: 'new-id',
      supplierUpdates: { supplierTaxNumber: '999' },
    });

    // The batch should include a set for the metadata doc update
    const allSetCalls = mockBatch.set.mock.calls;
    const metadataUpdate = allSetCalls.find(
      (call) => call[1].detectedSupplierId === 'new-id'
    );
    expect(metadataUpdate).toBeDefined();
    expect(metadataUpdate[1].processedInvoicePath).toBe('suppliers/new-id/invoices/inv-1');
  });

  it('updates financial_entries cross-references', async () => {
    const finSnap = makeDocSnap('fin-1', { supplierId: 'old-id', amount: 100 });

    setupMocks({
      oldSupplierData: { name: 'Test', supplierTaxNumber: '111' },
      invoices: [],
      financialDocs: [finSnap],
    });

    await migrateSupplier({
      oldSupplierId: 'old-id',
      newSupplierId: 'new-id',
      supplierUpdates: { supplierTaxNumber: '999' },
    });

    const allSetCalls = mockBatch.set.mock.calls;
    const financialUpdate = allSetCalls.find(
      (call) => call[0]?.id === 'fin-1'
    );
    expect(financialUpdate).toBeDefined();
    expect(financialUpdate[1].supplierId).toBe('new-id');
  });

  it('continues if GCS copy fails for a file', async () => {
    mockCopy = vi.fn().mockRejectedValue(new Error('GCS unavailable'));
    mockDelete = vi.fn().mockResolvedValue();

    setupMocks({
      oldSupplierData: { name: 'Test', supplierTaxNumber: '111' },
      invoices: [
        {
          id: 'inv-1',
          data: {
            supplierId: 'old-id',
            supplierTaxNumber: '111',
            filePath: 'suppliers/old-id/invoices/inv-1.pdf',
          },
        },
      ],
    });

    // Override the file mock after setupMocks (which resets it)
    mockCopy = vi.fn().mockRejectedValue(new Error('GCS unavailable'));
    mockDelete = vi.fn().mockResolvedValue();
    storage.bucket = vi.fn().mockReturnValue({
      file: vi.fn().mockReturnValue({ copy: mockCopy, delete: mockDelete }),
    });

    const result = await migrateSupplier({
      oldSupplierId: 'old-id',
      newSupplierId: 'new-id',
      supplierUpdates: { supplierTaxNumber: '999' },
    });

    // Migration completes despite GCS failure
    expect(result.migratedInvoices).toBe(1);
    expect(mockBatch.commit).toHaveBeenCalled();
  });
});
