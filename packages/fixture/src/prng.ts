/** Deterministic PRNG (SplitMix32) so every fixture is reproducible from its seed. */
export class Prng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x9e3779b9) >>> 0;
    let z = this.state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    z = (z ^ (z >>> 16)) >>> 0;
    return z / 4294967296;
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('pick from empty list');
    return items[this.int(items.length)] as T;
  }

  /** Deterministic sample of `k` distinct items (partial Fisher–Yates on a copy). */
  sample<T>(items: readonly T[], k: number): T[] {
    const arr = items.slice();
    const n = Math.min(k, arr.length);
    for (let i = 0; i < n; i++) {
      const j = i + this.int(arr.length - i);
      const t = arr[i] as T;
      arr[i] = arr[j] as T;
      arr[j] = t;
    }
    return arr.slice(0, n);
  }

  /** Independent stream derived from this one, for a named sub-purpose. */
  fork(label: string): Prng {
    let h = this.state ^ 0x811c9dc5;
    for (const ch of label) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    return new Prng(h);
  }
}
