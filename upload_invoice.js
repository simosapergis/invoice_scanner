#!/usr/bin/env node

import fs from "fs/promises";
import path from "path";
import process from "process";
import crypto from "crypto";

const DEFAULT_FOLDER = "uploads";
const REQUIRED_ENV_VARS = [
  "FIREBASE_API_KEY",
  "FIREBASE_AUTH_EMAIL",
  "FIREBASE_AUTH_PASSWORD"
];

function ensureEnv(varName) {
  const value = process.env[varName];
  if (!value) {
    throw new Error(`Missing ${varName}. Please export it before running the script.`);
  }
  return value;
}

function getFunctionUrl(cliOverride) {
  if (cliOverride) return cliOverride;
  if (process.env.SIGNED_URL_ENDPOINT) return process.env.SIGNED_URL_ENDPOINT;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const region =
    process.env.FIREBASE_FUNCTION_REGION ||
    process.env.GCLOUD_REGION ||
    "us-central1";

  if (!projectId) {
    throw new Error(
      "Missing SIGNED_URL_ENDPOINT or FIREBASE_PROJECT_ID. Provide one so the script knows where to request signed URLs."
    );
  }

  return `https://${region}-${projectId}.cloudfunctions.net/getSignedUploadUrl`;
}

function getSignInEndpoint(apiKey) {
  const emulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (emulatorHost) {
    const [host, port = "9099"] = emulatorHost.split(":");
    return {
      url: `http://${host}:${port}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
      headers: {
        "Authorization": "Bearer owner",
        "Content-Type": "application/json"
      }
    };
  }

  return {
    url: `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
    headers: {
      "Content-Type": "application/json"
    }
  };
}

async function signInWithEmailPassword(apiKey, email, password) {
  const { url, headers } = getSignInEndpoint(apiKey);
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      email,
      password,
      returnSecureToken: true
    })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const message =
      payload?.error?.message ||
      `Firebase Auth sign-in failed with status ${response.status}`;
    throw new Error(message);
  }

  return response.json();
}

function guessContentType(filePath, cliOverride) {
  if (cliOverride) return cliOverride;

  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".pdf":
      return "application/pdf";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function buildFilename(filePath, cliOverride) {
  if (cliOverride) return cliOverride;
  const ext = path.extname(filePath) || ".bin";
  return `${crypto.randomUUID()}${ext}`;
}

function parseArgs(argv) {
  const args = { folder: DEFAULT_FOLDER };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === "--folder" && argv[i + 1]) {
      args.folder = argv[++i];
    } else if (current === "--filename" && argv[i + 1]) {
      args.filename = argv[++i];
    } else if (current === "--content-type" && argv[i + 1]) {
      args.contentType = argv[++i];
    } else if (current === "--function-url" && argv[i + 1]) {
      args.functionUrl = argv[++i];
    } else if (current === "--help" || current === "-h") {
      args.help = true;
    } else if (current.startsWith("--")) {
      throw new Error(`Unknown flag ${current}`);
    } else {
      positional.push(current);
    }
  }

  if (positional.length > 1) {
    throw new Error("Provide only one file path argument.");
  }

  args.filePath = positional[0];
  return args;
}

async function requestSignedUrl(functionUrl, idToken, payload) {
  const response = await fetch(functionUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${idToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({}));
    const message =
      errorPayload?.error ||
      `Signed URL request failed with status ${response.status}`;
    throw new Error(message);
  }

  return response.json();
}

async function uploadToSignedUrl(uploadUrl, buffer, contentType) {
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": contentType
    },
    body: buffer
  });

  if (!response.ok) {
    const payload = await response.text().catch(() => "");
    throw new Error(
      `Upload failed with status ${response.status}: ${payload.slice(0, 200)}`
    );
  }
}

function printUsage() {
  console.log(`Usage: node upload_invoice.js <file-path> [options]

Options:
  --folder <name>          Destination folder prefix in Storage (default: ${DEFAULT_FOLDER})
  --filename <name>        Override the filename sent to the signing endpoint
  --content-type <type>    Explicit MIME type (auto-detected from extension otherwise)
  --function-url <url>     Override the getSignedUploadUrl endpoint
  -h, --help               Show this message

Environment variables:
  FIREBASE_API_KEY         Firebase Web API key (required)
  FIREBASE_AUTH_EMAIL      Email used for Firebase Auth (required)
  FIREBASE_AUTH_PASSWORD   Password for Firebase Auth (required)
  SIGNED_URL_ENDPOINT      (optional) Direct URL to getSignedUploadUrl
  FIREBASE_PROJECT_ID      (fallback) Used with FIREBASE_FUNCTION_REGION to derive the URL
  FIREBASE_FUNCTION_REGION (fallback, default: us-central1)
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.filePath) {
    printUsage();
    return;
  }

  for (const envName of REQUIRED_ENV_VARS) {
    ensureEnv(envName);
  }

  const absolutePath = path.resolve(process.cwd(), args.filePath);
  const fileBuffer = await fs.readFile(absolutePath);

  const contentType = guessContentType(absolutePath, args.contentType);
  const filename = buildFilename(absolutePath, args.filename);
  const folder = args.folder || DEFAULT_FOLDER;
  const functionUrl = getFunctionUrl(args.functionUrl);

  console.log("1/4 Authenticating with Firebase...");
  const { idToken, expiresIn } = await signInWithEmailPassword(
    process.env.FIREBASE_API_KEY,
    process.env.FIREBASE_AUTH_EMAIL,
    process.env.FIREBASE_AUTH_PASSWORD
  );
  console.log("   ✅ Received ID token (expires in %s seconds)", expiresIn);

  console.log("2/4 Requesting signed upload URL...");
  const signedUrlResponse = await requestSignedUrl(functionUrl, idToken, {
    filename,
    contentType,
    folder
  });
  console.log("   ✅ Signed URL created for %s", signedUrlResponse.objectName);

  console.log("3/4 Uploading file to signed URL...");
  await uploadToSignedUrl(signedUrlResponse.uploadUrl, fileBuffer, contentType);
  console.log("   ✅ Upload complete");

  console.log("4/4 Summary");
  console.log("   Bucket:      %s", signedUrlResponse.bucket);
  console.log("   Object name: %s", signedUrlResponse.objectName);
  console.log("   ContentType: %s", contentType);
  console.log("   Signed URL expires at: %s", signedUrlResponse.expiresAt);
}

main().catch((error) => {
  console.error("Upload failed:", error.message);
  process.exitCode = 1;
});


