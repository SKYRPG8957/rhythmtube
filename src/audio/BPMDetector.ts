/* === BPM 감지 - 자기상관(Autocorrelation) 기반 + 첫 비트 오프셋 === */
import { BPM_MIN, BPM_MAX } from '../utils/Constants';
import { rms } from '../utils/MathUtils';
import type { WasmBpmHint } from './WasmAudioAnalyzer';
import { extractSharedMono } from './AnalysisCache';

/** BPM 분석 결과 */
export interface BPMResult {
    readonly bpm: number;
    readonly confidence: number;     // 0~1
    readonly beatInterval: number;   // 초 단위 비트 간격
    readonly firstBeatOffset: number; // 첫 비트 시작 오프셋 (초)
}

/**
 * AudioBuffer에서 BPM 감지 + 첫 비트 오프셋
 * 
 * 알고리즘:
 * 1. 모노로 다운믹스
 * 2. 에너지 엔벨로프 계산 (RMS over windows)
 * 3. 차분 신호 (onset 강조)
 * 4. 반파 정류 (양수만)
 * 5. 자기상관 계산 (주기성 감지)
 * 6. 피크 탐색으로 BPM 추정
 * 7. 첫 비트 오프셋 감지 (에너지 피크 기반)
 */
export const detectBPM = (buffer: AudioBuffer): BPMResult => {
    try {
        const wasmHint = (buffer as unknown as { __wasmBpmHint?: WasmBpmHint }).__wasmBpmHint;
        if (wasmHint && Number.isFinite(wasmHint.bpm) && wasmHint.bpm >= BPM_MIN && wasmHint.bpm <= BPM_MAX) {
            const resolvedBpm = Math.round(wasmHint.bpm);
            return {
                bpm: resolvedBpm,
                confidence: Math.max(0.35, Math.min(0.99, wasmHint.confidence)),
                beatInterval: 60 / resolvedBpm,
                firstBeatOffset: Number.isFinite(wasmHint.firstBeatOffset) ? Math.max(0, wasmHint.firstBeatOffset) : 0,
            };
        }

        // 1. 모노 다운믹스
        const rawData = extractSharedMono(buffer);
        const sampleRate = buffer.sampleRate;

        // 너무 짧은 오디오 방어 (2초 미만)
        if (buffer.duration < 2) {
            return createFallbackResult(120);
        }

        // 2. 에너지 엔벨로프 (RMS, hop size = 256 samples → 더 정밀한 시간 해상도)
        const hopSize = 256;
        const envelope = computeEnergyEnvelope(rawData, hopSize);
        const envelopeRate = sampleRate / hopSize;

        // 엔벨로프가 너무 짧으면 폴백
        if (envelope.length < 10) {
            return createFallbackResult(120);
        }

        // 3. 차분 신호 (onset 강조)
        const diff = computeDifferential(envelope);

        // 4. 반파 정류 (양수만)
        const rectified = halfWaveRectify(diff);

        // 5. 자기상관 계산
        const { bpm, confidence } = autocorrelateBPM(rectified, envelopeRate);

        // BPM 유효성 검증
        if (!isFinite(bpm) || bpm <= 0 || bpm < BPM_MIN || bpm > BPM_MAX) {
            return createFallbackResult(120);
        }

        // 6. 첫 비트 오프셋 감지
        const beatInterval = 60 / bpm;
        const firstBeatOffset = detectFirstBeatOffset(
            envelope, envelopeRate, beatInterval
        );

        return {
            bpm: Math.round(bpm),
            confidence,
            beatInterval,
            firstBeatOffset: isFinite(firstBeatOffset) ? firstBeatOffset : 0,
        };
    } catch {
        // 분석 실패 시 폴백 BPM 사용
        return createFallbackResult(120);
    }
};

/** 폴백 BPM 결과 생성 */
const createFallbackResult = (bpm: number): BPMResult => ({
    bpm,
    confidence: 0.3,
    beatInterval: 60 / bpm,
    firstBeatOffset: 0,
});

/** 에너지 엔벨로프 계산 */
const computeEnergyEnvelope = (data: Float32Array, hopSize: number): Float32Array => {
    const frames = Math.floor(data.length / hopSize);
    const envelope = new Float32Array(frames);

    for (let i = 0; i < frames; i++) {
        envelope[i] = rms(data, i * hopSize, hopSize);
    }

    return envelope;
};

/** 차분 신호 (1차 미분) */
const computeDifferential = (data: Float32Array): Float32Array => {
    const diff = new Float32Array(data.length);
    for (let i = 1; i < data.length; i++) {
        diff[i] = data[i] - data[i - 1];
    }
    return diff;
};

/** 반파 정류 (음수 → 0) */
const halfWaveRectify = (data: Float32Array): Float32Array => {
    const result = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) {
        result[i] = Math.max(0, data[i]);
    }
    return result;
};

/** 자기상관 기반 BPM 추정 */
const autocorrelateBPM = (
    data: Float32Array,
    sampleRate: number
): { bpm: number; confidence: number } => {
    const minLag = Math.floor((60 / BPM_MAX) * sampleRate);
    const maxLag = Math.ceil((60 / BPM_MIN) * sampleRate);

    // 분석 구간 (전체의 중간 사용 - 인트로/아웃트로 제외)
    const startFrame = Math.floor(data.length * 0.1);
    const endFrame = Math.floor(data.length * 0.9);
    const analysisLength = endFrame - startFrame;

    if (analysisLength < maxLag * 2) {
        return autocorrelateRange(data, 0, data.length, minLag, maxLag, sampleRate);
    }

    return autocorrelateRange(data, startFrame, endFrame, minLag, maxLag, sampleRate);
};

/** 특정 범위에서 자기상관 */
const autocorrelateRange = (
    data: Float32Array,
    start: number,
    end: number,
    minLag: number,
    maxLag: number,
    sampleRate: number
): { bpm: number; confidence: number } => {
    // 정규화 상수
    let energy = 0;
    for (let i = start; i < end; i++) {
        energy += data[i] * data[i];
    }

    const correlationAt = (lag: number): number => {
        let corr = 0;
        const length = end - start;
        const corrLength = Math.min(length - lag, length);
        if (corrLength <= 0) return 0;

        for (let i = 0; i < corrLength; i++) {
            corr += data[start + i] * data[start + i + lag];
        }
        return energy > 0 ? corr / energy : 0;
    };

    // 자기상관 계산 (긴 범위는 coarse pass 후 local refine)
    let maxCorr = -Infinity;
    let bestLag = minLag;
    const lagSpan = Math.max(1, maxLag - minLag);
    const coarseStep = lagSpan >= 420 ? 2 : 1;

    for (let lag = minLag; lag <= maxLag; lag += coarseStep) {
        const corr = correlationAt(lag);
        if (corr > maxCorr) {
            maxCorr = corr;
            bestLag = lag;
        }
    }

    if (coarseStep > 1) {
        const refineStart = Math.max(minLag, bestLag - coarseStep * 2);
        const refineEnd = Math.min(maxLag, bestLag + coarseStep * 2);
        for (let lag = refineStart; lag <= refineEnd; lag++) {
            const corr = correlationAt(lag);
            if (corr > maxCorr) {
                maxCorr = corr;
                bestLag = lag;
            }
        }
    }

    // 2차 보간으로 정밀 피크 위치 계산
    let refinedLag = bestLag;

    if (bestLag > minLag && bestLag < maxLag) {
        const a = correlationAt(bestLag - 1);
        const b = correlationAt(bestLag);
        const c = correlationAt(bestLag + 1);
        const denom = a - 2 * b + c;
        if (Math.abs(denom) > 1e-10) {
            const delta = 0.5 * (a - c) / denom;
            if (isFinite(delta) && Math.abs(delta) < 1) {
                refinedLag = bestLag + delta;
            }
        }
    }

    const bpm = (60 * sampleRate) / refinedLag;

    // 하모닉 보정
    let correctedBPM = bpm;
    while (correctedBPM > BPM_MAX) correctedBPM /= 2;
    while (correctedBPM < BPM_MIN) correctedBPM *= 2;

    const confidence = Math.max(0, Math.min(1, maxCorr));

    return { bpm: correctedBPM, confidence };
};

/**
 * 첫 비트 오프셋 감지
 * 
 * 에너지 엔벨로프에서 초반 강한 피크를 찾고,
 * 비트 간격으로 정렬했을 때 가장 많은 피크와 일치하는 오프셋 선택
 */
const detectFirstBeatOffset = (
    envelope: Float32Array,
    envelopeRate: number,
    beatInterval: number
): number => {
    // 초반 5초 분석
    const analyzeFrames = Math.min(
        Math.ceil(5 * envelopeRate),
        envelope.length
    );

    // 에너지 피크 찾기
    const peaks: number[] = [];
    let maxEnv = 0;
    for (let i = 0; i < analyzeFrames; i++) {
        if (envelope[i] > maxEnv) maxEnv = envelope[i];
    }
    if (maxEnv === 0) return 0;

    const peakThreshold = maxEnv * 0.3;
    for (let i = 1; i < analyzeFrames - 1; i++) {
        if (
            envelope[i] > peakThreshold &&
            envelope[i] > envelope[i - 1] &&
            envelope[i] >= envelope[i + 1]
        ) {
            peaks.push(i / envelopeRate);
        }
    }

    if (peaks.length === 0) return 0;

    // 각 피크를 잠재적 오프셋으로 테스트
    // 비트 그리드와의 평균 일치도 계산
    let bestOffset = peaks[0];
    let bestScore = -1;

    const testWindow = beatInterval * 0.15; // ±15% 비트 간격 내 매칭

    for (const candidateOffset of peaks.slice(0, 10)) {
        let score = 0;

        for (const peak of peaks) {
            // 이 오프셋 기준 비트 그리드에서 가장 가까운 비트까지 거리
            const beatsAway = (peak - candidateOffset) / beatInterval;
            const roundedBeats = Math.round(beatsAway);
            const deviation = Math.abs(beatsAway - roundedBeats) * beatInterval;

            if (deviation < testWindow) {
                score += 1;
            }
        }

        if (score > bestScore) {
            bestScore = score;
            bestOffset = candidateOffset;
        }
    }

    return bestOffset;
};

/**
 * 감지된 BPM 기반으로 비트 위치 생성
 */
export const generateBeatPositions = (
    bpm: number,
    duration: number,
    offset: number = 0,
    divisor: number = 1
): readonly number[] => {
    const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
    const safeDivisor = Number.isFinite(divisor) && divisor > 0 ? divisor : 1;
    const interval = Math.max(0.03, (60 / safeBpm) / safeDivisor);
    const beats: number[] = [];

    let time = Number.isFinite(offset) ? offset : 0;
    let guard = 0;
    const maxPoints = Math.max(1024, Math.ceil(duration / interval) + 8);
    while (time < duration && guard < maxPoints) {
        beats.push(time);
        time += interval;
        guard++;
    }

    return beats;
};
