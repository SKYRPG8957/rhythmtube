
import type { NoteData } from '../map/MapData';
import type { Difficulty } from '../utils/Constants';
import {
    CANVAS_WIDTH, CANVAS_HEIGHT,
    LANE_TOP_Y, LANE_BOTTOM_Y,
    JUDGE_LINE_X, NOTE_SIZE,
    NOTE_SPEED_BASE, NOTE_SPAWN_OFFSET,
    JUDGE_PERFECT, JUDGE_GREAT, JUDGE_GOOD, JUDGE_MISS,
    NOTE_TYPE_HOLD, NOTE_TYPE_TAP, NOTE_TYPE_SLIDE, NOTE_TYPE_BURST,
    MIN_HOLD_DURATION_SEC, MIN_SLIDE_DURATION_SEC,
    LANE_TOP, LANE_BOTTOM,
    COLORS,
    type JudgeResult,
} from '../utils/Constants';
import { lerp } from '../utils/MathUtils';

interface ActiveNote {
    readonly data: NoteData;
    x: number;
    y: number;
    hit: boolean;
    started: boolean;
    judged: boolean;
    holdProgress: number;
    slideProgress: number;
    readonly slideStartY: number;
    readonly slideTargetY: number;
    readonly tickInterval: number;
    nextTickTime: number;
    ticksGiven: number;
    releaseGraceUntil: number;
    burstHitsRequired: number;
    burstHitsDone: number;
    burstLastHitTime: number;
}

interface JudgeMeta {
    readonly sustainTick?: boolean;
    readonly phase?: 'tap' | 'start' | 'tick' | 'burst' | 'end' | 'miss';
    readonly tickYRatio?: number;
    readonly tickLane?: number;
    readonly tickProgress?: number;
    readonly burstHitsDone?: number;
    readonly burstHitsRequired?: number;
}
type JudgeCallback = (result: JudgeResult, note: NoteData, meta?: JudgeMeta) => void;
interface CharacterMotionGuide {
    readonly yRatio: number; // 0=bottom, 1=top
    readonly lane: number;
    readonly airborne: boolean;
}

const STORAGE_SPEED_KEY = 'rhythmtube_notespeed';
const STORAGE_AUDIO_OFFSET_KEY = 'rhythmtube_offset';
const STORAGE_INPUT_OFFSET_KEY = 'rhythmtube_input_offset';
const STORAGE_VISUAL_OFFSET_KEY = 'rhythmtube_visual_offset';
const LEGACY_STORAGE_SPEED_KEY = 'beatrunner_notespeed';
const LEGACY_STORAGE_AUDIO_OFFSET_KEY = 'beatrunner_offset';
const LEGACY_STORAGE_INPUT_OFFSET_KEY = 'beatrunner_input_offset';
const LEGACY_STORAGE_VISUAL_OFFSET_KEY = 'beatrunner_visual_offset';
const LONG_START_WINDOW_MS = 340;
const LONG_HEAD_PREVIEW_SEC = 0.11;
const LONG_START_ACCEPT_RATIO = 0.92;
const INPUT_BUFFER_SEC = 0.11;
const BURST_MIN_HITS = 3;
const BURST_MAX_HITS = 12;
const BURST_HIT_INTERVAL_SEC = 0.045;

interface AssistTuning {
    readonly timingScale: number;
    readonly missScale: number;
    readonly crossLaneAssist: number;
}

export const createNoteManager = () => {
    const loadStoredNumber = (key: string, legacyKey: string, fallback: number): number => {
        const raw = localStorage.getItem(key) || localStorage.getItem(legacyKey);
        const parsed = raw !== null ? parseFloat(raw) : Number.NaN;
        return Number.isFinite(parsed) ? parsed : fallback;
    };
    let notes: readonly NoteData[] = [];
    let activeNotes: ActiveNote[] = [];
    let nextNoteIndex = 0;
    let noteSpeed = loadStoredNumber(STORAGE_SPEED_KEY, LEGACY_STORAGE_SPEED_KEY, 1.0);
    let audioOffset = loadStoredNumber(STORAGE_AUDIO_OFFSET_KEY, LEGACY_STORAGE_AUDIO_OFFSET_KEY, 0);
    let inputOffset = loadStoredNumber(STORAGE_INPUT_OFFSET_KEY, LEGACY_STORAGE_INPUT_OFFSET_KEY, 0);
    let visualOffset = loadStoredNumber(STORAGE_VISUAL_OFFSET_KEY, LEGACY_STORAGE_VISUAL_OFFSET_KEY, 0);
    let judgeCallbacks: JudgeCallback[] = [];
    let isAutoPlay = false;
    let rhythmTickIntervalSec = 0.5; // default fallback
    let lanePressBufferUntil: [number, number] = [0, 0];
    let currentDifficulty: Difficulty = 'normal';
    let assist: AssistTuning = {
        timingScale: 1,
        missScale: 1,
        crossLaneAssist: 0,
    };
    const getSustainDuration = (note: NoteData): number => {
        if (note.type === NOTE_TYPE_SLIDE) {
            return Math.max(note.duration || 0, MIN_SLIDE_DURATION_SEC);
        }
        if (note.type === NOTE_TYPE_HOLD) {
            return Math.max(note.duration || 0, MIN_HOLD_DURATION_SEC);
        }
        return note.duration || 0;
    };
    const getBurstHitsRequired = (note: NoteData): number => {
        const raw = Math.round(note.burstHitsRequired ?? 0);
        if (!Number.isFinite(raw) || raw <= 0) return 4;
        return Math.max(BURST_MIN_HITS, Math.min(BURST_MAX_HITS, raw));
    };
    const getBurstDuration = (note: NoteData): number => {
        const duration = note.duration ?? 0;
        return Math.max(0.52, Math.min(2.2, duration > 0 ? duration : 0.92));
    };
    const getBurstCompletionJudge = (
        hitsDone: number,
        required: number,
        completionRatio: number
    ): JudgeResult => {
        if (hitsDone < required) return 'miss';
        if (completionRatio <= 0.58) return 'perfect';
        if (completionRatio <= 0.84) return 'great';
        return 'good';
    };
    const finalizeBurst = (note: ActiveNote, adjustedTime: number, forcedMiss = false): void => {
        if (note.judged) return;
        const duration = getBurstDuration(note.data);
        const completionRatio = Math.max(0, Math.min(1.2, (adjustedTime - note.data.time) / Math.max(0.001, duration)));
        const result = forcedMiss
            ? 'miss'
            : getBurstCompletionJudge(note.burstHitsDone, note.burstHitsRequired, completionRatio);
        note.judged = true;
        note.hit = false;
        judgeCallbacks.forEach(cb => cb(result, note.data, {
            phase: result === 'miss' ? 'miss' : 'end',
            burstHitsDone: note.burstHitsDone,
            burstHitsRequired: note.burstHitsRequired,
        }));
    };

    const setAutoPlay = (enabled: boolean) => {
        isAutoPlay = enabled;
    };

    const setNotes = (mapNotes: readonly NoteData[]): void => {
        notes = mapNotes;
        activeNotes = [];
        nextNoteIndex = 0;
        lanePressBufferUntil = [0, 0];
    };

    const setNoteSpeed = (speed: number): void => {
        noteSpeed = Math.max(0.5, Math.min(3, speed));
        localStorage.setItem(STORAGE_SPEED_KEY, String(noteSpeed));
    };

    const setAudioOffset = (offset: number): void => {
        audioOffset = offset;
        localStorage.setItem(STORAGE_AUDIO_OFFSET_KEY, String(audioOffset));
    };

    const setInputOffset = (offset: number): void => {
        inputOffset = Math.max(-250, Math.min(250, offset));
        localStorage.setItem(STORAGE_INPUT_OFFSET_KEY, String(inputOffset));
    };

    const setVisualOffset = (offset: number): void => {
        visualOffset = Math.max(-250, Math.min(250, offset));
        localStorage.setItem(STORAGE_VISUAL_OFFSET_KEY, String(visualOffset));
    };

    const setMapBpm = (bpm: number): void => {
        if (!Number.isFinite(bpm) || bpm <= 0) {
            rhythmTickIntervalSec = 0.5;
            return;
        }
        const eighth = 60 / bpm / 2;
        rhythmTickIntervalSec = Math.max(0.2, Math.min(0.45, eighth));
    };

    const setDifficulty = (difficulty: Difficulty): void => {
        currentDifficulty = difficulty;
        if (difficulty === 'easy') {
            assist = { timingScale: 0.82, missScale: 1.34, crossLaneAssist: 0.72 };
            return;
        }
        if (difficulty === 'normal') {
            assist = { timingScale: 1.0, missScale: 1.08, crossLaneAssist: 0.18 };
            return;
        }
        if (difficulty === 'hard') {
            assist = { timingScale: 1.06, missScale: 0.95, crossLaneAssist: 0.05 };
            return;
        }
        assist = { timingScale: 1.12, missScale: 0.84, crossLaneAssist: 0 };
    };

    const injectBonusTap = (time: number, lane: number): void => {
        if (!Number.isFinite(time)) return;
        const safeTime = Math.max(0.02, time);
        const safeLane = lane === LANE_TOP ? LANE_TOP : LANE_BOTTOM;
        const bonusNote: NoteData = {
            time: safeTime,
            lane: safeLane,
            type: NOTE_TYPE_TAP,
            strength: 0.82,
        };

        const insertAt = notes.findIndex(n => n.time > safeTime);
        if (insertAt < 0) {
            notes = [...notes, bonusNote];
            return;
        }

        notes = [...notes.slice(0, insertAt), bonusNote, ...notes.slice(insertAt)];
        if (insertAt <= nextNoteIndex) {
            nextNoteIndex++;
        }
    };

    const onJudge = (cb: (result: JudgeResult, note: NoteData, meta?: JudgeMeta) => void): (() => void) => {
        judgeCallbacks = [...judgeCallbacks, cb];
        return () => { judgeCallbacks = judgeCallbacks.filter(c => c !== cb); };
    };

    const registerBufferedPress = (lane: number, currentTime: number): void => {
        if (lane !== 0 && lane !== 1) return;
        const adjusted = currentTime + (audioOffset + inputOffset) / 1000;
        lanePressBufferUntil[lane] = adjusted + INPUT_BUFFER_SEC;
    };

    const clearBufferedPress = (lane: number): void => {
        if (lane !== 0 && lane !== 1) return;
        lanePressBufferUntil[lane] = -1;
    };

    const pickLongStartOverride = (
        lane: number,
        adjustedTime: number,
        judgeX: number,
        speed: number,
        currentIdx: number,
        currentDistMs: number
    ): { idx: number; distMs: number } | null => {
        const startWindowMs = LONG_START_WINDOW_MS * assist.missScale;
        let bestIdx = -1;
        let bestDist = Number.POSITIVE_INFINITY;
        for (let i = 0; i < activeNotes.length; i++) {
            const note = activeNotes[i];
            if (note.judged || note.started) continue;
            const isSlide = note.data.type === NOTE_TYPE_SLIDE;
            const isHold = note.data.type === NOTE_TYPE_HOLD;
            if (!isSlide && !isHold) continue;

            const targetLane = note.data.targetLane ?? (note.data.lane === LANE_TOP ? LANE_BOTTOM : LANE_TOP);
            const laneMatch = isSlide
                ? (note.data.lane === lane || targetLane === lane)
                : note.data.lane === lane;
            if (!laneMatch) continue;

            const timeDist = Math.abs(adjustedTime - note.data.time) * 1000;
            const visualDist = Math.abs(note.x - judgeX) / Math.max(1, speed) * 1000;
            const dist = Math.min(timeDist * 0.8, visualDist * 1.06) * assist.timingScale;
            if (dist > startWindowMs * 0.98) continue;
            if (note.data.time > adjustedTime + startWindowMs / 1000 * 0.78) continue;

            if (dist < bestDist) {
                bestDist = dist;
                bestIdx = i;
            }
        }

        if (bestIdx < 0) return null;
        if (currentIdx < 0) return { idx: bestIdx, distMs: bestDist };
        const current = activeNotes[currentIdx];
        const currentIsLong = current.data.type === NOTE_TYPE_SLIDE || current.data.type === NOTE_TYPE_HOLD;
        if (!currentIsLong && bestDist <= currentDistMs * 1.12 + 4) {
            return { idx: bestIdx, distMs: bestDist };
        }
        if (currentIsLong && bestDist + 6 < currentDistMs) {
            return { idx: bestIdx, distMs: bestDist };
        }
        return null;
    };

    const update = (currentTime: number, dt: number): void => {
        const adjustedTime = currentTime + audioOffset / 1000;
        const judgeX = CANVAS_WIDTH * JUDGE_LINE_X;
        const speed = NOTE_SPEED_BASE * noteSpeed;

        // --- 오토 플레이 로직 ---
        if (isAutoPlay) {
            for (const note of activeNotes) {
                if (note.judged) continue;

                // 판정선에 거의 도달했을 때 (0.01s 오차)
                if (note.data.time <= adjustedTime + 0.01) {
                    if (note.data.type === NOTE_TYPE_BURST) {
                        if (!note.started) {
                            note.hit = true;
                            note.started = true;
                            note.burstHitsDone = 1;
                            note.burstLastHitTime = adjustedTime;
                            judgeCallbacks.forEach(cb => cb('good', note.data, {
                                sustainTick: true,
                                phase: 'burst',
                                tickYRatio: 0.5,
                                tickLane: LANE_BOTTOM,
                                burstHitsDone: note.burstHitsDone,
                                burstHitsRequired: note.burstHitsRequired,
                            }));
                        }
                        continue;
                    }
                    const isLong = note.data.type === NOTE_TYPE_SLIDE || note.data.type === NOTE_TYPE_HOLD;
                    if (isLong) {
                        // 롱노트 시작 마킹 (판정은 시작 시 한번만)
                        if (!note.hit) {
                            note.hit = true;
                            note.started = true;
                            judgeCallbacks.forEach(cb => cb('perfect', note.data, { phase: 'start' }));
                        }
                    } else {
                        // 탭은 즉시 처리
                        note.hit = true;
                        note.judged = true;
                        judgeCallbacks.forEach(cb => cb('perfect', note.data, { phase: 'tap' }));
                    }
                }
            }
        }
        // -----------------------

        const lookAhead = (CANVAS_WIDTH - judgeX + NOTE_SPAWN_OFFSET) / speed;
        while (nextNoteIndex < notes.length) {
            const noteData = notes[nextNoteIndex];
            if (noteData.time - adjustedTime > lookAhead) break;

            // 레인 Y좌표 계산
            const laneY = noteData.lane === 0
                ? CANVAS_HEIGHT * LANE_TOP_Y
                : CANVAS_HEIGHT * LANE_BOTTOM_Y;
            const burstY = lerp(CANVAS_HEIGHT * LANE_TOP_Y, CANVAS_HEIGHT * LANE_BOTTOM_Y, 0.5);
            const isBurst = noteData.type === NOTE_TYPE_BURST;

            // 슬라이드 노트 타겟 Y좌표
            const targetLane = noteData.targetLane ?? (noteData.lane === LANE_TOP ? LANE_BOTTOM : LANE_TOP);
            const slideTargetY = targetLane === 0
                ? CANVAS_HEIGHT * LANE_TOP_Y
                : CANVAS_HEIGHT * LANE_BOTTOM_Y;

            // 초기 X 위치 계산
            const timeDiff = noteData.time - adjustedTime;
            const initialX = judgeX + timeDiff * speed;

            // ActiveNote 생성 & 추가
            activeNotes.push({
                data: noteData,
                x: initialX,
                y: isBurst ? burstY : laneY,
                hit: false,
                started: false,
                judged: false,
                holdProgress: 0,
                slideProgress: 0,
                slideStartY: isBurst ? burstY : laneY,
                slideTargetY: slideTargetY,
                tickInterval: (noteData.type === NOTE_TYPE_HOLD || noteData.type === NOTE_TYPE_SLIDE) && (noteData.duration || 0) >= rhythmTickIntervalSec * 1.5 ? rhythmTickIntervalSec : 0,
                nextTickTime: noteData.time + rhythmTickIntervalSec,
                ticksGiven: 0,
                releaseGraceUntil: 0,
                burstHitsRequired: isBurst ? getBurstHitsRequired(noteData) : 0,
                burstHitsDone: 0,
                burstLastHitTime: -Infinity,
            });

            nextNoteIndex++;
        }

        for (let i = 0; i < activeNotes.length; i++) {
            const note = activeNotes[i];
            const timeDiff = note.data.time - adjustedTime;
            const newX = judgeX + timeDiff * speed;
            let newY = note.y;
            let slideProg = note.slideProgress;

            const isLongNote = note.data.type === NOTE_TYPE_SLIDE || note.data.type === NOTE_TYPE_HOLD;
            const noteDuration = isLongNote
                ? getSustainDuration(note.data)
                : (note.data.duration || 0);
            if (note.data.type === NOTE_TYPE_BURST) {
                const burstDuration = getBurstDuration(note.data);
                const burstY = lerp(CANVAS_HEIGHT * LANE_TOP_Y, CANVAS_HEIGHT * LANE_BOTTOM_Y, 0.5);
                const endTime = note.data.time + burstDuration;
                note.y = burstY;
                note.x = note.started && !note.judged ? judgeX : newX;

                if (isAutoPlay && note.started && !note.judged) {
                    while (
                        adjustedTime >= note.burstLastHitTime + BURST_HIT_INTERVAL_SEC
                        && adjustedTime <= endTime + 0.03
                        && note.burstHitsDone < note.burstHitsRequired
                    ) {
                        note.burstHitsDone++;
                        note.burstLastHitTime += BURST_HIT_INTERVAL_SEC;
                        judgeCallbacks.forEach(cb => cb('good', note.data, {
                            sustainTick: true,
                            phase: 'burst',
                            tickYRatio: 0.5,
                            tickLane: LANE_BOTTOM,
                            burstHitsDone: note.burstHitsDone,
                            burstHitsRequired: note.burstHitsRequired,
                        }));
                    }
                    if (note.burstHitsDone >= note.burstHitsRequired) {
                        finalizeBurst(note, adjustedTime);
                    }
                }

                if (!note.judged && adjustedTime > endTime + 0.03) {
                    finalizeBurst(note, adjustedTime, true);
                }
                continue;
            }

            if (isLongNote && noteDuration > 0) {
                const timeIntoNote = -timeDiff;
                // 롱노트는 "입력 시작 시점부터" 헤드를 판정선에 고정해 끝 지점을 읽을 수 있게 한다.
                const sustainEndTime = note.data.time + noteDuration + 0.1;
                const startWindowSec = (LONG_START_WINDOW_MS * assist.missScale) / 1000;
                const inStartPreviewWindow =
                    !note.started
                    && !note.judged
                    && adjustedTime >= note.data.time - LONG_HEAD_PREVIEW_SEC
                    && adjustedTime <= note.data.time + startWindowSec * 0.9;
                const shouldAnchorHead =
                    (note.started && !note.judged && adjustedTime <= sustainEndTime)
                    || inStartPreviewWindow;
                note.x = shouldAnchorHead ? judgeX : newX;

                if (note.data.type === NOTE_TYPE_SLIDE) {
                    // 시작 판정 전에는 대각선 슬라이드가 혼자 진행되지 않도록 고정.
                    const canAdvanceSlide = note.hit || adjustedTime <= note.releaseGraceUntil;
                    if (canAdvanceSlide) {
                        if (timeIntoNote > 0 && timeIntoNote <= noteDuration) {
                            slideProg = timeIntoNote / noteDuration;
                            newY = lerp(note.slideStartY, note.slideTargetY, slideProg);
                        } else if (timeIntoNote > noteDuration) {
                            slideProg = 1;
                            newY = note.slideTargetY;
                        }
                    } else {
                        // 미홀드 중에는 진행을 멈추고 직전 위치를 유지한다.
                        slideProg = note.slideProgress;
                        newY = lerp(note.slideStartY, note.slideTargetY, slideProg);
                    }
                }

                const prevHoldProgress = note.holdProgress;
                let holdProg = note.holdProgress;
                if (timeIntoNote > 0 && timeIntoNote <= noteDuration) {
                    holdProg = timeIntoNote / noteDuration;
                } else if (timeIntoNote > noteDuration) {
                    holdProg = 1;
                }

                note.y = newY;
                note.slideProgress = note.data.type === NOTE_TYPE_SLIDE ? slideProg : note.slideProgress;

                if (note.hit && !note.judged && holdProg >= 0.95) {
                    judgeCallbacks.forEach(cb => cb('perfect', note.data, { phase: 'end' }));
                    note.judged = true;
                    note.holdProgress = 1;
                    if (note.data.type === NOTE_TYPE_SLIDE) {
                        note.slideProgress = 1;
                    }
                    continue;
                }

                // 시작 판정 전(note.started=false)에는 조기 미스 처리하지 않는다.
                // 시작 실패는 LONG_START_WINDOW 기준 미스 로직이 담당한다.
                if (note.started && !note.hit && !note.judged && holdProg > 0.18 && prevHoldProgress > 0 && adjustedTime > note.releaseGraceUntil) {
                    judgeCallbacks.forEach(cb => cb('miss', note.data, { phase: 'miss' }));
                    note.judged = true;
                    note.holdProgress = holdProg;
                    continue;
                }

                if (note.hit && !note.judged && note.tickInterval > 0) {
                    const endTime = note.data.time + noteDuration;
                    const tickCutoff = endTime - 0.12;
                    while (adjustedTime >= note.nextTickTime && note.nextTickTime <= tickCutoff && note.ticksGiven < 16) {
                        const tickTime = note.nextTickTime;
                        const tickProgress = Math.max(0, Math.min(1, (tickTime - note.data.time) / Math.max(0.001, noteDuration)));
                        const tickY = note.data.type === NOTE_TYPE_SLIDE
                            ? lerp(note.slideStartY, note.slideTargetY, tickProgress)
                            : (note.data.lane === LANE_TOP ? CANVAS_HEIGHT * LANE_TOP_Y : CANVAS_HEIGHT * LANE_BOTTOM_Y);
                        const topY = CANVAS_HEIGHT * LANE_TOP_Y;
                        const bottomY = CANVAS_HEIGHT * LANE_BOTTOM_Y;
                        const yDenom = Math.max(1, bottomY - topY);
                        const yRatio = Math.max(0, Math.min(1, (bottomY - tickY) / yDenom));
                        const tickLane = yRatio >= 0.5 ? LANE_TOP : LANE_BOTTOM;
                        judgeCallbacks.forEach(cb => cb('perfect', note.data, {
                            sustainTick: true,
                            phase: 'tick',
                            tickYRatio: yRatio,
                            tickLane,
                            tickProgress,
                        }));
                        note.nextTickTime += note.tickInterval;
                        note.ticksGiven++;
                    }
                }
                note.holdProgress = holdProg;
                continue;
            }

            note.x = newX;
            note.y = newY;
            note.slideProgress = slideProg;
        }

        if (!isAutoPlay) {
            for (let i = 0; i < activeNotes.length; i++) {
                const note = activeNotes[i];
                if (note.judged) continue;
                const timeDiff = (currentTime + audioOffset / 1000 - note.data.time) * 1000;
                if (note.data.type === NOTE_TYPE_BURST) {
                    if (note.started) continue;
                    if (timeDiff > LONG_START_WINDOW_MS * assist.missScale) {
                        finalizeBurst(note, adjustedTime, true);
                    }
                    continue;
                }
                const isLong = note.data.type === NOTE_TYPE_SLIDE || note.data.type === NOTE_TYPE_HOLD;
                if (isLong) {
                    if (note.started) continue;
                    const startMissWindow = LONG_START_WINDOW_MS * assist.missScale;
                    if (timeDiff > startMissWindow) {
                        judgeCallbacks.forEach(cb => { cb('miss', note.data, { phase: 'miss' }); });
                        note.judged = true;
                    }
                    continue;
                }
                if (timeDiff > JUDGE_MISS * assist.missScale) {
                    judgeCallbacks.forEach(cb => { cb('miss', note.data, { phase: 'miss' }); });
                    note.judged = true;
                }
            }
        }

        // 입력 버퍼 처리: 눌렀는데 타이밍이 살짝 빨라 씹히는 케이스 완화
        for (let lane = 0; lane <= 1; lane++) {
            if (adjustedTime > lanePressBufferUntil[lane]) continue;
            let closestIdx = -1;
            let closestDist = Infinity;
            let closestScore = Number.POSITIVE_INFINITY;

            for (let i = 0; i < activeNotes.length; i++) {
                const note = activeNotes[i];
                if (note.judged) continue;
                const isSlide = note.data.type === NOTE_TYPE_SLIDE;
                const isHold = note.data.type === NOTE_TYPE_HOLD;
                const isBurst = note.data.type === NOTE_TYPE_BURST;
                if ((isSlide || isHold) && note.started) continue;
                if (isBurst && note.started) {
                    const burstEnd = note.data.time + getBurstDuration(note.data);
                    if (adjustedTime > burstEnd + 0.03) continue;
                }

                const targetLane = note.data.targetLane ?? (note.data.lane === LANE_TOP ? LANE_BOTTOM : LANE_TOP);
                const laneMatch = isBurst
                    ? true
                    : isSlide
                    ? (note.data.lane === lane || targetLane === lane)
                    : note.data.lane === lane;
                if (!laneMatch) continue;

                const timeDist = Math.abs(adjustedTime - note.data.time) * 1000;
                const visualDist = Math.abs(note.x - judgeX) / Math.max(1, speed) * 1000;
                let dist = timeDist;
                if (isBurst) {
                    if (note.started) {
                        const elapsedMs = Math.max(0, (adjustedTime - note.burstLastHitTime) * 1000);
                        dist = Math.abs(elapsedMs - BURST_HIT_INTERVAL_SEC * 1000) * 0.55;
                    } else {
                        dist = Math.min(timeDist * 0.9, visualDist * 1.02);
                    }
                }
                if (isSlide || isHold) dist = Math.min(timeDist * 0.82, visualDist * 1.08);
                dist *= assist.timingScale;

                const missWindow = isBurst
                    ? ((note.started ? JUDGE_MISS : LONG_START_WINDOW_MS) * assist.missScale)
                    : ((isSlide || isHold) ? LONG_START_WINDOW_MS : JUDGE_MISS) * assist.missScale;
                if (dist > missWindow) continue;

                const longFar = (isSlide || isHold) && timeDist > JUDGE_GREAT * 1.35;
                const priority = isBurst
                    ? 3.2
                    : (isSlide || isHold)
                        ? (longFar ? 1.35 : 2.2)
                        : 1.8;
                const longStartBonus = (isSlide || isHold) && !note.started ? 0.12 : 0;
                const futureTapPenalty = (!isSlide && !isHold && !isBurst && note.data.time > adjustedTime + 0.065) ? 0.16 : 0;
                const score = (dist / Math.max(1, missWindow)) - priority * 0.08 - longStartBonus + futureTapPenalty;
                if (score < closestScore || (Math.abs(score - closestScore) < 1e-6 && dist < closestDist)) {
                    closestScore = score;
                    closestDist = dist;
                    closestIdx = i;
                }
            }

            const longOverride = pickLongStartOverride(
                lane,
                adjustedTime,
                judgeX,
                speed,
                closestIdx,
                closestDist
            );
            if (longOverride) {
                closestIdx = longOverride.idx;
                closestDist = longOverride.distMs;
            }

            if (closestIdx === -1) continue;
            const note = activeNotes[closestIdx];
            if (note.data.type === NOTE_TYPE_BURST) {
                const burstDuration = getBurstDuration(note.data);
                const burstEnd = note.data.time + burstDuration;
                if (!note.started) {
                    if (closestDist > JUDGE_GOOD * 1.2) {
                        lanePressBufferUntil[lane] = -1;
                        continue;
                    }
                    note.hit = true;
                    note.started = true;
                    note.burstHitsDone = 1;
                    note.burstLastHitTime = adjustedTime;
                    judgeCallbacks.forEach(cb => cb('good', note.data, {
                        sustainTick: true,
                        phase: 'burst',
                        tickYRatio: 0.5,
                        tickLane: LANE_BOTTOM,
                        burstHitsDone: note.burstHitsDone,
                        burstHitsRequired: note.burstHitsRequired,
                    }));
                    lanePressBufferUntil[lane] = -1;
                    continue;
                }

                if (adjustedTime > burstEnd + 0.03) {
                    finalizeBurst(note, adjustedTime, true);
                    lanePressBufferUntil[lane] = -1;
                    continue;
                }
                const elapsedSinceHit = adjustedTime - note.burstLastHitTime;
                if (elapsedSinceHit < BURST_HIT_INTERVAL_SEC * 0.68) {
                    lanePressBufferUntil[lane] = -1;
                    continue;
                }
                note.burstHitsDone = Math.min(note.burstHitsRequired, note.burstHitsDone + 1);
                note.burstLastHitTime = adjustedTime;
                judgeCallbacks.forEach(cb => cb('good', note.data, {
                    sustainTick: true,
                    phase: 'burst',
                    tickYRatio: 0.5,
                    tickLane: LANE_BOTTOM,
                    burstHitsDone: note.burstHitsDone,
                    burstHitsRequired: note.burstHitsRequired,
                }));
                if (note.burstHitsDone >= note.burstHitsRequired) {
                    finalizeBurst(note, adjustedTime);
                }
                lanePressBufferUntil[lane] = -1;
                continue;
            }
            const isLongStart = note.data.type === NOTE_TYPE_SLIDE || note.data.type === NOTE_TYPE_HOLD;
            // 버퍼 입력은 miss를 강제하지 않는다.
            // 어긋난 입력은 무시하고, 실제 miss는 노트 통과 시 자동 미스 경로에서 처리.
            const longStartAccept = LONG_START_WINDOW_MS * assist.missScale * LONG_START_ACCEPT_RATIO;
            const acceptWindow = isLongStart ? longStartAccept : JUDGE_GOOD;
            if (closestDist > acceptWindow) {
                lanePressBufferUntil[lane] = -1;
                continue;
            }

            const result: JudgeResult = closestDist <= JUDGE_PERFECT
                ? 'perfect'
                : closestDist <= JUDGE_GREAT
                    ? 'great'
                    : 'good';

            if (isLongStart) {
                note.hit = true;
                note.started = true;
                note.releaseGraceUntil = adjustedTime + 0.24;
            } else {
                note.hit = true;
                note.judged = true;
            }

            const meta: JudgeMeta = isLongStart ? { phase: 'start' } : { phase: 'tap' };
            judgeCallbacks.forEach(cb => cb(result, note.data, meta));
            lanePressBufferUntil[lane] = -1;
        }

        activeNotes = activeNotes.filter(note => {
            if (note.data.type === NOTE_TYPE_BURST) {
                const endTime = note.data.time + getBurstDuration(note.data);
                if (!note.judged) {
                    return adjustedTime <= endTime + 0.22;
                }
                return adjustedTime <= endTime + 0.08;
            }
            const isLong = note.data.type === NOTE_TYPE_SLIDE || note.data.type === NOTE_TYPE_HOLD;
            const duration = isLong
                ? getSustainDuration(note.data)
                : (note.data.duration || 0);
            const endTime = note.data.time + duration;

            // 롱노트는 헤드가 화면을 벗어나도 종료 시점까지 유지
            if (isLong) {
                if (!note.judged) {
                    return adjustedTime <= endTime + 0.22;
                }
                return adjustedTime <= endTime + 0.08;
            }

            if (note.judged && note.x < -NOTE_SIZE) return false;
            if (note.x < -NOTE_SIZE * 2) return false;
            return true;
        });
    };

    const tryJudge = (lane: number, currentTime: number): JudgeResult | null => {
        const adjustedTime = currentTime + (audioOffset + inputOffset) / 1000;
        const judgeX = CANVAS_WIDTH * JUDGE_LINE_X;
        const speed = NOTE_SPEED_BASE * noteSpeed;

        let closestIdx = -1;
        let closestDist = Infinity;
        let closestScore = Number.POSITIVE_INFINITY;

        for (let i = 0; i < activeNotes.length; i++) {
            const note = activeNotes[i];
            if (note.judged) continue;

            const isSlide = note.data.type === NOTE_TYPE_SLIDE;
            const isHold = note.data.type === NOTE_TYPE_HOLD;
            const isBurst = note.data.type === NOTE_TYPE_BURST;
            const targetLane = note.data.targetLane ?? (note.data.lane === LANE_TOP ? LANE_BOTTOM : LANE_TOP);
            const isInStartLane = note.data.lane === lane;
            const isInTargetLane = isSlide && targetLane === lane;
            const allowCrossLaneTap = !isSlide && !isHold && assist.crossLaneAssist > 0;
            const isCrossLaneTap = !isBurst && allowCrossLaneTap && !isInStartLane;
            const burstEnd = note.data.time + getBurstDuration(note.data);

            // 시작된 롱노트는 재판정하지 않음 (유지는 update/release에서 처리)
            if ((isSlide || isHold) && note.hit) continue;
            if (isBurst && note.started && adjustedTime > burstEnd + 0.03) continue;

            // 슬라이드는 시작/도착 레인 모두 시작 가능(도착 레인은 소폭 페널티)
            if (isBurst) {
                // 버스트는 양 레인 입력 모두 허용
            } else if (isSlide) {
                if (!isInStartLane && !isInTargetLane) continue;
            } else if (!isInStartLane && !allowCrossLaneTap) {
                continue;
            }

            const timeDist = Math.abs(adjustedTime - note.data.time) * 1000;
            const visualDist = Math.abs(note.x - judgeX) / Math.max(1, speed) * 1000;
            let dist = timeDist;
            if (isBurst) {
                if (note.started) {
                    const elapsedMs = Math.max(0, (adjustedTime - note.burstLastHitTime) * 1000);
                    dist = Math.abs(elapsedMs - BURST_HIT_INTERVAL_SEC * 1000) * 0.55;
                } else {
                    dist = Math.min(timeDist * 0.9, visualDist * 1.02);
                }
            }
            if (isSlide || isHold) {
                // 롱노트 시작은 시간+판정선 거리 하이브리드로 씹힘 완화
                dist = Math.min(timeDist * 0.82, visualDist * 1.08);
            }
            if (isSlide && isInTargetLane && !isInStartLane) {
                dist *= 1.12;
            }
            if (isCrossLaneTap) {
                const crossPenalty = 1.55 - assist.crossLaneAssist * 0.43;
                dist *= crossPenalty;
            }
            dist *= assist.timingScale;
            const missWindow = (
                isBurst
                    ? (note.started ? JUDGE_MISS : LONG_START_WINDOW_MS)
                    : (isSlide || isHold ? LONG_START_WINDOW_MS : JUDGE_MISS)
            ) * assist.missScale;
            if (dist > missWindow) continue;
            const longFar = (isSlide || isHold) && timeDist > JUDGE_GREAT * 1.35;
            const priority = isBurst
                ? 3.2
                : (isSlide || isHold)
                    ? (longFar ? 1.35 : 2.2)
                    : 1.8;
            const longStartBonus = (isSlide || isHold) && !note.started ? 0.12 : 0;
            const futureTapPenalty = (!isSlide && !isHold && !isBurst && note.data.time > adjustedTime + 0.065) ? 0.16 : 0;
            const score = (dist / Math.max(1, missWindow)) - priority * 0.08 - longStartBonus + futureTapPenalty;
            if (score < closestScore || (Math.abs(score - closestScore) < 1e-6 && dist < closestDist)) {
                closestScore = score;
                closestDist = dist;
                closestIdx = i;
            }
        }

        const longOverride = pickLongStartOverride(
            lane,
            adjustedTime,
            judgeX,
            speed,
            closestIdx,
            closestDist
        );
        if (longOverride) {
            closestIdx = longOverride.idx;
            closestDist = longOverride.distMs;
        }

        if (closestIdx === -1) return null;

        let result: JudgeResult;
        const note = activeNotes[closestIdx];
        if (note.data.type === NOTE_TYPE_BURST) {
            const burstDuration = getBurstDuration(note.data);
            const burstEnd = note.data.time + burstDuration;
            if (!note.started) {
                if (closestDist > LONG_START_WINDOW_MS * assist.missScale) return null;
                note.hit = true;
                note.started = true;
                note.burstHitsDone = 1;
                note.burstLastHitTime = adjustedTime;
                judgeCallbacks.forEach(cb => cb('good', note.data, {
                    sustainTick: true,
                    phase: 'burst',
                    tickYRatio: 0.5,
                    tickLane: LANE_BOTTOM,
                    burstHitsDone: note.burstHitsDone,
                    burstHitsRequired: note.burstHitsRequired,
                }));
                return 'good';
            }
            if (adjustedTime > burstEnd + 0.03) {
                finalizeBurst(note, adjustedTime, true);
                return 'miss';
            }
            if (adjustedTime - note.burstLastHitTime < BURST_HIT_INTERVAL_SEC * 0.68) {
                return null;
            }
            note.burstHitsDone = Math.min(note.burstHitsRequired, note.burstHitsDone + 1);
            note.burstLastHitTime = adjustedTime;
            judgeCallbacks.forEach(cb => cb('good', note.data, {
                sustainTick: true,
                phase: 'burst',
                tickYRatio: 0.5,
                tickLane: LANE_BOTTOM,
                burstHitsDone: note.burstHitsDone,
                burstHitsRequired: note.burstHitsRequired,
            }));
            if (note.burstHitsDone >= note.burstHitsRequired) {
                finalizeBurst(note, adjustedTime);
                const completionRatio = Math.max(0, Math.min(1.2, (adjustedTime - note.data.time) / Math.max(0.001, burstDuration)));
                return getBurstCompletionJudge(note.burstHitsDone, note.burstHitsRequired, completionRatio);
            }
            return 'good';
        }
        const isHold = note.data.type === NOTE_TYPE_HOLD;
        const isSlide = note.data.type === NOTE_TYPE_SLIDE;
        const isLongStart = isSlide || isHold;
        const missWindow = (isLongStart ? LONG_START_WINDOW_MS : JUDGE_MISS) * assist.missScale;
        if (closestDist > missWindow) return null;
        if (closestDist <= JUDGE_PERFECT) result = 'perfect';
        else if (closestDist <= JUDGE_GREAT) result = 'great';
        else if (closestDist <= JUDGE_GOOD) result = 'good';
        else if (isLongStart) result = 'good';
        else return null;

        const target = activeNotes[closestIdx];
        if (isLongStart) {
            // 롱노트는 시작 판정만 수행. 종료 판정은 유지/릴리즈 로직에서 담당.
            target.hit = true;
            target.started = true;
            target.releaseGraceUntil = adjustedTime + 0.24;
        } else {
            target.hit = true;
            target.judged = true;
        }

        const meta: JudgeMeta = isLongStart ? { phase: 'start' } : { phase: 'tap' };
        judgeCallbacks.forEach(cb => { cb(result, target.data, meta); });
        return result;
    };

    /** 롱노트 홀드 상태 업데이트 (매 프레임 호출) */
    const updateHoldState = (laneHeld: readonly boolean[], currentTime: number): void => {
        // 오토플레이 중이면 항상 홀드 유지
        if (isAutoPlay) return;
        const adjustedTime = currentTime + (audioOffset + inputOffset) / 1000;

        const isSlideHeld = (
            note: ActiveNote,
            adjustedTimeNow: number,
            startHeld: boolean,
            targetHeld: boolean
        ): boolean => {
            if (note.data.type !== NOTE_TYPE_SLIDE) {
                return startHeld;
            }
            const targetLane = note.data.targetLane ?? (note.data.lane === 0 ? 1 : 0);
            const isDiagonal = targetLane !== note.data.lane;
            if (!isDiagonal) {
                return startHeld || targetHeld;
            }
            const duration = getSustainDuration(note.data);
            const batonLike = currentDifficulty === 'expert' || currentDifficulty === 'hard'
                ? duration >= Math.max(0.92, rhythmTickIntervalSec * 2.2)
                : currentDifficulty === 'normal'
                    ? duration >= Math.max(1.18, rhythmTickIntervalSec * 2.7)
                    : false;
            if (!batonLike) {
                return startHeld || targetHeld;
            }
            const progress = Math.max(0, Math.min(1, (adjustedTimeNow - note.data.time) / Math.max(0.001, duration)));
            if (progress < 0.42) return startHeld;
            if (progress <= 0.62) return startHeld || targetHeld;
            return targetHeld;
        };

        // 롱노트 시작 자동 인식:
        // 키를 미리 누르고 있어도 시작 타이밍에 진입하면 판정 시작.
        for (let i = 0; i < activeNotes.length; i++) {
            const note = activeNotes[i];
            if (note.judged || note.hit) continue;
            const isLong = note.data.type === NOTE_TYPE_SLIDE || note.data.type === NOTE_TYPE_HOLD;
            if (!isLong) continue;

            const startHeld = laneHeld[note.data.lane] ?? false;
            const targetLane = note.data.targetLane ?? (note.data.lane === 0 ? 1 : 0);
            const targetHeld = laneHeld[targetLane] ?? false;
            const isHeld = isSlideHeld(note, adjustedTime, startHeld, targetHeld);
            if (!isHeld) continue;

            const timeDist = Math.abs(adjustedTime - note.data.time) * 1000;
            const judgeX = CANVAS_WIDTH * JUDGE_LINE_X;
            const speed = NOTE_SPEED_BASE * noteSpeed;
            const visualDist = Math.abs(note.x - judgeX) / Math.max(1, speed) * 1000;
            const distMs = Math.min(timeDist, visualDist * 1.06);
            if (distMs > LONG_START_WINDOW_MS * assist.missScale) continue;

            const scaledDistMs = distMs * assist.timingScale;
            // 미리 누르고 있는 상태(auto-start)에서는 miss를 선고하지 않는다.
            // 타이밍이 맞는 순간에만 시작 판정을 부여하고, miss는 기존 자동 미스 경로가 담당한다.
            if (scaledDistMs > JUDGE_GOOD) continue;

            let result: JudgeResult;
            if (scaledDistMs <= JUDGE_PERFECT) result = 'perfect';
            else if (scaledDistMs <= JUDGE_GREAT) result = 'great';
            else result = 'good';

            judgeCallbacks.forEach(cb => cb(result, note.data, { phase: 'start' }));
            note.hit = true;
            note.started = true;
            note.releaseGraceUntil = adjustedTime + 0.24;
        }

        for (let i = 0; i < activeNotes.length; i++) {
            const note = activeNotes[i];
            if (note.judged || !note.hit) continue;

            const isLong = note.data.type === NOTE_TYPE_SLIDE || note.data.type === NOTE_TYPE_HOLD;
            if (!isLong) continue;

            const startHeld = laneHeld[note.data.lane] ?? false;
            const targetLane = note.data.targetLane ?? (note.data.lane === 0 ? 1 : 0);
            const targetHeld = laneHeld[targetLane] ?? false;
            const isHeld = isSlideHeld(note, adjustedTime, startHeld, targetHeld);
            if (!isHeld) {
                // 키를 뗀 직후 아주 짧은 복구 유예 부여
                note.hit = false;
                note.releaseGraceUntil = adjustedTime + 0.24;
            }
        }

        // 유예 시간 내 재홀드 허용
        for (let i = 0; i < activeNotes.length; i++) {
            const note = activeNotes[i];
            if (note.judged || note.hit) continue;
            const isLong = note.data.type === NOTE_TYPE_SLIDE || note.data.type === NOTE_TYPE_HOLD;
            if (!isLong) continue;
            const duration = getSustainDuration(note.data);
            if (duration <= 0) continue;
            if (adjustedTime > note.data.time + duration) continue;
            const startHeld = laneHeld[note.data.lane] ?? false;
            const targetLane = note.data.targetLane ?? (note.data.lane === 0 ? 1 : 0);
            const targetHeld = laneHeld[targetLane] ?? false;
            const isHeldNow = isSlideHeld(note, adjustedTime, startHeld, targetHeld);
            if (isHeldNow && adjustedTime <= note.releaseGraceUntil) {
                note.hit = true;
            }
        }
    };

    /** 롱노트 키 릴리즈 처리 */
    const releaseHold = (
        lane: number,
        currentTime: number,
        laneHeld?: readonly boolean[]
    ): void => {
        if (isAutoPlay) return;

        const adjustedTime = currentTime + (audioOffset + inputOffset) / 1000;
        const heldAt = (idx: number): boolean => {
            if (!laneHeld) return false;
            if (idx < 0 || idx >= laneHeld.length) return false;
            return !!laneHeld[idx];
        };

        for (let i = 0; i < activeNotes.length; i++) {
            const note = activeNotes[i];
            if (note.judged || !note.hit) continue;

            const isLong = note.data.type === NOTE_TYPE_SLIDE || note.data.type === NOTE_TYPE_HOLD;
            if (!isLong) continue;

            // 슬라이드는 시작/목표 레인 릴리즈를 모두 처리
            const targetLane = note.data.targetLane ?? (note.data.lane === 0 ? 1 : 0);
            const isRelatedLane = lane === note.data.lane || (note.data.type === NOTE_TYPE_SLIDE && lane === targetLane);
            if (!isRelatedLane) continue;

            // 다중 바인딩/양손 입력에서 해당 롱노트를 여전히 유지 중이면 release 판정을 하지 않는다.
            const startHeld = heldAt(note.data.lane);
            const targetHeld = heldAt(targetLane);
            const stillHeld = note.data.type === NOTE_TYPE_SLIDE
                ? (() => {
                    const isDiagonal = targetLane !== note.data.lane;
                    const duration = getSustainDuration(note.data);
                    const batonLike = isDiagonal && (
                        currentDifficulty === 'expert' || currentDifficulty === 'hard'
                            ? duration >= Math.max(0.92, rhythmTickIntervalSec * 2.2)
                            : currentDifficulty === 'normal'
                                ? duration >= Math.max(1.18, rhythmTickIntervalSec * 2.7)
                                : false
                    );
                    if (!batonLike) return startHeld || targetHeld;
                    const progressNow = Math.max(0, Math.min(1, (adjustedTime - note.data.time) / Math.max(0.001, duration)));
                    if (progressNow < 0.42) return startHeld;
                    if (progressNow <= 0.62) return startHeld || targetHeld;
                    return targetHeld;
                })()
                : startHeld;
            if (stillHeld) continue;

            // 진행도에 따라 판정
            const duration = getSustainDuration(note.data);
            if (duration <= 0) continue;

            const timeIntoNote = adjustedTime - note.data.time;
            const progress = Math.min(1, timeIntoNote / duration);

            // 초반 릴리즈는 즉시 종료하지 않고, 짧은 유예 후 복구 가능하게 처리.
            if (progress < 0.9) {
                note.hit = false;
                note.releaseGraceUntil = adjustedTime + 0.24;
                continue;
            }

            let result: JudgeResult;
            if (progress >= 0.95) {
                result = 'perfect';
            } else if (progress >= 0.8) {
                result = 'great';
            } else if (progress >= 0.55) {
                result = 'good';
            } else {
                result = 'miss';
            }

            judgeCallbacks.forEach(cb => cb(result, note.data, { phase: result === 'miss' ? 'miss' : 'end' }));
            note.judged = true;
            note.hit = false;
        }
    };

    const render = (ctx: CanvasRenderingContext2D): void => {
        const judgeX = CANVAS_WIDTH * JUDGE_LINE_X;
        const speed = NOTE_SPEED_BASE * noteSpeed;
        const visualShift = (visualOffset / 1000) * speed;

        for (const note of activeNotes) {
            if (note.judged && note.hit && Math.abs(note.x + visualShift - judgeX) > NOTE_SIZE * 0.9) continue;

            const { x, y, data } = note;
            const drawX = x + visualShift;
            const size = NOTE_SIZE;
            const isBurst = data.type === NOTE_TYPE_BURST;
            const isTop = data.lane === 0;
            const color = isBurst ? COLORS.accent : (isTop ? COLORS.noteTop : COLORS.noteBottom);

            // 판정선까지 거리 기반 근접도 (0=멀리, 1=판정선 위)
            const dist = Math.max(0, drawX - judgeX);
            const approachRange = CANVAS_WIDTH * 0.35;
            const proximity = 1 - Math.min(1, dist / approachRange);

            const judgeCross = Math.max(0, 1 - Math.abs(drawX - judgeX) / 28);
            if (!note.judged && judgeCross > 0) {
                ctx.save();
                ctx.globalCompositeOperation = 'lighter';
                ctx.fillStyle = `rgba(255,255,255,${(judgeCross * 0.22).toFixed(3)})`;
                ctx.beginPath();
                ctx.arc(drawX, y, size * (0.9 + judgeCross * 0.35), 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            }

            ctx.save();
            ctx.translate(drawX, y);

            if (note.judged && !note.hit) {
                ctx.globalAlpha = 0.3;
            }

            // 속도감 트레일 (판정선 접근시 강화)
            if (proximity > 0.35 && !note.judged) {
                const trailCount = Math.min(3, Math.floor((proximity - 0.35) * 5));
                for (let t = 1; t <= trailCount; t++) {
                    const trailOffset = t * 12;
                    const trailAlpha = (proximity - 0.35) * 0.12 / t;
                    const trailSize = size * (0.2 - t * 0.03);
                    ctx.globalAlpha = trailAlpha;
                    const tGrad = ctx.createRadialGradient(trailOffset, 0, 0, trailOffset, 0, trailSize);
                    tGrad.addColorStop(0, `${color}60`);
                    tGrad.addColorStop(1, `${color}00`);
                    ctx.fillStyle = tGrad;
                    ctx.beginPath();
                    ctx.arc(trailOffset, 0, trailSize, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.globalAlpha = note.judged && !note.hit ? 0.3 : 1.0;
            }

            if (data.type === NOTE_TYPE_HOLD && data.duration) {
                const tailLength = data.duration * NOTE_SPEED_BASE * noteSpeed;
                const holdH = size * 0.24;
                const holdGrad = ctx.createLinearGradient(-size * 0.3, 0, tailLength, 0);
                holdGrad.addColorStop(0, '#1b1230');
                holdGrad.addColorStop(0.18, `${color}d8`);
                holdGrad.addColorStop(0.62, `${color}9a`);
                holdGrad.addColorStop(1, `${color}45`);
                ctx.fillStyle = holdGrad;
                ctx.beginPath();
                ctx.roundRect(-size * 0.28, -holdH * 0.5, tailLength, holdH, 9);
                ctx.fill();
                ctx.strokeStyle = 'rgba(255,255,255,0.78)';
                ctx.lineWidth = 1.8;
                ctx.beginPath();
                ctx.moveTo(-size * 0.12, 0);
                ctx.lineTo(tailLength - 6, 0);
                ctx.stroke();

                ctx.strokeStyle = `${color}a8`;
                ctx.lineWidth = 1.2;
                ctx.beginPath();
                ctx.roundRect(-size * 0.28, -holdH * 0.5, tailLength, holdH, 9);
                ctx.stroke();

                ctx.fillStyle = '#ffffffc0';
                ctx.beginPath();
                ctx.arc(tailLength - size * 0.28, 0, holdH * 0.42, 0, Math.PI * 2);
                ctx.fill();
            }

            if (data.type === NOTE_TYPE_HOLD) {
                renderTapNote(ctx, size, color, proximity, isTop);
            } else if (data.type === NOTE_TYPE_SLIDE) {
                renderSlideNote(ctx, note, size, color, proximity);
            } else if (data.type === NOTE_TYPE_BURST) {
                renderBurstNote(ctx, note, size, color, proximity);
            } else {
                renderTapNote(ctx, size, color, proximity, isTop);
            }

            ctx.restore();
        }
    };


    const renderTapNote = (ctx: CanvasRenderingContext2D, size: number, color: string, proximity: number, isTop: boolean): void => {
        const proxScale = 1 + proximity * 0.13;
        const radius = size * 0.5 * proxScale;
        const pulse = 0.5 + Math.sin(performance.now() * 0.006) * 0.5;
        const accent = isTop ? '#74dfff' : '#ff7fbe';

        if (proximity > 0.22) {
            const glowR = radius * (1.3 + proximity * 0.2);
            const glow = ctx.createRadialGradient(0, 0, radius * 0.3, 0, 0, glowR);
            glow.addColorStop(0, `rgba(255,255,255,${(0.16 + pulse * 0.08).toFixed(3)})`);
            glow.addColorStop(1, `${accent}00`);
            ctx.fillStyle = glow;
            ctx.beginPath();
            ctx.arc(0, 0, glowR, 0, Math.PI * 2);
            ctx.fill();
        }

        // separation outline: improves readability over bright roads
        ctx.strokeStyle = `rgba(0,0,0,${(0.26 + proximity * 0.18).toFixed(3)})`;
        ctx.lineWidth = 3.8;
        ctx.beginPath();
        ctx.arc(0, 0, radius * 1.2, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = `rgba(255,255,255,${(0.28 + proximity * 0.25).toFixed(3)})`;
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.arc(0, 0, radius * 1.2, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = '#1b1230';
        ctx.beginPath();
        ctx.arc(0, 0, radius * 1.02, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = `${accent}b8`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, radius * 0.99, 0, Math.PI * 2);
        ctx.stroke();

        const coreGrad = ctx.createLinearGradient(-radius, -radius, radius, radius);
        coreGrad.addColorStop(0, '#fff6ff');
        coreGrad.addColorStop(0.42, accent);
        coreGrad.addColorStop(1, color);
        ctx.save();
        ctx.rotate(Math.PI / 4);
        const coreSize = radius * 0.96;
        ctx.fillStyle = coreGrad;
        ctx.fillRect(-coreSize * 0.5, -coreSize * 0.5, coreSize, coreSize);
        ctx.fillStyle = 'rgba(255,255,255,0.78)';
        ctx.fillRect(-coreSize * 0.18, -coreSize * 0.18, coreSize * 0.36, coreSize * 0.36);
        ctx.restore();

        ctx.strokeStyle = `rgba(255,255,255,${(0.7 + proximity * 0.16).toFixed(3)})`;
        ctx.lineWidth = 2.4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        if (isTop) {
            ctx.moveTo(-radius * 0.3, radius * 0.04);
            ctx.lineTo(0, -radius * 0.24);
            ctx.lineTo(radius * 0.3, radius * 0.04);
        } else {
            ctx.moveTo(-radius * 0.3, -radius * 0.04);
            ctx.lineTo(0, radius * 0.24);
            ctx.lineTo(radius * 0.3, -radius * 0.04);
        }
        ctx.stroke();
    };

    const renderBurstNote = (
        ctx: CanvasRenderingContext2D,
        note: ActiveNote,
        size: number,
        color: string,
        proximity: number
    ): void => {
        const proxScale = 1 + proximity * 0.08;
        const radius = size * 0.5 * proxScale;
        const progress = note.burstHitsRequired > 0
            ? Math.max(0, Math.min(1, note.burstHitsDone / note.burstHitsRequired))
            : 0;
        const pulse = 0.5 + Math.sin(performance.now() * 0.018 + note.data.time * 4.3) * 0.5;

        // outer glow
        ctx.fillStyle = `rgba(255, 214, 86, ${(0.18 + pulse * 0.12).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(0, 0, radius * (1.5 + pulse * 0.2), 0, Math.PI * 2);
        ctx.fill();

        // shell
        ctx.fillStyle = '#2e1a10';
        ctx.beginPath();
        ctx.arc(0, 0, radius * 1.08, 0, Math.PI * 2);
        ctx.fill();

        // core
        const core = ctx.createRadialGradient(-radius * 0.32, -radius * 0.34, radius * 0.2, 0, 0, radius * 1.16);
        core.addColorStop(0, '#fff8d7');
        core.addColorStop(0.28, '#ffe38a');
        core.addColorStop(1, color);
        ctx.fillStyle = core;
        ctx.beginPath();
        ctx.arc(0, 0, radius * 0.85, 0, Math.PI * 2);
        ctx.fill();

        // burst icon
        ctx.strokeStyle = '#fff6cf';
        ctx.lineWidth = 2.1;
        for (let i = 0; i < 6; i++) {
            const a = (Math.PI * 2 * i) / 6 + pulse * 0.06;
            const r1 = radius * 0.2;
            const r2 = radius * 0.52;
            ctx.beginPath();
            ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
            ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
            ctx.stroke();
        }

        // progress ring
        ctx.strokeStyle = `${color}e0`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, 0, radius * 1.22, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
        ctx.stroke();

        const seg = Math.max(3, note.burstHitsRequired || 4);
        for (let i = 0; i < seg; i++) {
            const a0 = -Math.PI / 2 + (i / seg) * Math.PI * 2 + 0.03;
            const a1 = -Math.PI / 2 + ((i + 1) / seg) * Math.PI * 2 - 0.03;
            ctx.strokeStyle = i < note.burstHitsDone
                ? 'rgba(255,230,120,0.95)'
                : 'rgba(255,255,255,0.18)';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(0, 0, radius * 1.34, a0, a1);
            ctx.stroke();
        }
    };

    const renderHoldHeadNote = (
        ctx: CanvasRenderingContext2D,
        size: number,
        color: string,
        proximity: number,
        isTop: boolean
    ): void => {
        const proxScale = 1 + proximity * 0.08;
        const w = size * 1.18 * proxScale;
        const h = size * 0.62 * proxScale;
        const r = h * 0.42;

        ctx.fillStyle = '#180f2a';
        ctx.beginPath();
        ctx.roundRect(-w * 0.52, -h * 0.5, w * 1.04, h, r);
        ctx.fill();

        const body = ctx.createLinearGradient(-w * 0.5, 0, w * 0.5, 0);
        body.addColorStop(0, `${color}d0`);
        body.addColorStop(1, `${color}84`);
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.roundRect(-w * 0.48, -h * 0.42, w * 0.96, h * 0.84, r * 0.82);
        ctx.fill();

        ctx.strokeStyle = 'rgba(255,255,255,0.78)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(-w * 0.48, -h * 0.42, w * 0.96, h * 0.84, r * 0.82);
        ctx.stroke();

        const barW = size * 0.09;
        const barH = size * 0.28;
        const gap = size * 0.11;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.roundRect(-gap - barW, -barH * 0.5, barW, barH, barW * 0.45);
        ctx.roundRect(gap, -barH * 0.5, barW, barH, barW * 0.45);
        ctx.fill();

        ctx.fillStyle = 'rgba(255,255,255,0.86)';
        ctx.beginPath();
        if (isTop) {
            ctx.moveTo(0, -h * 0.62);
            ctx.lineTo(-size * 0.12, -h * 0.42);
            ctx.lineTo(size * 0.12, -h * 0.42);
        } else {
            ctx.moveTo(0, h * 0.62);
            ctx.lineTo(-size * 0.12, h * 0.42);
            ctx.lineTo(size * 0.12, h * 0.42);
        }
        ctx.closePath();
        ctx.fill();
    };

    const renderSlideNote = (ctx: CanvasRenderingContext2D, note: ActiveNote, size: number, color: string, proximity: number): void => {
        const proxScale = 1 + proximity * 0.12;

        // 슬라이드 진행도
        const slideDuration = getSustainDuration(note.data);
        const progress = Math.min(1, Math.max(0, note.slideProgress));
        const remain = 1 - progress;
        const remainingDy = note.slideTargetY - note.y;
        const nowPulse = 0.5 + Math.sin(performance.now() * 0.012 + note.data.time * 7.7) * 0.5;
        const fullDx = Math.max(12, slideDuration * NOTE_SPEED_BASE * noteSpeed);
        const fullDy = note.slideTargetY - note.slideStartY;
        const isDiagonalSlide = Math.abs(fullDy) > size * 0.2;
        const batonVisualEligible = currentDifficulty === 'expert' || currentDifficulty === 'hard'
            ? slideDuration >= Math.max(0.92, rhythmTickIntervalSec * 2.2)
            : currentDifficulty === 'normal'
                ? slideDuration >= Math.max(1.18, rhythmTickIntervalSec * 2.7)
                : false;
        const isBatonStyle = isDiagonalSlide && batonVisualEligible;

        // 테일 그리기 (연결부) - 최적화된 단순 라인
        if (slideDuration > 0) {
            const tailLength = Math.max(0, remain * (slideDuration * NOTE_SPEED_BASE * noteSpeed));
            const endY = remainingDy;

            // 외곽 글로우
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(tailLength, endY);
            ctx.lineCap = 'round';
            ctx.strokeStyle = `${color}20`;
            ctx.lineWidth = 22;
            ctx.stroke();

            // 외곽 스트랩
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(tailLength, endY);
            ctx.strokeStyle = '#1a1230';
            ctx.lineWidth = 16;
            ctx.stroke();

            // 바디 (더 선명한 그라디언트)
            const bodyGrad = ctx.createLinearGradient(0, 0, tailLength, endY);
            bodyGrad.addColorStop(0, '#ffffff');
            bodyGrad.addColorStop(0.15, color);
            bodyGrad.addColorStop(0.6, color);
            bodyGrad.addColorStop(1, `${color}55`);
            ctx.strokeStyle = bodyGrad;
            ctx.lineWidth = 11;
            ctx.stroke();

            // 코어 하이라이트 (그라디언트 페이드)
            const coreGrad = ctx.createLinearGradient(0, 0, tailLength, endY);
            coreGrad.addColorStop(0, '#ffffffdd');
            coreGrad.addColorStop(0.4, '#ffffff88');
            coreGrad.addColorStop(1, '#ffffff22');
            ctx.strokeStyle = coreGrad;
            ctx.lineWidth = 3.5;
            ctx.stroke();

            // 끝점까지 남은 경로 구간 표시 (가독성 향상)
            const markerCount = Math.min(4, Math.max(1, Math.floor(remain * 4.5)));
            for (let i = 1; i <= markerCount; i++) {
                const t = i / (markerCount + 1);
                const mx = tailLength * t;
                const my = endY * t;
                const r = (1.7 + (1 - t) * 1.2) * proxScale;
                ctx.fillStyle = `rgba(255,255,255,${(0.14 + (1 - t) * 0.17).toFixed(3)})`;
                ctx.beginPath();
                ctx.arc(mx, my, r, 0, Math.PI * 2);
                ctx.fill();
            }

            if (isDiagonalSlide) {
                const hatchStep = Math.max(24, size * 0.95);
                const hatchCount = Math.min(6, Math.max(2, Math.floor(tailLength / hatchStep)));
                ctx.strokeStyle = 'rgba(255,255,255,0.22)';
                ctx.lineWidth = 1.35;
                for (let i = 1; i <= hatchCount; i++) {
                    const t = i / (hatchCount + 1);
                    const hx = tailLength * t;
                    const hy = endY * t;
                    const dir = endY >= 0 ? 1 : -1;
                    ctx.beginPath();
                    ctx.moveTo(hx - 4.2, hy - dir * 4.2);
                    ctx.lineTo(hx + 4.2, hy + dir * 4.2);
                    ctx.stroke();
                }
            }

            if (isBatonStyle) {
                const batonT = 0.55;
                const bx = tailLength * batonT;
                const by = endY * batonT;
                const batonR = (4.6 + proximity * 2.1) * proxScale;
                ctx.fillStyle = 'rgba(255,250,230,0.74)';
                ctx.beginPath();
                ctx.arc(bx, by, batonR * 1.42, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#ffffff';
                ctx.beginPath();
                ctx.arc(bx, by, batonR * 0.78, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = `${color}cc`;
                ctx.lineWidth = 1.6;
                ctx.beginPath();
                ctx.arc(bx, by, batonR, 0, Math.PI * 2);
                ctx.stroke();
            }

            // 끝점
            ctx.save();
            ctx.translate(tailLength, endY);
            const endGlow = (note.started ? 1 : 0.55) * (0.62 + nowPulse * 0.38);
            const endRadius = (6.2 + proximity * 2.8) * proxScale;
            ctx.fillStyle = `rgba(255,255,255,${(0.18 + endGlow * 0.26).toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(0, 0, endRadius * (1.45 + nowPulse * 0.18), 0, Math.PI * 2);
            ctx.fill();

            if (isDiagonalSlide) {
                ctx.rotate(Math.PI / 4);
                ctx.fillStyle = '#1f1433';
                ctx.fillRect(-7.2, -7.2, 14.4, 14.4);
                ctx.fillStyle = color;
                ctx.fillRect(-5.4, -5.4, 10.8, 10.8);
                ctx.fillStyle = '#fff';
                ctx.fillRect(-2.2, -2.2, 4.4, 4.4);
            } else {
                ctx.fillStyle = '#1f1433';
                ctx.beginPath();
                ctx.arc(0, 0, endRadius * 0.86, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(0, 0, endRadius * 0.64, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = '#ffffffcc';
                ctx.lineWidth = 1.6;
                ctx.beginPath();
                ctx.arc(0, 0, endRadius * 0.62, 0, Math.PI * 2);
                ctx.stroke();
            }
            ctx.restore();
        }

        // 노트 헤드 (탭 노트와 동일한 시각 언어)
        const isTop = note.y <= (CANVAS_HEIGHT * (LANE_TOP_Y + LANE_BOTTOM_Y) * 0.5);
        renderTapNote(ctx, size, color, proximity, isTop);

        // 헤드 진행도 링 (끝 타이밍 인지 강화)
        const ringRadius = size * (isDiagonalSlide ? 0.54 : 0.6 + proximity * 0.03) * proxScale;
        const ringEnd = -Math.PI / 2 + Math.PI * 2 * progress;
        ctx.strokeStyle = `${color}cc`;
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.arc(0, 0, ringRadius, -Math.PI / 2, ringEnd);
        ctx.stroke();
    };

    const getNoteSpeed = (): number => noteSpeed;
    const getAudioOffset = (): number => audioOffset;
    const getInputOffset = (): number => inputOffset;
    const getVisualOffset = (): number => visualOffset;
    const getActiveCount = (): number => activeNotes.length;
    const getCharacterMotionGuide = (currentTime: number): CharacterMotionGuide | null => {
        const adjustedTime = currentTime + audioOffset / 1000;
        const topY = CANVAS_HEIGHT * LANE_TOP_Y;
        const bottomY = CANVAS_HEIGHT * LANE_BOTTOM_Y;
        const toRatio = (y: number) => {
            const denom = Math.max(1, bottomY - topY);
            return Math.max(0, Math.min(1, (bottomY - y) / denom));
        };

        let best: CharacterMotionGuide | null = null;
        let bestScore = Infinity;

        for (const note of activeNotes) {
            if (note.judged || !note.hit) continue;
            const isLong = note.data.type === NOTE_TYPE_SLIDE || note.data.type === NOTE_TYPE_HOLD;
            const safeDuration = getSustainDuration(note.data);
            if (!isLong || safeDuration <= 0) continue;

            const progress = Math.max(0, Math.min(1, (adjustedTime - note.data.time) / safeDuration));
            if (adjustedTime < note.data.time - 0.03) continue;
            if (adjustedTime > note.data.time + safeDuration + 0.08) continue;

            const y = note.data.type === NOTE_TYPE_SLIDE
                ? lerp(note.slideStartY, note.slideTargetY, progress)
                : (note.data.lane === LANE_TOP ? topY : bottomY);
            const yRatio = toRatio(y);
            const score = Math.abs(adjustedTime - (note.data.time + safeDuration * 0.5));

            if (score < bestScore) {
                bestScore = score;
                best = {
                    yRatio,
                    lane: yRatio >= 0.5 ? LANE_TOP : LANE_BOTTOM,
                    airborne: yRatio > 0.08 || note.data.type === NOTE_TYPE_SLIDE,
                };
            }
        }

        return best;
    };

    return {
        setNotes,
        setNoteSpeed,
        setAudioOffset,
        setInputOffset,
        setVisualOffset,
        setMapBpm,
        setAutoPlay,
        setDifficulty,
        injectBonusTap,
        onJudge,
        update,
        tryJudge,
        updateHoldState,
        releaseHold,
        render,
        getNoteSpeed,
        getAudioOffset,
        getInputOffset,
        getVisualOffset,
        getActiveCount,
        getCharacterMotionGuide,
        registerBufferedPress,
        clearBufferedPress,
    };
};

export type NoteManager = ReturnType<typeof createNoteManager>;
