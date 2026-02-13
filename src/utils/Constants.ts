/* === 게임 상수 정의 === */

/** 게임 화면 해상도 */
export const CANVAS_WIDTH = 1280;
export const CANVAS_HEIGHT = 720;

/** 레인 설정 (2레인: 상단/하단) */
export const LANE_COUNT = 2;
export const LANE_TOP_Y = 0.38; // 상단 레인 Y 비율
export const LANE_BOTTOM_Y = 0.75; // 하단 레인 Y 비율

/** 판정선 X 위치 비율 */
export const JUDGE_LINE_X = 0.19;

/** 캐릭터 위치 */
export const CHARACTER_X = 0.14;
export const CHARACTER_SIZE = 104;

/** 노트 설정 */
export const NOTE_SIZE = 50;
export const NOTE_SPEED_BASE = 600; // px/s 기본 속도
export const NOTE_SPAWN_OFFSET = 300; // 화면 밖 스폰 여유

/** 판정 윈도우 (ms) */
export const JUDGE_PERFECT = 40;
export const JUDGE_GREAT = 80;
export const JUDGE_GOOD = 120;
export const JUDGE_MISS = 160;

/** 점수 */
export const SCORE_PERFECT = 300;
export const SCORE_GREAT = 200;
export const SCORE_GOOD = 100;
export const SCORE_MISS = 0;

/** 노트 타입 */
export const NOTE_TYPE_TAP = 'tap' as const;
export const NOTE_TYPE_HOLD = 'hold' as const;
export const NOTE_TYPE_DOUBLE = 'double' as const;
export const NOTE_TYPE_SLIDE = 'slide' as const;
export const NOTE_TYPE_BURST = 'burst' as const;
export const MIN_HOLD_DURATION_SEC = 0.45;
export const MIN_SLIDE_DURATION_SEC = 0.75;

/** 레인 인덱스 */
export const LANE_TOP = 0;
export const LANE_BOTTOM = 1;

/** 판정 결과 */
export type JudgeResult = 'perfect' | 'great' | 'good' | 'miss';

/** 노트 타입 유니온 */
export type NoteType =
    | typeof NOTE_TYPE_TAP
    | typeof NOTE_TYPE_HOLD
    | typeof NOTE_TYPE_DOUBLE
    | typeof NOTE_TYPE_SLIDE
    | typeof NOTE_TYPE_BURST;

/** 게임 상태 */
export type GameScreen = 'menu' | 'songSelect' | 'settings' | 'loading' | 'playing' | 'pause' | 'result';

/** 난이도 */
export type Difficulty = 'easy' | 'normal' | 'hard' | 'expert';

/** 기본 키 바인딩 */
export const DEFAULT_KEY_BINDINGS = {
    laneBottom: 'd',
    laneTop: 'f',
    special: ' ',
} as const;

/** 컬러 상수 */
export const COLORS = {
    // Muse Dash Style Palette
    primary: '#FF0055',    // Hot Pink (Main)
    secondary: '#00D1FF',  // Cyan (Secondary)
    accent: '#FFD600',     // Yellow (Accent/Perfect)
    background: '#2A0944', // Dark Purple (BG)
    surface: '#FFFFFF',
    text: '#FFFFFF',
    textSecondary: '#E0E0E0',
    lane: 'rgba(255, 255, 255, 0.1)',
    laneActive: 'rgba(255, 0, 85, 0.3)',
    noteTop: '#00D1FF',    // Sky/Air Note (Blue)
    noteBottom: '#FF0055', // Ground Note (Pink)
    judgeLine: '#FFFFFF',
    perfect: '#FFD600',    // Gold
    great: '#00D1FF',      // Blue
    good: '#2ED573',       // Green
    miss: '#FF4757',       // Red
} as const;

/** BPM 분석 설정 */
export const BPM_MIN = 60;
export const BPM_MAX = 200;
