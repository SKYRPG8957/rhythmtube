/* === 캐릭터 시스템 - 하이엔드 미소녀 프로시저럴 렌더링 === */
import {
    CANVAS_WIDTH, CANVAS_HEIGHT,
    CHARACTER_X, CHARACTER_SIZE,
    LANE_TOP_Y, LANE_BOTTOM_Y,
    LANE_TOP, LANE_BOTTOM,
    COLORS,
} from '../utils/Constants';
import { lerp } from '../utils/MathUtils';
import { SpriteManager } from '../utils/SpriteManager';


/** 캐릭터 상태 */
/** 캐릭터 상태 */
type CharacterState = 'run' | 'attack_top' | 'attack_bottom' | 'miss' | 'perfect' | 'entrance' | 'idle' | 'jump' | 'land';

// === 하이엔드 컬러 팔레트 (Cyberpunk 'Vivid' Style - K/DA Inspired) ===
const PALETTE = {
    skin: '#FFF0E6',          // 바닐라 피부
    skinShadow: '#F8C8B8',    // 웈 톤 쉐도우
    blush: '#FF8FA3',         // 소프트 로즈 블러시

    hairBase: '#C084FC',      // 라벤더 퍼플
    hairDark: '#7C3AED',      // 딥 바이올렛
    hairLight: '#E9D5FF',     // 페일 라벤더 (하이라이트)
    hairAccent: '#F0ABFC',    // 핑크 라벤더 (브릿지)

    eyeDark: '#4C1D95',       // 딥 인디고
    eyeMain: '#8B5CF6',      // 아메시스트
    eyeLight: '#DDD6FE',      // 라이트 라벤더

    outfitBase: '#1E1B4B',    // 다크 인디고 (세련된 늘낌)
    outfitSub: '#F59E0B',     // 애버 골드 포인트
    outfitGlow: '#A78BFA',    // 소프트 퍼플 글로우 (네온그린 대체)

    skirt: '#312E81',         // 인디고 스커트
    skirtShadow: '#1E1B4B',   // 다크 인디고

    accent: '#818CF8',        // 소프트 인디고 액센트
};

/** 스프라이트 설정 */
// 스프라이트 이미지를 사용하지 않고 100% Canvas API로 렌더링합니다.

export const createCharacter = () => {
    let currentState: CharacterState = 'entrance';
    let stateTimer = 0;
    let stateDuration = 0;
    let motionGuideRatio: number | null = null; // 0=bottom, 1=top

    // 100% Canvas API 프로시저럴 렌더링 (스프라이트 미사용)

    // 위치/물리
    let currentLane = LANE_BOTTOM;
    let yPos = CANVAS_HEIGHT * LANE_BOTTOM_Y;
    let targetY = yPos;

    // 애니메이션 변수들
    let animTime = 0;
    let squash = 1;
    let stretch = 1;

    let hitFlash = 0;
    let hitFlashColor: string = COLORS.perfect;

    // 머리카락 물리 시뮬레이션
    let hairSway = 0;
    let hairVelocity = 0;

    // 표정 제어
    let blinkTimer = 0;
    let isBlinking = false;
    let expressionOverride = 0; // 0: none, 1: happy, 2: pain

    // 이펙트
    let perfectAura = 0;
    let runTrail: { x: number, y: number, alpha: number, pose: number }[] = [];

    /** 상태 전환 */
    const setState = (newState: CharacterState, lane?: number, duration = 0.2): void => {
        // 같은 상태 연장
        if (newState === currentState && lane === undefined) {
            stateTimer = duration;
            stateDuration = Math.max(duration, 0.01);
            return;
        }

        const prevState = currentState;
        currentState = newState;
        stateTimer = duration;
        stateDuration = Math.max(duration, 0.01);

        if (lane !== undefined) {
            currentLane = lane;
            const newTarget = currentLane === LANE_TOP
                ? CANVAS_HEIGHT * LANE_TOP_Y
                : CANVAS_HEIGHT * LANE_BOTTOM_Y;

            // 레인 변경 시 약간의 점프 효과
            if (Math.abs(newTarget - targetY) > 10) {
                squash = 0.6;
                stretch = 1.4;
            }
            targetY = newTarget;
        }

        // Entrance Logic
        if (newState === 'entrance') {
            yPos = -300;
            targetY = currentLane === LANE_TOP ? CANVAS_HEIGHT * LANE_TOP_Y : CANVAS_HEIGHT * LANE_BOTTOM_Y;
            squash = 0.6;
            stretch = 1.4;
            return;
        }

        // 상태별 애니메이션 트리거
        if (newState === 'perfect') {
            squash = 0.65;
            stretch = 1.35;
            hitFlash = 0.72;
            hitFlashColor = COLORS.perfect;
            perfectAura = 1.28;
            expressionOverride = 1; // Happy
        } else if (newState === 'miss') {
            // Miss에서도 캐릭터가 "작아 보이는" 문제를 막기 위해 과한 눌림 제거
            squash = 1.06;
            stretch = 0.94;
            hitFlash = 0.4;
            hitFlashColor = COLORS.miss;
            hairVelocity += (Math.random() - 0.5) * 35; // 충격
            expressionOverride = 2; // Pain
        } else if ((newState === 'attack_top' || newState === 'attack_bottom')) {
            squash = 0.75;
            stretch = 1.25;
            hitFlash = 0.35;
            hitFlashColor = currentLane === LANE_TOP ? COLORS.noteTop : COLORS.noteBottom;

            // 공격 시 머리카락 휘날림
            hairVelocity += newState === 'attack_top' ? -15 : 15;
        }
    };

    /** 업데이트 */
    const update = (dt: number): void => {
        animTime += dt;

        // Entrance Handling
        if (currentState === 'entrance') {
            // Fall faster
            yPos = lerp(yPos, targetY, dt * 5);

            // Landing check
            if (Math.abs(yPos - targetY) < 10) {
                yPos = targetY;
                currentState = 'run';
                // Landing Impact
                squash = 1.5;
                stretch = 0.6;
            }
            return;
        }

        // 상태 타이머
        if (stateTimer > 0) {
            stateTimer -= dt;
            if (stateTimer <= 0) {
                currentState = 'run';
                expressionOverride = 0;

                // Auto Landing (Gravity)
                // 런 상태로 돌아오면 자동으로 바닥으로 내려옴
                if (currentLane !== LANE_BOTTOM && motionGuideRatio === null) {
                    currentLane = LANE_BOTTOM;
                    targetY = CANVAS_HEIGHT * LANE_BOTTOM_Y;

                    // 착지 애니메이션 효과
                    squash = 1.3;
                    stretch = 0.8;
                }
            }
        }

        // 슬라이드/롱노트 가이드가 있으면 그 위치를 우선 추적
        if (motionGuideRatio !== null) {
            const clamped = Math.max(0, Math.min(1, motionGuideRatio));
            const topY = CANVAS_HEIGHT * LANE_TOP_Y;
            const bottomY = CANVAS_HEIGHT * LANE_BOTTOM_Y;
            targetY = lerp(bottomY, topY, clamped);
            currentLane = clamped >= 0.5 ? LANE_TOP : LANE_BOTTOM;

            if (currentState === 'run' || currentState === 'attack_bottom') {
                currentState = 'jump';
                stateTimer = Math.max(stateTimer, 0.12);
                stateDuration = Math.max(stateDuration, 0.12);
            }
        }

        // 부드러운 이동 (Exponential smoothing)
        yPos = lerp(yPos, targetY, dt * 15);

        // 스쿼시 & 스트레치 복원
        squash = lerp(squash, 1, dt * 8);
        stretch = lerp(stretch, 1, dt * 8);

        // 이펙트 감소
        if (hitFlash > 0) hitFlash = Math.max(0, hitFlash - dt * 3);
        if (perfectAura > 0) perfectAura = Math.max(0, perfectAura - dt * 2);

        // 머리카락 물리 (Spring-damper system)
        const targetSway = (currentState === 'run' ? Math.sin(animTime * 10) * 0.2 : 0)
            + (yPos - targetY) * 0.05; // Y축 이동에 반응

        const force = (targetSway - hairSway) * 150; // Spring
        hairVelocity += force * dt;
        hairVelocity *= 0.9; // Damping
        hairSway += hairVelocity * dt;

        // 눈 깜빡임
        blinkTimer -= dt;
        if (blinkTimer <= 0) {
            isBlinking = !isBlinking;
            blinkTimer = isBlinking ? 0.1 : 2 + Math.random() * 3;
        }

        // 잔상 효과 (Running Trail)
        if (currentState === 'perfect' || Math.abs(yPos - targetY) > 50) {
            if (animTime % 0.05 < dt) {
                runTrail.push({ x: 0, y: yPos, alpha: 0.5, pose: animTime });
            }
        }
        for (let i = runTrail.length - 1; i >= 0; i--) {
            runTrail[i].alpha -= dt * 2;
            runTrail[i].x -= dt * 600; // 뒤로 이동
            if (runTrail[i].alpha <= 0) runTrail.splice(i, 1);
        }
    };

    /** 렌더링 (Canvas API + SpriteManager) */
    const render = (ctx: CanvasRenderingContext2D): void => {
        const x = CANVAS_WIDTH * CHARACTER_X; // 비율 → 픽셀 좌표 변환
        // yPos interpolates, apply squash/stretch
        const runBob = currentState === 'run' ? Math.sin(animTime * 18) * 1.8 : 0;
        const drawY = yPos + (1 - squash) * 22 + runBob; // Ground anchor correction
        const stepPulse = currentState === 'run' ? Math.max(0, Math.sin(animTime * 22)) : 0;
        const runScaleX = 1 + stepPulse * 0.03;
        const runScaleY = 1 - stepPulse * 0.02;

        ctx.save();
        ctx.translate(x, drawY);
        ctx.scale(squash * runScaleX, stretch * runScaleY);

        const spriteManager = SpriteManager.getInstance();
        let frameIndex = 1;
        let spriteBounds = {
            x: -CHARACTER_SIZE * 0.28,
            y: -CHARACTER_SIZE * 0.9,
            w: CHARACTER_SIZE * 0.56,
            h: CHARACTER_SIZE * 0.9,
        };

        // spritesheet 직접 분석 기반 역할 분류
        // 제외: #4(2인 스프라이트), #26/#29(1~2px 프레임)
        const RUN_FRAMES = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 23, 21, 19, 17, 15, 13, 11, 9, 7, 5, 3];
        const IDLE_FRAMES = [34, 35, 36, 37, 36, 35];
        const ATTACK_BOTTOM_FRAMES = [15, 18, 21, 24];
        const ATTACK_TOP_FRAMES = [27, 30, 28, 30];
        const JUMP_FRAMES = [30, 28, 27, 28];
        const LAND_FRAMES = [31, 32, 33];
        const MISS_FRAMES = [32, 35, 36];
        const PERFECT_FRAMES = [30, 27, 28, 30];

        if (currentState === 'idle') {
            frameIndex = pickLoopFrame(IDLE_FRAMES, animTime, 4);
        } else if (currentState === 'run') {
            frameIndex = pickLoopFrame(RUN_FRAMES, animTime, 14);
        } else if (currentState === 'attack_bottom') {
            frameIndex = pickStateFrame(ATTACK_BOTTOM_FRAMES, stateTimer, stateDuration);
        } else if (currentState === 'attack_top') {
            frameIndex = pickStateFrame(ATTACK_TOP_FRAMES, stateTimer, stateDuration);
        } else if (currentState === 'jump') {
            frameIndex = pickStateFrame(JUMP_FRAMES, stateTimer, stateDuration);
        } else if (currentState === 'land') {
            frameIndex = pickStateFrame(LAND_FRAMES, stateTimer, stateDuration);
        } else if (currentState === 'miss') {
            frameIndex = pickStateFrame(MISS_FRAMES, stateTimer, stateDuration);
        } else if (currentState === 'perfect') {
            frameIndex = pickStateFrame(PERFECT_FRAMES, stateTimer, stateDuration);
        } else if (currentState === 'entrance') {
            frameIndex = pickStateFrame(JUMP_FRAMES, stateTimer, stateDuration);
        }

        const spriteData = spriteManager.getFrameByIndex(frameIndex);

        if (spriteData) {
            const { image, frame, alignment, scale } = spriteData;
            // 프레임 크기 차이로 캐릭터가 커졌다 작아지는 현상을 방지하기 위해
            // 기준 높이를 낮추고(frame-scale 적용), 발 앵커를 유지한다.
            let displayHeight = CHARACTER_SIZE * 0.84;
            if (currentState === 'jump' || currentState === 'attack_top' || currentLane === LANE_TOP) {
                displayHeight = CHARACTER_SIZE * 0.88;
            }
            if (currentState === 'perfect') {
                displayHeight = CHARACTER_SIZE * 0.9;
            }
            if (currentState === 'miss') {
                displayHeight = CHARACTER_SIZE * 0.86;
            }

            const aspect = frame.w / Math.max(1, frame.h);
            const frameScale = Math.max(0.72, Math.min(1.08, scale || 1));
            let h = displayHeight * frameScale;
            let w = h * aspect;
            const maxDisplayWidth = CHARACTER_SIZE * (currentState === 'jump' || currentState === 'attack_top' ? 0.82 : 0.76);
            if (w > maxDisplayWidth) {
                const widthScale = maxDisplayWidth / w;
                w *= widthScale;
                h *= widthScale;
            }
            const scaleFactor = h / Math.max(1, frame.h);
            const drawX = -w / 2 + alignment.offsetX * scaleFactor;
            const drawY = -h + alignment.offsetY * scaleFactor;
            spriteBounds = { x: drawX, y: drawY, w, h };

            // 프레임별 중심/발 위치 보정 적용
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(image, frame.x, frame.y, frame.w, frame.h, drawX, drawY, w, h);
            ctx.imageSmoothingEnabled = true;
        } else {
            // 폴백: 빨간 박스
            ctx.fillStyle = 'red';
            ctx.fillRect(-25, -50, 50, 100);
        }

        // 히트 플래시 오버레이
        if (hitFlash > 0) {
            // 사각형 오버레이 대신 캐릭터 중심부 글로우로 변경 (과대 노란 박스 방지)
            const cx = spriteBounds.x + spriteBounds.w * 0.52;
            const cy = spriteBounds.y + spriteBounds.h * 0.48;
            const radius = Math.max(spriteBounds.w, spriteBounds.h) * (currentState === 'perfect' ? 0.62 : 0.52);
            const coreAlpha = hitFlash * (currentState === 'perfect' ? 0.38 : 0.26);
            const grad = ctx.createRadialGradient(cx, cy, radius * 0.18, cx, cy, radius);
            grad.addColorStop(0, `${hitFlashColor}${Math.round(Math.max(0, Math.min(1, coreAlpha)) * 255).toString(16).padStart(2, '0')}`);
            grad.addColorStop(0.55, `${hitFlashColor}${Math.round(Math.max(0, Math.min(1, coreAlpha * 0.5)) * 255).toString(16).padStart(2, '0')}`);
            grad.addColorStop(1, `${hitFlashColor}00`);
            ctx.globalCompositeOperation = 'lighter';
            ctx.fillStyle = grad;
            ctx.globalAlpha = 1;
            ctx.beginPath();
            ctx.arc(cx, cy, radius, 0, Math.PI * 2);
            ctx.fill();

            if (currentState === 'perfect') {
                const auraPulse = 0.5 + Math.sin(animTime * 20) * 0.5;
                const ringR = radius * (0.92 + auraPulse * 0.22);
                ctx.strokeStyle = `${hitFlashColor}cc`;
                ctx.lineWidth = 2.2;
                ctx.beginPath();
                ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
                ctx.stroke();

                ctx.strokeStyle = 'rgba(255,245,190,0.75)';
                ctx.lineWidth = 1.3;
                for (let i = 0; i < 8; i++) {
                    const a = animTime * 1.8 + (Math.PI * 2 * i) / 8;
                    const r0 = ringR * 0.88;
                    const r1 = ringR * 1.16;
                    ctx.beginPath();
                    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
                    ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
                    ctx.stroke();
                }
            }
            ctx.globalAlpha = 1.0;
            ctx.globalCompositeOperation = 'source-over';
        }

        ctx.restore();
    };

    /** 현재 위치 가져오기 */
    const getPosition = () => {
        return { x: CHARACTER_X * CANVAS_WIDTH, y: yPos };
    };

    const setMotionGuide = (ratio: number | null): void => {
        if (ratio === null || !Number.isFinite(ratio)) {
            motionGuideRatio = null;
            return;
        }
        motionGuideRatio = Math.max(0, Math.min(1, ratio));
    };

    return {
        update,
        render,
        setState,
        setMotionGuide,
        getPosition
    };
};

const pickLoopFrame = (frames: readonly number[], time: number, fps: number): number => {
    if (frames.length === 0) return 1;
    const idx = Math.floor(time * fps) % frames.length;
    return frames[idx];
};

const pickStateFrame = (frames: readonly number[], timer: number, duration: number): number => {
    if (frames.length === 0) return 1;
    const progress = Math.min(1, Math.max(0, 1 - timer / Math.max(duration, 0.01)));
    const idx = Math.min(frames.length - 1, Math.floor(progress * frames.length));
    return frames[idx];
};
