import { admin, serverTimestamp } from './config.js';

// ═══════════════════════════════════════════════════════════════════════════════
// FINANCIAL TRACKING CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════
const FINANCIAL_ENTRIES_COLLECTION = 'financial_entries';
//TODO: add financial summaries collection in case there is a performance issue
// const FINANCIAL_SUMMARIES_COLLECTION = 'financial_summaries';
const RECURRING_EXPENSES_COLLECTION = 'recurring_expenses';

const ENTRY_TYPE = {
  income: 'income',
  expense: 'expense',
};

const ENTRY_SOURCE = {
  manual: 'manual',
  invoicePayment: 'invoice_payment',
  recurring: 'recurring',
};

// Income categories
const INCOME_CATEGORY = {
  cashSales: 'cash_sales',
  cardSales: 'card_sales',
  otherIncome: 'other_income',
};

// Expense categories - ΠΑΓΙΑ ΜΗΝΑ (Fixed Monthly) + Invoice Payments
const EXPENSE_CATEGORY = {
  electricity: 'ΡΕΥΜΑ', // Electricity
  telecom: 'ΤΗΛΕΦΩΝΙΑ', // Telecom
  rent: 'ΕΝΟΙΚΙΟ', // Rent
  salaries: 'ΜΙΣΘΟΙ', // Staff/Salaries
  accountant: 'ΛΟΓΙΣΤΗΣ', // Accountant
  invoicePayment: 'ΠΛΗΡΩΜΗ_ΤΙΜΟΛΟΓΙΟΥ', // Invoice Payment (auto-generated)
  other: 'ΑΛΛΑ', // Other
};

const VALID_INCOME_CATEGORIES = Object.values(INCOME_CATEGORY);
const VALID_EXPENSE_CATEGORIES = Object.values(EXPENSE_CATEGORY);

/**
 * Validates financial entry request
 */
function validateFinancialEntryRequest(body) {
  const errors = [];

  // Validate type
  if (!body.type || !Object.values(ENTRY_TYPE).includes(body.type)) {
    errors.push(`type is required and must be one of: ${Object.values(ENTRY_TYPE).join(', ')}`);
  }

  // Validate category based on type
  if (body.type === ENTRY_TYPE.income) {
    if (!body.category || !VALID_INCOME_CATEGORIES.includes(body.category)) {
      errors.push(`category for income must be one of: ${VALID_INCOME_CATEGORIES.join(', ')}`);
    }
  } else if (body.type === ENTRY_TYPE.expense) {
    if (!body.category || !VALID_EXPENSE_CATEGORIES.includes(body.category)) {
      errors.push(`category for expense must be one of: ${VALID_EXPENSE_CATEGORIES.join(', ')}`);
    }
  }

  // Validate amount
  if (typeof body.amount !== 'number' || body.amount <= 0) {
    errors.push('amount is required and must be a positive number');
  }

  // Validate date
  if (!body.date) {
    errors.push('date is required');
  } else {
    const date = new Date(body.date);
    if (isNaN(date.getTime())) {
      errors.push('date must be a valid ISO date string');
    }
  }

  // Validate description (optional but must be string if provided)
  if (body.description !== undefined && typeof body.description !== 'string') {
    errors.push('description must be a string');
  }

  return errors;
}

const EDITABLE_ENTRY_FIELDS = ['type', 'category', 'amount', 'date', 'description'];

/**
 * Validates update financial entry request (partial field updates)
 */
function validateUpdateFinancialEntryRequest(body) {
  const errors = [];

  if (!body.entryId || typeof body.entryId !== 'string') {
    errors.push('entryId is required and must be a string');
  }

  if (!body.fields || typeof body.fields !== 'object' || Array.isArray(body.fields)) {
    errors.push('fields is required and must be an object');
    return errors;
  }

  const fields = body.fields;
  const providedKeys = Object.keys(fields);

  const unknownFields = providedKeys.filter((k) => !EDITABLE_ENTRY_FIELDS.includes(k));
  if (unknownFields.length > 0) {
    errors.push(`Unknown fields: ${unknownFields.join(', ')}. Allowed: ${EDITABLE_ENTRY_FIELDS.join(', ')}`);
  }

  const validKeys = providedKeys.filter((k) => EDITABLE_ENTRY_FIELDS.includes(k));
  if (validKeys.length === 0) {
    errors.push('At least one field to update must be provided');
  }

  if (fields.type !== undefined && !Object.values(ENTRY_TYPE).includes(fields.type)) {
    errors.push(`type must be one of: ${Object.values(ENTRY_TYPE).join(', ')}`);
  }

  if (fields.amount !== undefined && (typeof fields.amount !== 'number' || fields.amount <= 0)) {
    errors.push('amount must be a positive number');
  }

  if (fields.date !== undefined) {
    if (!fields.date || typeof fields.date !== 'string') {
      errors.push('date must be a valid ISO date string');
    } else {
      const date = new Date(fields.date);
      if (isNaN(date.getTime())) {
        errors.push('date must be a valid ISO date string');
      }
    }
  }

  if (fields.description !== undefined && fields.description !== null && typeof fields.description !== 'string') {
    errors.push('description must be a string or null');
  }

  return errors;
}

/**
 * Creates a financial entry document
 */
function buildFinancialEntry({ type, category, amount, date, description, source, metadata, userId, userName }) {
  return {
    type,
    category,
    amount,
    date: admin.firestore.Timestamp.fromDate(new Date(date)),
    description: description || null,
    source: source || ENTRY_SOURCE.manual,
    metadata: metadata || {},
    isDeleted: false,
    createdBy: userId,
    createdByName: userName || null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

export {
  FINANCIAL_ENTRIES_COLLECTION,
  RECURRING_EXPENSES_COLLECTION,
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
};
