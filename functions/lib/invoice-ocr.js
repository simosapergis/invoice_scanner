import OpenAI from 'openai';
import { admin, getVisionClient, OPENAI_API_KEY } from './config.js';

const REQUIRED_FIELDS = [
  'ΗΜΕΡΟΜΗΝΙΑ',
  'ΑΡΙΘΜΟΣ ΤΙΜΟΛΟΓΙΟΥ',
  'ΠΡΟΜΗΘΕΥΤΗΣ',
  'ΑΦΜ ΠΡΟΜΗΘΕΥΤΗ',
  'ΚΑΘΑΡΗ ΑΞΙΑ',
  'ΦΠΑ',
  'ΠΛΗΡΩΤΕΟ',
  'ΑΚΡΙΒΕΙΑ',
];

const FIELD_LABELS = {
  ΗΜΕΡΟΜΗΝΙΑ: 'invoiceDate',
  'ΑΡΙΘΜΟΣ ΤΙΜΟΛΟΓΙΟΥ': 'invoiceNumber',
  ΠΡΟΜΗΘΕΥΤΗΣ: 'supplierName',
  'ΑΦΜ ΠΡΟΜΗΘΕΥΤΗ': 'supplierTaxNumber',
  'ΚΑΘΑΡΗ ΑΞΙΑ': 'netAmount',
  ΦΠΑ: 'vat',
  ΠΛΗΡΩΤΕΟ: 'totalAmount',
  ΑΚΡΙΒΕΙΑ: 'confidence',
};

const METADATA_ERROR_MESSAGE = '❌ Aποτυχία τιμολογίου ΤΔΑ-%s από %s. %s';
const METADATA_SUCCESS_MESSAGE = '✅ Επιτυχία τιμολογίου ΤΔΑ-%s από %s.';

/**
 * Formats error message with prefix if invoiceNumber and supplierName are known.
 */
function formatMetadataError(invoiceNumber, supplierName, errorMsg) {
  if (invoiceNumber && supplierName && supplierName !== 'Unknown Supplier') {
    return METADATA_ERROR_MESSAGE.replace('%s', invoiceNumber).replace('%s', supplierName).replace('%s', errorMsg);
  }
  return errorMsg;
}

/**
 * Formats success message with invoiceNumber and supplierName.
 */
function formatMetadataSuccess(invoiceNumber, supplierName) {
  return METADATA_SUCCESS_MESSAGE.replace('%s', invoiceNumber).replace('%s', supplierName);
}

// Initialize OpenAI client - params are evaluated lazily
let openaiClient = null;
function getOpenAIClient() {
  if (!openaiClient) {
    const apiKey = OPENAI_API_KEY.value();
    openaiClient = apiKey ? new OpenAI({ apiKey }) : null;
  }
  return openaiClient;
}
const OCR_MAX_RETRIES = 3;

function collectResponseText(response) {
  const chunks = [];
  if (Array.isArray(response?.output)) {
    for (const block of response.output) {
      if (!Array.isArray(block?.content)) continue;
      for (const part of block.content) {
        if (typeof part?.text === 'string') chunks.push(part.text);
        else if (typeof part?.output_text === 'string') chunks.push(part.output_text);
        else if (typeof part?.value === 'string') chunks.push(part.value);
      }
    }
  }
  if (Array.isArray(response?.output_text)) {
    chunks.push(...response.output_text);
  }
  return chunks.join('\n').trim();
}

function parseJsonFromResponse(text) {
  if (!text) throw new Error('Empty OCR response');
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found in OCR response');
    return JSON.parse(match[0]);
  }
}

/**
 * Normalize European decimal format in OCR text before sending to GPT.
 * Converts "2.383,13" → "2383.13" so GPT sees standard decimal notation.
 */
function normalizeEuropeanDecimals(text) {
  // Match European format: optional thousands separators (.) followed by comma decimal
  // Examples: 2.383,13 | 383,13 | 1.234.567,89
  return text.replace(
    /\b(\d{1,3}(?:\.\d{3})*),(\d{1,2})\b/g,
    (_, intPart, decPart) => intPart.replace(/\./g, '') + '.' + decPart
  );
}

function parseAmount(value) {
  if (value === null || value === undefined) return null;

  // Remove everything except digits, dot, and minus (decimals already normalized before GPT)
  const str = value.toString().replace(/[^\d.-]/g, '');
  if (!str) return null;

  const num = Number(str);
  return Number.isFinite(num) ? num : null;
}

function parseDate(value) {
  if (!value) return null;

  // European format: dd/mm/yyyy or dd-mm-yyyy
  const euMatch = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (euMatch) {
    const [, day, month, year] = euMatch;
    const date = new Date(Date.UTC(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10)));
    if (!Number.isNaN(date.getTime())) {
      return admin.firestore.Timestamp.fromDate(date);
    }
  }

  // ISO format: yyyy-mm-dd
  const isoMatch = value.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    const date = new Date(Date.UTC(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10)));
    if (!Number.isNaN(date.getTime())) {
      return admin.firestore.Timestamp.fromDate(date);
    }
  }

  // Fallback for other formats (e.g. "05-Jan-2026", "January 5, 2026")
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const utcDate = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  return admin.firestore.Timestamp.fromDate(utcDate);
}

async function runInvoiceOcr(pageBuffers) {
  const client = getOpenAIClient();
  if (!client) {
    console.warn('OPENAI_API_KEY not configured; skipping OCR.');
    return null;
  }

  if (!Array.isArray(pageBuffers) || !pageBuffers.length) {
    console.warn('No page buffers provided for OCR.');
    return null;
  }

  // First+last page optimization for image uploads (>2 pages).
  // PDF uploads handle this via the Vision API `pages` parameter in runInvoiceOcrAttempt.
  let effectivePages = pageBuffers;
  const isImageUpload = pageBuffers.length > 0 && pageBuffers[0].mimeType !== 'application/pdf';
  if (isImageUpload && pageBuffers.length > 2) {
    const sorted = [...pageBuffers].sort((a, b) => a.pageNumber - b.pageNumber);
    effectivePages = [sorted[0], sorted[sorted.length - 1]];
    console.log(
      `Invoice has ${pageBuffers.length} pages; OCR will process only page ${effectivePages[0].pageNumber} and page ${effectivePages[1].pageNumber}`
    );
  }

  let lastError = null;
  for (let attempt = 1; attempt <= OCR_MAX_RETRIES; attempt++) {
    try {
      const result = await runInvoiceOcrAttempt(effectivePages);
      if (result) {
        if (attempt > 1) {
          console.log(`OCR succeeded on retry attempt ${attempt}.`);
        }
        return result;
      }
      lastError = new Error('OCR attempt produced no result.');
      console.warn(`OCR attempt ${attempt} produced no result; retrying...`);
    } catch (error) {
      lastError = error;
      console.error(`OCR attempt ${attempt} failed`, error);
    }
  }

  throw lastError || new Error(`Aποτυχία OCR έπειτα από ${OCR_MAX_RETRIES} προσπάθειες`);
}

async function runInvoiceOcrAttempt(pageBuffers) {
  const client = getOpenAIClient();
  const aggregatedText = [];
  for (const page of pageBuffers) {
    const mimeType = page.mimeType || 'application/octet-stream';

    if (mimeType === 'application/pdf') {
      try {
        const gcsUri = `gs://${page.bucketName}/${page.objectName}`;
        const totalPages = page.totalPages || 0;
        const pagesToRequest = totalPages > 2 ? [1, totalPages] : undefined;
        if (pagesToRequest) {
          console.log(`PDF has ${totalPages} pages; OCR will process only pages ${pagesToRequest.join(', ')}`);
        }
        const [result] = await getVisionClient().batchAnnotateFiles({
          requests: [{
            inputConfig: {
              gcsSource: { uri: gcsUri },
              mimeType: 'application/pdf',
            },
            features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
            ...(pagesToRequest && { pages: pagesToRequest }),
          }],
        });
        const pdfResponses = result.responses?.[0]?.responses || [];
        for (let i = 0; i < pdfResponses.length; i++) {
          const pageText = pdfResponses[i]?.fullTextAnnotation?.text?.trim();
          const pageNum = pagesToRequest ? pagesToRequest[i] : i + 1;
          if (pageText) {
            aggregatedText.push(`=== PAGE ${pageNum} ===\n${pageText}`);
          } else {
            console.warn(`Vision returned empty text for PDF page ${pageNum}`);
          }
        }
      } catch (visionError) {
        console.error('Vision API batchAnnotateFiles failed for PDF', visionError);
        throw visionError;
      }
      continue;
    }

    try {
      const [visionResult] = await getVisionClient().documentTextDetection({
        image: { content: page.buffer },
      });
      const pageText = visionResult?.fullTextAnnotation?.text?.trim();
      if (pageText) {
        aggregatedText.push(`=== PAGE ${page.pageNumber} ===\n${pageText}`);
      } else {
        console.warn(`Vision returned empty text for page ${page.pageNumber}`);
      }
    } catch (visionError) {
      console.error('Vision API failed to read invoice text', { mimeType }, visionError);
      throw visionError;
    }
  }

  const ocrText = aggregatedText.join('\n\n');
  if (!ocrText) {
    throw new Error('Vision API did not return any text for this invoice.');
  }

  // Normalize European decimals (2.383,13 → 2383.13) before GPT
  const fullText = normalizeEuropeanDecimals(ocrText);

  const systemPrompt = [
    'You are an expert accountant and document-analysis specialist for invoices and retail receipts (primarily Greek, occasionally foreign).',
    'You ALWAYS output strictly valid JSON following the schema provided by the user.',
    '',
    'You will be given the FULL OCR text of an invoice or retail receipt (possibly multi-page).',
    'The OCR may be noisy, misordered, or contain junk text from headers, footers, or page numbers.',
    'The OCR you receive contains multiple pages in the format',
    '=== PAGE 1 ===',
    '... page 1 text ...',
    '=== PAGE 2 ===',
    '... page 2 text ...',
    '=== PAGE N ===',
    '... page N text ...',
    '',
    '===========================',
    'STEP 0: INVOICE ORIGIN DETECTION',
    '===========================',
    'Before applying extraction rules, determine the invoice origin:',
    '- GREEK INVOICE: text is primarily in Greek, OR contains ΑΦΜ/Α.Φ.Μ., ΔΟΥ, or sections like "ΣΤΟΙΧΕΙΑ ΠΕΛΑΤΗ".',
    '  → Apply rules 3–9 below (GREEK INVOICE RULES).',
    '- GREEK RETAIL RECEIPT: text contains "ΑΠΟΔΕΙΞΗ ΛΙΑΝΙΚΗΣ", "ΤΑΜΕΙΟ", "ΤΑΜΙΑΣ", or "ΜΕΤΡΗΤΑ",',
    '  and shows short item lines with QTY × PRICE format. Single-page, no "ΣΤΟΙΧΕΙΑ ΠΕΛΑΤΗ" section.',
    '  → Apply the RETAIL RECEIPT OVERRIDES section instead of rules 3–9.',
    '- FOREIGN INVOICE: text is primarily in English or another non-Greek language, uses headers like',
    '  "FROM" / "BILL TO" / "SOLD TO", and lacks Greek tax markers.',
    '  → Apply the FOREIGN INVOICE OVERRIDES section instead of rules 3–4.',
    '  → Rules 5–9 still apply with the label adaptations noted in the overrides.',
    '',
    '===========================',
    'GENERAL EXTRACTION RULES',
    '===========================',
    '0. Treat each page independently. Do not mix data from different pages.',
    '1. Extract ONLY data from the actual invoice content. Ignore:',
    '   - phone numbers',
    '   - website URLs',
    '   - footer disclaimers',
    '   - repeated totals from intermediate sections',
    '',
    '2. Multi-page logic:',
    '   - Supplier information ALWAYS appears on page 1.',
    '   - Financial totals (Net, VAT, Payable) ALWAYS appear on the LAST page.',
    '   - Do NOT mix totals from earlier pages.',
    "   - If multiple candidates appear, prefer the last page's values.",
    '',
    '3. Supplier (ΠΡΟΜΗΘΕΥΤΗΣ):',
    '   - The supplier is the ISSUING company shown in the document header (top area of page 1).',
    '   - Supplier info typically appears BEFORE any "ΣΤΟΙΧΕΙΑ ΠΕΛΑΤΗ" or "ΣΤΟΙΧΕΙΑ ΑΠΟΣΤΟΛΗΣ" sections.',
    '   - The supplier block contains: company name/logo, address, phone, ΑΦΜ, ΔΟΥ.',
    '   - CRITICAL: The supplier name MUST have its own ΑΦΜ (9-digit tax number) directly associated with it.',
    '   - NEVER confuse supplier with customer. The customer appears AFTER sections like:',
    '     "ΣΤΟΙΧΕΙΑ ΠΕΛΑΤΗ", "ΕΠΩΝΥΜΙΑ ΠΕΛΑΤΗ", "ΠΕΛΑΤΗΣ", "ΑΠΟΔΕΚΤΗΣ", "ΠΑΡΑΛΗΠΤΗΣ".',
    '   - CRITICAL EXCLUSION - ERP/SOFTWARE BRANDING:',
    '     * Greek invoices often show branding from the ERP/invoicing software used to generate them.',
    '     * These are NOT the supplier. IGNORE any name that appears with a website URL (e.g., https://...).',
    '     * Common ERP/software companies to EXCLUDE as suppliers:',
    '       - Epsilon Net, Epsilon Digital, epsilondigital.gr',
    '       - SoftOne, Soft1, Galaxy',
    '       - Entersoft, Singular Logic, Atlantis',
    '       - Papirus, E-invoicing, myDATA',
    '       - Any name appearing at the bottom of the page near a QR code or URL',
    '     * The REAL supplier has an ΑΦΜ, ΔΟΥ, physical address - not just a website.',
    '   - If no name is clearly in the header with associated ΑΦΜ, return null.',
    '',
    '4. Supplier TAX ID (ΑΦΜ ΠΡΟΜΗΘΕΥΤΗ):',
    '   - The supplier ΑΦΜ is the 9-digit number in the document HEADER BLOCK (top of page).',
    '   - It appears near/below the supplier company name, often with ΔΟΥ nearby.',
    '   - CRITICAL EXCLUSION RULE:',
    '     * Scan the OCR text for keywords: "ΣΤΟΙΧΕΙΑ ΠΕΛΑΤΗ", "ΣΤΟΙΧΕΙΑ ΑΠΟΣΤΟΛΗΣ", "ΕΠΩΝΥΜΙΑ ΠΕΛΑΤΗ", "ΠΕΛΑΤΗΣ".',
    '     * Any ΑΦΜ appearing AFTER these keywords is the CUSTOMER ΑΦΜ - do NOT use it.',
    '     * Only use an ΑΦΜ that appears BEFORE any customer section.',
    '   - If there more than 1 ΑΦΜ or Α.Φ.Μ. values, the FIRST one (reading top-to-bottom) is almost always the supplier.',
    '   - Supplier ΑΦΜ must be exactly 9 digits.',
    '',
    '5. Invoice Number (ΑΡΙΘΜΟΣ ΤΙΜΟΛΟΓΙΟΥ):',
    '   - Look for a table/row with columns: ΣΕΙΡΑ | ΑΡΙΘΜΟΣ | ΗΜΕΡΟΜΗΝΙΑ (or similar).',
    '   - The invoice number is the value under the "ΑΡΙΘΜΟΣ" column header.',
    '   - CRITICAL EXCLUSION RULE:',
    '     * NEVER use numbers from rows labeled "Σχετικά Παραστατικά", "Παραστατικά", or "Αριθ. Παραστ.".',
    '     * These are reference/related document numbers, NOT the main invoice number.',
    '   - The invoice number often has 5-7 digits (e.g., 090748) and may include a series prefix.',
    '   - Accept typical suffixes: ΤΔΑ, Τ-ΔΑ, ΤΙΜ, ΤΙΜΟΛ, INV, ΤΠΥ, etc.',
    '   - Remove spaces and non-alphanumeric garbage.',
    '',
    '6. Date (ΗΜΕΡΟΜΗΝΙΑ):',
    '   - Must match dd/mm/yyyy or dd-mm-yyyy or yyyy-mm-dd.',
    '   - If multiple dates appear, choose the one closest to the invoice header.',
    '',
    '7. Payable Amount (ΠΛΗΡΩΤΕΟ):',
    '   - Labeled "ΠΛΗΡΩΤΕΟ", "ΤΕΛΙΚΟ", "ΣΥΝΟΛΟ", "ΣΥΝΟΛΙΚΟ".',
    '   - Select the highest valid amount among final totals.',
    '',
    '8. VAT Amount (ΦΠΑ):',
    '   - Labeled "ΦΠΑ", "Φ.Π.Α.", or shows VAT percentage.',
    '   - Select the final VAT amount (last page).',
    '   - Must not include the percentage symbol.',
    '',
    '9. Net Amount (ΚΑΘΑΡΗ ΑΞΙΑ):',
    '   - Labeled "ΚΑΘΑΡΗ ΑΞΙΑ" or "ΣΥΝΟΛΟ ΧΩΡΙΣ ΦΠΑ" or "ΚΑΘΑΡΗ".',
    '   - Extract ONLY the final net amount (last page).',
    '   - The CORRECT final net amount is the one that appears closest to the final payable amount.',
    '   - If ΚΑΘΑΡΗ ΑΞΙΑ is not clearly labeled or is ambiguous, derive it as: ΠΛΗΡΩΤΕΟ − ΦΠΑ.',
    '',
    '10. Amount formats:',
    '    - Always return dot-decimal (1234.56).',
    '    - Never include € symbols.',
    '',
    '11. If a field is uncertain or missing, set it to null.',
    '',
    '===========================',
    'ACCURACY FIELD ("ΑΚΡΙΒΕΙΑ")',
    '===========================',
    'Return a value 0–100 representing confidence:',
    '- 100 = all fields clearly present and correctly mapped',
    '- 60–90 = some ambiguities',
    '- < 60 = large uncertainty',
    '',
    '===========================',
    'FOREIGN INVOICE OVERRIDES',
    '===========================',
    'Apply ONLY when Step 0 classifies the invoice as FOREIGN.',
    '',
    'F1. Supplier (ΠΡΟΜΗΘΕΥΤΗΣ):',
    '   - The supplier is the ISSUING company, typically in the "FROM" section or the header logo/brand at the top.',
    '   - "BILL TO", "SOLD TO", and "SHIP TO" sections contain the CUSTOMER — never the supplier.',
    '   - The supplier name is the company name in the FROM block (e.g., "MINDBODY, Inc.").',
    '',
    'F2. Supplier VAT Number/TAX ID (ΑΦΜ ΠΡΟΜΗΘΕΥΤΗ):',
    '   - Foreign suppliers do not have a Greek ΑΦΜ (9-digit numeric).',
    '   - Look for a VAT number instead (e.g., "VAT number", "VAT ID", "Tax ID", "VAT Reg No").',
    '   - Foreign VAT numbers are ALPHANUMERIC with a country prefix (e.g., IE3668997OH, DE123456789).',
    '   - If a VAT number is found, return it as-is in ΑΦΜ ΠΡΟΜΗΘΕΥΤΗ.',
    '   - If no VAT number is available, return null.',
    '',
    'F3. Invoice Number:',
    '   - Look for "Invoice number", "Invoice #", "Invoice No.", "Inv No" near the top of page 1.',
    '',
    'F4. Date:',
    '   - May appear as dd-MMM-yyyy (e.g., 05-Jan-2026), mm/dd/yyyy, or other formats.',
    '   - Always output as dd/mm/yyyy.',
    '',
    'F5. Financial amounts:',
    '   - Net Amount: labeled "Subtotal", "Net Total", or "Sub-total".',
    '   - VAT/Tax: labeled "Tax", "VAT", or "Sales Tax".',
    '   - Payable: labeled "Total", "Invoice Total", "Amount Due", or "Total Due".',
    '   - If "Amount Paid" equals the total and "Balance Due" is 0, the payable is the "Invoice Total" or "Amount Paid".',
    '',
    '===========================',
    'RETAIL RECEIPT OVERRIDES',
    '===========================',
    'Apply ONLY when Step 0 classifies the document as a GREEK RETAIL RECEIPT.',
    'These rules REPLACE rules 3–9 entirely.',
    '',
    'R1. Supplier (ΠΡΟΜΗΘΕΥΤΗΣ):',
    '   - The store/company name appears at the TOP of the receipt, often in bold or stylized text.',
    '   - OCR on thermal receipts is noisy — cross-reference the name with the ΑΦΜ line and address nearby.',
    '   - Greek legal suffixes (ΟΕ, ΕΕ, ΕΠΕ, ΑΕ, ΙΚΕ, ΜΟΝΟΠΡΟΣΩΠΗ) confirm you found the real name.',
    '   - If the name looks garbled, prefer the reading that forms a plausible Greek surname or business name.',
    '',
    'R2. Supplier TAX ID (ΑΦΜ ΠΡΟΜΗΘΕΥΤΗ):',
    '   - 9-digit number near the top, on or near a line containing "ΑΦΜ".',
    '   - Retail receipts have only ONE ΑΦΜ (the store) — there is no customer ΑΦΜ.',
    '',
    'R3. Receipt Number → ΑΡΙΘΜΟΣ ΤΙΜΟΛΟΓΙΟΥ:',
    '   - The sequential number printed on the same line as "ΑΠΟΔΕΙΞΗ ΛΙΑΝΙΚΗΣ ΠΩΛΗΣΗΣ" or labeled "ΑΡ.", "Α/Α".',
    '   - Return it in the ΑΡΙΘΜΟΣ ΤΙΜΟΛΟΓΙΟΥ field.',
    '',
    'R4. Date (ΗΜΕΡΟΜΗΝΙΑ):',
    '   - Printed just below the receipt header, format dd/mm/yyyy or d/m/yyyy.',
    '',
    'R5. Financial amounts:',
    '   - Payable (ΠΛΗΡΩΤΕΟ): the monetary value next to "ΣΥΝΟΛΟ" (NOT "ΣΥΝΟΛΟ ΓΡΑΜΜΩΝ" or "ΣΥΝΟΛΟ ΤΕΜΑΧΙΩΝ", which are item counts).',
    '     Cross-check with the payment line: "ΜΕΤΡΗΤΑ" (cash), "ΚΑΡΤΑ" (card), or "ΠΛΗΡΩΜΗ" — the payment amount confirms the total.',
    '   - Net Amount (ΚΑΘΑΡΗ ΑΞΙΑ): if explicitly labeled, use that value.',
    '     Otherwise back-calculate: netAmount = totalAmount / (1 + vatRate).',
    '     Use the VAT rate shown on item lines (e.g., 13%, 24%). Round to 2 decimals.',
    '   - VAT (ΦΠΑ): if explicitly labeled, use that value.',
    '     Otherwise back-calculate: vat = totalAmount - netAmount. Round to 2 decimals.',
    '   - If multiple VAT rates exist on different items, sum the back-calculated VAT per rate group.',
    '',
    'R6. CRITICAL — "ΣΥΝΟΛΟ" disambiguation:',
    '   - "ΣΥΝΟΛΟ ΓΡΑΜΜΩΝ" or "ΣΥΝΟΛΟ ΤΕΜΑΧΙΩΝ" = item/line COUNT → IGNORE.',
    '   - "ΣΥΝΟΛΟ" followed by a monetary value (with decimals, e.g. 5.20) = the actual TOTAL → USE THIS.',
    '',
    '===========================',
    'REASONING',
    '===========================',
    'Think step-by-step INTERNALLY.',
    'Do NOT include reasoning in the output.',
    'Output ONLY the final JSON.',
  ].join('\n');

  const extractionPrompt =
    'Παρακάτω σου δίνω ΟΛΟ το κείμενο ενός τιμολογίου ή απόδειξης λιανικής (πιθανόν πολυσέλιδου) όπως προέκυψε από OCR.\n\n' +
    'Εντόπισε και επέστρεψε τα παρακάτω πεδία αυστηρά σε JSON, σύμφωνα με το schema:\n\n' +
    REQUIRED_FIELDS.map((field, idx) => `${idx + 1}. ${field}`).join('\n') +
    '\n\n⚠️ ΚΡΙΣΙΜΟΙ ΚΑΝΟΝΕΣ:\n' +
    '- ΑΦΜ ΠΡΟΜΗΘΕΥΤΗ: Χρησιμοποίησε ΜΟΝΟ το ΑΦΜ που εμφανίζεται ΠΡΙΝ από οποιοδήποτε "ΣΤΟΙΧΕΙΑ ΠΕΛΑΤΗ" ΚΑΙ ΣΤΟΙΧΕΙΑ ΑΠΟΣΤΟΛΗΣ.\n' +
    'Αν υπάρχουν πανω απο 1 ΑΦΜ, το ΠΡΩΤΟ (από πάνω προς τα κάτω) είναι του προμηθευτή.\n' +
    '- ΑΡΙΘΜΟΣ ΤΙΜΟΛΟΓΙΟΥ: Χρησιμοποίησε τον αριθμό από τη στήλη "ΑΡΙΘΜΟΣ" (συνήθως δίπλα σε ΣΕΙΡΑ/ΗΜΕΡΟΜΗΝΙΑ). ' +
    'ΠΟΤΕ μην χρησιμοποιήσεις αριθμούς από "Σχετικά Παραστατικά" - αυτοί είναι αριθμοί αναφοράς.\n' +
    '\nΘυμήσου:\n' +
    '- Ο προμηθευτής βρίσκεται μόνο στην πρώτη σελίδα, στην κορυφή της σελίδας.\n' +
    '- ΠΡΟΣΟΧΗ: Αγνόησε ονόματα εταιρειών ERP/λογισμικού (π.χ. Epsilon Net, SoftOne, Galaxy, Entersoft) - αυτές ΔΕΝ είναι ο προμηθευτής.\n' +
    '- Ο ΠΡΑΓΜΑΤΙΚΟΣ προμηθευτής έχει δικό του ΑΦΜ, ΔΟΥ και διεύθυνση - όχι απλώς URL ιστοσελίδας.\n' +
    '- Αν το τιμολόγιο είναι ξενόγλωσσο (π.χ. αγγλικά), αναγνώρισε τον προμηθευτή από το "FROM" section. Για ΑΦΜ, ψάξε για VAT number (αλφαριθμητικό, π.χ. IE3668997OH) — αν δεν υπάρχει, βάλε null.\n' +
    '- Αν είναι ΑΠΟΔΕΙΞΗ ΛΙΑΝΙΚΗΣ: το "ΣΥΝΟΛΟ" (με χρηματικό ποσό) είναι το ΠΛΗΡΩΤΕΟ. Αγνόησε "ΣΥΝΟΛΟ ΓΡΑΜΜΩΝ" (αριθμός ειδών). Υπολόγισε ΚΑΘΑΡΗ ΑΞΙΑ και ΦΠΑ αν δεν εμφανίζονται ρητά.\n' +
    '- Τα οικονομικά σύνολα βρίσκονται μόνο στην τελευταία σελίδα.\n' +
    '- Αν κάποιο πεδίο δεν είναι βέβαιο, βάλε null.\n' +
    '- Χρησιμοποίησε δεκαδικό με τελεία.\n\n' +
    'Ακολουθεί το κείμενο του τιμολογίου:\n\n' +
    fullText;

  const response = await client.responses.create({
    model: 'gpt-4o-mini',
    input: [
      {
        role: 'system',
        content: [{ type: 'input_text', text: systemPrompt }],
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: extractionPrompt }],
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'invoice_ocr_format',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ΗΜΕΡΟΜΗΝΙΑ: { type: ['string', 'null'] },
            'ΑΡΙΘΜΟΣ ΤΙΜΟΛΟΓΙΟΥ': { type: ['string', 'null'] },
            'ΑΦΜ ΠΡΟΜΗΘΕΥΤΗ': { type: ['string', 'null'] },
            ΠΡΟΜΗΘΕΥΤΗΣ: { type: ['string', 'null'] },
            'ΚΑΘΑΡΗ ΑΞΙΑ': { type: ['string', 'null'] },
            ΦΠΑ: { type: ['string', 'null'] },
            ΠΛΗΡΩΤΕΟ: { type: ['string', 'null'] },
            ΑΚΡΙΒΕΙΑ: { type: ['string', 'null'] },
          },
          required: REQUIRED_FIELDS,
        },
        strict: true,
      },
    },
    max_output_tokens: 800,
  });

  const rawText = collectResponseText(response);
  return parseJsonFromResponse(rawText);
}

export {
  REQUIRED_FIELDS,
  FIELD_LABELS,
  METADATA_ERROR_MESSAGE,
  METADATA_SUCCESS_MESSAGE,
  formatMetadataError,
  formatMetadataSuccess,
  getOpenAIClient,
  OCR_MAX_RETRIES,
  collectResponseText,
  parseJsonFromResponse,
  normalizeEuropeanDecimals,
  parseAmount,
  parseDate,
  runInvoiceOcr,
  runInvoiceOcrAttempt,
};
