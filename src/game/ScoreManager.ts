/* === 스코어 매니저 === */
import {
    SCORE_PERFECT, SCORE_GREAT, SCORE_GOOD, SCORE_MISS,
    type JudgeResult,
} from '../utils/Constants';

/** 스코어 상태 */
/** 스코어 상태 */
interface ScoreState {
    readonly score: number;
    readonly combo: number;
    readonly maxCombo: number;
    readonly perfects: number;
    readonly greats: number;
    readonly goods: number;
    readonly misses: number;
    readonly totalNotes: number;
    readonly hp: number; // Health Point (0-100)
    readonly sustainTicks: number;
}

export const createScoreManager = () => {
    let state: ScoreState = {
        score: 0,
        combo: 0,
        maxCombo: 0,
        perfects: 0,
        greats: 0,
        goods: 0,
        misses: 0,
        totalNotes: 0,
        hp: 100,
        sustainTicks: 0,
    };

    /** 초기화 */
    const reset = (totalNotes = 0): void => {
        state = {
            score: 0,
            combo: 0,
            maxCombo: 0,
            perfects: 0,
            greats: 0,
            goods: 0,
            misses: 0,
            totalNotes,
            hp: 100,
            sustainTicks: 0,
        };
    };

    /** 판정 결과 반영 */
    const addJudge = (result: JudgeResult): void => {
        const scoreMap: Record<JudgeResult, number> = {
            perfect: SCORE_PERFECT,
            great: SCORE_GREAT,
            good: SCORE_GOOD,
            miss: SCORE_MISS,
        };

        const baseScore = scoreMap[result];
        // 콤보 보너스 (10콤보마다 1.1배, 최대 2배)
        const comboMultiplier = result !== 'miss'
            ? Math.min(2, 1 + Math.floor(state.combo / 10) * 0.1)
            : 1;

        const newCombo = result === 'miss' ? 0 : state.combo + 1;
        const newMaxCombo = Math.max(state.maxCombo, newCombo);

        // HP Calculation
        let hpChange = 0;
        if (result === 'miss') hpChange = -10;
        else if (result === 'good') hpChange = -2; // Good also hurts a bit? Or neutral? Let's say neutral. Actually user wants pop style.
        else if (result === 'great') hpChange = 1;
        else if (result === 'perfect') hpChange = 2;

        // Good shouldn't hurt in typical runner games, but strict rhythm games might. Let's make Good +0.5 or +1.
        if (result === 'good') hpChange = 0.5;

        const newHp = Math.max(0, Math.min(100, state.hp + hpChange));

        state = {
            ...state,
            score: state.score + Math.round(baseScore * comboMultiplier),
            combo: newCombo,
            maxCombo: newMaxCombo,
            perfects: state.perfects + (result === 'perfect' ? 1 : 0),
            greats: state.greats + (result === 'great' ? 1 : 0),
            goods: state.goods + (result === 'good' ? 1 : 0),
            misses: state.misses + (result === 'miss' ? 1 : 0),
            hp: newHp,
            sustainTicks: state.sustainTicks,
        };
    };

    /** 롱노트 유지 틱 */
    const addSustainTick = (opts?: { countCombo?: boolean }): void => {
        const tickScore = 30;
        const countCombo = !!opts?.countCombo;
        const newCombo = countCombo ? state.combo + 1 : state.combo;
        const newMaxCombo = countCombo ? Math.max(state.maxCombo, newCombo) : state.maxCombo;
        state = {
            ...state,
            score: state.score + tickScore,
            combo: newCombo,
            maxCombo: newMaxCombo,
            hp: Math.min(100, state.hp + 0.12),
            sustainTicks: state.sustainTicks + 1,
        };
    };

    /** 정확도 계산 (%) */
    const getAccuracy = (): number => {
        const total = state.perfects + state.greats + state.goods + state.misses;
        if (total === 0) return 100;
        const weighted = state.perfects * 100 + state.greats * 75 + state.goods * 50;
        return weighted / total;
    };

    /** 랭크 계산 */
    const getRank = (): string => {
        const acc = getAccuracy();
        if (acc >= 95) return 'S';
        if (acc >= 90) return 'A'; // Adjusted boundaries
        if (acc >= 80) return 'B';
        if (acc >= 60) return 'C';
        return 'D';
    };

    /** 현재 상태 */
    const getState = (): ScoreState => state;

    return { reset, addJudge, addSustainTick, getAccuracy, getRank, getState };
};

export type ScoreManager = ReturnType<typeof createScoreManager>;
