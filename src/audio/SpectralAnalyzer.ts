/* === 스펙트럼 분석기 - 실제 FFT 기반 주파수 대역별 에너지 === */
import { fftInPlace } from './FastFFT';
import { extractSharedMono, getSharedHannWindow } from './AnalysisCache';

/** 주파수 대역 프로파일 */
export interface SpectralProfile {
    readonly time: number;      // 분석 시점 (초)
    readonly low: number;       // 저주파 에너지 (20-250Hz) - 베이스/킥
    readonly mid: number;       // 중주파 에너지 (250-2kHz) - 보컬/멜로디
    readonly high: number;      // 고주파 에너지 (2k-20kHz) - 하이햇/심벌
    readonly energy: number;    // 전체 에너지
    readonly brightness: number; // 스펙트럼 중심 (밝기)
    readonly transient: number; // 순간 타격성(공격감)
    readonly tonal: number;     // 멜로디 안정성(음색 중심성)
    readonly percussive: number; // 타악기 성향
}
export interface SpectralAnalyzeOptions {
    readonly fftSize?: number;
}

/**
 * AudioBuffer의 특정 시점들에서 스펙트럼 프로파일 분석 (실제 FFT)
 */
export const analyzeSpectralProfiles = (
    buffer: AudioBuffer,
    timePoints: readonly number[],
    options?: SpectralAnalyzeOptions
): readonly SpectralProfile[] => {
    const sampleRate = buffer.sampleRate;
    const mono = extractSharedMono(buffer);
    const fftSize = normalizeFftSize(options?.fftSize ?? 8192);
    const hannWindow = getSharedHannWindow(fftSize);
    const halfFFT = fftSize / 2;

    // 주파수 빈당 Hz
    const binHz = sampleRate / fftSize;

    // 대역 범위를 빈 인덱스로 변환
    const lowStart = Math.floor(20 / binHz);
    const lowEnd = Math.floor(250 / binHz);
    const midStart = lowEnd;
    const midEnd = Math.floor(2000 / binHz);
    const highStart = midEnd;
    const highEnd = Math.min(Math.floor(20000 / binHz), halfFFT);

    // FFT 버퍼 재사용
    const realBuf = new Float32Array(fftSize);
    const imagBuf = new Float32Array(fftSize);

    const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
    const profiles: SpectralProfile[] = [];
    let prevLow = 0;
    let prevMid = 0;
    let prevHigh = 0;
    let prevEnergy = 0;

    for (const time of timePoints) {
        const centerSample = Math.floor(time * sampleRate);
        const startSample = Math.max(0, centerSample - halfFFT);

        // 윈도우 적용
        for (let i = 0; i < fftSize; i++) {
            const idx = startSample + i;
            realBuf[i] = (idx < mono.length ? mono[idx] : 0) * hannWindow[i];
            imagBuf[i] = 0;
        }

        // FFT 수행
        fftInPlace(realBuf, imagBuf);

        // 대역별 에너지 계산
        const low = bandEnergy(realBuf, imagBuf, lowStart, lowEnd);
        const mid = bandEnergy(realBuf, imagBuf, midStart, midEnd);
        const high = bandEnergy(realBuf, imagBuf, highStart, highEnd);

        // 전체 에너지
        const totalEnergy = low + mid + high;

        // 스펙트럼 밝기 (가중 중심)
        const brightness = totalEnergy > 0
            ? (mid * 0.3 + high * 0.7) / totalEnergy
            : 0.5;

        const total = Math.max(1e-6, totalEnergy);
        const lowRatio = low / total;
        const midRatio = mid / total;
        const highRatio = high / total;
        const energyRise = Math.max(0, totalEnergy - prevEnergy);
        const bandRise = Math.max(0, (high - prevHigh) * 0.72 + (mid - prevMid) * 0.35 + (low - prevLow) * 0.12);
        const transient = clamp01((energyRise * 1.6 + bandRise * 0.72) / (total * 1.08 + 1e-5));
        const tonal = clamp01(
            midRatio * 0.62
            + (1 - Math.abs(midRatio - lowRatio)) * 0.18
            + (1 - Math.abs(midRatio - highRatio)) * 0.2
        );
        const percussive = clamp01(highRatio * 0.56 + transient * 0.44);

        profiles.push({
            time,
            low,
            mid,
            high,
            energy: totalEnergy,
            brightness,
            transient,
            tonal,
            percussive,
        });

        prevLow = low;
        prevMid = mid;
        prevHigh = high;
        prevEnergy = totalEnergy;
    }

    return profiles;
};

const normalizeFftSize = (value: number): number => {
    const candidates = [512, 1024, 2048, 4096, 8192];
    let best = 8192;
    let bestDist = Infinity;
    for (const c of candidates) {
        const d = Math.abs(c - value);
        if (d < bestDist) {
            bestDist = d;
            best = c;
        }
    }
    return best;
};

/** 특정 빈 범위의 RMS 에너지 */
const bandEnergy = (
    real: Float32Array,
    imag: Float32Array,
    startBin: number,
    endBin: number
): number => {
    let sum = 0;
    const count = endBin - startBin;
    if (count <= 0) return 0;

    for (let i = startBin; i < endBin; i++) {
        sum += real[i] * real[i] + imag[i] * imag[i];
    }

    return Math.sqrt(sum / count);
};

/**
 * 전체 곡의 평균 에너지 레벨 구간별 계산
 */
export const computeEnergyTimeline = (
    buffer: AudioBuffer,
    segmentDuration = 2
): readonly { readonly time: number; readonly energy: number }[] => {
    const mono = extractSharedMono(buffer);
    const sampleRate = buffer.sampleRate;
    const segmentSamples = Math.floor(segmentDuration * sampleRate);
    const numSegments = Math.ceil(mono.length / segmentSamples);

    const timeline: { time: number; energy: number }[] = [];

    for (let i = 0; i < numSegments; i++) {
        const start = i * segmentSamples;
        const end = Math.min(start + segmentSamples, mono.length);
        let energy = 0;
        for (let j = start; j < end; j++) {
            energy += mono[j] * mono[j];
        }
        energy = Math.sqrt(energy / (end - start));
        timeline.push({
            time: i * segmentDuration,
            energy,
        });
    }

    return timeline;
};
