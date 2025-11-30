#!/usr/bin/env node

import fs from "fs/promises";
import path from "path";
import process from "process";
import OpenAI from "openai";
import vision from "@google-cloud/vision";

const DEFAULT_FILE = "invoice.JPG";
const REQUIRED_FIELDS = [
  "ΗΜΕΡΟΜΗΝΙΑ",
  "ΑΡΙΘΜΟΣ ΤΙΜΟΛΟΓΙΟΥ",
  "ΠΡΟΜΗΘΕΥΤΗΣ",
  "ΣΥΝΟΛΟ ΧΩΡΙΣ ΦΠΑ",
  "ΦΠΑ",
  "ΤΕΛΙΚΟ ΠΟΣΟ"
];
const ACCURACY_FIELD = "ΑΚΡΙΒΕΙΑ";
const RESPONSE_FIELDS = [...REQUIRED_FIELDS, ACCURACY_FIELD];

function collectResponseText(response) {
  const chunks = [];

  if (Array.isArray(response?.output)) {
    for (const block of response.output) {
      if (!Array.isArray(block?.content)) continue;
      for (const part of block.content) {
        if (typeof part?.text === "string") {
          chunks.push(part.text);
        } else if (typeof part?.output_text === "string") {
          chunks.push(part.output_text);
        } else if (typeof part?.value === "string") {
          chunks.push(part.value);
        }
      }
    }
  }

  if (Array.isArray(response?.output_text)) {
    chunks.push(...response.output_text);
  }

  return chunks.join("\n").trim();
}

function parseFirstJsonChunk(text) {
  if (!text) {
    throw new Error("The model returned an empty response.");
  }

  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("Could not locate JSON in the model response.");
    }
    return JSON.parse(match[0]);
  }
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "Missing OPENAI_API_KEY. Please set the environment variable before running the script."
    );
  }

  const fileArgument = process.argv[2] ?? DEFAULT_FILE;
  const invoicePath = path.resolve(process.cwd(), fileArgument);

  try {
    await fs.access(invoicePath);
  } catch {
    throw new Error(`Δεν βρέθηκε το αρχείο τιμολογίου: ${invoicePath}`);
  }

  // 1) OCR με Google Cloud Vision (documentTextDetection)
  const visionClient = new vision.ImageAnnotatorClient();
  const [result] = await visionClient.documentTextDetection(invoicePath);
  const fullText = result.fullTextAnnotation?.text;

  if (!fullText) {
    throw new Error("Google Cloud Vision did not return any text.");
  }

  // 2) Δευτερογενής εξαγωγή πεδίων μέσω OpenAI (text‑only)
  const systemPrompt =
    "You are an expert accountant specializing in OCR for European invoices. " +
    "You will receive the raw text extracted from an invoice (which contains Greek text). " +
    "Using ONLY this text, extract the requested fields. " +
    "Respond strictly in JSON that matches the provided schema. " +
    "If a value is missing, return null. Amounts must use dot-decimal notation (e.g. 1234.56) and omit currency symbols.";

  const extractionPrompt =
    "Παρακάτω σου δίνω ΟΛΟ το κείμενο ενός τιμολογίου όπως προέκυψε από OCR. " +
    "Παρακαλώ εντόπισε και επέστρεψε τα παρακάτω πεδία στα ελληνικά. " +
    "Επιπλέον, πρόσθεσε και ένα πεδίο «ΑΚΡΙΒΕΙΑ» με ποσοστιαία εκτίμηση (0-100%) " +
    "για το πόσο βέβαιος είσαι ότι όλα τα υπόλοιπα δεδομένα είναι σωστά:\n" +
    RESPONSE_FIELDS.map((field, index) => `${index + 1}. ${field}`).join("\n") +
    "\n\nΑκολουθεί το κείμενο του τιμολογίου:\n\n" +
    fullText;

  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });

  const response = await client.responses.create({
    model: "gpt-4o-mini",
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: systemPrompt
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: extractionPrompt
          }
        ]
      }
    ],
    max_output_tokens: 800
  });

  const rawText = collectResponseText(response);
  const extracted = parseFirstJsonChunk(rawText);

  console.log("📄  OCR (Vision + GPT) αποτέλεσμα:");
  for (const field of REQUIRED_FIELDS) {
    const value = extracted[field];
    console.log(`- ${field}: ${value ?? "—"}`);
  }

  if (ACCURACY_FIELD in extracted) {
    const accuracyValue = extracted[ACCURACY_FIELD];
    console.log(`- ${ACCURACY_FIELD}: ${accuracyValue ?? "—"}`);
  }
}

main().catch((error) => {
  console.error("Failed to run invoice_ocr_2:", error.message);
  process.exitCode = 1;
});


