import { describe, it, expect } from 'vitest';
import { getVisionClient, getAthensToday, formatAthensDate } from '../lib/config.js';

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

// ═══════════════════════════════════════════════════════════════════════════════
// getAthensToday
// ═══════════════════════════════════════════════════════════════════════════════

describe('getAthensToday', () => {
  it('returns utcDate at UTC midnight and a numeric dayOfMonth', () => {
    const { utcDate, dayOfMonth } = getAthensToday();

    expect(utcDate).toBeInstanceOf(Date);
    expect(utcDate.getUTCHours()).toBe(0);
    expect(utcDate.getUTCMinutes()).toBe(0);
    expect(utcDate.getUTCSeconds()).toBe(0);
    expect(utcDate.getUTCMilliseconds()).toBe(0);

    expect(dayOfMonth).toBeGreaterThanOrEqual(1);
    expect(dayOfMonth).toBeLessThanOrEqual(31);
  });

  it('dayOfMonth matches the utcDate day component', () => {
    const { utcDate, dayOfMonth } = getAthensToday();
    expect(utcDate.getUTCDate()).toBe(dayOfMonth);
  });

  it('returns the Athens calendar date, not the server-local date', () => {
    const athensStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Athens',
    }).format(new Date());
    const expectedDay = parseInt(athensStr.split('-')[2], 10);

    const { dayOfMonth } = getAthensToday();
    expect(dayOfMonth).toBe(expectedDay);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// formatAthensDate
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatAthensDate', () => {
  it('returns a YYYY-MM-DD string', () => {
    const result = formatAthensDate(new Date('2026-06-15T12:00:00Z'));
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('formats a UTC midnight date correctly for Athens (same day)', () => {
    const result = formatAthensDate(new Date('2026-03-10T12:00:00Z'));
    expect(result).toBe('2026-03-10');
  });

  it('rolls forward for late-UTC dates that cross midnight in Athens', () => {
    // 2026-07-14 22:30 UTC = 2026-07-15 01:30 EEST (Athens, UTC+3 in summer)
    const result = formatAthensDate(new Date('2026-07-14T22:30:00Z'));
    expect(result).toBe('2026-07-15');
  });

  it('handles winter time (EET, UTC+2)', () => {
    // 2026-01-10 23:00 UTC = 2026-01-11 01:00 EET (Athens, UTC+2 in winter)
    const result = formatAthensDate(new Date('2026-01-10T23:00:00Z'));
    expect(result).toBe('2026-01-11');
  });
});
