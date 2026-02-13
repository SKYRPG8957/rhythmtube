/* === 난이도 스케일러 - 분석 결과를 유지한 채 부담만 조절 === */
import type { NoteData } from './MapData';
import type { Difficulty } from '../utils/Constants';
import { NOTE_TYPE_HOLD, NOTE_TYPE_SLIDE, NOTE_TYPE_TAP } from '../utils/Constants';

interface ScaleProfile {
    readonly minLaneGap: number;
    readonly minGlobalTapGap: number;
    readonly minStrength: number;
    readonly laneRunLimit: number;
    readonly simplifyLongs: boolean;
}

const PROFILE_BY_DIFF: Record<Difficulty, ScaleProfile> = {
    easy: {
        minLaneGap: 0.20,
        minGlobalTapGap: 0.16,
        minStrength: 0.30,
        laneRunLimit: 2,
        simplifyLongs: true,
    },
    normal: {
        minLaneGap: 0.052,
        minGlobalTapGap: 0.036,
        minStrength: 0.06,
        laneRunLimit: 5,
        simplifyLongs: false,
    },
    hard: {
        minLaneGap: 0.03,
        minGlobalTapGap: 0.024,
        minStrength: 0.02,
        laneRunLimit: 7,
        simplifyLongs: false,
    },
    expert: {
        minLaneGap: 0.019,
        minGlobalTapGap: 0.015,
        minStrength: 0.008,
        laneRunLimit: 9,
        simplifyLongs: false,
    },
};

export const scaleDifficulty = (
    notes: readonly NoteData[],
    difficulty: Difficulty,
    _bpm: number
): readonly NoteData[] => {
    if (notes.length === 0) return notes;
    return normalizeByDifficulty(notes, PROFILE_BY_DIFF[difficulty]);
};

const normalizeByDifficulty = (
    notes: readonly NoteData[],
    profile: ScaleProfile
): readonly NoteData[] => {
    const sorted = [...notes].sort((a, b) => a.time - b.time);
    const out: NoteData[] = [];
    const lastLaneTime: [number, number] = [-Infinity, -Infinity];
    let lastTapTime = -Infinity;
    let lastLane = -1;
    let laneRun = 0;

    for (const raw of sorted) {
        const strength = raw.strength ?? 0.5;
        if (strength < profile.minStrength) continue;

        const laneIdx = raw.lane === 0 ? 0 : 1;
        const isLong = raw.type === NOTE_TYPE_HOLD || raw.type === NOTE_TYPE_SLIDE;
        const laneGap = isLong ? profile.minLaneGap * 1.12 : profile.minLaneGap;
        if (raw.time - lastLaneTime[laneIdx] < laneGap) continue;

        let note: NoteData = raw;
        if (profile.simplifyLongs && isLong) {
            note = {
                time: raw.time,
                lane: raw.lane,
                type: NOTE_TYPE_TAP,
                strength: Math.max(0.4, strength * 0.9),
            };
        }

        if (note.type === NOTE_TYPE_TAP && note.time - lastTapTime < profile.minGlobalTapGap) {
            continue;
        }

        if (note.type === NOTE_TYPE_TAP) {
            if (note.lane === lastLane) {
                laneRun++;
                if (laneRun >= profile.laneRunLimit) {
                    note = { ...note, lane: note.lane === 0 ? 1 : 0 };
                    laneRun = 0;
                }
            } else {
                laneRun = 0;
            }
            lastTapTime = note.time;
            lastLane = note.lane;
        }

        out.push(note);
        lastLaneTime[note.lane === 0 ? 0 : 1] = note.time;
    }

    return out;
};
