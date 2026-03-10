import { describe, it, expect } from 'vitest';
import {
  validateExportRequest,
  validateInvoiceEntry,
  sanitizeZipEntryName,
  MAX_EXPORT_INVOICES,
} from '../lib/invoice-export.js';

// ═══════════════════════════════════════════════════════════════════════════════
// validateInvoiceEntry
// ═══════════════════════════════════════════════════════════════════════════════

describe('validateInvoiceEntry', () => {
  it('returns null for a valid entry', () => {
    expect(validateInvoiceEntry({ supplierId: 'sup-1', invoiceId: 'inv-1' }, 0)).toBeNull();
  });

  it('rejects null entry', () => {
    const error = validateInvoiceEntry(null, 0);
    expect(error).toBe('invoices[0] must be an object');
  });

  it('rejects non-object entry', () => {
    const error = validateInvoiceEntry('string', 2);
    expect(error).toBe('invoices[2] must be an object');
  });

  it('rejects missing supplierId', () => {
    const error = validateInvoiceEntry({ invoiceId: 'inv-1' }, 1);
    expect(error).toBe('invoices[1].supplierId is required and must be a string');
  });

  it('rejects non-string supplierId', () => {
    const error = validateInvoiceEntry({ supplierId: 123, invoiceId: 'inv-1' }, 0);
    expect(error).toBe('invoices[0].supplierId is required and must be a string');
  });

  it('rejects empty string supplierId', () => {
    const error = validateInvoiceEntry({ supplierId: '', invoiceId: 'inv-1' }, 0);
    expect(error).toBe('invoices[0].supplierId is required and must be a string');
  });

  it('rejects missing invoiceId', () => {
    const error = validateInvoiceEntry({ supplierId: 'sup-1' }, 3);
    expect(error).toBe('invoices[3].invoiceId is required and must be a string');
  });

  it('rejects non-string invoiceId', () => {
    const error = validateInvoiceEntry({ supplierId: 'sup-1', invoiceId: 42 }, 0);
    expect(error).toBe('invoices[0].invoiceId is required and must be a string');
  });

  it('rejects empty string invoiceId', () => {
    const error = validateInvoiceEntry({ supplierId: 'sup-1', invoiceId: '' }, 0);
    expect(error).toBe('invoices[0].invoiceId is required and must be a string');
  });

  it('includes the correct index in error messages', () => {
    const error = validateInvoiceEntry({}, 7);
    expect(error).toContain('invoices[7]');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// validateExportRequest
// ═══════════════════════════════════════════════════════════════════════════════

describe('validateExportRequest', () => {
  const validBody = {
    invoices: [
      { supplierId: 'sup-1', invoiceId: 'inv-a' },
      { supplierId: 'sup-2', invoiceId: 'inv-b' },
    ],
  };

  it('returns no errors for a valid request', () => {
    expect(validateExportRequest(validBody)).toEqual([]);
  });

  it('returns no errors for a single invoice', () => {
    expect(
      validateExportRequest({
        invoices: [{ supplierId: 'sup-1', invoiceId: 'inv-1' }],
      })
    ).toEqual([]);
  });

  // ─── invoices field ──────────────────────────────────────────────────────────

  it('rejects missing invoices field', () => {
    const errors = validateExportRequest({});
    expect(errors).toContain('invoices is required and must be an array');
  });

  it('rejects non-array invoices field', () => {
    const errors = validateExportRequest({ invoices: 'not-an-array' });
    expect(errors).toContain('invoices is required and must be an array');
  });

  it('rejects null invoices field', () => {
    const errors = validateExportRequest({ invoices: null });
    expect(errors).toContain('invoices is required and must be an array');
  });

  it('rejects empty invoices array', () => {
    const errors = validateExportRequest({ invoices: [] });
    expect(errors).toContain('invoices must contain at least one entry');
  });

  // ─── max limit ───────────────────────────────────────────────────────────────

  it('rejects invoices array exceeding max limit', () => {
    const tooMany = Array.from({ length: MAX_EXPORT_INVOICES + 1 }, (_, i) => ({
      supplierId: `sup-${i}`,
      invoiceId: `inv-${i}`,
    }));
    const errors = validateExportRequest({ invoices: tooMany });
    expect(errors).toContain(`invoices must not exceed ${MAX_EXPORT_INVOICES} entries`);
  });

  it('accepts invoices array at exactly the max limit', () => {
    const atMax = Array.from({ length: MAX_EXPORT_INVOICES }, (_, i) => ({
      supplierId: `sup-${i}`,
      invoiceId: `inv-${i}`,
    }));
    expect(validateExportRequest({ invoices: atMax })).toEqual([]);
  });

  // ─── entry validation ────────────────────────────────────────────────────────

  it('collects errors from individual entries', () => {
    const errors = validateExportRequest({
      invoices: [
        { supplierId: 'sup-1', invoiceId: 'inv-1' },
        { supplierId: 123, invoiceId: 'inv-2' },
        { supplierId: 'sup-3' },
      ],
    });
    expect(errors.length).toBe(2);
    expect(errors[0]).toContain('invoices[1]');
    expect(errors[1]).toContain('invoices[2]');
  });

  it('returns early for structural errors before validating entries', () => {
    const errors = validateExportRequest({ invoices: 'bad' });
    expect(errors.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// sanitizeZipEntryName
// ═══════════════════════════════════════════════════════════════════════════════

describe('sanitizeZipEntryName', () => {
  it('builds name from supplier name, invoice number, and date', () => {
    const invoice = {
      supplierName: 'ΑΦΟΙ ΠΑΠΑΔΟΠΟΥΛΟΙ',
      invoiceNumber: '12345',
      invoiceDate: {
        toDate: () => new Date('2026-01-15T00:00:00Z'),
      },
    };
    const name = sanitizeZipEntryName(invoice);
    expect(name).toBe('ΑΦΟΙ_ΠΑΠΑΔΟΠΟΥΛΟΙ_12345_2026-01-15.pdf');
  });

  it('handles missing supplier name', () => {
    const invoice = {
      invoiceNumber: '999',
      invoiceDate: {
        toDate: () => new Date('2026-03-01T00:00:00Z'),
      },
    };
    const name = sanitizeZipEntryName(invoice);
    expect(name).toBe('999_2026-03-01.pdf');
  });

  it('handles missing invoice number', () => {
    const invoice = {
      supplierName: 'TestSupplier',
      invoiceDate: {
        toDate: () => new Date('2026-06-15T00:00:00Z'),
      },
    };
    const name = sanitizeZipEntryName(invoice);
    expect(name).toBe('TestSupplier_2026-06-15.pdf');
  });

  it('handles missing date', () => {
    const invoice = {
      supplierName: 'TestSupplier',
      invoiceNumber: '42',
    };
    const name = sanitizeZipEntryName(invoice);
    expect(name).toBe('TestSupplier_42.pdf');
  });

  it('falls back to invoiceId when all metadata is missing', () => {
    const invoice = { invoiceId: 'abc-123-def' };
    const name = sanitizeZipEntryName(invoice);
    expect(name).toBe('abc-123-def.pdf');
  });

  it('falls back to unknown when everything is missing', () => {
    const name = sanitizeZipEntryName({});
    expect(name).toBe('unknown.pdf');
  });

  it('sanitizes special characters in supplier name', () => {
    const invoice = {
      supplierName: 'A.B.C. / Company (Ltd)',
      invoiceNumber: '1',
    };
    const name = sanitizeZipEntryName(invoice);
    // Special characters replaced with underscores
    expect(name).not.toMatch(/[/()]/);
    expect(name).toMatch(/\.pdf$/);
  });

  it('handles ISO date string instead of Timestamp', () => {
    const invoice = {
      supplierName: 'Test',
      invoiceDate: '2026-05-20',
    };
    const name = sanitizeZipEntryName(invoice);
    expect(name).toBe('Test_2026-05-20.pdf');
  });
});
