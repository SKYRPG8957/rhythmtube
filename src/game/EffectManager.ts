/* === 이펙트 매니저 - 부드러운 파티클 + 판정 텍스트 (눈 편안한 버전) === */
import { COLORS, CANVAS_WIDTH, CANVAS_HEIGHT, type JudgeResult } from '../utils/Constants';
import { randomFloat, easeOutCubic, easeOutElastic } from '../utils/MathUtils';

/** 파티클 */
interface Particle {
    x: number;
    y: number;
    vx: number;
    vy: number;
    life: number;
    maxLife: number;
    size: number;
    color: string;
    /** 파티클 타입: 0=일반, 1=잔상(trail), 2=바닥충격, 3=퍼펙트 꽃가루 */
    kind: number;
}

/** 판정 텍스트 */
interface JudgeText {
    x: number;
    y: number;
    text: string;
    color: string;
    life: number;
    maxLife: number;
}

/** 링 버스트 (Perfect 링 이펙트) */
interface RingBurst {
    x: number;
    y: number;
    life: number;
    maxLife: number;
    startRadius: number;
    endRadius: number;
    color: string;
}

// 파티클 상한선 (성능 보호)
const MAX_PARTICLES = 120;

export const createEffectManager = () => {
    let particles: Particle[] = [];
    let judgeTexts: JudgeText[] = [];
    let ringBursts: RingBurst[] = [];

    /** 히트 이펙트 생성 (눈 편안한 버전) */
    const spawnHitEffect = (x: number, y: number, result: JudgeResult, lane?: number): void => {
        const colorMap: Record<JudgeResult, string> = {
            perfect: COLORS.perfect,
            great: COLORS.great,
            good: COLORS.good,
            miss: COLORS.miss,
        };
        const color = colorMap[result];

        // 파티클 수 대폭 감소 (기존 50/30/15 → 15/8/4)
        const count = result === 'perfect' ? 15 : result === 'great' ? 8 : result === 'good' ? 4 : 0;

        if (result === 'miss') {
            // 미스: 판정 텍스트만
            judgeTexts = [...judgeTexts, {
                x,
                y: y - 40,
                text: 'MISS',
                color,
                life: 0,
                maxLife: 0.4,
            }];
            return;
        }

        // === 메인 파티클 (부드러운 산개) ===
        const newParticles: Particle[] = [];
        for (let i = 0; i < count; i++) {
            const angle = randomFloat(Math.PI * 0.3, Math.PI * 1.7);
            const speed = randomFloat(60, 180); // 속도 감소 (120~350 → 60~180)
            newParticles.push({
                x,
                y,
                vx: Math.cos(angle) * speed - 40,
                vy: Math.sin(angle) * speed,
                life: 0,
                maxLife: randomFloat(0.3, 0.5), // 수명 단축
                size: randomFloat(2, 6), // 크기 축소 (4~12 → 2~6)
                color,
                kind: 0,
            });
        }

        // === 잔상 트레일 (소량) ===
        const trailCount = result === 'perfect' ? 4 : 2;
        for (let i = 0; i < trailCount; i++) {
            const angle = randomFloat(Math.PI * 0.5, Math.PI * 1.5);
            const speed = randomFloat(20, 60);
            newParticles.push({
                x,
                y,
                vx: Math.cos(angle) * speed - 15,
                vy: Math.sin(angle) * speed,
                life: 0,
                maxLife: randomFloat(0.3, 0.5),
                size: randomFloat(3, 7),
                color,
                kind: 1,
            });
        }

        if (result === 'perfect') {
            const pollenCount = 10;
            for (let i = 0; i < pollenCount; i++) {
                const angle = randomFloat(Math.PI * 0.45, Math.PI * 1.55);
                const speed = randomFloat(32, 92);
                newParticles.push({
                    x: x + randomFloat(-10, 10),
                    y: y + randomFloat(-8, 8),
                    vx: Math.cos(angle) * speed - 20,
                    vy: Math.sin(angle) * speed - 18,
                    life: 0,
                    maxLife: randomFloat(0.36, 0.62),
                    size: randomFloat(1.8, 4.2),
                    color: randomFloat(0, 1) > 0.5 ? '#ffe37d' : '#ffd65a',
                    kind: 3,
                });
            }
        }

        particles = [...particles, ...newParticles];

        // === 파티클 수 제한 ===
        if (particles.length > MAX_PARTICLES) {
            particles = particles.slice(particles.length - MAX_PARTICLES);
        }

        // === 화면 번쩍임(히트 플래시) 완전 제거 - 눈 편안함 최우선 ===

        // === 링 버스트 (Perfect만, 부드럽게) ===
        if (result === 'perfect') {
            ringBursts = [...ringBursts, {
                x, y,
                life: 0,
                maxLife: 0.25,
                startRadius: 15,
                endRadius: 45, // 크기 축소 (75 → 45)
                color,
            }];
        }

        // === 판정 텍스트 ===
        const textMap: Record<JudgeResult, string> = {
            perfect: 'PERFECT',
            great: 'GREAT',
            good: 'GOOD',
            miss: 'MISS',
        };

        judgeTexts = [...judgeTexts, {
            x,
            y: y - 40,
            text: textMap[result],
            color,
            life: 0,
            maxLife: 0.6,
        }];
    };

    /** 특수 성공 이펙트 (버스트/스페셜 성공) */
    const spawnSpecialSuccessEffect = (x: number, y: number): void => {
        const color = '#ffd65a';
        const sparkle: Particle[] = [];
        for (let i = 0; i < 18; i++) {
            const angle = randomFloat(0, Math.PI * 2);
            const speed = randomFloat(70, 210);
            sparkle.push({
                x,
                y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed * 0.6 - 25,
                life: 0,
                maxLife: randomFloat(0.22, 0.44),
                size: randomFloat(1.6, 4.8),
                color,
                kind: 1,
            });
        }
        particles = [...particles, ...sparkle];
        if (particles.length > MAX_PARTICLES) {
            particles = particles.slice(particles.length - MAX_PARTICLES);
        }

        ringBursts = [...ringBursts,
            {
                x,
                y,
                life: 0,
                maxLife: 0.26,
                startRadius: 18,
                endRadius: 58,
                color,
            },
            {
                x,
                y,
                life: 0,
                maxLife: 0.2,
                startRadius: 8,
                endRadius: 36,
                color: '#fff2be',
            }
        ];

        judgeTexts = [...judgeTexts, {
            x,
            y: y - 52,
            text: 'SPECIAL',
            color,
            life: 0,
            maxLife: 0.58,
        }];
    };

    /** 업데이트 */
    const update = (dt: number): void => {
        const safeDt = Number.isFinite(dt) ? Math.max(0, Math.min(0.1, dt)) : (1 / 60);

        // 파티클 업데이트
        particles = particles
            .map(p => {
                const gravity = p.kind === 3 ? 52 : (p.kind === 2 ? 100 : 200); // 중력 감소
                const drag = p.kind === 3 ? 0.985 : (p.kind === 1 ? 0.96 : 0.99);
                return {
                    ...p,
                    x: p.x + p.vx * safeDt,
                    y: p.y + p.vy * safeDt,
                    vx: p.vx * drag,
                    vy: p.vy + gravity * safeDt,
                    life: p.life + safeDt,
                };
            })
            .filter(p => Number.isFinite(p.life) && Number.isFinite(p.maxLife) && p.life < p.maxLife);

        // 텍스트 업데이트
        judgeTexts = judgeTexts
            .map(t => ({
                ...t,
                y: t.y - 35 * safeDt, // 느리게 상승 (50 → 35)
                life: t.life + safeDt,
            }))
            .filter(t => Number.isFinite(t.life) && Number.isFinite(t.maxLife) && t.life < t.maxLife);

        // 링 버스트 업데이트
        ringBursts = ringBursts
            .map(r => ({ ...r, life: r.life + safeDt }))
            .filter(r => Number.isFinite(r.life) && Number.isFinite(r.maxLife) && r.life < r.maxLife);
    };

    /** 렌더링 */
    const render = (ctx: CanvasRenderingContext2D): void => {
        // === 링 버스트 ===
        for (const r of ringBursts) {
            const progress = r.life / r.maxLife;
            const alpha = (1 - easeOutCubic(progress)) * 0.5; // 투명도 감소
            const radius = r.startRadius + (r.endRadius - r.startRadius) * easeOutCubic(progress);

            ctx.strokeStyle = r.color;
            ctx.lineWidth = 2 * (1 - progress);
            ctx.globalAlpha = alpha;
            ctx.beginPath();
            ctx.arc(r.x, r.y, radius, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;

        // === 파티클 ===
        for (const p of particles) {
            const progress = p.life / p.maxLife;
            const alpha = (1 - easeOutCubic(progress)) * 0.7; // 전체 투명도 감소

            if (p.kind === 1) {
                // 트레일: 더 투명
                ctx.fillStyle = p.color;
                ctx.globalAlpha = alpha * 0.25;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size * (1 - progress * 0.5), 0, Math.PI * 2);
                ctx.fill();
            } else if (p.kind === 3) {
                ctx.save();
                ctx.translate(p.x, p.y);
                ctx.rotate(Math.atan2(p.vy, Math.max(1, p.vx)) * 0.35);
                ctx.fillStyle = p.color;
                ctx.globalAlpha = alpha * 0.82;
                ctx.beginPath();
                ctx.ellipse(0, 0, p.size * 1.4, p.size * 0.86, 0, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            } else {
                // 일반 파티클
                ctx.fillStyle = p.color;
                ctx.globalAlpha = alpha;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size * (1 - progress), 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.globalAlpha = 1;

        // === 판정 텍스트 ===
        for (const t of judgeTexts) {
            const progress = t.life / t.maxLife;
            const alpha = 1 - easeOutCubic(progress);

            // 부드러운 팝인 (과장 줄임)
            const scaleT = Math.min(progress * 6, 1);
            const scale = 1.0 + 0.3 * (1 - easeOutElastic(scaleT)); // 1.5x → 1.3x

            ctx.save();
            ctx.translate(t.x, t.y);
            ctx.scale(scale, scale);
            ctx.globalAlpha = alpha;
            ctx.font = 'bold 28px Outfit'; // 크기 축소 (36 → 28)
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            // 부드러운 그림자 (글로우 대신)
            ctx.fillStyle = t.color;
            ctx.fillText(t.text, 0, 0);

            ctx.restore();
        }
    };

    /** 모든 이펙트 클리어 */
    const clear = (): void => {
        particles = [];
        judgeTexts = [];
        ringBursts = [];
    };

    return { spawnHitEffect, spawnSpecialSuccessEffect, update, render, clear };
};

export type EffectManager = ReturnType<typeof createEffectManager>;
