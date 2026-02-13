/* === 맵 데이터 타입 정의 === */
import type { NoteType, Difficulty } from '../utils/Constants';

export interface NoteData {
    readonly time: number;
    readonly lane: number;
    readonly type: NoteType;
    readonly duration?: number;
    readonly strength?: number;
    readonly targetLane?: number;
    readonly slideStartY?: number;
    readonly burstHitsRequired?: number;
}

/** 곡 섹션 정보 */
export interface SectionInfo {
    readonly startTime: number;
    readonly endTime: number;
    readonly type: SectionType;
    readonly avgEnergy: number;
    /** 간주/인트로 등 노트가 없어야 하는 구간 */
    readonly isInterlude?: boolean;
}

/** 섹션 타입 */
export type SectionType = 'intro' | 'verse' | 'chorus' | 'bridge' | 'drop' | 'outro' | 'interlude';

/** 완성된 맵 데이터 */
export interface MapData {
    readonly bpm: number;
    readonly duration: number;
    readonly difficulty: Difficulty;
    readonly visualTheme?: VisualTheme;
    readonly notes: readonly NoteData[];
    readonly sections: readonly SectionInfo[];
    readonly beatPositions: readonly number[];
    readonly totalNotes: number;
}

export type VisualTheme = 'meadow' | 'sunset' | 'nightCity';

/** 맵 생성 진행률 콜백 */
export type ProgressCallback = (stage: string, progress: number) => void;
