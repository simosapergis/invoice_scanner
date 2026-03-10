import { describe, it, expect } from 'vitest';
import {
  sanitizeFilename,
  sanitizeId,
  normalizeTotalPages,
  normalizePageNumber,
  padPageNumber,
  parseUploadObjectName,
} from '../lib/invoice-upload.js';

// ═══════════════════════════════════════════════════════════════════════════════
// sanitizeFilename
// ═══════════════════════════════════════════════════════════════════════════════

describe('sanitizeFilename', () => {
  it('replaces non-alphanumeric characters with underscores', () => {
    expect(sanitizeFilename('my invoice (1).pdf')).toBe('my_invoice__1_.pdf');
  });

  it('preserves valid filename characters (letters, digits, dot, hyphen, underscore)', () => {
    expect(sanitizeFilename('invoice-2024_v2.pdf')).toBe('invoice-2024_v2.pdf');
  });

  it('returns a UUID when input is empty string', () => {
    const result = sanitizeFilename('');
    expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('returns a UUID for null input', () => {
    const result = sanitizeFilename(null);
    expect(result).toMatch(/^[0-9a-f]{8}-/);
  });

  it('returns a UUID for undefined input', () => {
    const result = sanitizeFilename(undefined);
    expect(result).toMatch(/^[0-9a-f]{8}-/);
  });

  it('handles Greek characters by replacing with underscores', () => {
    expect(sanitizeFilename('τιμολόγιο.pdf')).toBe('_________.pdf');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// sanitizeId
// ═══════════════════════════════════════════════════════════════════════════════

describe('sanitizeId', () => {
  it('lowercases and replaces non-alphanumeric chars with hyphens', () => {
    expect(sanitizeId('My Supplier Name')).toBe('my-supplier-name');
  });

  it('trims leading and trailing hyphens', () => {
    expect(sanitizeId('--hello--')).toBe('hello');
  });

  it('collapses consecutive non-alphanumeric chars into a single hyphen', () => {
    expect(sanitizeId('a   b___c')).toBe('a-b-c');
  });

  it('truncates to 64 characters', () => {
    const long = 'a'.repeat(100);
    expect(sanitizeId(long).length).toBeLessThanOrEqual(64);
  });

  it('returns fallback for empty string', () => {
    expect(sanitizeId('', 'default-id')).toBe('default-id');
  });

  it('returns fallback for null', () => {
    expect(sanitizeId(null, 'fallback')).toBe('fallback');
  });

  it('returns fallback for undefined', () => {
    expect(sanitizeId(undefined, 'fb')).toBe('fb');
  });

  it('converts numbers to string before sanitizing', () => {
    expect(sanitizeId(12345)).toBe('12345');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// normalizeTotalPages
// ═══════════════════════════════════════════════════════════════════════════════

describe('normalizeTotalPages', () => {
  it('returns null for undefined', () => {
    expect(normalizeTotalPages(undefined)).toBeNull();
  });

  it('returns null for null', () => {
    expect(normalizeTotalPages(null)).toBeNull();
  });

  it('converts string to number', () => {
    expect(normalizeTotalPages('3')).toBe(3);
  });

  it('returns value for positive integer', () => {
    expect(normalizeTotalPages(5)).toBe(5);
  });

  it('throws for zero', () => {
    expect(() => normalizeTotalPages(0)).toThrow('totalPages must be a positive integer');
  });

  it('throws for negative number', () => {
    expect(() => normalizeTotalPages(-1)).toThrow('totalPages must be a positive integer');
  });

  it('throws for non-integer', () => {
    expect(() => normalizeTotalPages(2.5)).toThrow('totalPages must be a positive integer');
  });

  it('throws for NaN string', () => {
    expect(() => normalizeTotalPages('abc')).toThrow('totalPages must be a positive integer');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// normalizePageNumber
// ═══════════════════════════════════════════════════════════════════════════════

describe('normalizePageNumber', () => {
  it('returns value for positive integer', () => {
    expect(normalizePageNumber(1)).toBe(1);
  });

  it('converts string to number', () => {
    expect(normalizePageNumber('2')).toBe(2);
  });

  it('throws for zero', () => {
    expect(() => normalizePageNumber(0)).toThrow('pageNumber must be a positive integer');
  });

  it('throws for negative number', () => {
    expect(() => normalizePageNumber(-5)).toThrow('pageNumber must be a positive integer');
  });

  it('throws for non-integer', () => {
    expect(() => normalizePageNumber(1.5)).toThrow('pageNumber must be a positive integer');
  });

  it('throws for NaN string', () => {
    expect(() => normalizePageNumber('foo')).toThrow('pageNumber must be a positive integer');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// padPageNumber
// ═══════════════════════════════════════════════════════════════════════════════

describe('padPageNumber', () => {
  it('pads single-digit numbers to 3 digits', () => {
    expect(padPageNumber(1)).toBe('001');
  });

  it('pads double-digit numbers to 3 digits', () => {
    expect(padPageNumber(12)).toBe('012');
  });

  it('leaves triple-digit numbers unchanged', () => {
    expect(padPageNumber(123)).toBe('123');
  });

  it('does not truncate 4+ digit numbers', () => {
    expect(padPageNumber(1234)).toBe('1234');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseUploadObjectName
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseUploadObjectName', () => {
  it('parses a valid upload object name with leading zeros', () => {
    const result = parseUploadObjectName('uploads/invoice-123/page-001-file.pdf');
    expect(result).toEqual({ invoiceId: 'invoice-123', pageNumber: 1 });
  });

  it('extracts multi-digit page numbers', () => {
    const result = parseUploadObjectName('uploads/abc/page-012-scan.jpg');
    expect(result).toEqual({ invoiceId: 'abc', pageNumber: 12 });
  });

  it('handles page numbers without leading zeros', () => {
    const result = parseUploadObjectName('uploads/inv-1/page-3-doc.png');
    expect(result).toEqual({ invoiceId: 'inv-1', pageNumber: 3 });
  });

  it('parses UUID-style invoice IDs', () => {
    const result = parseUploadObjectName('uploads/a1b2c3d4-e5f6-7890-abcd-ef1234567890/page-001-test.pdf');
    expect(result).toEqual({
      invoiceId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      pageNumber: 1,
    });
  });

  it('returns null for non-upload paths', () => {
    expect(parseUploadObjectName('other/path/file.pdf')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseUploadObjectName('')).toBeNull();
  });

  it('returns null for null', () => {
    expect(parseUploadObjectName(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(parseUploadObjectName(undefined)).toBeNull();
  });

  it('returns null for upload path without page pattern', () => {
    expect(parseUploadObjectName('uploads/inv-1/file.pdf')).toBeNull();
  });

  it('returns null when path has no filename after invoice ID', () => {
    expect(parseUploadObjectName('uploads/inv-1/')).toBeNull();
  });

  it('returns null when path lacks invoice ID segment', () => {
    expect(parseUploadObjectName('uploads/')).toBeNull();
  });

  it('is case-insensitive for page prefix', () => {
    const result = parseUploadObjectName('uploads/inv-1/PAGE-005-file.pdf');
    expect(result).toEqual({ invoiceId: 'inv-1', pageNumber: 5 });
  });
});
