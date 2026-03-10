import { describe, it, expect } from 'vitest';
import {
  ENTRY_TYPE,
  ENTRY_SOURCE,
  INCOME_CATEGORY,
  EXPENSE_CATEGORY,
  VALID_INCOME_CATEGORIES,
  VALID_EXPENSE_CATEGORIES,
  EDITABLE_ENTRY_FIELDS,
  validateFinancialEntryRequest,
  validateUpdateFinancialEntryRequest,
  buildFinancialEntry,
} from '../lib/financial.js';

// ═══════════════════════════════════════════════════════════════════════════════
// validateFinancialEntryRequest
// ═══════════════════════════════════════════════════════════════════════════════

describe('validateFinancialEntryRequest', () => {
  const validIncome = {
    type: 'income',
    category: INCOME_CATEGORY.cashSales,
    amount: 100,
    date: '2024-12-25',
  };

  const validExpense = {
    type: 'expense',
    category: EXPENSE_CATEGORY.rent,
    amount: 500,
    date: '2024-12-01',
  };

  it('returns no errors for valid income entry', () => {
    expect(validateFinancialEntryRequest(validIncome)).toEqual([]);
  });

  it('returns no errors for valid expense entry', () => {
    expect(validateFinancialEntryRequest(validExpense)).toEqual([]);
  });

  it('accepts all valid income categories', () => {
    for (const category of VALID_INCOME_CATEGORIES) {
      const errors = validateFinancialEntryRequest({ ...validIncome, category });
      expect(errors).toEqual([]);
    }
  });

  it('accepts all valid expense categories', () => {
    for (const category of VALID_EXPENSE_CATEGORIES) {
      const errors = validateFinancialEntryRequest({ ...validExpense, category });
      expect(errors).toEqual([]);
    }
  });

  // Type validation
  it('requires type to be provided', () => {
    const errors = validateFinancialEntryRequest({ ...validIncome, type: undefined });
    expect(errors.some((e) => e.includes('type is required'))).toBe(true);
  });

  it('rejects invalid type', () => {
    const errors = validateFinancialEntryRequest({ ...validIncome, type: 'refund' });
    expect(errors.some((e) => e.includes('type is required'))).toBe(true);
  });

  // Category validation
  it('rejects invalid income category', () => {
    const errors = validateFinancialEntryRequest({ ...validIncome, category: 'invalid_cat' });
    expect(errors.some((e) => e.includes('category for income'))).toBe(true);
  });

  it('rejects invalid expense category', () => {
    const errors = validateFinancialEntryRequest({ ...validExpense, category: 'invalid_cat' });
    expect(errors.some((e) => e.includes('category for expense'))).toBe(true);
  });

  it('rejects missing category', () => {
    const errors = validateFinancialEntryRequest({ ...validIncome, category: undefined });
    expect(errors.some((e) => e.includes('category'))).toBe(true);
  });

  // Amount validation
  it('requires positive amount', () => {
    const errors = validateFinancialEntryRequest({ ...validIncome, amount: 0 });
    expect(errors.some((e) => e.includes('amount'))).toBe(true);
  });

  it('rejects negative amount', () => {
    const errors = validateFinancialEntryRequest({ ...validIncome, amount: -10 });
    expect(errors.some((e) => e.includes('amount'))).toBe(true);
  });

  it('rejects non-number amount', () => {
    const errors = validateFinancialEntryRequest({ ...validIncome, amount: '100' });
    expect(errors.some((e) => e.includes('amount'))).toBe(true);
  });

  // Date validation
  it('requires date', () => {
    const errors = validateFinancialEntryRequest({ ...validIncome, date: undefined });
    expect(errors).toContain('date is required');
  });

  it('rejects invalid date format', () => {
    const errors = validateFinancialEntryRequest({ ...validIncome, date: 'not-a-date' });
    expect(errors).toContain('date must be a valid ISO date string');
  });

  it('accepts valid ISO date', () => {
    const errors = validateFinancialEntryRequest({ ...validIncome, date: '2024-06-15' });
    expect(errors).toEqual([]);
  });

  // Description validation
  it('accepts undefined description', () => {
    const errors = validateFinancialEntryRequest(validIncome);
    expect(errors).toEqual([]);
  });

  it('accepts string description', () => {
    const errors = validateFinancialEntryRequest({ ...validIncome, description: 'Monthly sales' });
    expect(errors).toEqual([]);
  });

  it('rejects non-string description', () => {
    const errors = validateFinancialEntryRequest({ ...validIncome, description: 123 });
    expect(errors).toContain('description must be a string');
  });

  // Multiple validation errors
  it('collects multiple errors at once', () => {
    const errors = validateFinancialEntryRequest({
      type: 'invalid',
      amount: -5,
      date: 'bad-date',
      description: 42,
    });
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// validateUpdateFinancialEntryRequest
// ═══════════════════════════════════════════════════════════════════════════════

describe('validateUpdateFinancialEntryRequest', () => {
  const validUpdate = {
    entryId: 'entry-123',
    fields: { amount: 200 },
  };

  it('returns no errors for a valid single-field update', () => {
    expect(validateUpdateFinancialEntryRequest(validUpdate)).toEqual([]);
  });

  it('returns no errors for a valid multi-field update', () => {
    const errors = validateUpdateFinancialEntryRequest({
      entryId: 'entry-123',
      fields: { amount: 300, date: '2025-06-01', description: 'Updated' },
    });
    expect(errors).toEqual([]);
  });

  // entryId validation
  it('requires entryId', () => {
    const errors = validateUpdateFinancialEntryRequest({ fields: { amount: 100 } });
    expect(errors.some((e) => e.includes('entryId'))).toBe(true);
  });

  it('rejects non-string entryId', () => {
    const errors = validateUpdateFinancialEntryRequest({ entryId: 42, fields: { amount: 100 } });
    expect(errors.some((e) => e.includes('entryId'))).toBe(true);
  });

  // fields validation
  it('requires fields to be present', () => {
    const errors = validateUpdateFinancialEntryRequest({ entryId: 'e1' });
    expect(errors.some((e) => e.includes('fields is required'))).toBe(true);
  });

  it('rejects non-object fields', () => {
    const errors = validateUpdateFinancialEntryRequest({ entryId: 'e1', fields: 'bad' });
    expect(errors.some((e) => e.includes('fields is required'))).toBe(true);
  });

  it('rejects array as fields', () => {
    const errors = validateUpdateFinancialEntryRequest({ entryId: 'e1', fields: [1, 2] });
    expect(errors.some((e) => e.includes('fields is required'))).toBe(true);
  });

  it('rejects empty fields object with no valid keys', () => {
    const errors = validateUpdateFinancialEntryRequest({ entryId: 'e1', fields: {} });
    expect(errors.some((e) => e.includes('At least one field'))).toBe(true);
  });

  // Unknown fields
  it('rejects unknown fields', () => {
    const errors = validateUpdateFinancialEntryRequest({
      entryId: 'e1',
      fields: { amount: 100, source: 'manual' },
    });
    expect(errors.some((e) => e.includes('Unknown fields'))).toBe(true);
    expect(errors.some((e) => e.includes('source'))).toBe(true);
  });

  // type validation
  it('accepts valid type values', () => {
    for (const type of Object.values(ENTRY_TYPE)) {
      const errors = validateUpdateFinancialEntryRequest({ entryId: 'e1', fields: { type } });
      expect(errors).toEqual([]);
    }
  });

  it('rejects invalid type', () => {
    const errors = validateUpdateFinancialEntryRequest({ entryId: 'e1', fields: { type: 'refund' } });
    expect(errors.some((e) => e.includes('type must be one of'))).toBe(true);
  });

  // amount validation
  it('rejects zero amount', () => {
    const errors = validateUpdateFinancialEntryRequest({ entryId: 'e1', fields: { amount: 0 } });
    expect(errors.some((e) => e.includes('amount'))).toBe(true);
  });

  it('rejects negative amount', () => {
    const errors = validateUpdateFinancialEntryRequest({ entryId: 'e1', fields: { amount: -5 } });
    expect(errors.some((e) => e.includes('amount'))).toBe(true);
  });

  it('rejects non-number amount', () => {
    const errors = validateUpdateFinancialEntryRequest({ entryId: 'e1', fields: { amount: '100' } });
    expect(errors.some((e) => e.includes('amount'))).toBe(true);
  });

  // date validation
  it('accepts valid ISO date', () => {
    const errors = validateUpdateFinancialEntryRequest({ entryId: 'e1', fields: { date: '2025-03-10' } });
    expect(errors).toEqual([]);
  });

  it('rejects invalid date string', () => {
    const errors = validateUpdateFinancialEntryRequest({ entryId: 'e1', fields: { date: 'not-a-date' } });
    expect(errors.some((e) => e.includes('date must be a valid'))).toBe(true);
  });

  it('rejects empty string date', () => {
    const errors = validateUpdateFinancialEntryRequest({ entryId: 'e1', fields: { date: '' } });
    expect(errors.some((e) => e.includes('date must be a valid'))).toBe(true);
  });

  // description validation
  it('accepts string description', () => {
    const errors = validateUpdateFinancialEntryRequest({ entryId: 'e1', fields: { description: 'Updated note' } });
    expect(errors).toEqual([]);
  });

  it('accepts null description', () => {
    const errors = validateUpdateFinancialEntryRequest({ entryId: 'e1', fields: { description: null } });
    expect(errors).toEqual([]);
  });

  it('rejects non-string non-null description', () => {
    const errors = validateUpdateFinancialEntryRequest({ entryId: 'e1', fields: { description: 42 } });
    expect(errors.some((e) => e.includes('description must be a string or null'))).toBe(true);
  });

  // Multiple errors collected
  it('collects multiple errors at once', () => {
    const errors = validateUpdateFinancialEntryRequest({
      entryId: '',
      fields: { amount: -1, date: 'bad', type: 'invalid', unknown: true },
    });
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });

  // EDITABLE_ENTRY_FIELDS constant
  it('EDITABLE_ENTRY_FIELDS contains expected fields', () => {
    expect(EDITABLE_ENTRY_FIELDS).toEqual(['type', 'category', 'amount', 'date', 'description']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildFinancialEntry
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildFinancialEntry', () => {
  it('builds a complete entry with all fields', () => {
    const entry = buildFinancialEntry({
      type: 'income',
      category: 'cash_sales',
      amount: 250.5,
      date: '2024-12-25',
      description: 'Holiday sales',
      source: ENTRY_SOURCE.manual,
      userId: 'user-123',
      userName: 'Simos',
    });

    expect(entry.type).toBe('income');
    expect(entry.category).toBe('cash_sales');
    expect(entry.amount).toBe(250.5);
    expect(entry.description).toBe('Holiday sales');
    expect(entry.source).toBe('manual');
    expect(entry.isDeleted).toBe(false);
    expect(entry.createdBy).toBe('user-123');
    expect(entry.createdByName).toBe('Simos');
  });

  it('sets createdByName to null when userName is not provided', () => {
    const entry = buildFinancialEntry({
      type: 'expense',
      category: EXPENSE_CATEGORY.rent,
      amount: 800,
      date: '2024-01-01',
      userId: 'user-1',
    });

    expect(entry.createdBy).toBe('user-1');
    expect(entry.createdByName).toBeNull();
  });

  it('converts date string to Timestamp', () => {
    const entry = buildFinancialEntry({
      type: 'expense',
      category: EXPENSE_CATEGORY.rent,
      amount: 800,
      date: '2024-01-01',
      userId: 'user-1',
    });

    expect(entry.date).toBeDefined();
    expect(entry.date.toDate()).toBeInstanceOf(Date);
    expect(entry.date.toDate().toISOString()).toBe('2024-01-01T00:00:00.000Z');
  });

  it('sets createdAt and updatedAt timestamps', () => {
    const entry = buildFinancialEntry({
      type: 'income',
      category: 'cash_sales',
      amount: 100,
      date: '2024-06-15',
      userId: 'user-1',
    });

    expect(entry.createdAt).toBeDefined();
    expect(entry.updatedAt).toBeDefined();
  });

  it('defaults description to null when not provided', () => {
    const entry = buildFinancialEntry({
      type: 'expense',
      category: EXPENSE_CATEGORY.rent,
      amount: 800,
      date: '2024-01-01',
      userId: 'user-1',
    });

    expect(entry.description).toBeNull();
  });

  it('defaults source to "manual" when not provided', () => {
    const entry = buildFinancialEntry({
      type: 'expense',
      category: EXPENSE_CATEGORY.rent,
      amount: 800,
      date: '2024-01-01',
      userId: 'user-1',
    });

    expect(entry.source).toBe('manual');
  });

  it('defaults metadata to empty object when not provided', () => {
    const entry = buildFinancialEntry({
      type: 'expense',
      category: EXPENSE_CATEGORY.rent,
      amount: 800,
      date: '2024-01-01',
      userId: 'user-1',
    });

    expect(entry.metadata).toEqual({});
  });

  it('includes custom metadata when provided', () => {
    const meta = { invoiceId: 'inv-1', supplierId: 'sup-1' };
    const entry = buildFinancialEntry({
      type: 'expense',
      category: EXPENSE_CATEGORY.invoicePayment,
      amount: 100,
      date: '2024-06-15',
      source: ENTRY_SOURCE.invoicePayment,
      metadata: meta,
      userId: 'user-1',
    });

    expect(entry.metadata).toEqual(meta);
    expect(entry.source).toBe('invoice_payment');
  });

  it('always sets isDeleted to false', () => {
    const entry = buildFinancialEntry({
      type: 'income',
      category: 'cash_sales',
      amount: 50,
      date: '2024-03-01',
      userId: 'u1',
    });

    expect(entry.isDeleted).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

describe('financial constants', () => {
  it('ENTRY_TYPE has income and expense values', () => {
    expect(ENTRY_TYPE.income).toBe('income');
    expect(ENTRY_TYPE.expense).toBe('expense');
  });

  it('ENTRY_SOURCE has manual, invoicePayment, and recurring', () => {
    expect(ENTRY_SOURCE.manual).toBe('manual');
    expect(ENTRY_SOURCE.invoicePayment).toBe('invoice_payment');
    expect(ENTRY_SOURCE.recurring).toBe('recurring');
  });

  it('VALID_INCOME_CATEGORIES contains all income categories', () => {
    expect(VALID_INCOME_CATEGORIES).toContain('cash_sales');
    expect(VALID_INCOME_CATEGORIES).toContain('card_sales');
    expect(VALID_INCOME_CATEGORIES).toContain('other_income');
    expect(VALID_INCOME_CATEGORIES).toHaveLength(3);
  });

  it('VALID_EXPENSE_CATEGORIES contains all expense categories', () => {
    expect(VALID_EXPENSE_CATEGORIES).toContain('ΕΝΟΙΚΙΟ');
    expect(VALID_EXPENSE_CATEGORIES).toContain('ΜΙΣΘΟΙ');
    expect(VALID_EXPENSE_CATEGORIES).toContain('ΡΕΥΜΑ');
    expect(VALID_EXPENSE_CATEGORIES).toContain('ΤΗΛΕΦΩΝΙΑ');
    expect(VALID_EXPENSE_CATEGORIES).toContain('ΛΟΓΙΣΤΗΣ');
    expect(VALID_EXPENSE_CATEGORIES).toContain('ΠΛΗΡΩΜΗ_ΤΙΜΟΛΟΓΙΟΥ');
    expect(VALID_EXPENSE_CATEGORIES).toContain('ΑΛΛΑ');
    expect(VALID_EXPENSE_CATEGORIES).toHaveLength(7);
  });
});
