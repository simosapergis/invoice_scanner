import { describe, it, expect } from 'vitest';
import {
  normalizeEuropeanDecimals,
  parseAmount,
  parseDate,
  collectResponseText,
  parseJsonFromResponse,
  formatMetadataError,
  formatMetadataSuccess,
} from '../lib/invoice-ocr.js';

// ═══════════════════════════════════════════════════════════════════════════════
// normalizeEuropeanDecimals
// ═══════════════════════════════════════════════════════════════════════════════

describe('normalizeEuropeanDecimals', () => {
  it('converts simple European decimal (383,13 → 383.13)', () => {
    expect(normalizeEuropeanDecimals('383,13')).toBe('383.13');
  });

  it('converts with thousands separator (2.383,13 → 2383.13)', () => {
    expect(normalizeEuropeanDecimals('2.383,13')).toBe('2383.13');
  });

  it('converts multiple thousands groups (1.234.567,89 → 1234567.89)', () => {
    expect(normalizeEuropeanDecimals('1.234.567,89')).toBe('1234567.89');
  });

  it('handles single-digit decimal part (100,5 → 100.5)', () => {
    expect(normalizeEuropeanDecimals('100,5')).toBe('100.5');
  });

  it('preserves surrounding text', () => {
    expect(normalizeEuropeanDecimals('Total: 2.383,13 EUR')).toBe('Total: 2383.13 EUR');
  });

  it('converts multiple European numbers in the same string', () => {
    const input = 'Net: 1.000,00 VAT: 240,00 Total: 1.240,00';
    const expected = 'Net: 1000.00 VAT: 240.00 Total: 1240.00';
    expect(normalizeEuropeanDecimals(input)).toBe(expected);
  });

  it('does not modify standard decimal format (1234.56)', () => {
    expect(normalizeEuropeanDecimals('1234.56')).toBe('1234.56');
  });

  it('does not modify plain integers', () => {
    expect(normalizeEuropeanDecimals('1234')).toBe('1234');
  });

  it('handles empty string', () => {
    expect(normalizeEuropeanDecimals('')).toBe('');
  });

  it('handles small amounts (0,50 → 0.50)', () => {
    expect(normalizeEuropeanDecimals('0,50')).toBe('0.50');
  });

  it('handles realistic multi-page invoice OCR text', () => {
    const input = '=== PAGE 1 ===\nΚΑΘΑΡΗ ΑΞΙΑ: 2.383,13\nΦΠΑ: 571,95\nΠΛΗΡΩΤΕΟ: 2.955,08';
    const expected = '=== PAGE 1 ===\nΚΑΘΑΡΗ ΑΞΙΑ: 2383.13\nΦΠΑ: 571.95\nΠΛΗΡΩΤΕΟ: 2955.08';
    expect(normalizeEuropeanDecimals(input)).toBe(expected);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseAmount
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseAmount', () => {
  it('parses a simple decimal number string', () => {
    expect(parseAmount('1234.56')).toBe(1234.56);
  });

  it('strips currency symbols', () => {
    expect(parseAmount('€1234.56')).toBe(1234.56);
  });

  it('passes through numeric values', () => {
    expect(parseAmount(100)).toBe(100);
    expect(parseAmount(0)).toBe(0);
  });

  it('returns null for null', () => {
    expect(parseAmount(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(parseAmount(undefined)).toBeNull();
  });

  it('returns null for empty string after stripping', () => {
    expect(parseAmount('')).toBeNull();
  });

  it('returns null for fully non-numeric string', () => {
    expect(parseAmount('abc')).toBeNull();
  });

  it('handles negative numbers', () => {
    expect(parseAmount('-50.00')).toBe(-50);
  });

  it('strips spaces between digits', () => {
    expect(parseAmount('1 234.56')).toBe(1234.56);
  });

  it('handles integer strings', () => {
    expect(parseAmount('500')).toBe(500);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseDate
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseDate', () => {
  it('parses European format dd/mm/yyyy', () => {
    const result = parseDate('25/12/2024');
    expect(result).not.toBeNull();
    expect(result.toDate().toISOString()).toBe('2024-12-25T00:00:00.000Z');
  });

  it('parses European format dd-mm-yyyy', () => {
    const result = parseDate('01-06-2025');
    expect(result).not.toBeNull();
    expect(result.toDate().toISOString()).toBe('2025-06-01T00:00:00.000Z');
  });

  it('parses ISO format yyyy-mm-dd', () => {
    const result = parseDate('2024-03-15');
    expect(result).not.toBeNull();
    expect(result.toDate().toISOString()).toBe('2024-03-15T00:00:00.000Z');
  });

  it('parses single-digit day and month (European format)', () => {
    const result = parseDate('5/3/2024');
    expect(result).not.toBeNull();
    expect(result.toDate().toISOString()).toBe('2024-03-05T00:00:00.000Z');
  });

  it('returns null for null', () => {
    expect(parseDate(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(parseDate(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseDate('')).toBeNull();
  });

  it('returns null for invalid date string', () => {
    expect(parseDate('not-a-date')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// collectResponseText
// ═══════════════════════════════════════════════════════════════════════════════

describe('collectResponseText', () => {
  it('extracts text from output content blocks', () => {
    const response = {
      output: [
        { content: [{ text: 'Hello' }, { text: ' World' }] },
      ],
    };
    expect(collectResponseText(response)).toBe('Hello\n World');
  });

  it('handles output_text property on content parts', () => {
    const response = {
      output: [
        { content: [{ output_text: 'result text' }] },
      ],
    };
    expect(collectResponseText(response)).toBe('result text');
  });

  it('handles value property on content parts', () => {
    const response = {
      output: [
        { content: [{ value: 'some value' }] },
      ],
    };
    expect(collectResponseText(response)).toBe('some value');
  });

  it('handles output_text array at response level', () => {
    const response = {
      output_text: ['line1', 'line2'],
    };
    expect(collectResponseText(response)).toBe('line1\nline2');
  });

  it('combines output blocks and output_text array', () => {
    const response = {
      output: [
        { content: [{ text: 'from blocks' }] },
      ],
      output_text: ['from array'],
    };
    expect(collectResponseText(response)).toBe('from blocks\nfrom array');
  });

  it('returns empty string for empty response object', () => {
    expect(collectResponseText({})).toBe('');
  });

  it('returns empty string for null', () => {
    expect(collectResponseText(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(collectResponseText(undefined)).toBe('');
  });

  it('skips output blocks without content array', () => {
    const response = {
      output: [
        { notContent: 'ignored' },
        { content: [{ text: 'valid' }] },
      ],
    };
    expect(collectResponseText(response)).toBe('valid');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseJsonFromResponse
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseJsonFromResponse', () => {
  it('parses valid JSON string', () => {
    expect(parseJsonFromResponse('{"key": "value"}')).toEqual({ key: 'value' });
  });

  it('extracts JSON embedded in surrounding text', () => {
    const text = 'Here is the result: {"key": "value"} end';
    expect(parseJsonFromResponse(text)).toEqual({ key: 'value' });
  });

  it('handles JSON with nested objects', () => {
    const json = '{"outer": {"inner": 42}}';
    expect(parseJsonFromResponse(json)).toEqual({ outer: { inner: 42 } });
  });

  it('throws for empty text', () => {
    expect(() => parseJsonFromResponse('')).toThrow('Empty OCR response');
  });

  it('throws for null', () => {
    expect(() => parseJsonFromResponse(null)).toThrow('Empty OCR response');
  });

  it('throws for text without JSON', () => {
    expect(() => parseJsonFromResponse('no json here at all')).toThrow('No JSON found in OCR response');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// formatMetadataError / formatMetadataSuccess
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatMetadataError', () => {
  it('formats error with invoice number and supplier name', () => {
    const result = formatMetadataError('12345', 'Test Supplier', 'OCR failed');
    expect(result).toContain('12345');
    expect(result).toContain('Test Supplier');
    expect(result).toContain('OCR failed');
    expect(result).toContain('❌');
  });

  it('returns raw error when supplier is "Unknown Supplier"', () => {
    expect(formatMetadataError('12345', 'Unknown Supplier', 'OCR failed')).toBe('OCR failed');
  });

  it('returns raw error when invoice number is missing', () => {
    expect(formatMetadataError(null, 'Test Supplier', 'OCR failed')).toBe('OCR failed');
  });

  it('returns raw error when supplier name is missing', () => {
    expect(formatMetadataError('12345', null, 'OCR failed')).toBe('OCR failed');
  });
});

describe('formatMetadataSuccess', () => {
  it('formats success message with invoice number and supplier', () => {
    const result = formatMetadataSuccess('12345', 'Test Supplier');
    expect(result).toContain('12345');
    expect(result).toContain('Test Supplier');
    expect(result).toContain('✅');
  });
});
