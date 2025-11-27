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

export function extractBearerToken(headerValue) {
  if (!headerValue) return null;
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

export async function createSignedUploadUrl(options) {
  const {
    adminInstance,
    storageInstance,
    bucketName,
    idToken,
    filename,
    contentType = "application/octet-stream",
    folder = "uploads"
  } = options;

  if (!idToken) {
    return {
      status: 401,
      payload: { error: "Missing Authorization: Bearer <token>" }
    };
  }

  if (!filename) {
    return {
      status: 400,
      payload: { error: "filename is required in the request body" }
    };
  }

  let decoded;
  try {
    decoded = await adminInstance.auth().verifyIdToken(idToken);
  } catch (error) {
    return {
      status: 401,
      payload: {
        error: "Invalid or expired Firebase ID token",
        details: error.message
      }
    };
  }

  const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const objectName = `${folder}/${decoded.uid}/${Date.now()}-${sanitizedFilename}`;
  const expiresAtMs = Date.now() + 15 * 60 * 1000; // 15 minutes

  const bucket = storageInstance.bucket(bucketName);
  const file = bucket.file(objectName);

  const [signedUrl] = await file.getSignedUrl({
    version: "v4",
    action: "write",
    expires: expiresAtMs,
    contentType
  });

  return {
    status: 200,
    payload: {
      uploadUrl: signedUrl,
      bucket: bucketName,
      objectName,
      contentType,
      expiresAt: new Date(expiresAtMs).toISOString()
    }
  };
}

app.post("/signed-url", async (req, res) => {
  try {
    const idToken = extractBearerToken(req.header("Authorization"));
    const result = await createSignedUploadUrl({
      adminInstance: admin,
      storageInstance: storage,
      bucketName: GCS_BUCKET,
      idToken,
      filename: req.body?.filename,
      contentType: req.body?.contentType,
      folder: req.body?.folder
    });

    return res.status(result.status).json(result.payload);
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



