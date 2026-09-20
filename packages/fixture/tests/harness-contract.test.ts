import { describe, expect, it } from 'vitest';

import {
  addDays,
  composeKey,
  daysBetween,
  fingerprintText,
  isOutsideWindow,
  payloadLocator,
  pyJsonDumps,
  pyReprStr,
  recordKey,
  validateCount,
  valueHash,
  type JsonRecord,
} from '../src/harness-contract.js';

// Vectors produced by running archive-harness (GenericJsonAdapter) on the same
// records in Python; see PR description for the script.
const CFG = { key_fields: ['id'], records_path: 'records', ignore_fields: ['internal_note'], key_date_field: 'created' };

const R1: JsonRecord = {
  id: 'R1',
  created: '2025-01-01',
  name: 'Alpha "q" \\ é',
  amount: 42,
  flag: true,
  none: null,
  nested: { b: [1, 2, { c: 'd' }], a: 'z' },
  internal_note: 'x',
};
const R2: JsonRecord = {
  id: 'R2',
  created: '2025-02-03',
  name: "it's",
  amount: -7,
  flag: false,
  list: [],
  obj: {},
  internal_note: 'y',
};

describe('value_hash parity with harness.adapter.value_hash', () => {
  it('matches Python for nested/quoted/unicode values', () => {
    expect(valueHash(R1, CFG.key_fields, CFG.ignore_fields)).toBe(
      '59291e425f5b0e7b063db107d07b685147f7728eb83f6e3c95eb95fd67fcc4cd',
    );
  });
  it('matches Python for booleans, negatives and empty containers', () => {
    expect(valueHash(R2, CFG.key_fields, CFG.ignore_fields)).toBe(
      '666987308f6b924a41fc365b5e304ac5a2a23f3fae9a2f9ccd5225606293df7f',
    );
  });
  it('ignores ignore_fields (silent-field semantics)', () => {
    const a = valueHash(R1, CFG.key_fields, CFG.ignore_fields);
    const b = valueHash({ ...R1, internal_note: 'changed' }, CFG.key_fields, CFG.ignore_fields);
    expect(a).toBe(b);
    expect(valueHash({ ...R1, name: 'changed' }, CFG.key_fields, CFG.ignore_fields)).not.toBe(a);
  });
  it('rejects non-integer numbers whose repr may diverge from Python', () => {
    expect(() => valueHash({ id: 'x', v: 0.1 }, ['id'], [])).toThrow();
  });
});

describe('record keys', () => {
  it('composes with KEY_SEP and prefixes the date part', () => {
    expect(composeKey(['2025-01-01', 'R1'])).toBe('2025-01-01|R1');
    expect(recordKey(R1, CFG.key_fields, CFG.key_date_field)).toBe('2025-01-01|R1');
    expect(recordKey(R1, CFG.key_fields, null)).toBe('R1');
  });
});

describe('fingerprint parity', () => {
  it('matches the harness as_text() output', () => {
    expect(fingerprintText(2, Object.keys({ ...R1, ...R2 }), CFG)).toBe(
      '{"count":2,"fields":["amount","created","flag","id","internal_note","list","name","nested","none","obj"],"selectors":["json:records","key:date(created),id","pages:none"]}',
    );
  });
});

describe('python repr / json.dumps emulation', () => {
  it('uses single quotes unless the string contains one', () => {
    expect(pyReprStr('a')).toBe("'a'");
    expect(pyReprStr("it's")).toBe('"it\'s"');
    expect(pyReprStr('both \' and "')).toBe("'both \\' and \"'");
  });
  it('sorts keys and uses Python separators', () => {
    expect(pyJsonDumps({ b: 1, a: [true, null, 'x'] })).toBe('{"a": [true, null, "x"], "b": 1}');
  });
});

describe('payload locator', () => {
  it('follows <source>/<YYYY>/<MM>/<compact-ts>-<sha12>.raw', () => {
    const loc = payloadLocator('src', new Date('2025-03-08T06:15:00Z'), 'abcdef0123456789ff', 123456);
    expect(loc).toBe('src/2025/03/20250308T061500123456Z-abcdef012345.raw');
  });
});

describe('validate_count (40% rule)', () => {
  it('passes on first run and within tolerance', () => {
    expect(validateCount(null, 0)).toBeNull();
    expect(validateCount(100, 61)).toBeNull();
    expect(validateCount(100, 139)).toBeNull();
  });
  it('fails when a populated source goes to zero or deviates >40%', () => {
    expect(validateCount(100, 0)).toMatch(/0/);
    expect(validateCount(100, 59)).toMatch(/41/);
    expect(validateCount(100, 141)).toMatch(/41/);
  });
});

describe('rolling window', () => {
  it('a record is outside once its date part is before as_of - days', () => {
    // 2024 is a leap year: 2025-01-01 - 365d = 2024-01-02
    expect(isOutsideWindow('2024-01-02|K', '2025-01-01', 365, 0)).toBe(false);
    expect(isOutsideWindow('2024-01-01|K', '2025-01-01', 365, 0)).toBe(true);
  });
  it('malformed date parts are never outside', () => {
    expect(isOutsideWindow('nodate|K', '2025-01-01', 365, 0)).toBe(false);
  });
});

describe('date helpers', () => {
  it('add/diff days across month boundaries', () => {
    expect(addDays('2025-01-31', 1)).toBe('2025-02-01');
    expect(addDays('2025-01-01', -1)).toBe('2024-12-31');
    expect(daysBetween('2025-01-01', '2025-03-08')).toBe(66);
  });
});
