// Firebase Functions v2 imports
import { onRequest } from 'firebase-functions/v2/https';
import { onObjectFinalized } from 'firebase-functions/v2/storage';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';

// ═══════════════════════════════════════════════════════════════════════════════
// LIB IMPORTS
// ═══════════════════════════════════════════════════════════════════════════════

import {
  admin,
  db,
  storage,
  REGION,
  SERVICE_ACCOUNT_EMAIL,
  GCS_BUCKET,
  UPLOADS_PREFIX,
  METADATA_INVOICE_COLLECTION,
  SIGNED_URL_TTL_MS,
  PAYMENT_STATUS,
  serverTimestamp,
  getBucketName,
  getAthensToday,
} from './lib/config.js';

import { authenticateRequest, getUserDisplayName } from './lib/auth.js';
import { HTTP_OPTS, requireMethod, sendError } from './lib/http-utils.js';

import {
  sanitizeFilename,
  normalizeTotalPages,
  normalizePageNumber,
  padPageNumber,
  ensureInvoiceDocument,
  registerUploadedPage,
  parseUploadObjectName,
} from './lib/invoice-upload.js';

import { processInvoiceDocumentHandler } from './lib/invoice-processor.js';

import { validatePaymentRequest, derivePaymentStatus, validateUpdateFieldsRequest } from './lib/payments.js';

import { validateUpdateSupplierRequest } from './lib/suppliers.js';

import {
  FINANCIAL_ENTRIES_COLLECTION,
  RECURRING_EXPENSES_COLLECTION,
  ENTRY_TYPE,
  ENTRY_SOURCE,
  EXPENSE_CATEGORY,
  VALID_INCOME_CATEGORIES,
  VALID_EXPENSE_CATEGORIES,
  validateFinancialEntryRequest,
  validateUpdateFinancialEntryRequest,
  buildFinancialEntry,
} from './lib/financial.js';

import { validateRecurringExpenseRequest } from './lib/recurring.js';

import {
  validateExportRequest,
  fetchInvoiceDocuments,
  recordDownloads,
  streamInvoicesZip,
  getExportDownloadUrl,
} from './lib/invoice-export.js';

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNED UPLOAD URL
// ═══════════════════════════════════════════════════════════════════════════════

// Blue-green deployment: v2 functions run alongside v1
// Old function name: getSignedUploadUrl
export const getSignedUploadUrl_v2 = onRequest(HTTP_OPTS, async (req, res) => {
  if (!requireMethod(req, res, 'POST')) return;

  const bucketName = getBucketName();
  if (!bucketName) {
    return sendError(res, 500, 'Missing GCS bucket configuration');
  }

  const authResult = await authenticateRequest(req);
  if (authResult.error) {
    return sendError(res, authResult.status, authResult.error);
  }
  const decoded = authResult.user;

  const {
    filename,
    contentType = 'application/octet-stream',
    invoiceId,
    pageNumber,
    totalPages = null,
  } = req.body || {};

  if (!filename) {
    return sendError(res, 400, 'filename is required in the request body');
  }

  try {
    const normalizedTotalPages = normalizeTotalPages(totalPages);
    const normalizedPageNumber = normalizePageNumber(pageNumber);
    const sanitizedFilename = sanitizeFilename(filename);
    const invoiceMetadata = await ensureInvoiceDocument({
      invoiceId,
      uid: decoded.uid,
      userName: getUserDisplayName(decoded),
      bucketName,
      totalPages: normalizedTotalPages,
    });
    const resolvedInvoiceId = invoiceMetadata.invoiceId;
    const resolvedTotalPages = invoiceMetadata.totalPages || normalizedTotalPages;
    if (!resolvedTotalPages) {
      throw new Error('totalPages must be specified for the invoice');
    }
    const objectName = `${UPLOADS_PREFIX}${resolvedInvoiceId}/page-${padPageNumber(
      normalizedPageNumber
    )}-${sanitizedFilename}`;
    const expiresAtMs = Date.now() + SIGNED_URL_TTL_MS;

    const [signedUrl] = await storage.bucket(bucketName).file(objectName).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: expiresAtMs,
      contentType,
    });

    return res.json({
      invoiceId: resolvedInvoiceId,
      pageNumber: normalizedPageNumber,
      totalPages: resolvedTotalPages,
      uploadUrl: signedUrl,
      bucket: bucketName,
      objectName,
      contentType,
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
  } catch (error) {
    console.error('Failed to create signed URL:', error);
    return sendError(res, error.httpStatus || 500, error.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROCESS UPLOADED INVOICE (Storage trigger)
// ═══════════════════════════════════════════════════════════════════════════════

// Blue-green deployment: v2 functions run alongside v1
// Old function name: processUploadedInvoice
export const processUploadedInvoice_v2 = onObjectFinalized(
  {
    region: REGION,
    serviceAccount: SERVICE_ACCOUNT_EMAIL,
    bucket: GCS_BUCKET,
  },
  async (event) => {
    const object = event.data;
    const { name: objectName, bucket, contentType } = object;

    if (!objectName) {
      console.warn('Finalize event missing object name');
      return;
    }

    if (!objectName.startsWith(UPLOADS_PREFIX)) {
      console.log(`Skipping ${objectName} because it is outside ${UPLOADS_PREFIX}`);
      return;
    }

    const parsed = parseUploadObjectName(objectName);
    if (!parsed) {
      console.warn(`Unable to parse invoice metadata from object name: ${objectName}`);
      return;
    }

    try {
      await registerUploadedPage({
        invoiceId: parsed.invoiceId,
        pageNumber: parsed.pageNumber,
        objectName,
        bucketName: bucket,
        contentType: contentType || 'application/octet-stream',
      });
      console.log(`Registered page ${parsed.pageNumber} for invoice ${parsed.invoiceId} (${objectName})`);
    } catch (error) {
      console.error(`Failed to register page ${parsed.pageNumber} for invoice ${parsed.invoiceId}`, error);
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// PROCESS INVOICE DOCUMENT (Firestore trigger)
// ═══════════════════════════════════════════════════════════════════════════════

// Blue-green deployment: v2 functions run alongside v1
// Old function name: processInvoiceDocument
export const processInvoiceDocument_v2 = onDocumentWritten(
  {
    region: REGION,
    serviceAccount: SERVICE_ACCOUNT_EMAIL,
    document: `${METADATA_INVOICE_COLLECTION}/{invoiceId}`,
  },
  processInvoiceDocumentHandler
);

// ═══════════════════════════════════════════════════════════════════════════════
// PAYMENT STATUS UPDATE FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════
//
// Securely updates the payment status of an invoice with full audit trail.
//
// Request Body:
// {
//   supplierId: string,         // Required - supplier identifier
//   invoiceId: string,          // Required - invoice document ID
//   action: "pay" | "partial",  // Required - payment action type
//   amount?: number,            // Required for "partial", optional for "pay" (defaults to full)
//   paymentMethod?: string,     // Optional - cash, bank_transfer, card, etc.
//   paymentDate?: string,       // Optional - ISO date string, defaults to now
//   notes?: string              // Optional - payment notes
// }
//
// Security:
// - Requires Firebase Authentication
// - User must be the invoice owner (uploadedBy === uid)
// - Input validation: positive amounts, no overpayment
// - Atomic updates via Firestore transaction
// ═══════════════════════════════════════════════════════════════════════════════

// Blue-green deployment: v2 functions run alongside v1
// Old function name: updatePaymentStatus
export const updatePaymentStatus_v2 = onRequest(HTTP_OPTS, async (req, res) => {
  if (!requireMethod(req, res, 'POST')) return;

  // 1. Authenticate
  const authResult = await authenticateRequest(req);
  if (authResult.error) {
    return sendError(res, authResult.status, authResult.error);
  }
  const user = authResult.user;

  // 2. Validate request body
  const body = req.body || {};
  const validationErrors = validatePaymentRequest(body);
  if (validationErrors.length > 0) {
    return sendError(res, 400, 'Validation failed', { details: validationErrors });
  }

  const { supplierId, invoiceId, action, paymentMethod, notes } = body;
  const paymentDate = body.paymentDate
    ? admin.firestore.Timestamp.fromDate(new Date(body.paymentDate))
    : admin.firestore.FieldValue.serverTimestamp();

  const invoiceRef = db.collection('suppliers').doc(supplierId).collection('invoices').doc(invoiceId);

  try {
    const result = await db.runTransaction(async (tx) => {
      const invoiceSnap = await tx.get(invoiceRef);

      // 3. Check invoice exists
      if (!invoiceSnap.exists) {
        throw Object.assign(new Error(`Invoice not found: suppliers/${supplierId}/invoices/${invoiceId}`), {
          httpStatus: 404,
        });
      }

      const invoiceData = invoiceSnap.data();

      // 4. Authorization check - only owner can update
      if (invoiceData.uploadedBy && invoiceData.uploadedBy !== user.uid) {
        throw Object.assign(new Error('You are not authorized to update this invoice'), { httpStatus: 403 });
      }

      // 5. Get current payment state
      const totalAmount = invoiceData.totalAmount || 0;
      const currentPaidAmount = invoiceData.paidAmount || 0;
      const currentUnpaidAmount = totalAmount - currentPaidAmount;

      // 6. Calculate payment amount
      let paymentAmount;
      if (action === 'pay') {
        // Full payment - pay remaining balance
        paymentAmount = body.amount !== undefined ? body.amount : currentUnpaidAmount;
      } else {
        // Partial payment - use specified amount
        paymentAmount = body.amount;
      }

      // 7. Validate payment doesn't exceed remaining balance
      if (totalAmount > 0 && paymentAmount > currentUnpaidAmount + 0.01) {
        throw Object.assign(
          new Error(
            `Payment amount (${paymentAmount.toFixed(2)}) exceeds unpaid balance (${currentUnpaidAmount.toFixed(2)})`
          ),
          { httpStatus: 400 }
        );
      }

      // 8. Validate not already fully paid
      if (invoiceData.paymentStatus === PAYMENT_STATUS.paid) {
        throw Object.assign(new Error('Invoice is already fully paid'), { httpStatus: 400 });
      }

      // 9. Calculate new amounts
      const newPaidAmount = currentPaidAmount + paymentAmount;
      const newUnpaidAmount = Math.max(0, totalAmount - newPaidAmount);
      const newPaymentStatus = derivePaymentStatus(newPaidAmount, totalAmount);

      // 10. Build payment history entry
      const paymentEntry = {
        amount: paymentAmount,
        paymentDate,
        paymentMethod: paymentMethod || 'other',
        notes: notes || null,
        recordedAt: admin.firestore.Timestamp.now(),
        recordedBy: user.uid,
        recordedByName: getUserDisplayName(user),
      };

      // 11. Update invoice document
      tx.update(invoiceRef, {
        paymentStatus: newPaymentStatus,
        paidAmount: newPaidAmount,
        unpaidAmount: newUnpaidAmount,
        lastPaymentAt: admin.firestore.FieldValue.serverTimestamp(),
        paymentHistory: admin.firestore.FieldValue.arrayUnion(paymentEntry),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return {
        invoiceId,
        supplierId,
        supplierName: invoiceData.supplierName || null,
        invoiceNumber: invoiceData.invoiceNumber || null,
        previousStatus: invoiceData.paymentStatus || PAYMENT_STATUS.unpaid,
        newStatus: newPaymentStatus,
        paymentAmount,
        paymentDate,
        totalAmount,
        paidAmount: newPaidAmount,
        unpaidAmount: newUnpaidAmount,
      };
    });

    console.log(`Payment recorded for invoice ${invoiceId}:`, result);

    // Auto-create expense entry for the payment
    try {
      const expenseEntry = {
        type: ENTRY_TYPE.expense,
        category: EXPENSE_CATEGORY.invoicePayment,
        amount: result.paymentAmount,
        date: result.paymentDate,
        description: `Τιμολόγιο #${result.invoiceNumber || invoiceId} - ${result.supplierName || supplierId}`,
        source: ENTRY_SOURCE.invoicePayment,
        metadata: {
          invoiceId,
          supplierId,
          supplierName: result.supplierName,
          invoiceNumber: result.invoiceNumber,
        },
        isDeleted: false,
        createdBy: user.uid,
        createdByName: getUserDisplayName(user),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      const expenseRef = await db.collection(FINANCIAL_ENTRIES_COLLECTION).add(expenseEntry);
      console.log(`Auto-created expense entry ${expenseRef.id} for invoice payment`);
    } catch (expenseError) {
      // Log but don't fail the payment - expense creation is secondary
      console.error('Failed to auto-create expense entry for payment:', expenseError);
    }

    return res.status(200).json({
      success: true,
      message:
        result.newStatus === PAYMENT_STATUS.paid
          ? 'Invoice marked as fully paid'
          : `Partial payment of ${result.paymentAmount.toFixed(2)} recorded`,
      data: result,
    });
  } catch (error) {
    console.error('Payment update failed:', error);
    const httpStatus = error.httpStatus || 500;
    return sendError(res, httpStatus, error.message, { code: httpStatus === 500 ? 'INTERNAL_ERROR' : 'PAYMENT_ERROR' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// UPDATE INVOICE FIELDS
// ═══════════════════════════════════════════════════════════════════════════════
//
// Updates editable invoice fields. Recalculates payment status when amounts change.
//
// Request Body:
// {
//   supplierId: string,           // Required - supplier identifier
//   invoiceId: string,            // Required - invoice document ID
//   fields: {                     // Required - fields to update (all optional)
//     supplierName?: string,
//     supplierTaxNumber?: string,
//     invoiceNumber?: string,
//     invoiceDate?: string,       // ISO date string
//     dueDate?: string,           // ISO date string
//     totalAmount?: number,
//     netAmount?: number,
//     vatAmount?: number,
//     vatRate?: number,
//     currency?: string,
//     paidAmount?: number         // Will recalculate unpaidAmount & paymentStatus
//   }
// }
//
// Security:
// - Requires Firebase Authentication
// - Atomic updates via Firestore transaction
// ═══════════════════════════════════════════════════════════════════════════════

// Blue-green deployment: v2 functions run alongside v1
// Old function name: updateInvoiceFields
export const updateInvoiceFields_v2 = onRequest(HTTP_OPTS, async (req, res) => {
  if (!requireMethod(req, res, 'POST')) return;

  // 1. Authenticate
  const authResult = await authenticateRequest(req);
  if (authResult.error) {
    return sendError(res, authResult.status, authResult.error);
  }
  const user = authResult.user;

  // 2. Validate request body
  const body = req.body || {};
  const validationErrors = validateUpdateFieldsRequest(body);
  if (validationErrors.length > 0) {
    return sendError(res, 400, 'Validation failed', { details: validationErrors });
  }

  const { supplierId, invoiceId, fields } = body;

  const invoiceRef = db.collection('suppliers').doc(supplierId).collection('invoices').doc(invoiceId);

  try {
    const result = await db.runTransaction(async (tx) => {
      const invoiceSnap = await tx.get(invoiceRef);

      // 3. Check invoice exists
      if (!invoiceSnap.exists) {
        throw Object.assign(new Error(`Invoice not found: suppliers/${supplierId}/invoices/${invoiceId}`), {
          httpStatus: 404,
        });
      }

      const invoiceData = invoiceSnap.data();

      // 4. Build update object
      const updates = {
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastEditedBy: user.uid,
        lastEditedByName: getUserDisplayName(user),
        lastEditedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      // Track which fields are being updated
      const updatedFields = [];

      // Process string fields
      if (fields.supplierName !== undefined) {
        updates.supplierName = fields.supplierName;
        updatedFields.push('supplierName');
      }
      if (fields.supplierTaxNumber !== undefined) {
        updates.supplierTaxNumber = fields.supplierTaxNumber;
        updatedFields.push('supplierTaxNumber');
      }
      if (fields.invoiceNumber !== undefined) {
        updates.invoiceNumber = fields.invoiceNumber;
        updatedFields.push('invoiceNumber');
      }
      if (fields.currency !== undefined) {
        updates.currency = fields.currency;
        updatedFields.push('currency');
      }

      // Process date fields
      if (fields.invoiceDate !== undefined) {
        updates.invoiceDate = admin.firestore.Timestamp.fromDate(new Date(fields.invoiceDate));
        updatedFields.push('invoiceDate');
      }
      if (fields.dueDate !== undefined) {
        updates.dueDate = admin.firestore.Timestamp.fromDate(new Date(fields.dueDate));
        updatedFields.push('dueDate');
      }

      // Process numeric fields
      if (fields.netAmount !== undefined) {
        updates.netAmount = fields.netAmount;
        updatedFields.push('netAmount');
      }
      if (fields.vatAmount !== undefined) {
        updates.vatAmount = fields.vatAmount;
        updatedFields.push('vatAmount');
      }
      if (fields.vatRate !== undefined) {
        updates.vatRate = fields.vatRate;
        updatedFields.push('vatRate');
      }

      // 5. Handle amount changes with payment recalculation
      const currentTotalAmount = invoiceData.totalAmount || 0;
      const currentPaidAmount = invoiceData.paidAmount || 0;

      let newTotalAmount = currentTotalAmount;
      let newPaidAmount = currentPaidAmount;

      if (fields.totalAmount !== undefined) {
        newTotalAmount = fields.totalAmount;
        updates.totalAmount = newTotalAmount;
        updatedFields.push('totalAmount');
      }

      if (fields.paidAmount !== undefined) {
        newPaidAmount = fields.paidAmount;
        updates.paidAmount = newPaidAmount;
        updatedFields.push('paidAmount');
      }

      // Recalculate unpaidAmount and paymentStatus if amounts changed
      if (fields.totalAmount !== undefined || fields.paidAmount !== undefined) {
        // Validate paidAmount doesn't exceed totalAmount
        if (newPaidAmount > newTotalAmount + 0.01) {
          throw Object.assign(
            new Error(
              `paidAmount (${newPaidAmount.toFixed(2)}) cannot exceed totalAmount (${newTotalAmount.toFixed(2)})`
            ),
            { httpStatus: 400 }
          );
        }

        updates.unpaidAmount = Math.max(0, newTotalAmount - newPaidAmount);
        updates.paymentStatus = derivePaymentStatus(newPaidAmount, newTotalAmount);
      }

      // 6. Update invoice document
      tx.update(invoiceRef, updates);

      return {
        invoiceId,
        supplierId,
        updatedFields,
        totalAmount: newTotalAmount,
        paidAmount: newPaidAmount,
        unpaidAmount: updates.unpaidAmount !== undefined ? updates.unpaidAmount : invoiceData.unpaidAmount || 0,
        paymentStatus: updates.paymentStatus || invoiceData.paymentStatus,
      };
    });

    console.log(`Invoice fields updated for ${invoiceId}:`, result.updatedFields);

    return res.status(200).json({
      success: true,
      message: `Updated ${result.updatedFields.length} field(s): ${result.updatedFields.join(', ')}`,
      data: result,
    });
  } catch (error) {
    console.error('Invoice field update failed:', error);
    const httpStatus = error.httpStatus || 500;
    return sendError(res, httpStatus, error.message, { code: httpStatus === 500 ? 'INTERNAL_ERROR' : 'UPDATE_ERROR' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// UPDATE SUPPLIER FIELDS
// ═══════════════════════════════════════════════════════════════════════════════
//
// Updates editable supplier fields at /suppliers/{supplierId}
//
// Request Body:
// {
//   supplierId: string,           // Required - supplier identifier
//   fields: {                     // Required - fields to update (all optional)
//     name?: string,
//     supplierCategory?: string,
//     supplierTaxNumber?: string, // Numbers only
//     delivery?: {
//       dayOfWeek: number,        // 1-7 (ISO 8601: Mon-Sun)
//       from: { hour: number, minute: number },
//       to: { hour: number, minute: number }
//     }
//   }
// }
//
// Security:
// - Requires Firebase Authentication
// ═══════════════════════════════════════════════════════════════════════════════

// Blue-green deployment: v2 functions run alongside v1
// Old function name: updateSupplierFields
export const updateSupplierFields_v2 = onRequest(HTTP_OPTS, async (req, res) => {
  if (!requireMethod(req, res, 'POST')) return;

  // 1. Authenticate
  const authResult = await authenticateRequest(req);
  if (authResult.error) {
    return sendError(res, authResult.status, authResult.error);
  }
  const user = authResult.user;

  // 2. Validate request body
  const body = req.body || {};
  const validationErrors = validateUpdateSupplierRequest(body);
  if (validationErrors.length > 0) {
    return sendError(res, 400, 'Validation failed', { details: validationErrors });
  }

  const { supplierId, fields } = body;
  const supplierRef = db.collection('suppliers').doc(supplierId);

  try {
    const result = await db.runTransaction(async (tx) => {
      const supplierSnap = await tx.get(supplierRef);

      // 3. Check supplier exists
      if (!supplierSnap.exists) {
        throw Object.assign(new Error(`Supplier not found: suppliers/${supplierId}`), { httpStatus: 404 });
      }

      // 4. Build update object
      const updates = {
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastEditedBy: user.uid,
        lastEditedByName: getUserDisplayName(user),
        lastEditedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      const updatedFields = [];

      // Process string fields
      if (fields.name !== undefined) {
        updates.name = fields.name;
        updatedFields.push('name');
      }

      if (fields.supplierCategory !== undefined) {
        updates.supplierCategory = fields.supplierCategory;
        updatedFields.push('supplierCategory');
      }

      if (fields.supplierTaxNumber !== undefined) {
        updates.supplierTaxNumber = fields.supplierTaxNumber;
        updatedFields.push('supplierTaxNumber');
      }

      // Process delivery object
      if (fields.delivery !== undefined) {
        updates.delivery = {
          dayOfWeek: fields.delivery.dayOfWeek,
          from: {
            hour: fields.delivery.from?.hour,
            minute: fields.delivery.from?.minute,
          },
          to: {
            hour: fields.delivery.to?.hour,
            minute: fields.delivery.to?.minute,
          },
        };
        updatedFields.push('delivery');
      }

      // 5. Update supplier document
      tx.update(supplierRef, updates);

      return {
        supplierId,
        updatedFields,
      };
    });

    console.log(`Supplier fields updated for ${supplierId}:`, result.updatedFields);

    return res.status(200).json({
      success: true,
      message: `Updated ${result.updatedFields.length} field(s): ${result.updatedFields.join(', ')}`,
      data: result,
    });
  } catch (error) {
    console.error('Supplier field update failed:', error);
    const httpStatus = error.httpStatus || 500;
    return sendError(res, httpStatus, error.message, { code: httpStatus === 500 ? 'INTERNAL_ERROR' : 'UPDATE_ERROR' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNED DOWNLOAD URL
// ═══════════════════════════════════════════════════════════════════════════════
//
// Generates a signed URL for downloading an invoice PDF from Cloud Storage.
//
// Request Body:
// {
//   filePath: string           // Required - path to file in storage (e.g. "suppliers/abc/invoices/xyz.pdf")
// }
//
// Response:
// {
//   downloadUrl: string,       // Signed URL for downloading
//   expiresAt: string          // ISO timestamp when URL expires
// }
//
// Security:
// - Requires Firebase Authentication (any authenticated user can download)
// ═══════════════════════════════════════════════════════════════════════════════

// Blue-green deployment: v2 functions run alongside v1
// Old function name: getSignedDownloadUrl
export const getSignedDownloadUrl_v2 = onRequest(HTTP_OPTS, async (req, res) => {
  if (!requireMethod(req, res, 'POST')) return;

  const authResult = await authenticateRequest(req);
  if (authResult.error) {
    return sendError(res, authResult.status, authResult.error);
  }

  const { filePath } = req.body || {};

  if (!filePath || typeof filePath !== 'string') {
    return sendError(res, 400, 'filePath is required and must be a string');
  }

  const bucketName = getBucketName();
  if (!bucketName) {
    return sendError(res, 500, 'Missing GCS bucket configuration');
  }

  try {
    // Check if file exists
    const file = storage.bucket(bucketName).file(filePath);
    const [exists] = await file.exists();

    if (!exists) {
      return sendError(res, 404, 'File not found');
    }

    // Generate signed URL for reading/downloading
    const expiresAtMs = Date.now() + SIGNED_URL_TTL_MS;

    const [downloadUrl] = await file.getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: expiresAtMs,
    });

    return res.status(200).json({
      downloadUrl,
      filePath,
      bucket: bucketName,
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
  } catch (error) {
    console.error('Failed to generate signed download URL:', error);
    return sendError(res, 500, 'Failed to generate download URL', { details: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADD FINANCIAL ENTRY
// ═══════════════════════════════════════════════════════════════════════════════
//
// Adds a manual income or expense entry.
//
// Request Body:
// {
//   type: "income" | "expense",
//   category: string,              // See INCOME_CATEGORY or EXPENSE_CATEGORY
//   amount: number,
//   date: string,                  // ISO date string (business date)
//   description?: string
// }
// ═══════════════════════════════════════════════════════════════════════════════

// Blue-green deployment: v2 functions run alongside v1
// Old function name: addFinancialEntry
export const addFinancialEntry_v2 = onRequest(HTTP_OPTS, async (req, res) => {
  if (!requireMethod(req, res, 'POST')) return;

  // Authenticate
  const authResult = await authenticateRequest(req);
  if (authResult.error) {
    return sendError(res, authResult.status, authResult.error);
  }
  const user = authResult.user;

  // Validate
  const body = req.body || {};
  const validationErrors = validateFinancialEntryRequest(body);
  if (validationErrors.length > 0) {
    return sendError(res, 400, 'Validation failed', { details: validationErrors });
  }

  try {
    const entry = buildFinancialEntry({
      type: body.type,
      category: body.category,
      amount: body.amount,
      date: body.date,
      description: body.description,
      source: ENTRY_SOURCE.manual,
      userId: user.uid,
      userName: getUserDisplayName(user),
    });

    const docRef = await db.collection(FINANCIAL_ENTRIES_COLLECTION).add(entry);

    console.log(`Financial entry created: ${docRef.id} - ${body.type} ${body.category} ${body.amount}`);

    return res.status(201).json({
      success: true,
      message: `${body.type === ENTRY_TYPE.income ? 'Έσοδο' : 'Έξοδο'} καταχωρήθηκε επιτυχώς`,
      data: {
        entryId: docRef.id,
        ...entry,
        date: body.date,
      },
    });
  } catch (error) {
    console.error('Failed to add financial entry:', error);
    return sendError(res, 500, 'Failed to add financial entry', { details: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// EDIT FINANCIAL ENTRY
// ═══════════════════════════════════════════════════════════════════════════════
//
// Edits a manual or recurring financial entry. Invoice payment entries are
// read-only. Soft-deleted entries cannot be edited.
//
// Request Body:
// {
//   entryId: string,
//   fields: {
//     type?: "income" | "expense",   // Manual only
//     category?: string,
//     amount?: number,
//     date?: string,                 // ISO date string
//     description?: string | null
//   }
// }
// ═══════════════════════════════════════════════════════════════════════════════

// Blue-green deployment: v2 functions run alongside v1
// Old function name: editFinancialEntry
export const editFinancialEntry_v2 = onRequest(HTTP_OPTS, async (req, res) => {
  if (!requireMethod(req, res, 'POST')) return;

  const authResult = await authenticateRequest(req);
  if (authResult.error) {
    return sendError(res, authResult.status, authResult.error);
  }
  const user = authResult.user;

  const body = req.body || {};
  const validationErrors = validateUpdateFinancialEntryRequest(body);
  if (validationErrors.length > 0) {
    return sendError(res, 400, 'Validation failed', { details: validationErrors });
  }

  const { entryId, fields } = body;

  try {
    const entryRef = db.collection(FINANCIAL_ENTRIES_COLLECTION).doc(entryId);
    const entrySnap = await entryRef.get();

    if (!entrySnap.exists) {
      return sendError(res, 404, 'Η εγγραφή δεν βρέθηκε');
    }

    const current = entrySnap.data();

    if (current.isDeleted) {
      return sendError(res, 400, 'Δεν μπορείτε να επεξεργαστείτε διαγραμμένες εγγραφές');
    }

    if (current.source === ENTRY_SOURCE.invoicePayment) {
      return sendError(res, 400, 'Δεν μπορείτε να επεξεργαστείτε εγγραφές πληρωμών τιμολογίων');
    }

    if (current.source === ENTRY_SOURCE.recurring && fields.type !== undefined) {
      return sendError(res, 400, 'Δεν μπορείτε να αλλάξετε τον τύπο σε πάγια έξοδα');
    }

    // Determine effective type for category validation
    const effectiveType = fields.type ?? current.type;

    // If type is changing, category must also be provided
    if (fields.type !== undefined && fields.type !== current.type && fields.category === undefined) {
      const validCategories =
        effectiveType === ENTRY_TYPE.income ? VALID_INCOME_CATEGORIES : VALID_EXPENSE_CATEGORIES;
      if (!validCategories.includes(current.category)) {
        return sendError(res, 400, 'Πρέπει να δώσετε κατηγορία όταν αλλάζετε τον τύπο', {
          details: [`category is required when changing type to ${effectiveType}`],
        });
      }
    }

    // Validate category against effective type
    if (fields.category !== undefined) {
      const validCategories =
        effectiveType === ENTRY_TYPE.income ? VALID_INCOME_CATEGORIES : VALID_EXPENSE_CATEGORIES;
      if (!validCategories.includes(fields.category)) {
        return sendError(res, 400, 'Validation failed', {
          details: [`category for ${effectiveType} must be one of: ${validCategories.join(', ')}`],
        });
      }
    }

    // Build update object
    const updates = {
      updatedAt: serverTimestamp(),
      updatedBy: user.uid,
      updatedByName: getUserDisplayName(user),
    };

    if (fields.type !== undefined) updates.type = fields.type;
    if (fields.category !== undefined) updates.category = fields.category;
    if (fields.amount !== undefined) updates.amount = fields.amount;
    if (fields.date !== undefined) updates.date = admin.firestore.Timestamp.fromDate(new Date(fields.date));
    if (fields.description !== undefined) updates.description = fields.description === null ? null : fields.description;

    await entryRef.update(updates);

    console.log(`Financial entry updated: ${entryId}`);

    return res.status(200).json({
      success: true,
      message: 'Η εγγραφή ενημερώθηκε επιτυχώς',
      data: { entryId, updatedFields: Object.keys(fields) },
    });
  } catch (error) {
    console.error('Failed to update financial entry:', error);
    return sendError(res, 500, 'Failed to update financial entry', { details: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE FINANCIAL ENTRY (Soft Delete)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Soft deletes a financial entry.
//
// Request Body:
// {
//   entryId: string
// }
// ═══════════════════════════════════════════════════════════════════════════════

// Blue-green deployment: v2 functions run alongside v1
// Old function name: deleteFinancialEntry
export const deleteFinancialEntry_v2 = onRequest(HTTP_OPTS, async (req, res) => {
  if (!requireMethod(req, res, 'POST')) return;

  const authResult = await authenticateRequest(req);
  if (authResult.error) {
    return sendError(res, authResult.status, authResult.error);
  }
  const user = authResult.user;

  const { entryId } = req.body || {};
  if (!entryId || typeof entryId !== 'string') {
    return sendError(res, 400, 'entryId is required and must be a string');
  }

  try {
    const entryRef = db.collection(FINANCIAL_ENTRIES_COLLECTION).doc(entryId);
    const entrySnap = await entryRef.get();

    if (!entrySnap.exists) {
      return sendError(res, 404, 'Entry not found');
    }

    await entryRef.update({
      isDeleted: true,
      deletedBy: user.uid,
      deletedByName: getUserDisplayName(user),
      deletedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    console.log(`Financial entry soft deleted: ${entryId}`);

    return res.status(200).json({
      success: true,
      message: 'Η εγγραφή διαγράφηκε επιτυχώς',
      entryId,
    });
  } catch (error) {
    console.error('Failed to delete financial entry:', error);
    return sendError(res, 500, 'Failed to delete entry', { details: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET FINANCIAL REPORT
// ═══════════════════════════════════════════════════════════════════════════════
//
// Retrieves financial entries and summary for a date range.
//
// Request Body:
// {
//   startDate: string,             // ISO date string
//   endDate: string,               // ISO date string
//   type?: "income" | "expense",   // Optional filter
//   includeDeleted?: boolean       // Default false
// }
// ═══════════════════════════════════════════════════════════════════════════════

// Blue-green deployment: v2 functions run alongside v1
// Old function name: getFinancialReport
export const getFinancialReport_v2 = onRequest(HTTP_OPTS, async (req, res) => {
  if (!requireMethod(req, res, 'POST')) return;

  const authResult = await authenticateRequest(req);
  if (authResult.error) {
    return sendError(res, authResult.status, authResult.error);
  }

  const { startDate, endDate, type, includeDeleted } = req.body || {};

  if (!startDate || !endDate) {
    return sendError(res, 400, 'startDate and endDate are required');
  }

  const start = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T23:59:59.999Z');

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return sendError(res, 400, 'Invalid date format');
  }

  try {
    let query = db
      .collection(FINANCIAL_ENTRIES_COLLECTION)
      .where('date', '>=', admin.firestore.Timestamp.fromDate(start))
      .where('date', '<=', admin.firestore.Timestamp.fromDate(end));

    if (type && Object.values(ENTRY_TYPE).includes(type)) {
      query = query.where('type', '==', type);
    }

    const snapshot = await query.orderBy('date', 'desc').get();

    const entries = [];
    let totalIncome = 0;
    let totalExpenses = 0;
    const incomeBreakdown = {};
    const expenseBreakdown = {};

    snapshot.forEach((doc) => {
      const data = doc.data();

      // Skip deleted unless requested
      if (data.isDeleted && !includeDeleted) {
        return;
      }

      const entry = {
        id: doc.id,
        ...data,
        date: data.date?.toDate?.()?.toISOString() || data.date,
      };
      entries.push(entry);

      // Calculate totals (only non-deleted)
      if (!data.isDeleted) {
        if (data.type === ENTRY_TYPE.income) {
          totalIncome += data.amount;
          incomeBreakdown[data.category] = (incomeBreakdown[data.category] || 0) + data.amount;
        } else if (data.type === ENTRY_TYPE.expense) {
          totalExpenses += data.amount;
          expenseBreakdown[data.category] = (expenseBreakdown[data.category] || 0) + data.amount;
        }
      }
    });

    return res.status(200).json({
      success: true,
      data: {
        period: { startDate, endDate },
        summary: {
          totalIncome: Math.round(totalIncome * 100) / 100,
          totalExpenses: Math.round(totalExpenses * 100) / 100,
          netBalance: Math.round((totalIncome - totalExpenses) * 100) / 100,
          entryCount: entries.length,
        },
        breakdown: {
          income: incomeBreakdown,
          expenses: expenseBreakdown,
        },
        entries,
      },
    });
  } catch (error) {
    console.error('Failed to get financial report:', error);
    return sendError(res, 500, 'Failed to get report', { details: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADD RECURRING EXPENSE
// ═══════════════════════════════════════════════════════════════════════════════
//
// Sets up a recurring monthly expense (e.g., rent, utilities).
//
// Request Body:
// {
//   category: string,              // Expense category
//   amount: number,
//   dayOfMonth: number,            // 1-28 (day to generate expense)
//   description?: string
// }
// ═══════════════════════════════════════════════════════════════════════════════

// Blue-green deployment: v2 functions run alongside v1
// Old function name: addRecurringExpense
export const addRecurringExpense_v2 = onRequest(HTTP_OPTS, async (req, res) => {
  if (!requireMethod(req, res, 'POST')) return;

  const authResult = await authenticateRequest(req);
  if (authResult.error) {
    return sendError(res, authResult.status, authResult.error);
  }
  const user = authResult.user;

  const body = req.body || {};
  const validationErrors = validateRecurringExpenseRequest(body);
  if (validationErrors.length > 0) {
    return sendError(res, 400, 'Validation failed', { details: validationErrors });
  }

  try {
    const recurringExpense = {
      category: body.category,
      amount: body.amount,
      dayOfMonth: body.dayOfMonth,
      description: body.description || null,
      isActive: true,
      createdBy: user.uid,
      createdByName: getUserDisplayName(user),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    const docRef = await db.collection(RECURRING_EXPENSES_COLLECTION).add(recurringExpense);

    console.log(`Recurring expense created: ${docRef.id} - ${body.category} ${body.amount}`);

    return res.status(201).json({
      success: true,
      message: 'Πάγιο έξοδο δημιουργήθηκε επιτυχώς',
      data: {
        recurringId: docRef.id,
        ...recurringExpense,
      },
    });
  } catch (error) {
    console.error('Failed to add recurring expense:', error);
    return sendError(res, 500, 'Failed to add recurring expense', { details: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// UPDATE RECURRING EXPENSE
// ═══════════════════════════════════════════════════════════════════════════════
//
// Updates a recurring expense.
//
// Request Body:
// {
//   recurringId: string,
//   fields: {
//     amount?: number,
//     dayOfMonth?: number,
//     description?: string,
//     isActive?: boolean
//   }
// }
// ═══════════════════════════════════════════════════════════════════════════════

// Blue-green deployment: v2 functions run alongside v1
// Old function name: updateRecurringExpense
export const updateRecurringExpense_v2 = onRequest(HTTP_OPTS, async (req, res) => {
  if (!requireMethod(req, res, 'POST')) return;

  const authResult = await authenticateRequest(req);
  if (authResult.error) {
    return sendError(res, authResult.status, authResult.error);
  }
  const user = authResult.user;

  const { recurringId, fields } = req.body || {};

  if (!recurringId || typeof recurringId !== 'string') {
    return sendError(res, 400, 'recurringId is required');
  }

  if (!fields || typeof fields !== 'object') {
    return sendError(res, 400, 'fields is required and must be an object');
  }

  // Validate fields
  const errors = [];
  if (fields.amount !== undefined && (typeof fields.amount !== 'number' || fields.amount <= 0)) {
    errors.push('amount must be a positive number');
  }
  if (
    fields.dayOfMonth !== undefined &&
    (typeof fields.dayOfMonth !== 'number' || fields.dayOfMonth < 1 || fields.dayOfMonth > 28)
  ) {
    errors.push('dayOfMonth must be between 1 and 28');
  }
  if (fields.description !== undefined && typeof fields.description !== 'string') {
    errors.push('description must be a string');
  }
  if (fields.isActive !== undefined && typeof fields.isActive !== 'boolean') {
    errors.push('isActive must be a boolean');
  }

  if (errors.length > 0) {
    return sendError(res, 400, 'Validation failed', { details: errors });
  }

  try {
    const recurringRef = db.collection(RECURRING_EXPENSES_COLLECTION).doc(recurringId);
    const recurringSnap = await recurringRef.get();

    if (!recurringSnap.exists) {
      return sendError(res, 404, 'Recurring expense not found');
    }

    const updates = {
      updatedAt: serverTimestamp(),
      lastEditedBy: user.uid,
      lastEditedByName: getUserDisplayName(user),
    };

    if (fields.amount !== undefined) updates.amount = fields.amount;
    if (fields.dayOfMonth !== undefined) updates.dayOfMonth = fields.dayOfMonth;
    if (fields.description !== undefined) updates.description = fields.description;
    if (fields.isActive !== undefined) updates.isActive = fields.isActive;

    await recurringRef.update(updates);

    console.log(`Recurring expense updated: ${recurringId}`);

    return res.status(200).json({
      success: true,
      message: 'Πάγιο έξοδο ενημερώθηκε επιτυχώς',
      recurringId,
    });
  } catch (error) {
    console.error('Failed to update recurring expense:', error);
    return sendError(res, 500, 'Failed to update recurring expense', { details: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROCESS RECURRING EXPENSES (Scheduled)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Runs daily to generate expense entries for recurring expenses.
// ═══════════════════════════════════════════════════════════════════════════════

// Blue-green deployment: v2 functions run alongside v1
// Old function name: processRecurringExpenses
export const processRecurringExpenses_v2 = onSchedule(
  {
    region: REGION,
    serviceAccount: SERVICE_ACCOUNT_EMAIL,
    schedule: '0 6 * * *', // Run at 6:00 AM daily
    timeZone: 'Europe/Athens',
  },
  async (_event) => {
    const { utcDate: today, dayOfMonth } = getAthensToday();

    console.log(`Processing recurring expenses for day ${dayOfMonth}`);

    try {
      // Find all active recurring expenses for today's day of month
      const snapshot = await db
        .collection(RECURRING_EXPENSES_COLLECTION)
        .where('isActive', '==', true)
        .where('dayOfMonth', '==', dayOfMonth)
        .get();

      if (snapshot.empty) {
        console.log('No recurring expenses to process today');
        return null;
      }

      const batch = db.batch();
      let count = 0;

      snapshot.forEach((doc) => {
        const recurring = doc.data();

        const entry = {
          type: ENTRY_TYPE.expense,
          category: recurring.category,
          amount: recurring.amount,
          date: admin.firestore.Timestamp.fromDate(today),
          description: recurring.description || `Πάγιο έξοδο: ${recurring.category}`,
          source: ENTRY_SOURCE.recurring,
          metadata: {
            recurringExpenseId: doc.id,
          },
          isDeleted: false,
          createdBy: recurring.createdBy,
          createdByName: recurring.createdByName || null,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        };

        const newEntryRef = db.collection(FINANCIAL_ENTRIES_COLLECTION).doc();
        batch.set(newEntryRef, entry);
        count++;
      });

      await batch.commit();

      console.log(`Created ${count} recurring expense entries for day ${dayOfMonth}`);
      return null;
    } catch (error) {
      console.error('Failed to process recurring expenses:', error);
      return null;
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// GET RECURRING EXPENSES
// ═══════════════════════════════════════════════════════════════════════════════
//
// Lists all recurring expenses.
// ═══════════════════════════════════════════════════════════════════════════════

// Blue-green deployment: v2 functions run alongside v1
// Old function name: getRecurringExpenses
export const getRecurringExpenses_v2 = onRequest(HTTP_OPTS, async (req, res) => {
  if (!requireMethod(req, res, 'GET')) return;

  const authResult = await authenticateRequest(req);
  if (authResult.error) {
    return sendError(res, authResult.status, authResult.error);
  }

  try {
    const snapshot = await db.collection(RECURRING_EXPENSES_COLLECTION).orderBy('createdAt', 'desc').get();

    const expenses = [];
    snapshot.forEach((doc) => {
      expenses.push({
        id: doc.id,
        ...doc.data(),
      });
    });

    return res.status(200).json({
      success: true,
      data: expenses,
    });
  } catch (error) {
    console.error('Failed to get recurring expenses:', error);
    return sendError(res, 500, 'Failed to get recurring expenses', { details: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT INVOICES (ZIP Download)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Accepts a list of selected invoices (by supplierId + invoiceId), fetches
// their PDFs from GCS, streams them into a ZIP archive, uploads the ZIP to a
// temporary GCS path, records a download event on each invoice, and returns
// a signed download URL.
//
// The date-range listing and supplier grouping happens entirely on the client
// via the Firestore SDK. This function only handles the selected downloads.
//
// Request Body:
// {
//   invoices: [                          // Required - selected invoices
//     { supplierId: string, invoiceId: string },
//     ...
//   ]
// }
//
// Response:
// {
//   success: true,
//   message: string,
//   data: {
//     downloadUrl: string,
//     invoiceCount: number,
//     zipPath: string,
//     expiresAt: string
//   }
// }
//
// Download tracking:
// - After a successful export, each invoice document receives a
//   `downloadedBy.<uid>` map entry with `lastDownloadedAt` and
//   `downloadCount` so the client UI can show "already downloaded" badges.
//
// Security:
// - Requires Firebase Authentication
// ═══════════════════════════════════════════════════════════════════════════════

const EXPORT_OPTS = {
  ...HTTP_OPTS,
  timeoutSeconds: 540,
  memory: '1GiB',
};

// Blue-green deployment: v2 functions run alongside v1
// Old function name: exportInvoices
export const exportInvoices_v2 = onRequest(EXPORT_OPTS, async (req, res) => {
  if (!requireMethod(req, res, 'POST')) return;

  // 1. Authenticate
  const authResult = await authenticateRequest(req);
  if (authResult.error) {
    return sendError(res, authResult.status, authResult.error);
  }
  const user = authResult.user;

  // 2. Validate request body
  const body = req.body || {};
  const validationErrors = validateExportRequest(body);
  if (validationErrors.length > 0) {
    return sendError(res, 400, 'Validation failed', { details: validationErrors });
  }

  const { invoices: invoicePairs } = body;

  try {
    // 3. Fetch invoice documents by direct path
    const invoices = await fetchInvoiceDocuments(invoicePairs);

    if (invoices.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'Δεν βρέθηκαν τιμολόγια για τα επιλεγμένα αναγνωριστικά',
        data: { invoiceCount: 0 },
      });
    }

    // 4. Filter to invoices that have a PDF file
    const exportable = invoices.filter((inv) => inv.filePath);
    if (exportable.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'Δεν βρέθηκαν αρχεία PDF για τα επιλεγμένα τιμολόγια',
        data: { invoiceCount: invoices.length },
      });
    }

    console.log(`Exporting ${exportable.length} invoices for user ${user.uid}`);

    // 5. Stream PDFs into a ZIP and upload to GCS
    const zipPath = await streamInvoicesZip({
      invoices: exportable,
      uid: user.uid,
    });

    // 6. Record download event on each exported invoice
    const exportedPairs = exportable.map(({ supplierId, invoiceId }) => ({
      supplierId,
      invoiceId,
    }));
    try {
      await recordDownloads({ invoicePairs: exportedPairs, uid: user.uid, userName: getUserDisplayName(user) });
    } catch (trackingError) {
      // Log but don't fail the export — download tracking is secondary
      console.error('Failed to record download tracking:', trackingError);
    }

    // 7. Generate signed download URL
    const { downloadUrl, expiresAt } = await getExportDownloadUrl(zipPath);

    console.log(`Export complete: ${exportable.length} invoices → ${zipPath}`);

    return res.status(200).json({
      success: true,
      message: `Εξαγωγή ${exportable.length} τιμολογίων ολοκληρώθηκε`,
      data: {
        downloadUrl,
        invoiceCount: exportable.length,
        zipPath,
        expiresAt,
      },
    });
  } catch (error) {
    console.error('Invoice export failed:', error);
    return sendError(res, 500, 'Αποτυχία εξαγωγής τιμολογίων', {
      details: error.message,
      code: 'EXPORT_ERROR',
    });
  }
});
