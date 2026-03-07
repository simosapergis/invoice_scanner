import { REGION, SERVICE_ACCOUNT_EMAIL } from './config.js';

const HTTP_OPTS = {
  region: REGION,
  serviceAccount: SERVICE_ACCOUNT_EMAIL,
  cors: true,
  invoker: 'public',
  timeoutSeconds: 60,
  memory: '256MiB',
};

/**
 * Returns false (and sends 405) if the request method doesn't match.
 * Callers should `return` when the result is false.
 */
function requireMethod(req, res, method) {
  if (req.method !== method) {
    res.status(405).json({ error: `Method not allowed. Use ${method}.` });
    return false;
  }
  return true;
}

/**
 * Sends a standardized JSON error response.
 */
function sendError(res, status, message, { details, code } = {}) {
  const body = { error: message };
  if (details) body.details = details;
  if (code) body.code = code;
  return res.status(status).json(body);
}

export { HTTP_OPTS, requireMethod, sendError };
