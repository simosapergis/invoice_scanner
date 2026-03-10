import { PDFDocument } from 'pdf-lib';
import { storage } from './config.js';

async function convertBufferToPdf(buffer, mimeType = 'image/jpeg') {
  if (mimeType === 'application/pdf') {
    return buffer;
  }

  const pdfDoc = await PDFDocument.create();
  let embeddedImage;

  if (mimeType === 'image/png') {
    embeddedImage = await pdfDoc.embedPng(buffer);
  } else {
    // pdf-lib supports JPEG/JPG via embedJpg; fall back to it for other bitmap formats
    embeddedImage = await pdfDoc.embedJpg(buffer);
  }

  const { width, height } = embeddedImage;
  const page = pdfDoc.addPage([width, height]);
  page.drawImage(embeddedImage, { x: 0, y: 0, width, height });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

async function buildCombinedPdfFromPages(pageEntries, defaultBucket) {
  if (!Array.isArray(pageEntries) || pageEntries.length === 0) {
    throw new Error('No invoice pages were provided for OCR.');
  }

  const combinedPdf = await PDFDocument.create();
  const downloadedPages = [];

  for (const entry of pageEntries) {
    const bucketName = entry.bucket || defaultBucket;
    if (!bucketName) {
      throw new Error(`Missing bucket configuration for page ${entry.pageNumber}`);
    }

    if (!entry.objectName) {
      throw new Error(`Missing object name for page ${entry.pageNumber}`);
    }

    const [buffer] = await storage.bucket(bucketName).file(entry.objectName).download();
    const mimeType = entry.contentType || 'application/octet-stream';
    downloadedPages.push({
      pageNumber: entry.pageNumber,
      buffer,
      mimeType,
      objectName: entry.objectName,
      bucketName,
    });

    if (mimeType === 'application/pdf') {
      const pdfDoc = await PDFDocument.load(buffer);
      const pageIndices = Array.from({ length: pdfDoc.getPageCount() }, (_, index) => index);
      const copiedPages = await combinedPdf.copyPages(pdfDoc, pageIndices);
      copiedPages.forEach((page) => combinedPdf.addPage(page));
      continue;
    }

    const singlePagePdfBuffer = await convertBufferToPdf(buffer, mimeType);
    const singlePageDoc = await PDFDocument.load(singlePagePdfBuffer);
    const [copiedPage] = await combinedPdf.copyPages(singlePageDoc, [0]);
    combinedPdf.addPage(copiedPage);
  }

  const combinedBuffer = await combinedPdf.save();
  return {
    combinedPdfBuffer: Buffer.from(combinedBuffer),
    downloadedPages,
  };
}

export { convertBufferToPdf, buildCombinedPdfFromPages };
