import { describe, it, expect } from 'vitest';
import { validateRecurringExpenseRequest } from '../lib/recurring.js';
import { EXPENSE_CATEGORY } from '../lib/financial.js';

// ═══════════════════════════════════════════════════════════════════════════════
// validateRecurringExpenseRequest
// ═══════════════════════════════════════════════════════════════════════════════

describe('validateRecurringExpenseRequest', () => {
  const validBody = {
    category: EXPENSE_CATEGORY.rent,
    amount: 800,
    dayOfMonth: 1,
  };

  it('returns no errors for valid request', () => {
    expect(validateRecurringExpenseRequest(validBody)).toEqual([]);
  });

  it('accepts all valid expense categories', () => {
    for (const category of Object.values(EXPENSE_CATEGORY)) {
      const errors = validateRecurringExpenseRequest({ ...validBody, category });
      expect(errors).toEqual([]);
    }
  });

  // Category validation
  it('rejects invalid category', () => {
    const errors = validateRecurringExpenseRequest({ ...validBody, category: 'invalid' });
    expect(errors.some((e) => e.includes('category'))).toBe(true);
  });

  it('rejects missing category', () => {
    const errors = validateRecurringExpenseRequest({ ...validBody, category: undefined });
    expect(errors.some((e) => e.includes('category'))).toBe(true);
  });

  // Amount validation
  it('requires positive amount', () => {
    const errors = validateRecurringExpenseRequest({ ...validBody, amount: 0 });
    expect(errors.some((e) => e.includes('amount'))).toBe(true);
  });

  it('rejects negative amount', () => {
    const errors = validateRecurringExpenseRequest({ ...validBody, amount: -100 });
    expect(errors.some((e) => e.includes('amount'))).toBe(true);
  });

  it('rejects non-number amount', () => {
    const errors = validateRecurringExpenseRequest({ ...validBody, amount: '500' });
    expect(errors.some((e) => e.includes('amount'))).toBe(true);
  });

  // dayOfMonth validation
  it('accepts dayOfMonth 1', () => {
    expect(validateRecurringExpenseRequest({ ...validBody, dayOfMonth: 1 })).toEqual([]);
  });

  it('accepts dayOfMonth 28', () => {
    expect(validateRecurringExpenseRequest({ ...validBody, dayOfMonth: 28 })).toEqual([]);
  });

  it('rejects dayOfMonth 0', () => {
    const errors = validateRecurringExpenseRequest({ ...validBody, dayOfMonth: 0 });
    expect(errors.some((e) => e.includes('dayOfMonth'))).toBe(true);
  });

  it('rejects dayOfMonth 29', () => {
    const errors = validateRecurringExpenseRequest({ ...validBody, dayOfMonth: 29 });
    expect(errors.some((e) => e.includes('dayOfMonth'))).toBe(true);
  });

  it('rejects non-number dayOfMonth', () => {
    const errors = validateRecurringExpenseRequest({ ...validBody, dayOfMonth: '15' });
    expect(errors.some((e) => e.includes('dayOfMonth'))).toBe(true);
  });

  it('rejects missing dayOfMonth', () => {
    const errors = validateRecurringExpenseRequest({ ...validBody, dayOfMonth: undefined });
    expect(errors.some((e) => e.includes('dayOfMonth'))).toBe(true);
  });

  // Description validation
  it('accepts undefined description', () => {
    expect(validateRecurringExpenseRequest(validBody)).toEqual([]);
  });

  it('accepts string description', () => {
    const errors = validateRecurringExpenseRequest({ ...validBody, description: 'Monthly rent' });
    expect(errors).toEqual([]);
  });

  it('rejects non-string description', () => {
    const errors = validateRecurringExpenseRequest({ ...validBody, description: 123 });
    expect(errors).toContain('description must be a string');
  });

  // Multiple errors
  it('collects multiple errors at once', () => {
    const errors = validateRecurringExpenseRequest({
      category: 'invalid',
      amount: -5,
      dayOfMonth: 30,
      description: 42,
    });
    expect(errors.length).toBe(4);
  });
});
