/* === Fast FFT plan cache === */

interface FFTPlan {
    readonly size: number;
    readonly bitReverse: Uint32Array;
    readonly cos: Float32Array;
    readonly sin: Float32Array;
}

const planCache = new Map<number, FFTPlan>();

const isPowerOfTwo = (n: number): boolean => n > 0 && (n & (n - 1)) === 0;

const buildPlan = (size: number): FFTPlan => {
    if (!isPowerOfTwo(size)) {
        throw new Error(`FFT size must be power-of-two: ${size}`);
    }
    const bits = Math.log2(size) | 0;
    const bitReverse = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
        let x = i;
        let y = 0;
        for (let b = 0; b < bits; b++) {
            y = (y << 1) | (x & 1);
            x >>= 1;
        }
        bitReverse[i] = y >>> 0;
    }

    const half = size >> 1;
    const cos = new Float32Array(half);
    const sin = new Float32Array(half);
    const twoPiByN = (Math.PI * 2) / size;
    for (let k = 0; k < half; k++) {
        const angle = -twoPiByN * k;
        cos[k] = Math.cos(angle);
        sin[k] = Math.sin(angle);
    }

    return { size, bitReverse, cos, sin };
};

const getPlan = (size: number): FFTPlan => {
    const cached = planCache.get(size);
    if (cached) return cached;
    const plan = buildPlan(size);
    planCache.set(size, plan);
    return plan;
};

export const fftInPlace = (real: Float32Array, imag: Float32Array): void => {
    const n = real.length;
    if (imag.length !== n) {
        throw new Error('FFT real/imag length mismatch');
    }
    const plan = getPlan(n);

    // bit-reversal permutation
    for (let i = 0; i < n; i++) {
        const j = plan.bitReverse[i];
        if (j <= i) continue;
        const tr = real[i];
        real[i] = real[j];
        real[j] = tr;
        const ti = imag[i];
        imag[i] = imag[j];
        imag[j] = ti;
    }

    // iterative radix-2 Cooley-Tukey
    for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1;
        const twiddleStep = n / size;
        for (let i = 0; i < n; i += size) {
            let tw = 0;
            for (let k = 0; k < half; k++) {
                const wr = plan.cos[tw];
                const wi = plan.sin[tw];

                const evenIdx = i + k;
                const oddIdx = evenIdx + half;

                const or = real[oddIdx];
                const oi = imag[oddIdx];
                const tr = wr * or - wi * oi;
                const ti = wr * oi + wi * or;

                const er = real[evenIdx];
                const ei = imag[evenIdx];
                real[oddIdx] = er - tr;
                imag[oddIdx] = ei - ti;
                real[evenIdx] = er + tr;
                imag[evenIdx] = ei + ti;

                tw += twiddleStep;
            }
        }
    }
};

