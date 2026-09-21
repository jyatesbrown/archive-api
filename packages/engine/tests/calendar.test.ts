import { describe, expect, it } from 'vitest';

import { addDays, dateOf, daysBetween, isIsoDate } from '../src/calendar.js';

describe('isIsoDate', () => {
  it.each(['2025-01-01', '2024-02-29', '1999-12-31', '2025-06-30'])('accepts %s', (d) => {
    expect(isIsoDate(d)).toBe(true);
  });
  it.each([
    '2025-02-29',
    '2025-13-01',
    '2025-00-10',
    '2025-04-31',
    '2025-1-1',
    '20250101',
    '2025-01-01T00:00:00Z',
    '',
    'yesterday',
    '2025-01-01 ',
  ])('rejects %j', (d) => {
    expect(isIsoDate(d)).toBe(false);
  });
});

describe('arithmetic', () => {
  it('addDays crosses month and year boundaries', () => {
    expect(addDays('2025-01-31', 1)).toBe('2025-02-01');
    expect(addDays('2024-12-31', 1)).toBe('2025-01-01');
    expect(addDays('2025-01-01', -1)).toBe('2024-12-31');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
  });
  it('daysBetween is signed', () => {
    expect(daysBetween('2025-01-01', '2025-01-31')).toBe(30);
    expect(daysBetween('2025-01-31', '2025-01-01')).toBe(-30);
    expect(daysBetween('2025-01-01', '2025-01-01')).toBe(0);
  });
  it('dateOf takes the calendar day of a harness timestamp', () => {
    expect(dateOf('2025-03-08T06:15:00.123456Z')).toBe('2025-03-08');
  });
});
