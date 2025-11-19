#!/usr/bin/env node

import fs from "fs/promises";
import path from "path";
import process from "process";
import OpenAI from "openai";

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

const MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".pdf": "application/pdf"
};

function detectMime(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

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
  const mimeType = detectMime(invoicePath);

  try {
    await fs.access(invoicePath);
  } catch {
    throw new Error(`Δεν βρέθηκε το αρχείο τιμολογίου: ${invoicePath}`);
  }

  const fileBuffer = await fs.readFile(invoicePath);
  const fileBase64 = fileBuffer.toString("base64");

  const systemPrompt =
    "You are an expert accountant specializing in OCR for European invoices. " +
    "Read the provided invoice (which may contain Greek text) and extract the requested fields. " +
    "Respond strictly in JSON that matches the provided schema. " +
    "If a value is missing, return null. Amounts must use dot-decimal notation (e.g. 1234.56) and omit currency symbols.";

const extractionPrompt =
  "Παρακαλώ κάνε OCR στο συνημμένο τιμολόγιο και επέστρεψε τα παρακάτω πεδία στα ελληνικά. " +
  "Εκτός από τα αριθμητικά/κειμενικά πεδία, πρόσθεσε και ένα πεδίο «ΑΚΡΙΒΕΙΑ» με ποσοστιαία εκτίμηση (0-100%) " +
  "για το πόσο βέβαιος είσαι ότι όλα τα υπόλοιπα δεδομένα είναι σωστά:\n" +
  RESPONSE_FIELDS.map((field, index) => `${index + 1}. ${field}`).join("\n");

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
          },
          {
            type: "input_image",
            image_url: `data:${mimeType};base64,${fileBase64}`
          }
        ]
      }
    ],
    // response_format: {
    //   type: "json_schema",
    //   json_schema: {
    //     name: "greek_invoice_ocr",
    //     schema: {
    //       type: "object",
    //       additionalProperties: false,
    //       properties: {
    //         "ΗΜΕΡΟΜΗΝΙΑ": { type: ["string", "null"], description: "Ημερομηνία με ISO 8601 (YYYY-MM-DD)." },
    //         "ΑΡΙΘΜΟΣ ΤΙΜΟΛΟΓΙΟΥ": { type: ["string", "null"], description: "Σειρά ή αριθμός τιμολογίου όπως εμφανίζεται στο έγγραφο." },
    //         "ΠΡΟΜΗΘΕΥΤΗΣ": { type: ["string", "null"], description: "Επωνυμία ή επωνυμίες όλων των προμηθευτών." },
    //         "ΣΥΝΟΛΟ ΧΩΡΙΣ ΦΠΑ": { type: ["string", "null"], description: "Καθαρή αξία χωρίς ΦΠΑ σε ευρώ με δεκαδικά." },
    //         "ΦΠΑ": { type: ["string", "null"], description: "Ποσό ΦΠΑ σε ευρώ." },
    //         "ΤΕΛΙΚΟ ΠΟΣΟ": { type: ["string", "null"], description: "Αξία πληρωτέου ποσού σε ευρώ." }
    //       },
    //       required: REQUIRED_FIELDS
    //     },
    //     strict: true
    //   }
    // },
    max_output_tokens: 800
  });

  const rawText = collectResponseText(response);
  const extracted = parseFirstJsonChunk(rawText);

  console.log("📄  OCR αποτέλεσμα:");
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
  console.error("Failed to run invoice OCR:", error.message);
  process.exitCode = 1;
});

