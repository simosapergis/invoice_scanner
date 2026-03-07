import { admin } from './config.js';

function extractBearerToken(headerValue) {
  if (!headerValue) return null;
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * Validates and extracts the authenticated user from the request
 */
async function authenticateRequest(req) {
  const idToken = extractBearerToken(req.headers.authorization);
  if (!idToken) {
    return { error: 'Missing or invalid Authorization header', status: 401 };
  }
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    return { user: decodedToken };
  } catch (error) {
    console.error('Token verification failed:', error);
    return { error: 'Invalid or expired token', status: 401 };
  }
}

function getUserDisplayName(decodedToken) {
  return decodedToken.name || decodedToken.email || decodedToken.uid;
}

export { extractBearerToken, authenticateRequest, getUserDisplayName };
