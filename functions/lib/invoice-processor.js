import {
  admin,
  db,
  storage,
  INVOICE_STATUS,
  PAYMENT_STATUS,
  UPLOADS_PREFIX,
  serverTimestamp,
  getBucketName,
} from './config.js';
import { sanitizeId } from './invoice-upload.js';
import {
  FIELD_LABELS,
  formatMetadataError,
  formatMetadataSuccess,
  getOpenAIClient,
  parseAmount,
  parseDate,
  runInvoiceOcr,
} from './invoice-ocr.js';
import { buildCombinedPdfFromPages } from './invoice-pdf.js';
import { ensureSupplierProfile } from './suppliers.js';

/**
 * Core handler for processInvoiceDocument_v2.
 * Processes an invoice document when its status changes to 'ready'.
 * Handles: lock, OCR, dedup, supplier upsert, PDF storage, and writes.
 */
async function processInvoiceDocumentHandler(event) {
  const change = event.data;
  const context = event.params;
  const after = change.after.exists ? change.after.data() : null;
  if (!after) {
    return;
  }

  const before = change.before.exists ? change.before.data() : null;
  if (before && before.status === after.status) {
    return;
  }

  if (after.status !== INVOICE_STATUS.ready) {
    return;
  }

  const openaiClient = getOpenAIClient();
  if (!openaiClient) {
    console.warn('OPENAI_API_KEY not configured; unable to run OCR.');
    await change.after.ref.update({
      status: INVOICE_STATUS.error,
      errorMessage: 'Αποτυχία OCR, το OPENAI_API_KEY λείπει.',
      updatedAt: serverTimestamp(),
    });
    return;
  }

  let lockedSnapshot;
  try {
    lockedSnapshot = await db.runTransaction(async (tx) => {
      const lockedSnap = await tx.get(change.after.ref);
      const lockedData = lockedSnap.data();
      if (lockedData.status !== INVOICE_STATUS.ready) {
        return null;
      }

      tx.update(change.after.ref, {
        status: INVOICE_STATUS.processing,
        processingStartedAt: serverTimestamp(),
        errorMessage: null,
        updatedAt: serverTimestamp(),
      });

      return lockedData;
    });
  } catch (error) {
    console.error('Failed to lock invoice document for processing', error);
    return;
  }

  if (!lockedSnapshot) {
    return;
  }

  const invoiceId = context.invoiceId;
  const invoiceData = lockedSnapshot;
  const bucketName = invoiceData.bucket || getBucketName();
  if (!bucketName) {
    await change.after.ref.update({
      status: INVOICE_STATUS.error,
      errorMessage: 'Λείπει η ρύθμιση του bucket για την επεξεργασία τιμολογίου.',
      updatedAt: serverTimestamp(),
    });
    return;
  }

  const pages = Array.isArray(invoiceData.pages)
    ? [...invoiceData.pages].sort((a, b) => a.pageNumber - b.pageNumber)
    : [];

  if (!pages.length) {
    await change.after.ref.update({
      status: INVOICE_STATUS.error,
      errorMessage: 'Δεν έγινε ανέβασμα τιμολογίου.',
      updatedAt: serverTimestamp(),
    });
    return;
  }

  if (invoiceData.totalPages && pages.length !== invoiceData.totalPages) {
    await change.after.ref.update({
      status: INVOICE_STATUS.error,
      errorMessage: `Αναμενόταν ${invoiceData.totalPages} σελίδες αλλά βρέθηκαν ${pages.length}.`,
      updatedAt: serverTimestamp(),
    });
    return;
  }

  // Declare outside try block so they're accessible in catch for error formatting
  let supplierName = null;
  let invoiceNumber = null;

  const isSinglePdf = pages.length === 1 && pages[0].contentType === 'application/pdf';

  try {
    let pagesToOcr;
    let combinedPdfBuffer;

    if (isSinglePdf) {
      // PDF path: Vision reads directly from GCS, no download needed for OCR
      const pdfPage = pages[0];
      pagesToOcr = [{
        mimeType: 'application/pdf',
        bucketName: pdfPage.bucket || bucketName,
        objectName: pdfPage.objectName,
        totalPages: invoiceData.totalPages || null,
        pageNumber: 1,
      }];
    } else {
      // Image path: download all pages, combine into a single PDF
      const result = await buildCombinedPdfFromPages(pages, bucketName);
      combinedPdfBuffer = result.combinedPdfBuffer;
      pagesToOcr = result.downloadedPages;
    }

    const ocrResult = await runInvoiceOcr(pagesToOcr);
    if (!ocrResult) {
      throw new Error('OCR result was empty.');
    }

    const mappedResult = Object.entries(ocrResult).reduce((acc, [key, value]) => {
      const englishKey = FIELD_LABELS[key] || key;
      acc[englishKey] = value;
      return acc;
    }, {});

    console.log('OCR extraction (GR):', JSON.stringify(ocrResult, null, 2));
    console.log('OCR extraction (EN):', JSON.stringify(mappedResult, null, 2));

    const ocrSupplierName = mappedResult.supplierName || null;
    const supplierTaxNumber = mappedResult.supplierTaxNumber || ocrSupplierName;

    if (!supplierTaxNumber && !ocrSupplierName) {
      throw new Error('Δεν ήταν δυνατή η αναγνώριση του προμηθευτή (δεν βρέθηκε ΑΦΜ ή επωνυμία).');
    }

    supplierName = ocrSupplierName || 'Unknown Supplier';
    const supplierId = sanitizeId(supplierTaxNumber, sanitizeId(ocrSupplierName, 'unknown-supplier'));
    const missingTaxNumber = !mappedResult.supplierTaxNumber;
    invoiceNumber = mappedResult.invoiceNumber?.toString().match(/\d+/g)?.join('') || null;
    const uploadedBy = invoiceData.ownerUid || null;
    const uploadedByName = invoiceData.ownerName || null;
    const { canonicalName } = await ensureSupplierProfile({
      supplierId,
      supplierName,
      supplierTaxNumber,
      supplierCategory: mappedResult.supplierCategory || null,
      missingTaxNumber,
    });
    if (canonicalName) {
      supplierName = canonicalName;
    }

    // Check for duplicate invoice (same supplier + invoice number, only against done invoices)
    if (invoiceNumber && supplierId) {
      const duplicateQuery = await db
        .collection('suppliers')
        .doc(supplierId)
        .collection('invoices')
        .where('invoiceNumber', '==', invoiceNumber)
        .where('processingStatus', '==', INVOICE_STATUS.uploaded)
        .limit(1)
        .get();

      if (!duplicateQuery.empty) {
        const existingInvoice = duplicateQuery.docs[0];
        const baseError = `Διπλότυπο τιμολόγιο (υπάρχον: ${existingInvoice.id})`;
        const errorMessage = formatMetadataError(invoiceNumber, supplierName, baseError);

        console.error(errorMessage);

        await change.after.ref.update({
          status: INVOICE_STATUS.error,
          errorMessage,
          duplicateOf: existingInvoice.id,
          detectedInvoiceNumber: invoiceNumber,
          detectedSupplierId: supplierId,
          updatedAt: serverTimestamp(),
        });

        return;
      }
    }

    const pdfObjectPath = `suppliers/${supplierId}/invoices/${invoiceId}.pdf`;
    try {
      if (isSinglePdf) {
        // Server-side copy: no download/upload, no memory usage
        const sourceFile = storage.bucket(bucketName).file(pages[0].objectName);
        const destFile = storage.bucket(bucketName).file(pdfObjectPath);
        await sourceFile.copy(destFile);
      } else {
        await storage
          .bucket(bucketName)
          .file(pdfObjectPath)
          .save(combinedPdfBuffer, {
            resumable: false,
            contentType: 'application/pdf',
            metadata: {
              pages: pages.length,
              originalFolder: invoiceData.storageFolder || `${UPLOADS_PREFIX}${invoiceId}`,
            },
          });
      }
      console.log(`Stored normalized PDF at gs://${bucketName}/${pdfObjectPath}`);
    } catch (pdfError) {
      console.error(`Failed to store combined PDF for invoice ${invoiceId}:`, pdfError);
    }

    const invoiceDocRef = db.doc(`suppliers/${supplierId}/invoices/${invoiceId}`);

    // Store original OCR data for reference when user edits fields
    const ocrData = {
      supplierName: ocrSupplierName,
      supplierTaxNumber,
      invoiceNumber,
      invoiceDate: mappedResult.invoiceDate || null,
      dueDate: mappedResult.dueDate || null,
      totalAmount: mappedResult.totalAmount || null,
      currency: mappedResult.currency || 'EUR',
      netAmount: mappedResult.netAmount || null,
      vatAmount: mappedResult.vat || null,
      vatRate: mappedResult.vatRate || null,
      confidence: mappedResult.confidence ? Number(mappedResult.confidence) : null,
      extractedAt: admin.firestore.Timestamp.now(),
    };

    const invoicePayload = {
      invoiceId,
      rawFilePaths: pages.map((p) => p.objectName),
      filePath: pdfObjectPath,
      bucket: bucketName,
      uploadedBy,
      uploadedByName,
      supplierId,
      supplierName,
      supplierTaxNumber,
      missingTaxNumber,
      invoiceNumber,
      invoiceDate: parseDate(mappedResult.invoiceDate),
      dueDate: parseDate(mappedResult.dueDate),
      totalAmount: parseAmount(mappedResult.totalAmount),
      currency: mappedResult.currency || 'EUR',
      netAmount: parseAmount(mappedResult.netAmount),
      vatAmount: parseAmount(mappedResult.vat),
      vatRate: parseAmount(mappedResult.vatRate),
      processingStatus: INVOICE_STATUS.uploaded,
      paymentStatus: PAYMENT_STATUS.unpaid,
      unpaidAmount: parseAmount(mappedResult.totalAmount),
      errorMessage: null,
      confidence: mappedResult.confidence ? Number(mappedResult.confidence) : null,
      ocr: ocrData,
      createdAt: invoiceData.createdAt || serverTimestamp(),
      uploadedAt: serverTimestamp(),
    };

    await invoiceDocRef.set(invoicePayload, { merge: true });

    await change.after.ref.update({
      status: INVOICE_STATUS.done,
      uploadedAt: serverTimestamp(),
      processedInvoicePath: invoiceDocRef.path,
      confidence: invoicePayload.confidence,
      errorMessage: null,
      successMessage: formatMetadataSuccess(invoiceNumber, supplierName),
      updatedAt: serverTimestamp(),
    });

    console.log(`Stored invoice data at ${invoiceDocRef.path}`);

    // TODO: send notification on success
  } catch (error) {
    const baseError = `Αδυναμία επεξεργασίας τιμολογίου με id: ${invoiceId}. Σφάλμα: ${error.message}`;
    const errorMessage = formatMetadataError(invoiceNumber, supplierName, baseError);
    console.error(errorMessage);
    await change.after.ref.update({
      status: INVOICE_STATUS.error,
      errorMessage,
      updatedAt: serverTimestamp(),
    });

    // TODO: send notification on error
  }
}

export { processInvoiceDocumentHandler };
