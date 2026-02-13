/* === 게임 엔진 - 메인 루프 + 타이밍 === */
import { CANVAS_WIDTH, CANVAS_HEIGHT, type GameScreen } from '../utils/Constants';

/** 엔진 상태 타입 */
interface EngineState {
    readonly canvas: HTMLCanvasElement;
    readonly ctx: CanvasRenderingContext2D;
    readonly currentScreen: GameScreen;
    readonly running: boolean;
    readonly lastTime: number;
    readonly deltaTime: number;
    readonly fps: number;
}

interface ViewportTransform {
    readonly scale: number;
    readonly offsetX: number;
    readonly offsetY: number;
    readonly width: number;
    readonly height: number;
}

/** 업데이트/렌더 콜백 */
type UpdateCallback = (dt: number) => void;
type RenderCallback = (ctx: CanvasRenderingContext2D) => void;
type ScreenChangeCallback = (screen: GameScreen) => void;

/** 엔진 생성 */
export const createEngine = () => {
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;

    let state: EngineState = {
        canvas,
        ctx,
        currentScreen: 'menu',
        running: false,
        lastTime: 0,
        deltaTime: 0,
        fps: 0,
    };

    let updateCallbacks: UpdateCallback[] = [];
    let renderCallbacks: RenderCallback[] = [];
    let screenChangeCallbacks: ScreenChangeCallback[] = [];
    let rafId = 0;

    /** 캔버스 리사이즈 */
    const resizeCanvas = (): void => {
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.scale(dpr, dpr);

        // CSS 기준 렌더링 크기 설정
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
    };

    /** 논리 좌표를 실제 캔버스 좌표로 변환 */
    const getScale = (): { sx: number; sy: number } => {
        const { scale } = getViewportTransform();
        return {
            sx: scale,
            sy: scale,
        };
    };

    /** 현재 뷰포트 변환 정보(종횡비 유지 렌더) */
    const getViewportTransform = (): ViewportTransform => {
        const rect = canvas.getBoundingClientRect();
        const scale = Math.min(rect.width / CANVAS_WIDTH, rect.height / CANVAS_HEIGHT);
        const width = CANVAS_WIDTH * scale;
        const height = CANVAS_HEIGHT * scale;
        const offsetX = (rect.width - width) * 0.5;
        const offsetY = (rect.height - height) * 0.5;
        return { scale, offsetX, offsetY, width, height };
    };

    /** 메인 루프 */
    const loop = (timestamp: number): void => {
        if (!state.running) return;

        const dt = Math.min((timestamp - state.lastTime) / 1000, 0.05); // 최대 50ms
        state = {
            ...state,
            lastTime: timestamp,
            deltaTime: dt,
            fps: dt > 0 ? 1 / dt : 60,
        };

        // 업데이트
        updateCallbacks.forEach(cb => cb(dt));

        // 렌더
        const viewport = getViewportTransform();
        ctx.save();
        ctx.translate(viewport.offsetX, viewport.offsetY);
        ctx.scale(viewport.scale, viewport.scale);
        ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        renderCallbacks.forEach(cb => cb(ctx));
        ctx.restore();

        rafId = requestAnimationFrame(loop);
    };

    /** 엔진 시작 */
    const start = (): void => {
        if (state.running) return;
        state = { ...state, running: true, lastTime: performance.now() };
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);
        rafId = requestAnimationFrame(loop);
    };

    /** 엔진 정지 */
    const stop = (): void => {
        state = { ...state, running: false };
        cancelAnimationFrame(rafId);
        window.removeEventListener('resize', resizeCanvas);
    };

    /** 화면 전환 */
    const setScreen = (screen: GameScreen): void => {
        state = { ...state, currentScreen: screen };
        screenChangeCallbacks.forEach(cb => cb(screen));
    };

    /** 콜백 등록 */
    const onUpdate = (cb: UpdateCallback): (() => void) => {
        updateCallbacks = [...updateCallbacks, cb];
        return () => { updateCallbacks = updateCallbacks.filter(c => c !== cb); };
    };

    const onRender = (cb: RenderCallback): (() => void) => {
        renderCallbacks = [...renderCallbacks, cb];
        return () => { renderCallbacks = renderCallbacks.filter(c => c !== cb); };
    };

    const onScreenChange = (cb: ScreenChangeCallback): (() => void) => {
        screenChangeCallbacks = [...screenChangeCallbacks, cb];
        return () => { screenChangeCallbacks = screenChangeCallbacks.filter(c => c !== cb); };
    };

    /** 현재 상태 */
    const getState = () => state;
    const getCanvas = () => canvas;
    const getCtx = () => ctx;
    const getCurrentScreen = (): GameScreen => state.currentScreen;

    return {
        start,
        stop,
        setScreen,
        onUpdate,
        onRender,
        onScreenChange,
        getState,
        getCanvas,
        getCtx,
        getCurrentScreen,
        getScale,
        getViewportTransform,
    };
};

export type Engine = ReturnType<typeof createEngine>;
