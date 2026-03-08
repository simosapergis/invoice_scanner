import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  normalizeEuropeanDecimals,
  parseAmount,
  parseDate,
  collectResponseText,
  parseJsonFromResponse,
  formatMetadataError,
  formatMetadataSuccess,
  getOpenAIClient,
  runInvoiceOcrAttempt,
} from '../lib/invoice-ocr.js';
import { getVisionClient } from '../lib/config.js';

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

  it('parses dd-MMM-yyyy format via fallback (05-Jan-2026)', () => {
    const result = parseDate('05-Jan-2026');
    expect(result).not.toBeNull();
    expect(result.toDate().toISOString()).toBe('2026-01-05T00:00:00.000Z');
  });

  it('parses MMM dd, yyyy format via fallback (Jan 05, 2026)', () => {
    const result = parseDate('Jan 05, 2026');
    expect(result).not.toBeNull();
    expect(result.toDate().toISOString()).toBe('2026-01-05T00:00:00.000Z');
  });

  it('parses full month name format via fallback (January 5, 2026)', () => {
    const result = parseDate('January 5, 2026');
    expect(result).not.toBeNull();
    expect(result.toDate().toISOString()).toBe('2026-01-05T00:00:00.000Z');
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

// ═══════════════════════════════════════════════════════════════════════════════
// getOpenAIClient
// ═══════════════════════════════════════════════════════════════════════════════

describe('getOpenAIClient', () => {
  it('returns an OpenAI client instance', () => {
    const client = getOpenAIClient();
    expect(client).toBeDefined();
    expect(client.responses).toBeDefined();
  });

  it('returns the same instance on repeated calls (singleton)', () => {
    const a = getOpenAIClient();
    const b = getOpenAIClient();
    expect(a).toBe(b);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// runInvoiceOcrAttempt
// ═══════════════════════════════════════════════════════════════════════════════

describe('runInvoiceOcrAttempt', () => {
  const MOCK_OCR_JSON = JSON.stringify({
    ΗΜΕΡΟΜΗΝΙΑ: '01/01/2026',
    'ΑΡΙΘΜΟΣ ΤΙΜΟΛΟΓΙΟΥ': '12345',
    ΠΡΟΜΗΘΕΥΤΗΣ: 'Test Supplier',
    'ΑΦΜ ΠΡΟΜΗΘΕΥΤΗ': '123456789',
    'ΚΑΘΑΡΗ ΑΞΙΑ': '100.00',
    ΦΠΑ: '24.00',
    ΠΛΗΡΩΤΕΟ: '124.00',
    ΑΚΡΙΒΕΙΑ: '90',
  });

  let visionClient;
  let openaiClient;

  beforeEach(() => {
    visionClient = getVisionClient();
    openaiClient = getOpenAIClient();
    openaiClient.responses.create = vi.fn().mockResolvedValue({
      output: [{ content: [{ text: MOCK_OCR_JSON }] }],
    });
  });

  it('calls batchAnnotateFiles for PDF pages with GCS URI', async () => {
    const batchSpy = vi.spyOn(visionClient, 'batchAnnotateFiles').mockResolvedValue([{
      responses: [{
        responses: [
          { fullTextAnnotation: { text: 'Page 1 text from PDF' } },
        ],
      }],
    }]);

    const pages = [{
      mimeType: 'application/pdf',
      bucketName: 'test-bucket',
      objectName: 'uploads/inv-1/invoice.pdf',
      totalPages: 1,
      pageNumber: 1,
    }];

    const result = await runInvoiceOcrAttempt(pages);

    expect(batchSpy).toHaveBeenCalledOnce();
    const callArg = batchSpy.mock.calls[0][0];
    expect(callArg.requests[0].inputConfig.gcsSource.uri).toBe('gs://test-bucket/uploads/inv-1/invoice.pdf');
    expect(callArg.requests[0].inputConfig.mimeType).toBe('application/pdf');
    expect(result).toBeDefined();
    expect(result['ΠΡΟΜΗΘΕΥΤΗΣ']).toBe('Test Supplier');
    batchSpy.mockRestore();
  });

  it('passes pages [1, N] when totalPages > 2 (first+last optimization)', async () => {
    const batchSpy = vi.spyOn(visionClient, 'batchAnnotateFiles').mockResolvedValue([{
      responses: [{
        responses: [
          { fullTextAnnotation: { text: 'First page text' } },
          { fullTextAnnotation: { text: 'Last page text' } },
        ],
      }],
    }]);

    const pages = [{
      mimeType: 'application/pdf',
      bucketName: 'test-bucket',
      objectName: 'uploads/inv-1/invoice.pdf',
      totalPages: 5,
      pageNumber: 1,
    }];

    await runInvoiceOcrAttempt(pages);

    const callArg = batchSpy.mock.calls[0][0];
    expect(callArg.requests[0].pages).toEqual([1, 5]);
    batchSpy.mockRestore();
  });

  it('omits pages param when totalPages <= 2', async () => {
    const batchSpy = vi.spyOn(visionClient, 'batchAnnotateFiles').mockResolvedValue([{
      responses: [{
        responses: [
          { fullTextAnnotation: { text: 'Page 1' } },
          { fullTextAnnotation: { text: 'Page 2' } },
        ],
      }],
    }]);

    const pages = [{
      mimeType: 'application/pdf',
      bucketName: 'test-bucket',
      objectName: 'uploads/inv-1/invoice.pdf',
      totalPages: 2,
      pageNumber: 1,
    }];

    await runInvoiceOcrAttempt(pages);

    const callArg = batchSpy.mock.calls[0][0];
    expect(callArg.requests[0].pages).toBeUndefined();
    batchSpy.mockRestore();
  });

  it('throws when PDF Vision response has no text', async () => {
    vi.spyOn(visionClient, 'batchAnnotateFiles').mockResolvedValue([{
      responses: [{
        responses: [
          { fullTextAnnotation: { text: '' } },
        ],
      }],
    }]);

    const pages = [{
      mimeType: 'application/pdf',
      bucketName: 'test-bucket',
      objectName: 'uploads/inv-1/invoice.pdf',
      totalPages: 1,
      pageNumber: 1,
    }];

    await expect(runInvoiceOcrAttempt(pages)).rejects.toThrow('Vision API did not return any text');
    vi.restoreAllMocks();
  });

  it('calls documentTextDetection for image pages', async () => {
    const docSpy = vi.spyOn(visionClient, 'documentTextDetection').mockResolvedValue([{
      fullTextAnnotation: { text: 'Image page text' },
    }]);

    const pages = [{
      mimeType: 'image/jpeg',
      buffer: Buffer.from('fake-image'),
      pageNumber: 1,
    }];

    const result = await runInvoiceOcrAttempt(pages);

    expect(docSpy).toHaveBeenCalledOnce();
    expect(result).toBeDefined();
    docSpy.mockRestore();
  });
});
