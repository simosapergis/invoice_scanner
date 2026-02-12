import { VALID_EXPENSE_CATEGORIES } from './financial.js';

/**
 * Validates recurring expense request
 */
function validateRecurringExpenseRequest(body) {
  const errors = [];

  if (!body.category || !VALID_EXPENSE_CATEGORIES.includes(body.category)) {
    errors.push(`category must be one of: ${VALID_EXPENSE_CATEGORIES.join(', ')}`);
  }

  if (typeof body.amount !== 'number' || body.amount <= 0) {
    errors.push('amount is required and must be a positive number');
  }

  if (!body.dayOfMonth || typeof body.dayOfMonth !== 'number' || body.dayOfMonth < 1 || body.dayOfMonth > 28) {
    errors.push('dayOfMonth is required and must be between 1 and 28');
  }

  if (body.description !== undefined && typeof body.description !== 'string') {
    errors.push('description must be a string');
  }

  return errors;
}

export { validateRecurringExpenseRequest };
