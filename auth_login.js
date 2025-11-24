#!/usr/bin/env node

import process from "process";
import { createInterface } from "readline/promises";

function getSignInEndpoint(apiKey) {
  const emulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (emulatorHost) {
    const [host, port = "9099"] = emulatorHost.split(":");
    return {
      url: `http://${host}:${port}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
      headers: {
        // Firebase emulators expect this header to route the request correctly.
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

async function promptForCredentials() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });

  try {
    const email =
      process.env.FIREBASE_AUTH_EMAIL || (await rl.question("Email: "));

    let password = process.env.FIREBASE_AUTH_PASSWORD;
    if (!password) {
      // readline doesn't support hidden input natively; instruct user
      password = await rl.question(
        "Password (input hidden by terminal tools, otherwise paste safely): ",
        { hideEchoBack: true }
      );
    }

    return { email: email.trim(), password: password.trim() };
  } finally {
    rl.close();
  }
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
    const errorPayload = await response.json().catch(() => ({}));
    const message =
      errorPayload?.error?.message ??
      `Firebase Auth sign-in failed with status ${response.status}`;
    throw new Error(message);
  }

  return response.json();
}

async function main() {
  const apiKey = process.env.FIREBASE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing FIREBASE_API_KEY. Set it to your Firebase Web API key before running this script."
    );
  }

  const { email, password } = await promptForCredentials();
  if (!email || !password) {
    throw new Error("Email and password are required.");
  }

  console.log("🔐 Signing in with Firebase Authentication...");
  const result = await signInWithEmailPassword(apiKey, email, password);

  const { idToken, refreshToken, expiresIn, localId } = result;

  console.log("\n✅ Sign-in successful!");
  console.log("User ID:", localId);
  console.log("ID Token (use this as Bearer token when calling secured endpoints):");
  console.log(idToken);
  console.log("\nRefresh Token (store securely if you need long-lived sessions):");
  console.log(refreshToken);
  console.log(`\nToken Expires In: ${expiresIn} seconds`);
}

main().catch((error) => {
  console.error("Failed to sign in:", error.message);
  process.exitCode = 1;
});

