import type { CaptureRef, IsoDate } from './types.js';

export type EngineErrorCode = 'invalid_date' | 'invalid_range' | 'invalid_key' | 'no_capture';

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

export class InvalidDateError extends EngineError {
  readonly value: string;
  constructor(value: string) {
    super('invalid_date', `not a calendar date (YYYY-MM-DD): ${JSON.stringify(value)}`);
    this.name = 'InvalidDateError';
    this.value = value;
  }
}

export class InvalidRangeError extends EngineError {
  readonly from: IsoDate;
  readonly to: IsoDate;
  constructor(from: IsoDate, to: IsoDate) {
    super('invalid_range', `from (${from}) must not be after to (${to})`);
    this.name = 'InvalidRangeError';
    this.from = from;
    this.to = to;
  }
}

export class InvalidKeyError extends EngineError {
  constructor() {
    super('invalid_key', 'key must be a non-empty string');
    this.name = 'InvalidKeyError';
  }
}

/**
 * `diff` requires ok captures on both dates: a diff between two states the
 * archive never observed would be invention. Nearest captures are reported so
 * the caller can re-ask with dates that exist.
 */
export class NoCaptureError extends EngineError {
  readonly date: IsoDate;
  readonly nearestBefore: CaptureRef | null;
  readonly nearestAfter: CaptureRef | null;
  readonly rejectedOnDate: readonly CaptureRef[];
  constructor(
    date: IsoDate,
    nearestBefore: CaptureRef | null,
    nearestAfter: CaptureRef | null,
    rejectedOnDate: readonly CaptureRef[],
  ) {
    const why = rejectedOnDate.length > 0 ? `capture on ${date} was ${rejectedOnDate[0]?.outcome}` : `no capture on ${date}`;
    super('no_capture', `${why}; nearest ok captures: ${nearestBefore?.date ?? 'none'} / ${nearestAfter?.date ?? 'none'}`);
    this.name = 'NoCaptureError';
    this.date = date;
    this.nearestBefore = nearestBefore;
    this.nearestAfter = nearestAfter;
    this.rejectedOnDate = rejectedOnDate;
  }
}
