/* === 섹션 감지기 - 곡의 구조적 구간 분석 (간주 감지 포함) === */
import type { SectionInfo, SectionType } from './MapData';
import { computeEnergyTimeline } from '../audio/SpectralAnalyzer';

interface EnergyStats {
    readonly p20: number;
    readonly p50: number;
    readonly p75: number;
    readonly p88: number;
    readonly dynamicRange: number;
    readonly average: number;
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

const percentile = (values: readonly number[], q: number, fallback: number): number => {
    if (values.length === 0) return fallback;
    const sorted = [...values].sort((a, b) => a - b);
    const qq = Math.max(0, Math.min(1, q));
    const pos = qq * (sorted.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    const t = pos - lo;
    return sorted[lo] + (sorted[hi] - sorted[lo]) * t;
};

const buildEnergyStats = (
    normalizedTimeline: readonly { time: number; energy: number }[]
): EnergyStats => {
    const energies = normalizedTimeline.map(t => t.energy);
    const p20 = percentile(energies, 0.2, 0.28);
    const p50 = percentile(energies, 0.5, 0.5);
    const p75 = percentile(energies, 0.75, 0.68);
    const p88 = percentile(energies, 0.88, 0.78);
    const average = energies.length > 0
        ? energies.reduce((a, b) => a + b, 0) / energies.length
        : 0.5;
    const dynamicRange = clamp01((p88 - p20) / 0.9);
    return { p20, p50, p75, p88, dynamicRange, average };
};

const normalizeEnergyTimeline = (
    timeline: readonly { time: number; energy: number }[]
): readonly { time: number; energy: number }[] => {
    const energies = timeline.map(t => t.energy);
    const p10 = percentile(energies, 0.1, 0);
    const p90 = percentile(energies, 0.9, 1);
    const mean = energies.length > 0
        ? energies.reduce((a, b) => a + b, 0) / energies.length
        : 0.5;
    const spread = Math.max(0.04, p90 - p10, mean * 0.26);
    return timeline.map(t => ({
        ...t,
        energy: clamp01((t.energy - p10) / spread),
    }));
};

const smoothEnergyTimeline = (
    timeline: readonly { time: number; energy: number }[],
    radius: number
): readonly { time: number; energy: number }[] => {
    if (timeline.length <= 2 || radius <= 0) return timeline;
    const out: Array<{ time: number; energy: number }> = new Array(timeline.length);
    for (let i = 0; i < timeline.length; i++) {
        const s = Math.max(0, i - radius);
        const e = Math.min(timeline.length - 1, i + radius);
        let sum = 0;
        let weightSum = 0;
        for (let j = s; j <= e; j++) {
            const d = Math.abs(j - i);
            const w = 1 / (1 + d);
            sum += timeline[j].energy * w;
            weightSum += w;
        }
        out[i] = {
            time: timeline[i].time,
            energy: weightSum > 0 ? sum / weightSum : timeline[i].energy,
        };
    }
    return out;
};

/**
 * 곡의 에너지 변화를 분석하여 섹션 경계 감지
 *
 * 알고리즘:
 * 1. 에너지 타임라인 계산 (1초 단위)
 * 2. 에너지 변화율로 경계 감지
 * 3. 경계 사이 구간을 에너지 레벨로 분류
 * 4. 저에너지 구간을 간주(interlude)로 마킹
 */
export const detectSections = (buffer: AudioBuffer): readonly SectionInfo[] => {
    const segmentDuration = buffer.duration >= 420
        ? 1
        : buffer.duration >= 220
            ? 0.75
            : 0.5;
    const timelineRaw = computeEnergyTimeline(buffer, segmentDuration);
    const smoothRadius = segmentDuration <= 0.5 ? 2 : 1;
    const timeline = smoothEnergyTimeline(timelineRaw, smoothRadius);
    if (timeline.length < 2) {
        return [createSection(0, buffer.duration, 'verse', 0.5)];
    }

    // 에너지 정규화 (저다이내믹 곡 과증폭 방지)
    const normalized = normalizeEnergyTimeline(timeline);
    const stats = buildEnergyStats(normalized);

    // 경계 감지 (에너지 점프)
    const minSectionGapSec = Math.max(2.6, Math.min(4.4, segmentDuration * 5.8));
    const boundaries = findBoundaries(normalized, stats, minSectionGapSec);

    // 경계가 없으면 전체를 하나의 섹션으로
    if (boundaries.length === 0) {
        const avgE = normalized.reduce((s, t) => s + t.energy, 0) / normalized.length;
        const singleType = classifySection(avgE, 0, buffer.duration, stats);
        // 단일 섹션에서 intro/outro 오판 시 노트가 전부 사라지는 문제 방지
        const safeType: SectionType = singleType === 'intro' || singleType === 'outro' ? 'verse' : singleType;
        return [createSection(0, buffer.duration, safeType, avgE)];
    }

    // 경계 기반 섹션 생성
    const sections = buildSections(normalized, boundaries, buffer.duration, stats);

    // 간주(interlude) 감지: 에너지가 급격히 떨어지는 구간
    const enhanced = detectInterludes(sections, normalized);
    const tightened = tightenEdgeSections(enhanced, buffer.duration);
    return normalizeSectionsForPlayability(tightened, buffer.duration);
};

/** 에너지 점프로 경계 감지 */
const findBoundaries = (
    timeline: readonly { time: number; energy: number }[],
    stats: EnergyStats,
    minSectionGapSec: number
): number[] => {
    const boundaries: number[] = [];
    const changes: number[] = [];
    for (let i = 1; i < timeline.length; i++) {
        changes.push(Math.abs(timeline[i].energy - timeline[i - 1].energy));
    }

    const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
    const maxChange = Math.max(...changes);
    const rangeFactor = clamp01(stats.dynamicRange);
    const minJump = 0.06 + (1 - rangeFactor) * 0.05;
    const dynamicThreshold = (mean * (0.45 + (1 - rangeFactor) * 0.18))
        + (maxChange * (0.2 + rangeFactor * 0.08));

    for (let i = 1; i < timeline.length; i++) {
        const change = Math.abs(timeline[i].energy - timeline[i - 1].energy);
        const prevDelta = i >= 2 ? timeline[i - 1].energy - timeline[i - 2].energy : 0;
        const currDelta = timeline[i].energy - timeline[i - 1].energy;
        const turningBoost = (prevDelta * currDelta < 0) ? 0.018 : 0;
        const jumpScore = change + turningBoost;
        if (jumpScore > dynamicThreshold && jumpScore > minJump) {
            boundaries.push(timeline[i].time);
        }
    }

    // 너무 가까운 경계 병합
    const merged: number[] = [];
    for (const b of boundaries) {
        if (merged.length === 0 || b - merged[merged.length - 1] > minSectionGapSec) {
            merged.push(b);
        }
    }

    return merged;
};

/** 경계 기반 섹션 생성 */
const buildSections = (
    timeline: readonly { time: number; energy: number }[],
    boundaries: readonly number[],
    duration: number,
    stats: EnergyStats
): readonly SectionInfo[] => {
    const sections: SectionInfo[] = [];
    const allBounds = [0, ...boundaries, duration];
    const times = timeline.map(t => t.time);
    const prefixEnergy: number[] = new Array(timeline.length + 1).fill(0);
    for (let i = 0; i < timeline.length; i++) {
        prefixEnergy[i + 1] = prefixEnergy[i] + timeline[i].energy;
    }
    const lowerBound = (arr: readonly number[], target: number): number => {
        let lo = 0;
        let hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };

    for (let i = 0; i < allBounds.length - 1; i++) {
        const startTime = allBounds[i];
        const endTime = allBounds[i + 1];
        // 구간 평균 에너지 (prefix-sum 기반)
        const i0 = lowerBound(times, startTime);
        const i1 = lowerBound(times, endTime);
        const count = Math.max(0, i1 - i0);
        const sum = count > 0 ? prefixEnergy[i1] - prefixEnergy[i0] : 0;
        const avgEnergy = count > 0 ? sum / count : 0.5;

        const type = classifySection(avgEnergy, startTime, duration, stats);
        sections.push(createSection(startTime, endTime, type, avgEnergy));
    }

    return sections;
};

/**
 * 간주(interlude) 감지
 *
 * 에너지가 낮고 주변 섹션보다 현저히 낮은 구간 = 간주
 * - 인트로: 곡 시작의 저에너지 구간
 * - 간주: 곡 중간의 저에너지 구간 (이전 섹션이 고에너지였을 때)
 * - 아웃트로: 곡 끝의 저에너지 구간
 */
const detectInterludes = (
    sections: readonly SectionInfo[],
    timeline: readonly { time: number; energy: number }[]
): readonly SectionInfo[] => {
    if (sections.length === 0) return sections;
    const times = timeline.map(t => t.time);
    const lowGate = 0.14;
    const prefixHighCount: number[] = new Array(timeline.length + 1).fill(0);
    for (let i = 0; i < timeline.length; i++) {
        const isHigh = timeline[i].energy >= lowGate ? 1 : 0;
        prefixHighCount[i + 1] = prefixHighCount[i] + isHigh;
    }
    const lowerBound = (arr: readonly number[], target: number): number => {
        let lo = 0;
        let hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    const isAllLowInRange = (start: number, end: number): boolean => {
        if (end <= start) return true;
        const i0 = lowerBound(times, start);
        const i1 = lowerBound(times, end);
        if (i1 <= i0) return true;
        return (prefixHighCount[i1] - prefixHighCount[i0]) === 0;
    };

    // 전체 평균 에너지 계산
    const totalAvgEnergy = sections.reduce((sum, s) => sum + s.avgEnergy, 0) / sections.length;

    // 간주 판별 임계값: 전체 평균의 35% 이하
    const interludeThreshold = totalAvgEnergy * 0.2;
    // 낮은 에너지 임계값: 절대값 0.09 이하
    const absoluteLowThreshold = 0.09;
    const totalDuration = sections[sections.length - 1].endTime;
    const maxIntroDuration = Math.min(12, totalDuration * 0.18);
    const maxOutroDuration = Math.min(10, totalDuration * 0.14);

    return sections.map((section, i) => {
        const isLowEnergy = section.avgEnergy < interludeThreshold || section.avgEnergy < absoluteLowThreshold;
        const duration = section.endTime - section.startTime;

        const nextEnergy = i < sections.length - 1 ? sections[i + 1].avgEnergy : section.avgEnergy;

        // 곡 시작부 (처음 섹션이 충분히 낮고, 즉시 에너지 반등이 확인될 때만 intro)
        if (
            i === 0
            && isLowEnergy
            && duration <= Math.min(maxIntroDuration, 8.5)
            && section.avgEnergy < 0.2
            && nextEnergy - section.avgEnergy >= 0.2
            && nextEnergy >= 0.32
            && isAllLowInRange(section.startTime, section.endTime)
        ) {
            return { ...section, type: 'intro' as SectionType, isInterlude: false };
        }

        // 곡 끝부 (마지막 섹션이 저에너지 → outro/interlude)
        if (i === sections.length - 1 && isLowEnergy && duration <= maxOutroDuration && section.avgEnergy < 0.2) {
            return { ...section, type: 'outro' as SectionType, isInterlude: false };
        }

        // 중간 간주 감지:
        // 이전 섹션이 고에너지(코러스/드랍)이고 현재 섹션이 저에너지 → 간주
        if (i > 0 && i < sections.length - 1 && isLowEnergy) {
            const prevSection = sections[i - 1];
            const nextSection = sections[i + 1];
            const energyDrop = prevSection.avgEnergy - section.avgEnergy;
            const rebound = nextSection.avgEnergy - section.avgEnergy;
            const farFromEdge = section.startTime > Math.min(10, totalDuration * 0.09)
                && section.endTime < totalDuration - Math.min(10, totalDuration * 0.09);

            // 에너지가 급격히 떨어지면 (0.3 이상 차이) 간주
            if (
                farFromEdge
                && (
                    (energyDrop > 0.5 && rebound >= 0.16 && duration >= 3.2)
                    || (section.avgEnergy < 0.075 && rebound >= 0.12 && duration >= 3.8)
                )
            ) {
                return { ...section, type: 'interlude' as SectionType, isInterlude: true };
            }
        }

        // 2초 이상 저에너지 구간이 지속되면 간주로 판별
        if (i > 0 && i < sections.length - 1 && isLowEnergy && duration >= 2.8) {
            // 구간 내 에너지 타임라인 확인 - 지속적으로 낮은지
            const prevSection = sections[i - 1];
            const nextSection = sections[i + 1];
            const allLow = isAllLowInRange(section.startTime, section.endTime);
            if (
                allLow
                && duration >= 4.2
                && section.avgEnergy < Math.min(absoluteLowThreshold, totalAvgEnergy * 0.16)
                && prevSection.avgEnergy >= section.avgEnergy + 0.12
                && nextSection.avgEnergy >= section.avgEnergy + 0.1
            ) {
                return { ...section, type: 'interlude' as SectionType, isInterlude: true };
            }
        }

        return section;
    });
};

/** intro/outro/interlude 오판으로 노트가 비는 현상 방지 */
const tightenEdgeSections = (
    sections: readonly SectionInfo[],
    duration: number
): readonly SectionInfo[] => {
    if (sections.length === 0) return sections;
    const avgEnergy = sections.reduce((acc, s) => acc + s.avgEnergy, 0) / sections.length;

    return sections.map((section, i) => {
        const len = section.endTime - section.startTime;

        if (section.type === 'intro' && i === 0) {
            if (len > Math.min(8, duration * 0.12) || section.avgEnergy > Math.max(0.28, avgEnergy * 0.8)) {
                return { ...section, type: 'verse' as SectionType, isInterlude: false };
            }
        }

        if (section.type === 'outro' && i === sections.length - 1) {
            if (len > Math.min(10, duration * 0.16) || section.avgEnergy > Math.max(0.28, avgEnergy * 0.8)) {
                return { ...section, type: 'verse' as SectionType, isInterlude: false };
            }
        }

        if (section.type === 'interlude' && i > 0 && i < sections.length - 1) {
            if (len < 2.2 || section.avgEnergy > Math.max(0.2, avgEnergy * 0.55)) {
                return { ...section, type: 'bridge' as SectionType, isInterlude: false };
            }
        }

        return section;
    });
};

/** 섹션 오판으로 플레이 구간이 지나치게 줄어드는 현상 방지 */
const normalizeSectionsForPlayability = (
    sections: readonly SectionInfo[],
    duration: number
): readonly SectionInfo[] => {
    if (sections.length === 0) return sections;
    const isSilentType = (t: SectionType): boolean =>
        t === 'intro' || t === 'outro' || t === 'interlude';

    const toLen = (s: SectionInfo): number => Math.max(0, s.endTime - s.startTime);
    const playableDuration = sections
        .filter(s => !isSilentType(s.type))
        .reduce((acc, s) => acc + toLen(s), 0);

    // 플레이 가능한 구간이 전체의 45% 미만이면 과도한 오판으로 간주
    if (playableDuration >= duration * 0.45) {
        return sections;
    }

    const adjusted = [...sections].map(s => ({ ...s }));
    for (let i = 0; i < adjusted.length; i++) {
        const section = adjusted[i];
        if (section.type === 'outro' || section.type === 'intro' || section.type === 'interlude') {
            const isEdgeIntro = i === 0 && section.type === 'intro' && toLen(section) <= 4.5;
            const isEdgeOutro = i === adjusted.length - 1 && section.type === 'outro' && toLen(section) <= 6.5;
            if (isEdgeIntro || isEdgeOutro) continue;
            adjusted[i] = {
                ...section,
                type: 'verse',
                isInterlude: false,
            };
        }
    }

    return adjusted;
};

/** 에너지와 위치 기반 섹션 타입 분류 */
const classifySection = (
    energy: number,
    startTime: number,
    totalDuration: number,
    stats: EnergyStats
): SectionType => {
    const relativePos = startTime / totalDuration;
    const lowRangeTrack = stats.dynamicRange <= 0.16;
    const introGate = Math.min(0.34, stats.p20 + 0.08 + (1 - stats.dynamicRange) * 0.04);
    const outroGate = Math.min(0.28, stats.p20 + 0.05 + (1 - stats.dynamicRange) * 0.03);
    const dropGate = Math.max(0.7, stats.p88 - stats.dynamicRange * 0.04);
    const chorusGate = Math.max(0.5, stats.p75 - 0.03);
    const verseGate = Math.max(0.32, stats.p50 - 0.05);
    const bridgeGate = Math.max(0.18, stats.p20 + 0.04);

    // 위치 기반 힌트
    if (relativePos < 0.035 && startTime < 6.5 && energy < introGate * 0.86 && stats.dynamicRange > 0.12) return 'intro';
    if (relativePos > 0.95 && (totalDuration - startTime) < 9 && energy < outroGate) return 'outro';

    // 저다이내믹/잔잔한 곡은 과한 drop 판정을 피하고 verse/bridge 위주로 분류.
    if (lowRangeTrack) {
        if (energy > chorusGate + 0.06 && relativePos > 0.16 && relativePos < 0.9) return 'chorus';
        if (energy > verseGate + 0.02) return 'verse';
        if (energy > bridgeGate) return 'bridge';
        return 'bridge';
    }

    // 에너지 기반 분류
    if (energy > dropGate) return 'drop';
    if (energy > chorusGate) return 'chorus';
    if (energy > verseGate) return 'verse';
    if (energy > bridgeGate) return 'bridge';
    return 'bridge';
};

/** 섹션 객체 생성 헬퍼 */
const createSection = (
    startTime: number,
    endTime: number,
    type: SectionType,
    avgEnergy: number
): SectionInfo => ({
    startTime,
    endTime,
    type,
    avgEnergy,
});
