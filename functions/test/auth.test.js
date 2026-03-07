import { describe, it, expect } from 'vitest';
import { extractBearerToken, getUserDisplayName } from '../lib/auth.js';

// ═══════════════════════════════════════════════════════════════════════════════
// extractBearerToken
// ═══════════════════════════════════════════════════════════════════════════════

describe('extractBearerToken', () => {
  it('extracts token from valid Bearer header', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
  });

  it('is case-insensitive for Bearer prefix', () => {
    expect(extractBearerToken('bearer xyz')).toBe('xyz');
    expect(extractBearerToken('BEARER xyz')).toBe('xyz');
  });

  it('returns null for missing header', () => {
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractBearerToken('')).toBeNull();
  });

  it('returns null for non-Bearer scheme', () => {
    expect(extractBearerToken('Basic abc123')).toBeNull();
  });

  it('returns null for Bearer without token', () => {
    expect(extractBearerToken('Bearer ')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getUserDisplayName
// ═══════════════════════════════════════════════════════════════════════════════

describe('getUserDisplayName', () => {
  it('returns name when present', () => {
    expect(getUserDisplayName({ name: 'Simos', email: 'simos@test.com', uid: 'abc123' })).toBe('Simos');
  });

  it('falls back to email when name is missing', () => {
    expect(getUserDisplayName({ email: 'simos@test.com', uid: 'abc123' })).toBe('simos@test.com');
  });

  it('falls back to uid when name and email are missing', () => {
    expect(getUserDisplayName({ uid: 'abc123' })).toBe('abc123');
  });

  it('prefers name over email', () => {
    expect(getUserDisplayName({ name: 'Simos', email: 'simos@test.com' })).toBe('Simos');
  });

  it('skips empty string name and falls back to email', () => {
    expect(getUserDisplayName({ name: '', email: 'simos@test.com', uid: 'abc123' })).toBe('simos@test.com');
  });

  it('skips empty string email and falls back to uid', () => {
    expect(getUserDisplayName({ name: '', email: '', uid: 'abc123' })).toBe('abc123');
  });
});
