#!/usr/bin/env node

import process from "process";
import express from "express";
import admin from "firebase-admin";
import { Storage } from "@google-cloud/storage";

const PORT = Number(process.env.PORT ?? 8080);
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const GCS_BUCKET = process.env.GCS_BUCKET;

if (!FIREBASE_PROJECT_ID) {
  console.error("Missing FIREBASE_PROJECT_ID environment variable.");
  process.exit(1);
}

if (!GCS_BUCKET) {
  console.error("Missing GCS_BUCKET environment variable.");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: FIREBASE_PROJECT_ID
});

const storage = new Storage();
const app = express();
app.use(express.json());

function extractBearerToken(headerValue) {
  if (!headerValue) return null;
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

app.post("/signed-url", async (req, res) => {
  try {
    const idToken = extractBearerToken(req.header("Authorization"));
    if (!idToken) {
      return res.status(401).json({ error: "Missing Authorization: Bearer <token>" });
    }

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (error) {
      return res.status(401).json({ error: "Invalid or expired Firebase ID token", details: error.message });
    }

    const { filename, contentType = "application/octet-stream", folder = "uploads" } = req.body ?? {};
    if (!filename) {
      return res.status(400).json({ error: "filename is required in the request body" });
    }

    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const objectName = `${folder}/${decoded.uid}/${Date.now()}-${sanitizedFilename}`;
    const expiresAtMs = Date.now() + 15 * 60 * 1000; // 15 minutes

    const bucket = storage.bucket(GCS_BUCKET);
    const file = bucket.file(objectName);

    const [signedUrl] = await file.getSignedUrl({
      version: "v4",
      action: "write",
      expires: expiresAtMs,
      contentType
    });

    return res.json({
      uploadUrl: signedUrl,
      bucket: GCS_BUCKET,
      objectName,
      contentType,
      expiresAt: new Date(expiresAtMs).toISOString()
    });
  } catch (error) {
    console.error("Failed to create signed URL:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Signed URL server listening on http://localhost:${PORT}`);
});


