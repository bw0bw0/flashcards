// Bit-exact port of the random number generation Anki's scheduler uses:
// `rand::rngs::StdRng::seed_from_u64(seed)` (rand 0.10.1: ChaCha12 from the
// chacha20 crate, seeded via rand_core's PCG32 expansion) followed by
// `random_range(0.0f32..1.0)` or `random_range(lo..hi)` on u32.
//
// Sources: rand_core-0.10.1/src/seedable_rng.rs (pcg32, seed_from_u64),
// chacha20-0.10.2/src/rng.rs, rand-0.10.1/src/distr/uniform_{float,int}.rs.

const MASK64 = (1n << 64n) - 1n;

/** rand_core's `seed_from_u64`: fills a 32-byte seed with PCG32 output. */
function seedFromU64(seed: bigint): Uint32Array {
  const MUL = 0x5851f42d4c957f2dn;
  const INC = 0xa17654e46fbe17f3n;
  let state = seed & MASK64;
  const key = new Uint32Array(8);
  for (let i = 0; i < 8; i++) {
    state = (state * MUL + INC) & MASK64;
    const xorshifted = Number((((state >> 18n) ^ state) >> 27n) & 0xffffffffn);
    const rot = Number(state >> 59n);
    key[i] = ((xorshifted >>> rot) | (xorshifted << ((32 - rot) & 31))) >>> 0;
  }
  return key;
}

function rotl(v: number, n: number): number {
  return ((v << n) | (v >>> (32 - n))) >>> 0;
}

/** ChaCha with 12 rounds, 64-bit block counter and zero 64-bit stream id. */
export class StdRng {
  private readonly key: Uint32Array;
  private counter = 0n;
  private readonly buffer = new Uint32Array(16);
  private index = 16;

  private constructor(key: Uint32Array) {
    this.key = key;
  }

  static seedFromU64(seed: bigint | number): StdRng {
    return new StdRng(seedFromU64(BigInt(seed)));
  }

  private refill(): void {
    const s = new Uint32Array(16);
    s[0] = 0x61707865;
    s[1] = 0x3320646e;
    s[2] = 0x79622d32;
    s[3] = 0x6b206574;
    s.set(this.key, 4);
    s[12] = Number(this.counter & 0xffffffffn);
    s[13] = Number((this.counter >> 32n) & 0xffffffffn);
    s[14] = 0;
    s[15] = 0;
    const x = Uint32Array.from(s);
    const qr = (a: number, b: number, c: number, d: number) => {
      x[a] = (x[a] + x[b]) >>> 0; x[d] = rotl(x[d] ^ x[a], 16);
      x[c] = (x[c] + x[d]) >>> 0; x[b] = rotl(x[b] ^ x[c], 12);
      x[a] = (x[a] + x[b]) >>> 0; x[d] = rotl(x[d] ^ x[a], 8);
      x[c] = (x[c] + x[d]) >>> 0; x[b] = rotl(x[b] ^ x[c], 7);
    };
    for (let round = 0; round < 12; round += 2) {
      qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15);
      qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14);
    }
    for (let i = 0; i < 16; i++) this.buffer[i] = (x[i] + s[i]) >>> 0;
    this.counter = (this.counter + 1n) & MASK64;
    this.index = 0;
  }

  nextU32(): number {
    if (this.index >= 16) this.refill();
    return this.buffer[this.index++];
  }

  /** `random_range(0.0f32..1.0)`: 23 random mantissa bits, as an f32 in [0, 1). */
  randomF32Unit(): number {
    const bits = (this.nextU32() >>> 9) | 0x3f800000;
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, bits);
    return Math.fround(view.getFloat32(0) - 1);
  }

  /** `random_range(low..high)` on u32: Canon's method, biased variant. */
  randomRangeU32(low: number, high: number): number {
    if (!(low < high)) throw new Error("empty range");
    const range = BigInt((high - 1 - low + 1) >>> 0);
    const product = BigInt(this.nextU32()) * range;
    let result = product >> 32n;
    const loOrder = product & 0xffffffffn;
    if (loOrder > ((1n << 32n) - range) % (1n << 32n)) {
      const newHiOrder = (BigInt(this.nextU32()) * range) >> 32n;
      if (loOrder + newHiOrder > 0xffffffffn) result += 1n;
    }
    return (low + Number(result)) >>> 0;
  }
}
