import { describe, it, expect } from 'vitest';
import { getVisionClient } from '../lib/config.js';

// ═══════════════════════════════════════════════════════════════════════════════
// getVisionClient
// ═══════════════════════════════════════════════════════════════════════════════

describe('getVisionClient', () => {
  it('returns a Vision ImageAnnotatorClient instance', () => {
    const client = getVisionClient();
    expect(client).toBeDefined();
    expect(typeof client.documentTextDetection).toBe('function');
  });

  it('returns the same instance on repeated calls (singleton)', () => {
    const a = getVisionClient();
    const b = getVisionClient();
    expect(a).toBe(b);
  });
});
