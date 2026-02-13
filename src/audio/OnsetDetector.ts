/* === Onset Detection - Multi-band FFT === */
import { fftInPlace } from './FastFFT';
import { extractSharedMono, getSharedHannWindow } from './AnalysisCache';

/** Onset 결과 */
export interface OnsetResult {
    readonly onsets: readonly number[];     // Single band (legacy support)
    readonly strengths: readonly number[];

    // Multi-band support
    readonly lowOnsets: readonly number[];
    readonly midOnsets: readonly number[];
    readonly highOnsets: readonly number[];
    readonly lowStrengths: readonly number[];
    readonly midStrengths: readonly number[];
    readonly highStrengths: readonly number[];
}

export interface OnsetDetectOptions {
    readonly fftSize?: number;
    readonly hopSize?: number;
    readonly startTimeSec?: number;
    readonly durationSec?: number;
    /** 이미 다운믹스된 mono를 재사용할 때 사용 */
    readonly monoData?: Float32Array;
}

export interface OnsetFluxProfile {
    readonly lowFlux: Float32Array;
    readonly midFlux: Float32Array;
    readonly highFlux: Float32Array;
    readonly lowEnergy: Float32Array;
    readonly midEnergy: Float32Array;
    readonly highEnergy: Float32Array;
    readonly framerate: number;
    readonly startTimeSec: number;
}

/**
 * 오디오 버퍼에서 멀티밴드 onset 감지
 */
export const detectOnsets = (
    buffer: AudioBuffer,
    sensitivity = 1.0,
    options?: OnsetDetectOptions
): OnsetResult => {
    const flux = computeOnsetFlux(buffer, options);
    return detectOnsetsFromFlux(flux, sensitivity);
};

/**
 * FFT 기반 플럭스 계산만 선행 수행한다.
 * 민감도 스윕 시 이 결과를 재사용하면 반복 FFT 비용을 크게 줄일 수 있다.
 */
export const computeOnsetFlux = (
    buffer: AudioBuffer,
    options?: OnsetDetectOptions
): OnsetFluxProfile => {
    const sampleRate = buffer.sampleRate;
    const fftSize = sanitizeFFTSize(options?.fftSize ?? 8192);
    const hopSize = Math.max(64, Math.floor(options?.hopSize ?? 128));

    const rawMono = options?.monoData ?? extractSharedMono(buffer);
    const safeStart = Math.max(0, options?.startTimeSec ?? 0);
    const startSample = Math.max(0, Math.min(rawMono.length, Math.floor(safeStart * sampleRate)));

    const requestedDurationSec = options?.durationSec;
    const rawEnd = Number.isFinite(requestedDurationSec)
        ? startSample + Math.max(0, Math.floor((requestedDurationSec as number) * sampleRate))
        : rawMono.length;
    const endSample = Math.max(startSample, Math.min(rawMono.length, rawEnd));
    const analysisData = rawMono.subarray(startSample, endSample);

    const hannWindow = getSharedHannWindow(fftSize);
    const { lowFlux, midFlux, highFlux, lowEnergy, midEnergy, highEnergy } = computeMultiBandFlux(
        analysisData,
        fftSize,
        hopSize,
        hannWindow,
        sampleRate
    );

    return {
        lowFlux,
        midFlux,
        highFlux,
        lowEnergy,
        midEnergy,
        highEnergy,
        framerate: sampleRate / hopSize,
        startTimeSec: startSample / sampleRate,
    };
};

/**
 * 이미 계산된 플럭스에서 민감도별 onset을 추출한다.
 */
export const detectOnsetsFromFlux = (
    fluxProfile: OnsetFluxProfile,
    sensitivity = 1.0
): OnsetResult => {
    const low = findPeaks(fluxProfile.lowFlux, fluxProfile.framerate, sensitivity * 0.92);
    const mid = findPeaks(fluxProfile.midFlux, fluxProfile.framerate, sensitivity * 0.82);
    const high = findPeaks(fluxProfile.highFlux, fluxProfile.framerate, sensitivity * 1.28);

    if (fluxProfile.startTimeSec > 0) {
        shiftOnsetTimes(low.onsets, fluxProfile.startTimeSec);
        shiftOnsetTimes(mid.onsets, fluxProfile.startTimeSec);
        shiftOnsetTimes(high.onsets, fluxProfile.startTimeSec);
    }

    const combined = fuseOnsetsByBandConsensus(low, mid, high);
    return {
        onsets: combined.onsets,
        strengths: combined.strengths,
        lowOnsets: low.onsets,
        lowStrengths: low.strengths,
        midOnsets: mid.onsets,
        midStrengths: mid.strengths,
        highOnsets: high.onsets,
        highStrengths: high.strengths,
    };
};

const shiftOnsetTimes = (times: number[], offsetSec: number): void => {
    for (let i = 0; i < times.length; i++) {
        times[i] += offsetSec;
    }
};

/** 멀티밴드 Flux 계산 */
const computeMultiBandFlux = (
    data: Float32Array,
    fftSize: number,
    hopSize: number,
    hannWindow: Float32Array,
    sampleRate: number
): {
    lowFlux: Float32Array;
    midFlux: Float32Array;
    highFlux: Float32Array;
    lowEnergy: Float32Array;
    midEnergy: Float32Array;
    highEnergy: Float32Array;
} => {
    const numFrames = Math.max(0, Math.floor((data.length - fftSize) / hopSize) + 1);
    const lowFlux = new Float32Array(numFrames);
    const midFlux = new Float32Array(numFrames);
    const highFlux = new Float32Array(numFrames);
    const lowEnergy = new Float32Array(numFrames);
    const midEnergy = new Float32Array(numFrames);
    const highEnergy = new Float32Array(numFrames);
    if (numFrames <= 0) return { lowFlux, midFlux, highFlux, lowEnergy, midEnergy, highEnergy };

    const halfFFT = fftSize / 2;
    const binHz = sampleRate / fftSize;
    const lowEnd = Math.floor(240 / binHz);                 // 킥/베이스
    const midEnd = Math.floor(4200 / binHz);                // 보컬/주 멜로디
    const highEnd = Math.min(Math.floor(18000 / binHz), halfFFT); // 타격성 고역
    const lowBins = Math.max(1, lowEnd);
    const midBins = Math.max(1, midEnd - lowEnd);
    const highBins = Math.max(1, highEnd - midEnd);

    const prevMag = new Float32Array(halfFFT);
    const realBuf = new Float32Array(fftSize);
    const imagBuf = new Float32Array(fftSize);
    const vibSuppressBins = 1; // SuperFlux 스타일: 인접 bin max로 전프레임 비교

    for (let frame = 0; frame < numFrames; frame++) {
        const offset = frame * hopSize;
        for (let i = 0; i < fftSize; i++) {
            realBuf[i] = data[offset + i] * hannWindow[i];
            imagBuf[i] = 0;
        }
        fftInPlace(realBuf, imagBuf);

        let lf = 0;
        let mf = 0;
        let hf = 0;
        let le = 0;
        let me = 0;
        let he = 0;
        for (let bin = 0; bin < highEnd; bin++) {
            const magSq = realBuf[bin] * realBuf[bin] + imagBuf[bin] * imagBuf[bin];
            let prevRef = prevMag[bin];
            for (let d = 1; d <= vibSuppressBins; d++) {
                const li = bin - d;
                const ri = bin + d;
                if (li >= 0 && prevMag[li] > prevRef) prevRef = prevMag[li];
                if (ri < highEnd && prevMag[ri] > prevRef) prevRef = prevMag[ri];
            }
            const diff = magSq - prevRef;
            if (diff > 0) {
                if (bin < lowEnd) {
                    lf += diff;
                } else if (bin < midEnd) {
                    const hz = bin * binHz;
                    const presenceBoost = hz >= 900 && hz <= 3800 ? 1.2 : 1;
                    mf += diff * presenceBoost;
                } else {
                    hf += diff;
                }
            }
            if (bin < lowEnd) le += magSq;
            else if (bin < midEnd) me += magSq;
            else he += magSq;
            prevMag[bin] = magSq;
        }
        lowFlux[frame] = lf;
        midFlux[frame] = mf;
        highFlux[frame] = hf;
        lowEnergy[frame] = Math.sqrt(le / lowBins);
        midEnergy[frame] = Math.sqrt(me / midBins);
        highEnergy[frame] = Math.sqrt(he / highBins);
    }

    return { lowFlux, midFlux, highFlux, lowEnergy, midEnergy, highEnergy };
};

const sanitizeFFTSize = (value: number): number => {
    const v = Math.max(256, Math.floor(value));
    let p = 1;
    while (p < v) p <<= 1;
    if (p > v && p >= 1024) p >>= 1;
    return Math.max(256, p);
};

/** 적응적 피크 감지 (prefix sum 기반 O(n)) */
const findPeaks = (
    flux: Float32Array,
    framerate: number,
    sensitivity: number
): { onsets: number[]; strengths: number[] } => {
    const onsets: number[] = [];
    const strengths: number[] = [];
    if (flux.length < 3 || framerate <= 0) return { onsets, strengths };

    let maxFlux = 0;
    for (let i = 0; i < flux.length; i++) {
        if (flux[i] > maxFlux) maxFlux = flux[i];
    }
    if (maxFlux <= 1e-12) return { onsets, strengths };

    let fluxSum = 0;
    let fluxSqSum = 0;
    for (let i = 0; i < flux.length; i++) {
        const v = flux[i];
        fluxSum += v;
        fluxSqSum += v * v;
    }
    const globalMean = fluxSum / Math.max(1, flux.length);
    const globalVar = Math.max(0, fluxSqSum / Math.max(1, flux.length) - globalMean * globalMean);
    const globalStd = Math.sqrt(globalVar);
    const noisyContinuum = Math.max(0, Math.min(1, (globalMean / Math.max(1e-9, maxFlux) - 0.11) / 0.2));
    const noisyVariance = Math.max(0, Math.min(1, (globalStd / Math.max(1e-9, maxFlux) - 0.08) / 0.28));
    const noisyLevel = Math.max(noisyContinuum, noisyVariance);

    const safeSensitivity = Math.max(0.5, sensitivity);
    const windowSize = Math.max(4, Math.ceil(framerate * (0.26 + noisyLevel * 0.05)));
    const minIntervalSec = safeSensitivity >= 1.24
        ? 0.03
        : safeSensitivity >= 1.0
            ? 0.035
            : 0.041;
    const minInterval = Math.max(1, Math.ceil(framerate * (minIntervalSec + noisyLevel * 0.018)));
    const stdWeight = 0.31 + (0.57 / safeSensitivity) + noisyLevel * 0.26;
    const globalFloor = maxFlux * (0.0018 + 0.0018 / safeSensitivity + noisyLevel * 0.0045);

    const prefix = new Float64Array(flux.length + 1);
    const prefixSq = new Float64Array(flux.length + 1);
    for (let i = 0; i < flux.length; i++) {
        const v = flux[i];
        prefix[i + 1] = prefix[i] + v;
        prefixSq[i + 1] = prefixSq[i] + v * v;
    }

    let lastOnset = -minInterval;
    for (let i = 1; i < flux.length - 1; i++) {
        const value = flux[i];
        if (value <= globalFloor) continue;
        if (!(value > flux[i - 1] && value >= flux[i + 1])) continue;
        if (i - lastOnset < minInterval) continue;

        const start = Math.max(0, i - windowSize);
        const end = Math.min(flux.length, i + windowSize + 1);
        const count = Math.max(1, end - start);
        const sum = prefix[end] - prefix[start];
        const mean = sum / count;
        const sq = prefixSq[end] - prefixSq[start];
        const variance = Math.max(0, (sq / count) - mean * mean);
        const std = Math.sqrt(variance);
        const threshold = mean + std * stdWeight + globalFloor;
        const prominence = value - Math.max(flux[i - 1], flux[i + 1]);
        if (prominence <= globalFloor * (1.08 + noisyLevel * 4.1)) continue;
        // 노이즈 곡에서는 에너지 대비 prominence 비율도 확인
        if (noisyLevel > 0.4 && prominence < value * (0.052 + noisyLevel * 0.11)) continue;

        if (value <= threshold) continue;

        onsets.push(i / framerate);
        strengths.push(Math.min(1, Math.pow(value / maxFlux, 0.72)));
        lastOnset = i;
    }
    return { onsets, strengths };
};

/** Onset 병합 (시간순 정렬 + 중복 제거) */
const mergeOnsets = (
    sources: { onsets: number[]; strengths: number[] }[]
): { onsets: number[]; strengths: number[] } => {
    const combined: { time: number; strength: number }[] = [];
    for (const src of sources) {
        for (let i = 0; i < src.onsets.length; i++) {
            combined.push({ time: src.onsets[i], strength: src.strengths[i] });
        }
    }
    combined.sort((a, b) => a.time - b.time);

    if (combined.length === 0) return { onsets: [], strengths: [] };
    const resultOnsets: number[] = [];
    const resultStrengths: number[] = [];
    let last = combined[0];
    for (let i = 1; i < combined.length; i++) {
        const curr = combined[i];
        if (curr.time - last.time < 0.05) {
            if (curr.strength > last.strength) last = curr;
        } else {
            resultOnsets.push(last.time);
            resultStrengths.push(last.strength);
            last = curr;
        }
    }
    resultOnsets.push(last.time);
    resultStrengths.push(last.strength);
    return { onsets: resultOnsets, strengths: resultStrengths };
};

const fuseOnsetsByBandConsensus = (
    low: { onsets: number[]; strengths: number[] },
    mid: { onsets: number[]; strengths: number[] },
    high: { onsets: number[]; strengths: number[] }
): { onsets: number[]; strengths: number[] } => {
    const events: Array<{ time: number; strength: number; band: 0 | 1 | 2 }> = [];
    for (let i = 0; i < low.onsets.length; i++) events.push({ time: low.onsets[i], strength: low.strengths[i], band: 0 });
    for (let i = 0; i < mid.onsets.length; i++) events.push({ time: mid.onsets[i], strength: Math.min(1, mid.strengths[i] * 1.12), band: 1 });
    for (let i = 0; i < high.onsets.length; i++) events.push({ time: high.onsets[i], strength: high.strengths[i], band: 2 });
    if (events.length === 0) return { onsets: [], strengths: [] };

    events.sort((a, b) => a.time - b.time);

    const clusteredTimes: number[] = [];
    const clusteredStrengths: number[] = [];
    const clusterWindow = 0.038;
    let cluster: Array<{ time: number; strength: number; band: 0 | 1 | 2 }> = [events[0]];

    const flush = () => {
        if (cluster.length === 0) return;
        const bestByBand = [0, 0, 0];
        let weightSum = 0;
        let weightedTime = 0;
        let maxStrength = 0;
        for (const e of cluster) {
            bestByBand[e.band] = Math.max(bestByBand[e.band], e.strength);
            const w = 0.18 + e.strength * 0.82;
            weightSum += w;
            weightedTime += e.time * w;
            maxStrength = Math.max(maxStrength, e.strength);
        }
        const bandCount = (bestByBand[0] > 0 ? 1 : 0) + (bestByBand[1] > 0 ? 1 : 0) + (bestByBand[2] > 0 ? 1 : 0);
        const meanStrength = (bestByBand[0] + bestByBand[1] + bestByBand[2]) / Math.max(1, bandCount);
        const accept = maxStrength >= 0.66
            || (bandCount >= 2 && meanStrength >= 0.3)
            || (bestByBand[1] >= 0.4 && bandCount >= 1);
        if (accept) {
            clusteredTimes.push(weightSum > 0 ? weightedTime / weightSum : cluster[0].time);
            clusteredStrengths.push(Math.min(1, Math.max(maxStrength, meanStrength * 0.9)));
        }
        cluster = [];
    };

    for (let i = 1; i < events.length; i++) {
        const e = events[i];
        const last = cluster[cluster.length - 1];
        if (e.time - last.time <= clusterWindow) {
            cluster.push(e);
        } else {
            flush();
            cluster = [e];
        }
    }
    flush();

    const outOnsets: number[] = [];
    const outStrengths: number[] = [];
    const refractory = 0.052;
    for (let i = 0; i < clusteredTimes.length; i++) {
        const t = clusteredTimes[i];
        const s = clusteredStrengths[i];
        if (outOnsets.length === 0 || t - outOnsets[outOnsets.length - 1] >= refractory) {
            outOnsets.push(t);
            outStrengths.push(s);
        } else if (s > outStrengths[outStrengths.length - 1]) {
            outOnsets[outOnsets.length - 1] = t;
            outStrengths[outStrengths.length - 1] = s;
        }
    }

    return { onsets: outOnsets, strengths: outStrengths };
};

/**
 * Onset 시간을 비트 그리드(+8분음표)에 스냅
 *
 * 각 onset을 가장 가까운 비트 또는 반비트 위치에 정렬하여
 * 리듬 게임에 적합한 정확한 타이밍을 생성
 */
export const quantizeOnsets = (
    onsets: readonly number[],
    beatPositions: readonly number[]
): readonly number[] => {
    if (beatPositions.length < 2) return onsets;

    const beatInterval = beatPositions[1] - beatPositions[0];
    const halfBeat = beatInterval / 2;

    const grid: number[] = [];
    for (const beat of beatPositions) {
        grid.push(beat);
        grid.push(beat + halfBeat);
    }
    grid.sort((a, b) => a - b);

    const quantized: number[] = [];
    const usedGridPoints = new Set<number>();
    for (const onset of onsets) {
        let closestIdx = 0;
        let minDist = Infinity;

        let lo = 0;
        let hi = grid.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const dist = Math.abs(grid[mid] - onset);
            if (dist < minDist) {
                minDist = dist;
                closestIdx = mid;
            }
            if (grid[mid] < onset) lo = mid + 1;
            else hi = mid - 1;
        }

        const snapThreshold = halfBeat * 0.6;
        const snappedTime = minDist <= snapThreshold ? grid[closestIdx] : onset;
        const gridKey = Math.round(snappedTime * 1000);
        if (!usedGridPoints.has(gridKey)) {
            quantized.push(snappedTime);
            usedGridPoints.add(gridKey);
        }
    }
    return quantized;
};
