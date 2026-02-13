/* === 패턴 라이브러리 - 섹션별 노트 배치 템플릿 === */
import type { SectionType } from './MapData';
import { LANE_TOP, LANE_BOTTOM } from '../utils/Constants';

/** 패턴 엔트리: 비트 오프셋 + 레인 */
// 16분음표 단위 상수로 정밀도 향상
const QUARTER = 1;
const EIGHTH = 0.5;
const SIXTEENTH = 0.25;

export interface PatternEntry {
    readonly beatOffset: number; // 0~3 (4비트 기준)
    readonly lane: number;       // 0=상단, 1=하단
    readonly isHold?: boolean;   // 홀드 노트 여부
    readonly holdBeats?: number; // 홀드 지속 비트 수
}

/** 패턴 = 4비트 단위의 노트 배치 */
export type Pattern = readonly PatternEntry[];

/** 섹션별 패턴 세트 */
interface PatternSet {
    readonly patterns: readonly Pattern[];
    readonly weight: number; // 패턴 출현 가중치
}

/** intro 패턴 - 희소, 단순 */
const introPatterns: readonly Pattern[] = [
    // 4비트에 1노트
    [{ beatOffset: 0, lane: LANE_BOTTOM }],
    [{ beatOffset: 0, lane: LANE_TOP }],
    // 2비트에 1노트
    [{ beatOffset: 0, lane: LANE_BOTTOM }, { beatOffset: 2, lane: LANE_BOTTOM }],
    // 빈 패턴 (쉬는 구간)
    [],
];

/** verse 패턴 - 중간 밀도 + 비대칭 */
const versePatterns: readonly Pattern[] = [
    [{ beatOffset: 0, lane: LANE_BOTTOM }, { beatOffset: 2, lane: LANE_TOP }],
    [{ beatOffset: 0, lane: LANE_TOP }, { beatOffset: 2, lane: LANE_BOTTOM }],
    [
        { beatOffset: 0, lane: LANE_BOTTOM },
        { beatOffset: 1, lane: LANE_TOP },
        { beatOffset: 2, lane: LANE_BOTTOM },
    ],
    [
        { beatOffset: 0, lane: LANE_TOP },
        { beatOffset: 2, lane: LANE_BOTTOM },
        { beatOffset: 3, lane: LANE_TOP },
    ],
    [{ beatOffset: 0, lane: LANE_BOTTOM }, { beatOffset: 1, lane: LANE_BOTTOM }],
    [
        { beatOffset: 0, lane: LANE_BOTTOM },
        { beatOffset: 1.5, lane: LANE_TOP },
        { beatOffset: 3, lane: LANE_BOTTOM },
    ],
    [
        { beatOffset: 0, lane: LANE_TOP },
        { beatOffset: 1, lane: LANE_BOTTOM },
        { beatOffset: 3, lane: LANE_TOP },
    ],
];

/** chorus 패턴 - 고밀도, 복잡 */
const chorusPatterns: readonly Pattern[] = [
    // 매 비트
    [
        { beatOffset: 0, lane: LANE_BOTTOM },
        { beatOffset: 1, lane: LANE_TOP },
        { beatOffset: 2, lane: LANE_BOTTOM },
        { beatOffset: 3, lane: LANE_TOP },
    ],
    // 교차 + 더블
    [
        { beatOffset: 0, lane: LANE_TOP },
        { beatOffset: 1, lane: LANE_BOTTOM },
        { beatOffset: 2, lane: LANE_TOP },
        { beatOffset: 3, lane: LANE_BOTTOM },
    ],
    // 연타 파트
    [
        { beatOffset: 0, lane: LANE_BOTTOM },
        { beatOffset: 0.5, lane: LANE_TOP },
        { beatOffset: 1, lane: LANE_BOTTOM },
        { beatOffset: 2, lane: LANE_TOP },
        { beatOffset: 3, lane: LANE_BOTTOM },
    ],
    // 밀도 높은 교차
    [
        { beatOffset: 0, lane: LANE_TOP },
        { beatOffset: 0.5, lane: LANE_BOTTOM },
        { beatOffset: 1.5, lane: LANE_TOP },
        { beatOffset: 2, lane: LANE_BOTTOM },
        { beatOffset: 3, lane: LANE_TOP },
    ],
];

/** bridge 패턴 - 홀드 노트 + 느린 변화 */
const bridgePatterns: readonly Pattern[] = [
    // 롱노트
    [{ beatOffset: 0, lane: LANE_BOTTOM, isHold: true, holdBeats: 2 }],
    [{ beatOffset: 0, lane: LANE_TOP, isHold: true, holdBeats: 3 }],
    // 롱노트 + 탭
    [
        { beatOffset: 0, lane: LANE_BOTTOM, isHold: true, holdBeats: 2 },
        { beatOffset: 2, lane: LANE_TOP },
    ],
    // 느린 싱글
    [{ beatOffset: 0, lane: LANE_TOP }, { beatOffset: 3, lane: LANE_BOTTOM }],
];

/** drop 패턴 - 폭발적 밀도 */
const CHORUS_PATTERNS: readonly PatternEntry[][] = [
    // 1. Basic 8th note stream (기본 8비트)
    [
        { beatOffset: 0, lane: LANE_BOTTOM },
        { beatOffset: 0.5, lane: LANE_TOP },
        { beatOffset: 1.0, lane: LANE_BOTTOM },
        { beatOffset: 1.5, lane: LANE_TOP },
    ],
    // 2. Off-beat emphasis (엇박자)
    [
        { beatOffset: 0, lane: LANE_BOTTOM },
        { beatOffset: 0.75, lane: LANE_TOP }, // 점 8분음표
        { beatOffset: 1.5, lane: LANE_BOTTOM },
    ],
    // 3. Double taps (연타)
    [
        { beatOffset: 0, lane: LANE_BOTTOM },
        { beatOffset: 0.25, lane: LANE_BOTTOM },
        { beatOffset: 1.0, lane: LANE_TOP },
        { beatOffset: 1.25, lane: LANE_TOP },
    ],
    // 4. Gallop (따-다단 리듬)
    [
        { beatOffset: 0, lane: LANE_BOTTOM },
        { beatOffset: 0.75, lane: LANE_TOP },
        { beatOffset: 1.0, lane: LANE_TOP },
        { beatOffset: 1.75, lane: LANE_BOTTOM },
        { beatOffset: 2.0, lane: LANE_BOTTOM },
    ],
];

const DROP_PATTERNS: readonly PatternEntry[][] = [
    [
        { beatOffset: 0, lane: LANE_BOTTOM },
        { beatOffset: 0.25, lane: LANE_TOP },
        { beatOffset: 0.5, lane: LANE_BOTTOM },
        { beatOffset: 0.75, lane: LANE_TOP },
        { beatOffset: 1.0, lane: LANE_BOTTOM },
        { beatOffset: 1.25, lane: LANE_TOP },
        { beatOffset: 1.5, lane: LANE_BOTTOM },
        { beatOffset: 1.75, lane: LANE_TOP },
    ],
    [
        { beatOffset: 0, lane: LANE_BOTTOM },
        { beatOffset: 0.25, lane: LANE_BOTTOM },
        { beatOffset: 0.5, lane: LANE_TOP },
        { beatOffset: 0.75, lane: LANE_TOP },
    ],
    [
        { beatOffset: 0, lane: LANE_BOTTOM },
        { beatOffset: 0.5, lane: LANE_TOP },
        { beatOffset: 0.75, lane: LANE_BOTTOM },
        { beatOffset: 1.25, lane: LANE_TOP },
        { beatOffset: 1.5, lane: LANE_BOTTOM },
    ],
    [
        { beatOffset: 0, lane: LANE_BOTTOM, isHold: true, holdBeats: 0.5 },
        { beatOffset: 0.75, lane: LANE_TOP },
        { beatOffset: 1.0, lane: LANE_TOP },
        { beatOffset: 1.5, lane: LANE_BOTTOM, isHold: true, holdBeats: 0.5 },
    ],
    [
        { beatOffset: 0, lane: LANE_TOP },
        { beatOffset: 0.25, lane: LANE_BOTTOM },
        { beatOffset: 0.75, lane: LANE_TOP },
        { beatOffset: 1.0, lane: LANE_BOTTOM },
        { beatOffset: 1.5, lane: LANE_TOP },
        { beatOffset: 1.75, lane: LANE_BOTTOM },
    ],
    [
        { beatOffset: 0, lane: LANE_BOTTOM },
        { beatOffset: 0.5, lane: LANE_BOTTOM },
        { beatOffset: 0.75, lane: LANE_TOP },
        { beatOffset: 1.25, lane: LANE_BOTTOM },
        { beatOffset: 1.75, lane: LANE_TOP },
    ],
];

/** outro 패턴 - 서서히 줄어듦 */
const outroPatterns: readonly Pattern[] = [
    [{ beatOffset: 0, lane: LANE_BOTTOM }],
    [{ beatOffset: 0, lane: LANE_TOP }],
    [],
    [{ beatOffset: 0, lane: LANE_BOTTOM }, { beatOffset: 2, lane: LANE_TOP }],
];

/** 섹션 타입별 패턴 맵 */
const PATTERN_MAP: Record<SectionType, readonly Pattern[]> = {
    intro: introPatterns,
    verse: versePatterns,
    chorus: CHORUS_PATTERNS,
    bridge: bridgePatterns,
    drop: DROP_PATTERNS,
    outro: outroPatterns,
    interlude: [], // 간주: 노트 없음
};

let lastPatternIndex = -1;

export const selectPattern = (
    sectionType: SectionType,
    index: number
): Pattern => {
    const patterns = PATTERN_MAP[sectionType];
    if (patterns.length === 0) return [];

    const hash = (index * 2654435761) >>> 0;
    let patternIndex = hash % patterns.length;

    if (patternIndex === lastPatternIndex && patterns.length > 1) {
        patternIndex = (patternIndex + 1) % patterns.length;
    }

    lastPatternIndex = patternIndex;
    return patterns[patternIndex];
};

/**
 * 스펙트럼 기반 레인 오버라이드
 * 
 * 저주파 우세 → 하단, 고주파 우세 → 상단
 */
export const overrideLaneBySpectrum = (
    originalLane: number,
    lowEnergy: number,
    highEnergy: number,
    threshold = 0.3
): number => {
    const ratio = lowEnergy + highEnergy > 0
        ? highEnergy / (lowEnergy + highEnergy)
        : 0.5;

    if (ratio > 0.5 + threshold) return LANE_TOP;
    if (ratio < 0.5 - threshold) return LANE_BOTTOM;
    return originalLane;
};
