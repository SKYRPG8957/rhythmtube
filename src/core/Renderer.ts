/* === Canvas 2D 렌더러 === */
import {
    CANVAS_WIDTH, CANVAS_HEIGHT,
    LANE_TOP_Y, LANE_BOTTOM_Y, JUDGE_LINE_X,
    COLORS,
} from '../utils/Constants';
import { lerp } from '../utils/MathUtils';
import type { VisualTheme } from '../map/MapData';

interface ParallaxLayer {
    readonly color: string;
    readonly y: number;
    readonly height: number;
    readonly speed: number;
    offset: number;
}

interface RendererState {
    readonly beatPulse: number;
    readonly bgLayers: readonly ParallaxLayer[];
    readonly bgTime: number;
}
interface GameplayCamera {
    readonly x: number;
    readonly y: number;
    readonly zoom: number;
    readonly tilt: number;
}

export const createRenderer = () => {
    let state: RendererState = {
        beatPulse: 0,
        bgLayers: createParallaxLayers(),
        bgTime: 0,
    };

    let shakeX = 0;
    let shakeY = 0;
    let backgroundPaused = false;
    let hasVideoBackground = false;
    let visualTheme: VisualTheme = 'nightCity';
    let cameraX = 0;
    let cameraY = 0;
    let cameraZoom = 1.02;
    let cameraTilt = 0;
    let cameraFlow = 0;
    let cameraFlowTarget = 0;
    let cameraFlowRatio = 0.5;
    let cameraImpulseX = 0;
    let cameraImpulseY = 0;
    let cameraImpulseZoom = 0;
    let cameraImpulseTilt = 0;
    let musicTime = 0;
    let musicBpm = 120;
    let musicDrive = 1;
    let musicDriveTarget = 1;
    let musicHighlight = 0;
    let musicHighlightTarget = 0;
    let musicMotionMode = 0.5;
    let musicMotionModeTarget = 0.5;
    let comboDrive = 0;
    let comboDriveTarget = 0;
    let failSlowMo = 1;
    let failSlowMoTarget = 1;

    function createParallaxLayers(): ParallaxLayer[] {
        return [
            { color: '', y: 0, height: CANVAS_HEIGHT * 0.5, speed: 0, offset: 0 },
            { color: 'rgba(54, 38, 92, 0.22)', y: CANVAS_HEIGHT * 0.2, height: CANVAS_HEIGHT * 0.35, speed: 24, offset: 0 },
            { color: 'rgba(40, 66, 128, 0.4)', y: CANVAS_HEIGHT * 0.35, height: CANVAS_HEIGHT * 0.3, speed: 72, offset: 0 },
            { color: 'rgba(40, 28, 78, 0.86)', y: CANVAS_HEIGHT * 0.65, height: CANVAS_HEIGHT * 0.35, speed: 180, offset: 0 },
        ];
    }

    const renderBackground = (ctx: CanvasRenderingContext2D, dt: number): void => {
        const tempoMul = Math.max(0.82, Math.min(1.38, musicBpm / 120));
        const energyMul = Math.max(
            0.86,
            Math.min(1.9, 0.92 + (musicDrive - 1) * 0.42 + musicHighlight * 0.34 + comboDrive * 0.2)
        );
        const motionMul = Math.max(0.84, Math.min(1.8, tempoMul * energyMul));
        const bgTimeMul = 0.9 + (motionMul - 1) * 0.45;
        if (!backgroundPaused) {
            state = { ...state, bgTime: state.bgTime + dt * bgTimeMul };
        }

        ctx.save();
        // 카메라 줌아웃/틸트에서도 가장자리에 빈 공간이 보이지 않도록 배경 오버스캔 렌더.
        const overscan = Math.round(
            420
            + Math.max(0, cameraZoom - 1) * 860
            + Math.min(220, Math.abs(cameraX) * 0.62)
            + Math.min(180, Math.abs(cameraY) * 0.72)
        );
        const overscanScaleX = (CANVAS_WIDTH + overscan * 2) / CANVAS_WIDTH;
        const overscanScaleY = (CANVAS_HEIGHT + overscan * 2) / CANVAS_HEIGHT;
        ctx.translate(CANVAS_WIDTH * 0.5, CANVAS_HEIGHT * 0.5);
        ctx.scale(overscanScaleX, overscanScaleY);
        ctx.translate(-CANVAS_WIDTH * 0.5, -CANVAS_HEIGHT * 0.5);
        ctx.translate(shakeX * 0.45, shakeY * 0.45);

        if (hasVideoBackground) {
            // YouTube 비디오 배경 위에 반투명 오버레이 (비디오가 비침)
            ctx.fillStyle = `rgba(3, 10, 20, 0.3)`;
            ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
            drawVideoStageFx(ctx, state.bgTime);
            if (visualTheme === 'sunset') {
                ctx.save();
                ctx.globalAlpha = 0.6;
                drawSunsetBackground(ctx, state.bgTime);
                ctx.globalAlpha = 0.72;
                drawSunsetDetails(ctx, state.bgTime);
                ctx.restore();
            } else if (visualTheme === 'meadow') {
                ctx.save();
                ctx.globalAlpha = 0.42;
                drawMeadowBackground(ctx, state.bgTime);
                ctx.globalAlpha = 0.58;
                drawForestBands(ctx, state.bgTime);
                ctx.restore();
            } else {
                ctx.save();
                ctx.globalAlpha = 0.5;
                drawNightCityBackdrop(ctx, state.bgTime);
                ctx.restore();
            }

            // 비트 펄스 효과 (더 강렬하게)
            if (state.beatPulse > 0) {
                const pulseAlpha = Math.min(0.095, state.beatPulse * 0.095);
                const pulseColor = visualTheme === 'sunset'
                    ? `rgba(255, 180, 100, ${pulseAlpha})`
                    : visualTheme === 'meadow'
                        ? `rgba(130, 255, 160, ${pulseAlpha})`
                        : `rgba(255, 178, 216, ${pulseAlpha * 0.82})`;
                ctx.fillStyle = pulseColor;
                ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

                // 강한 비트에서 에지 글로우
                if (state.beatPulse > 0.45) {
                    const edgeAlpha = Math.min(0.045, (state.beatPulse - 0.45) * 0.08);
                    const edgeTone = visualTheme === 'sunset'
                        ? '255, 176, 116'
                        : visualTheme === 'meadow'
                            ? '166, 240, 178'
                            : '255, 186, 230';
                    const edgeGrad = ctx.createRadialGradient(
                        CANVAS_WIDTH * 0.5, CANVAS_HEIGHT * 0.5, CANVAS_WIDTH * 0.2,
                        CANVAS_WIDTH * 0.5, CANVAS_HEIGHT * 0.5, CANVAS_WIDTH * 0.7
                    );
                    edgeGrad.addColorStop(0, 'rgba(255,255,255,0)');
                    edgeGrad.addColorStop(1, `rgba(${edgeTone},${edgeAlpha.toFixed(3)})`);
                    ctx.fillStyle = edgeGrad;
                    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
                }
            }
        } else {
            if (visualTheme === 'meadow') {
                drawMeadowBackground(ctx, state.bgTime);
                drawForestBands(ctx, state.bgTime);
            } else if (visualTheme === 'sunset') {
                drawSunsetBackground(ctx, state.bgTime);
                drawSunsetDetails(ctx, state.bgTime);
            } else {
                drawNightCitySky(ctx, state.bgTime);
                drawStars(ctx);
                drawAuroraBands(ctx, state.bgTime);
                drawCandyClouds(ctx, state.bgTime);
                drawNightCityBackdrop(ctx, state.bgTime);
            }
        }

        const PATTERN_WIDTH = 1120;

        // 간주 중에는 배경 스크롤 정지
        const updatedLayers = backgroundPaused ? [...state.bgLayers] : state.bgLayers.map(layer => {
            if (layer.speed <= 0) return layer;
            const layerBoost = 1 + Math.min(0.28, layer.speed / 220) * (motionMul - 1);
            const newOffset = (layer.offset + layer.speed * dt * layerBoost * motionMul) % PATTERN_WIDTH;
            return { ...layer, offset: newOffset };
        });
        if (!backgroundPaused) {
            state = { ...state, bgLayers: updatedLayers };
        }

        // 비디오 배경일 때도 바닥 레이어는 유지 (게임플레이 가시성)
        if (visualTheme === 'nightCity') {
            drawCityLayer(ctx, updatedLayers[1], 0.3, PATTERN_WIDTH);
            drawCityLayer(ctx, updatedLayers[2], 0.5, PATTERN_WIDTH);
        }

        if (visualTheme === 'nightCity') {
            drawDistantLightSweep(ctx, state.bgTime);
        }

        // 바닥은 달리기 경로에만 렌더링
        const floorTopY = CANVAS_HEIGHT * (LANE_BOTTOM_Y - 0.145);
        const floorHorizonY = CANVAS_HEIGHT * (LANE_BOTTOM_Y - 0.16);
        if (visualTheme === 'nightCity') {
            drawGroundFog(ctx, state.bgTime, floorHorizonY);
        }
        drawFloorGrid(ctx, floorTopY, CANVAS_WIDTH * (JUDGE_LINE_X + 0.02), updatedLayers[3].offset);
        if (visualTheme === 'meadow') {
            const floorPath = getFloorPathGeometry(floorTopY, CANVAS_WIDTH * (JUDGE_LINE_X + 0.02));

            ctx.save();
            ctx.beginPath();
            ctx.moveTo(floorPath.xNear, floorPath.yTopNear);
            ctx.lineTo(floorPath.xFar, floorPath.yTopFar);
            ctx.lineTo(floorPath.xFar, floorPath.yBottomFar);
            ctx.lineTo(floorPath.xNear, floorPath.yBottomNear);
            ctx.closePath();
            ctx.clip();
            drawMeadowGroundDetails(ctx, state.bgTime, updatedLayers[3].offset);
            ctx.restore();
        }
        if (visualTheme === 'nightCity') {
            drawHalftoneOverlay(ctx, state.bgTime, 0, floorHorizonY - 14);
        }

        ctx.restore();

    };

    const drawStars = (ctx: CanvasRenderingContext2D): void => {
        const time = state.bgTime;
        const starCount = 80;
        for (let i = 0; i < starCount; i++) {
            const seed = i * 7919;
            const x = ((seed * 13) % CANVAS_WIDTH);
            const y = ((seed * 17) % (CANVAS_HEIGHT * 0.5));
            const baseSize = ((seed * 23) % 3) + 0.5;
            const twinkle = Math.sin(time * (1.2 + (seed % 7) * 0.3) + seed) * 0.5 + 0.5;
            const size = baseSize * (0.7 + twinkle * 0.6);
            const alpha = (0.3 + ((seed * 29) % 7) / 10) * (0.6 + twinkle * 0.4) * (1 + state.beatPulse * 0.35);

            ctx.beginPath();
            ctx.arc(x, y, size, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(1, alpha).toFixed(3)})`;
            ctx.fill();

            // 밝은 별에 십자 글레어
            if (baseSize > 2 && twinkle > 0.7) {
                const glareLen = size * 3;
                const glareAlpha = (twinkle - 0.7) * 0.3;
                ctx.strokeStyle = `rgba(200, 230, 255, ${glareAlpha.toFixed(3)})`;
                ctx.lineWidth = 0.7;
                ctx.beginPath();
                ctx.moveTo(x - glareLen, y);
                ctx.lineTo(x + glareLen, y);
                ctx.moveTo(x, y - glareLen);
                ctx.lineTo(x, y + glareLen);
                ctx.stroke();
            }
        }

        // 부유하는 보케 파티클 (비트 반응)
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (let i = 0; i < 12; i++) {
            const seed = i * 3571 + 97;
            const baseX = (seed * 41) % CANVAS_WIDTH;
            const baseY = (seed * 53) % (CANVAS_HEIGHT * 0.6);
            const floatX = baseX + Math.sin(time * 0.4 + i * 1.7) * 40;
            const floatY = baseY + Math.cos(time * 0.3 + i * 2.1) * 25;
            const bokehSize = 8 + (seed % 12) + state.beatPulse * 6;
            const bokehAlpha = 0.04 + (seed % 5) * 0.008 + state.beatPulse * 0.03;
            const bokehGrad = ctx.createRadialGradient(floatX, floatY, 0, floatX, floatY, bokehSize);
            const hue = (seed % 3) === 0 ? '236, 186, 255' : (seed % 3) === 1 ? '255, 180, 230' : '255, 220, 178';
            bokehGrad.addColorStop(0, `rgba(${hue}, ${bokehAlpha.toFixed(3)})`);
            bokehGrad.addColorStop(1, `rgba(${hue}, 0)`);
            ctx.fillStyle = bokehGrad;
            ctx.beginPath();
            ctx.arc(floatX, floatY, bokehSize, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    };

    const drawAuroraBands = (ctx: CanvasRenderingContext2D, time: number): void => {
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (let i = 0; i < 3; i++) {
            const y = CANVAS_HEIGHT * (0.15 + i * 0.08);
            const wave = Math.sin(time * (0.45 + i * 0.12) + i * 2.1);
            const grad = ctx.createLinearGradient(0, y - 40, 0, y + 80);
            grad.addColorStop(0, 'rgba(236, 186, 255, 0)');
            grad.addColorStop(0.45, `rgba(236, 186, 255, ${0.06 + state.beatPulse * 0.03})`);
            grad.addColorStop(1, 'rgba(255, 198, 142, 0)');
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.moveTo(0, y + wave * 12);
            for (let x = 0; x <= CANVAS_WIDTH; x += 48) {
                const w = Math.sin((x * 0.01) + time * 0.7 + i) * 12;
                ctx.lineTo(x, y + w + wave * 8);
            }
            ctx.lineTo(CANVAS_WIDTH, y + 100);
            ctx.lineTo(0, y + 100);
            ctx.closePath();
            ctx.fill();
        }
        ctx.restore();
    };

    const drawCityLayer = (ctx: CanvasRenderingContext2D, layer: ParallaxLayer, opacity: number, patternWidth: number): void => {
        ctx.fillStyle = `rgba(10, 4, 25, ${opacity})`;
        const buildingWidths = [40, 60, 35, 80, 50, 70, 45, 90, 55, 65, 40, 75];
        const buildingHeights = [80, 120, 60, 150, 90, 130, 70, 160, 100, 110, 75, 140];

        let drawX = -layer.offset;
        if (drawX > 0) drawX -= patternWidth;

        let idx = 0;

        while (drawX < CANVAS_WIDTH) {
            const w = buildingWidths[idx % buildingWidths.length];
            const h = buildingHeights[idx % buildingHeights.length] * (1 + state.beatPulse * 0.02);
            const gap = 10 + (idx % 3) * 5;
            const bY = layer.y + layer.height - h;

            if (drawX + w > 0 && drawX < CANVAS_WIDTH) {
                ctx.fillRect(drawX, bY, w, h);
                ctx.fillStyle = `rgba(26, 16, 52, ${Math.min(0.9, opacity + 0.12)})`;
                ctx.fillRect(drawX, bY - 4, w, 4);

                if ((idx % 5) === 0) {
                    // rooftop antenna to avoid flat skyline silhouette repetition
                    const rx = drawX + w * 0.56;
                    ctx.strokeStyle = `rgba(255, 196, 126, ${Math.max(0.1, opacity * 0.48)})`;
                    ctx.lineWidth = 1.2;
                    ctx.beginPath();
                    ctx.moveTo(rx, bY - 2);
                    ctx.lineTo(rx, bY - 16 - (idx % 3) * 3);
                    ctx.stroke();
                }

                if (opacity > 0.4) {
                    const windowColor = idx % 3 === 0 ? COLORS.primary : idx % 3 === 1 ? COLORS.secondary : COLORS.accent;
                    ctx.fillStyle = `${windowColor}22`;
                    for (let wy = bY + 10; wy < bY + h - 10; wy += 20) {
                        for (let wx = drawX + 8; wx < drawX + w - 8; wx += 15) {
                            if ((wx * wy * 31) % 5 < 3) {
                                ctx.fillRect(wx, wy, 6, 8);
                            }
                        }
                    }
                    ctx.fillStyle = `rgba(10, 4, 25, ${opacity})`;
                }
            }

            drawX += w + gap;
            idx++;
        }
    };

    const drawFloorGrid = (
        ctx: CanvasRenderingContext2D,
        floorY: number,
        vanishingX: number,
        motionOffset: number
    ): void => {
        const themeColor = visualTheme === 'sunset' ? '255, 180, 100'
            : visualTheme === 'meadow' ? '130, 255, 170'
            : '236, 178, 255';
        const {
            xNear,
            xFar,
            yTopNear,
            yBottomNear,
            yTopFar,
            yBottomFar,
            roadLength,
        } = getFloorPathGeometry(floorY, vanishingX);
        const scrollNorm = (((-motionOffset) % 96) + 96) / 96;
        const centerNear = (yTopNear + yBottomNear) * 0.5;
        const centerFar = (yTopFar + yBottomFar) * 0.5;

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(xNear, yTopNear);
        ctx.lineTo(xFar, yTopFar);
        ctx.lineTo(xFar, yBottomFar);
        ctx.lineTo(xNear, yBottomNear);
        ctx.closePath();
        ctx.clip();

        const roadGrad = ctx.createLinearGradient(xNear, centerNear, xFar, centerFar);
        if (visualTheme === 'sunset') {
            roadGrad.addColorStop(0, 'rgba(64, 58, 54, 0.96)');
            roadGrad.addColorStop(1, 'rgba(34, 31, 30, 0.99)');
        } else if (visualTheme === 'meadow') {
            roadGrad.addColorStop(0, 'rgba(56, 66, 58, 0.95)');
            roadGrad.addColorStop(1, 'rgba(30, 38, 32, 0.99)');
        } else {
            roadGrad.addColorStop(0, 'rgba(46, 42, 58, 0.96)');
            roadGrad.addColorStop(1, 'rgba(22, 20, 29, 0.99)');
        }
        ctx.fillStyle = roadGrad;
        ctx.fillRect(xNear - 8, Math.min(yTopNear, yTopFar) - 6, roadLength + 22, Math.max(yBottomNear, yBottomFar) - Math.min(yTopNear, yTopFar) + 12);

        const centerGlow = ctx.createLinearGradient(xNear, centerNear, xFar, centerFar);
        centerGlow.addColorStop(0, 'rgba(255,255,255,0.15)');
        centerGlow.addColorStop(1, 'rgba(255,255,255,0.02)');
        ctx.fillStyle = centerGlow;
        ctx.beginPath();
        ctx.moveTo(xNear, centerNear - 22);
        ctx.lineTo(xFar, centerFar - 6);
        ctx.lineTo(xFar, centerFar + 6);
        ctx.lineTo(xNear, centerNear + 22);
        ctx.closePath();
        ctx.fill();

        const crossCount = 12;
        for (let i = 0; i < crossCount; i++) {
            const t = (i + scrollNorm) / Math.max(1, crossCount);
            const p = 1 - Math.pow(1 - t, 1.95);
            const x = xNear + p * roadLength;
            const yTop = lerp(yTopNear, yTopFar, p);
            const yBottom = lerp(yBottomNear, yBottomFar, p);
            const alpha = 0.04 + (1 - t) * 0.1 + state.beatPulse * 0.01;
            ctx.strokeStyle = `rgba(${themeColor}, ${alpha.toFixed(3)})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(Math.round(x) + 0.5, yTop);
            ctx.lineTo(Math.round(x) + 0.5, yBottom);
            ctx.stroke();
        }

        const laneCount = 4;
        for (let i = 1; i <= laneCount; i++) {
            const u = i / (laneCount + 1);
            const yNear = lerp(yTopNear, yBottomNear, u);
            const yFar = lerp(yTopFar, yBottomFar, u);
            ctx.strokeStyle = `rgba(${themeColor}, ${(0.05 + state.beatPulse * 0.008).toFixed(3)})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(xNear, yNear);
            ctx.lineTo(xFar, yFar);
            ctx.stroke();
        }

        const dashSpacing = Math.max(44, roadLength / 10.4);
        const dashLength = 28;
        const dashCount = Math.ceil((roadLength + dashSpacing) / dashSpacing);
        const dashOffset = (((motionOffset * 2.2) % dashSpacing) + dashSpacing) % dashSpacing;
        for (let i = 0; i < dashCount; i++) {
            const xTail = xFar - (i * dashSpacing + dashOffset);
            const xHead = xTail - dashLength;
            if (xHead <= xNear || xTail >= xFar + 40) continue;
            const kA = Math.max(0, Math.min(1, (xHead - xNear) / Math.max(1, roadLength)));
            const kB = Math.max(0, Math.min(1, (xTail - xNear) / Math.max(1, roadLength)));
            const cyA = lerp(centerNear, centerFar, kA);
            const cyB = lerp(centerNear, centerFar, kB);
            const hA = lerp(7.5, 2.8, kA);
            const hB = lerp(7.5, 2.8, kB);
            const alpha = 0.22 + (1 - kA) * 0.48;
            ctx.fillStyle = `rgba(255, 232, 164, ${alpha.toFixed(3)})`;
            ctx.beginPath();
            ctx.moveTo(xHead, cyA - hA);
            ctx.lineTo(xTail, cyB - hB);
            ctx.lineTo(xTail, cyB + hB);
            ctx.lineTo(xHead, cyA + hA);
            ctx.closePath();
            ctx.fill();
        }

        const textureCount = 22;
        for (let i = 0; i < textureCount; i++) {
            const t = (i / textureCount + scrollNorm * 0.25) % 1;
            const p = 1 - Math.pow(1 - t, 2.1);
            const x = xNear + p * roadLength;
            const yTop = lerp(yTopNear, yTopFar, p);
            const yBottom = lerp(yBottomNear, yBottomFar, p);
            const seed = i * 97 + Math.floor(scrollNorm * 1000);
            const py = lerp(yTop, yBottom, ((seed % 100) / 100));
            const alpha = 0.04 + (1 - t) * 0.08;
            ctx.fillStyle = `rgba(${themeColor}, ${alpha.toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(x, py, 0.8 + (1 - t) * 1.7, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();

        const roadEdgeAlpha = 0.16 + state.beatPulse * 0.05 + comboDrive * 0.02;
        ctx.strokeStyle = `rgba(${themeColor}, ${roadEdgeAlpha.toFixed(3)})`;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(xNear, yTopNear);
        ctx.lineTo(xFar, yTopFar);
        ctx.moveTo(xNear, yBottomNear);
        ctx.lineTo(xFar, yBottomFar);
        ctx.stroke();

        const shoulderGlow = 0.04 + musicHighlight * 0.07 + comboDrive * 0.05;
        ctx.strokeStyle = `rgba(255, 232, 170, ${shoulderGlow.toFixed(3)})`;
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.moveTo(xNear + 2, yTopNear + 6);
        ctx.lineTo(xFar, yTopFar + 2);
        ctx.moveTo(xNear + 2, yBottomNear - 6);
        ctx.lineTo(xFar, yBottomFar - 2);
        ctx.stroke();

        const speedLines = 8;
        const speedPhase = (((motionOffset * 1.7) % 140) + 140) % 140;
        ctx.strokeStyle = `rgba(255,255,255,${(0.04 + musicHighlight * 0.04).toFixed(3)})`;
        ctx.lineWidth = 1.05;
        for (let i = 0; i < speedLines; i++) {
            const x = xNear + i * 150 - speedPhase;
            if (x < xNear || x > xFar - 24) continue;
            const k = Math.max(0, Math.min(1, (x - xNear) / Math.max(1, roadLength)));
            const yTop = lerp(yTopNear, yTopFar, k);
            const yBottom = lerp(yBottomNear, yBottomFar, k);
            const yMid = (yTop + yBottom) * 0.5;
            const h = lerp(14, 5, k);
            ctx.beginPath();
            ctx.moveTo(x, yMid - h * 0.5);
            ctx.lineTo(x + 14, yMid - h * 0.25);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(x, yMid + h * 0.5);
            ctx.lineTo(x + 14, yMid + h * 0.25);
            ctx.stroke();
        }
    };

    const getFloorPathGeometry = (floorY: number, vanishingX: number) => {
        const xNear = Math.max(20, CANVAS_WIDTH * (JUDGE_LINE_X + 0.02));
        const xFar = CANVAS_WIDTH + 26;
        const laneTop = CANVAS_HEIGHT * LANE_TOP_Y;
        const laneBottom = CANVAS_HEIGHT * LANE_BOTTOM_Y;
        const laneSpan = Math.max(40, laneBottom - laneTop);
        const laneCenter = (laneTop + laneBottom) * 0.5;
        const centerNear = Math.max(floorY + laneSpan * 0.12, laneBottom + laneSpan * 0.08);
        const vanishingNorm = Math.max(0, Math.min(1, vanishingX / CANVAS_WIDTH));
        const centerFar = laneCenter + (vanishingNorm - 0.5) * laneSpan * 0.05;
        const nearHalf = laneSpan * 0.34;
        const farHalf = laneSpan * 0.14;
        const yTopNear = centerNear - nearHalf;
        const yBottomNear = centerNear + nearHalf;
        const yTopFar = centerFar - farHalf;
        const yBottomFar = centerFar + farHalf;
        const roadLength = Math.max(1, xFar - xNear);
        return {
            xNear,
            xFar,
            yTopNear,
            yBottomNear,
            yTopFar,
            yBottomFar,
            roadLength,
        };
    };

    const drawDistantLightSweep = (ctx: CanvasRenderingContext2D, time: number): void => {
        const sweepX = ((time * 70) % (CANVAS_WIDTH + 600)) - 300;
        const grad = ctx.createLinearGradient(sweepX - 220, 0, sweepX + 220, 0);
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(0.5, `rgba(255, 175, 70, ${0.06 + state.beatPulse * 0.04})`);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, CANVAS_HEIGHT * 0.08, CANVAS_WIDTH, CANVAS_HEIGHT * 0.45);
    };

    const drawGroundFog = (ctx: CanvasRenderingContext2D, time: number, horizonY: number): void => {
        const baseY = Math.max(horizonY + 52, CANVAS_HEIGHT * 0.72);
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.beginPath();
        ctx.rect(0, horizonY + 4, CANVAS_WIDTH, CANVAS_HEIGHT - (horizonY + 4));
        ctx.clip();
        for (let i = 0; i < 3; i++) {
            const drift = ((time * (22 + i * 6)) % (CANVAS_WIDTH + 300)) - 150;
            const grad = ctx.createRadialGradient(
                drift,
                baseY + i * 24,
                10,
                drift,
                baseY + i * 24,
                260 + i * 60
            );
            grad.addColorStop(0, `rgba(120, 210, 255, ${0.03 + state.beatPulse * 0.015})`);
            grad.addColorStop(1, 'rgba(120, 210, 255, 0)');
            ctx.fillStyle = grad;
            ctx.fillRect(-40, baseY - 90, CANVAS_WIDTH + 80, CANVAS_HEIGHT * 0.35);
        }
        ctx.restore();
    };

    const drawCandyClouds = (ctx: CanvasRenderingContext2D, time: number): void => {
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (let i = 0; i < 5; i++) {
            const baseX = (((time * (16 + i * 2)) + i * 220) % (CANVAS_WIDTH + 380)) - 190;
            const y = CANVAS_HEIGHT * (0.14 + i * 0.06) + Math.sin(time * 0.8 + i) * 10;
            const w = 220 + i * 30;
            const h = 68 + i * 12;
            const grad = ctx.createRadialGradient(baseX, y, 20, baseX, y, w);
            grad.addColorStop(0, `rgba(255, 185, 236, ${0.11 + state.beatPulse * 0.05})`);
            grad.addColorStop(0.65, `rgba(131, 219, 255, ${0.08 + state.beatPulse * 0.03})`);
            grad.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = grad;
            ctx.fillRect(baseX - w, y - h, w * 2, h * 2);
        }
        ctx.restore();
    };

    const drawHalftoneOverlay = (ctx: CanvasRenderingContext2D, time: number, yStart: number, yEnd: number): void => {
        const pulse = 0.01 + state.beatPulse * 0.012;
        ctx.save();
        ctx.globalCompositeOperation = 'overlay';
        const start = Math.max(0, Math.min(CANVAS_HEIGHT, yStart));
        const end = Math.max(start, Math.min(CANVAS_HEIGHT, yEnd));
        for (let y = start; y < end; y += 20) {
            for (let x = 0; x < CANVAS_WIDTH; x += 20) {
                const n = Math.sin((x * 0.025) + (y * 0.018) + time * 0.9);
                const alpha = Math.max(0, n) * pulse;
                if (alpha <= 0.002) continue;
                ctx.fillStyle = `rgba(255, 250, 210, ${alpha})`;
                ctx.beginPath();
                ctx.arc(x, y, 2.2, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.restore();
    };

    const drawVideoStageFx = (ctx: CanvasRenderingContext2D, time: number): void => {
        const topGrad = ctx.createLinearGradient(0, 0, 0, CANVAS_HEIGHT * 0.42);
        topGrad.addColorStop(0, `rgba(255, 194, 116, ${0.05 + state.beatPulse * 0.018})`);
        topGrad.addColorStop(1, 'rgba(255, 194, 116, 0)');
        ctx.fillStyle = topGrad;
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT * 0.48);

        const bottomGrad = ctx.createLinearGradient(0, CANVAS_HEIGHT * 0.58, 0, CANVAS_HEIGHT);
        bottomGrad.addColorStop(0, 'rgba(120, 220, 255, 0)');
        bottomGrad.addColorStop(1, `rgba(120, 220, 255, ${0.05 + state.beatPulse * 0.018})`);
        ctx.fillStyle = bottomGrad;
        ctx.fillRect(0, CANVAS_HEIGHT * 0.55, CANVAS_WIDTH, CANVAS_HEIGHT * 0.45);

        const sweepX = ((time * 180) % (CANVAS_WIDTH + 320)) - 160;
        const sweep = ctx.createLinearGradient(sweepX - 90, 0, sweepX + 90, 0);
        sweep.addColorStop(0, 'rgba(255,255,255,0)');
        sweep.addColorStop(0.5, `rgba(255, 222, 168, ${0.02 + state.beatPulse * 0.01})`);
        sweep.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = sweep;
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

        ctx.strokeStyle = `rgba(255, 226, 176, ${0.03 + state.beatPulse * 0.02})`;
        ctx.lineWidth = 1;
        for (let y = CANVAS_HEIGHT * 0.14; y < CANVAS_HEIGHT * 0.62; y += 28) {
            const wobble = Math.sin(time * 1.6 + y * 0.018) * 8;
            ctx.beginPath();
            ctx.moveTo(-20, y + wobble);
            ctx.lineTo(CANVAS_WIDTH + 20, y - wobble * 0.6);
            ctx.stroke();
        }
    };

    const drawVignette = (ctx: CanvasRenderingContext2D): void => {
        const cx = CANVAS_WIDTH / 2;
        const cy = CANVAS_HEIGHT / 2;
        const outerRadius = Math.sqrt(cx * cx + cy * cy);

        const vignetteGrad = ctx.createRadialGradient(cx, cy, outerRadius * 0.35, cx, cy, outerRadius);
        vignetteGrad.addColorStop(0, 'rgba(0, 0, 0, 0)');
        vignetteGrad.addColorStop(0.6, 'rgba(5, 2, 15, 0.15)');
        vignetteGrad.addColorStop(0.85, 'rgba(5, 2, 15, 0.35)');
        vignetteGrad.addColorStop(1, 'rgba(5, 2, 15, 0.42)');
        ctx.fillStyle = vignetteGrad;
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

        // 비트에 반응하는 테두리 글로우
        if (state.beatPulse > 0.1) {
            const borderAlpha = (state.beatPulse - 0.1) * 0.12;
            const themeColor = visualTheme === 'sunset' ? '255,170,80'
                : visualTheme === 'meadow' ? '100,230,130'
                : '0,200,255';
            // 상단
            const topGlow = ctx.createLinearGradient(0, 0, 0, 40);
            topGlow.addColorStop(0, `rgba(${themeColor},${borderAlpha.toFixed(3)})`);
            topGlow.addColorStop(1, `rgba(${themeColor},0)`);
            ctx.fillStyle = topGlow;
            ctx.fillRect(0, 0, CANVAS_WIDTH, 40);
            // 하단
            const botGlow = ctx.createLinearGradient(0, CANVAS_HEIGHT - 40, 0, CANVAS_HEIGHT);
            botGlow.addColorStop(0, `rgba(${themeColor},0)`);
            botGlow.addColorStop(1, `rgba(${themeColor},${borderAlpha.toFixed(3)})`);
            ctx.fillStyle = botGlow;
            ctx.fillRect(0, CANVAS_HEIGHT - 40, CANVAS_WIDTH, 40);
        }
    };

    // 화면 고정 후처리: 카메라 워킹의 회전/이동을 따라가지 않게 분리.
    const renderScreenOverlay = (ctx: CanvasRenderingContext2D): void => {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        drawVignette(ctx);
        ctx.restore();
    };

    const drawMeadowBackground = (ctx: CanvasRenderingContext2D, time: number): void => {
        const sky = ctx.createLinearGradient(0, 0, 0, CANVAS_HEIGHT * 0.72);
        sky.addColorStop(0, '#a5ddff');
        sky.addColorStop(0.52, '#d7f7ff');
        sky.addColorStop(1, '#f8ffd8');
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

        // cloud bands
        for (let i = 0; i < 6; i++) {
            const meadowCloudCycle = CANVAS_WIDTH + 280;
            const cx = ((((-time * (12 + i * 2)) + i * 220) % meadowCloudCycle) + meadowCloudCycle) % meadowCloudCycle - 120;
            const cy = CANVAS_HEIGHT * (0.16 + i * 0.05);
            const grad = ctx.createRadialGradient(cx, cy, 20, cx, cy, 170);
            grad.addColorStop(0, 'rgba(255,255,255,0.42)');
            grad.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = grad;
            ctx.fillRect(cx - 180, cy - 90, 360, 180);
        }

        // hills
        const hill = (y: number, amp: number, color: string, speed: number) => {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.moveTo(0, CANVAS_HEIGHT);
            for (let x = 0; x <= CANVAS_WIDTH; x += 20) {
                const wave = Math.sin(x * 0.007 + time * speed) * amp;
                ctx.lineTo(x, y + wave);
            }
            ctx.lineTo(CANVAS_WIDTH, CANVAS_HEIGHT);
            ctx.closePath();
            ctx.fill();
        };
        hill(CANVAS_HEIGHT * 0.6, 20, 'rgba(99, 190, 118, 0.8)', 0.2);
        hill(CANVAS_HEIGHT * 0.68, 16, 'rgba(67, 153, 95, 0.92)', 0.3);
    };

    const drawForestBands = (ctx: CanvasRenderingContext2D, time: number): void => {
        const drawPineBand = (
            baseY: number,
            trunkH: number,
            crownH: number,
            spacing: number,
            speed: number,
            trunkColor: string,
            crownColor: string
        ) => {
            const drift = (((-time * speed) % spacing) + spacing) % spacing;
            for (let x = -spacing - drift; x < CANVAS_WIDTH + spacing; x += spacing) {
                const sx = x + spacing * 0.5;
                ctx.fillStyle = trunkColor;
                ctx.fillRect(sx - 3, baseY - trunkH, 6, trunkH);

                ctx.fillStyle = crownColor;
                for (let l = 0; l < 3; l++) {
                    const layerY = baseY - trunkH - l * (crownH * 0.27);
                    const half = crownH * (0.26 - l * 0.045);
                    ctx.beginPath();
                    ctx.moveTo(sx, layerY - crownH * 0.24);
                    ctx.lineTo(sx - half, layerY + crownH * 0.12);
                    ctx.lineTo(sx + half, layerY + crownH * 0.12);
                    ctx.closePath();
                    ctx.fill();
                }
            }
        };

        const mist = ctx.createLinearGradient(0, CANVAS_HEIGHT * 0.56, 0, CANVAS_HEIGHT * 0.78);
        mist.addColorStop(0, 'rgba(236, 255, 241, 0.08)');
        mist.addColorStop(1, 'rgba(236, 255, 241, 0)');
        ctx.fillStyle = mist;
        ctx.fillRect(0, CANVAS_HEIGHT * 0.52, CANVAS_WIDTH, CANVAS_HEIGHT * 0.3);

        drawPineBand(
            CANVAS_HEIGHT * 0.68,
            24,
            70,
            88,
            10,
            'rgba(55, 92, 57, 0.48)',
            'rgba(62, 120, 73, 0.55)'
        );
        drawPineBand(
            CANVAS_HEIGHT * 0.74,
            30,
            84,
            72,
            16,
            'rgba(36, 69, 44, 0.66)',
            'rgba(42, 98, 57, 0.74)'
        );
    };

    const drawMeadowGroundDetails = (ctx: CanvasRenderingContext2D, time: number, offset: number): void => {
        const floorY = CANVAS_HEIGHT * 0.74;
        const base = ((offset * 0.6 + time * 20) % 56);
        for (let x = -56 + base; x < CANVAS_WIDTH + 56; x += 28) {
            const h = 8 + (Math.sin((x * 0.04) + time * 3.1) + 1) * 5;
            ctx.strokeStyle = 'rgba(190, 255, 170, 0.45)';
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.moveTo(x, floorY);
            ctx.quadraticCurveTo(x + 2, floorY - h * 0.6, x + 4, floorY - h);
            ctx.stroke();
        }

        for (let i = 0; i < 24; i++) {
            const seed = i * 137 + 41;
            const x = (seed * 29 + offset * 0.4) % (CANVAS_WIDTH + 20) - 10;
            const y = floorY + 8 + (seed % 28);
            const pulse = (Math.sin(time * 4 + i) + 1) * 0.5;
            ctx.fillStyle = `rgba(255, 238, 170, ${0.18 + pulse * 0.2})`;
            ctx.beginPath();
            ctx.arc(x, y, 1.2 + pulse * 0.9, 0, Math.PI * 2);
            ctx.fill();
        }
    };

    const drawNightCitySky = (ctx: CanvasRenderingContext2D, time: number): void => {
        const pulseBoost = state.beatPulse * 0.15;
        const colorShift = Math.sin(time * 0.15) * 0.5 + 0.5;
        const skyGrad = ctx.createLinearGradient(0, 0, 0, CANVAS_HEIGHT * 0.72);
        skyGrad.addColorStop(0, `rgba(${Math.round(46 + pulseBoost * 18 + colorShift * 8)}, ${Math.round(33 + pulseBoost * 10)}, ${Math.round(88 + pulseBoost * 14 + colorShift * 6)}, 1)`);
        skyGrad.addColorStop(0.55, `rgba(${Math.round(40 + pulseBoost * 14)}, ${Math.round(34 + pulseBoost * 8 + colorShift * 4)}, ${Math.round(94 + pulseBoost * 12)}, 1)`);
        skyGrad.addColorStop(1, `rgba(${Math.round(22 + pulseBoost * 8)}, ${Math.round(20 + pulseBoost * 6)}, ${Math.round(54 + pulseBoost * 8)}, 1)`);
        ctx.fillStyle = skyGrad;
        ctx.fillRect(-20, -20, CANVAS_WIDTH + 40, CANVAS_HEIGHT + 40);

        // 달 (더 풍부한 글로우)
        const moonX = CANVAS_WIDTH * 0.82 + Math.sin(time * 0.2) * 4;
        const moonY = CANVAS_HEIGHT * 0.16;
        // 외부 헤일로
        const halo = ctx.createRadialGradient(moonX, moonY, 20, moonX, moonY, 180);
        halo.addColorStop(0, `rgba(255, 240, 215, ${(0.12 + state.beatPulse * 0.06).toFixed(3)})`);
        halo.addColorStop(1, 'rgba(255, 240, 215, 0)');
        ctx.fillStyle = halo;
        ctx.fillRect(moonX - 200, moonY - 200, 400, 400);
        // 코어
        const moon = ctx.createRadialGradient(moonX, moonY, 6, moonX, moonY, 100);
        moon.addColorStop(0, 'rgba(255, 245, 215, 0.9)');
        moon.addColorStop(0.5, 'rgba(255, 238, 200, 0.3)');
        moon.addColorStop(1, 'rgba(255, 240, 205, 0)');
        ctx.fillStyle = moon;
        ctx.fillRect(moonX - 110, moonY - 110, 220, 220);
    };

    const drawNightCityBackdrop = (ctx: CanvasRenderingContext2D, time: number): void => {
        const drift = (((-time * 18) % 140) + 140) % 140;
        for (let layer = 0; layer < 2; layer++) {
            const baseY = CANVAS_HEIGHT * (0.5 + layer * 0.09);
            const alpha = 0.18 + layer * 0.1;
            const widthBase = 36 + layer * 18;
            const heightBase = 90 + layer * 38;
            ctx.fillStyle = `rgba(12, 8, 28, ${alpha})`;
            for (let x = -140 + drift * (0.6 + layer * 0.3); x < CANVAS_WIDTH + 140; x += widthBase + 12) {
                const w = widthBase + ((x * 17 + layer * 31) % 26);
                const h = heightBase + ((x * 11 + layer * 47) % 72);
                const y = baseY + layer * 18 - h;
                ctx.fillRect(x, y, w, h);
            }
        }
    };

    const drawSunsetBackground = (ctx: CanvasRenderingContext2D, time: number): void => {
        const sky = ctx.createLinearGradient(0, 0, 0, CANVAS_HEIGHT * 0.75);
        sky.addColorStop(0, '#ffd9b8');
        sky.addColorStop(0.46, '#ffbc98');
        sky.addColorStop(1, '#9f8dc4');
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

        const sunY = CANVAS_HEIGHT * 0.28 + Math.sin(time * 0.2) * 4;
        ctx.fillStyle = 'rgba(255, 230, 176, 0.48)';
        ctx.beginPath();
        ctx.arc(CANVAS_WIDTH * 0.72, sunY, 46, 0, Math.PI * 2);
        ctx.fill();
        const sun = ctx.createRadialGradient(CANVAS_WIDTH * 0.72, sunY, 10, CANVAS_WIDTH * 0.72, sunY, 120);
        sun.addColorStop(0, 'rgba(255, 246, 196, 0.92)');
        sun.addColorStop(1, 'rgba(255, 239, 180, 0)');
        ctx.fillStyle = sun;
        ctx.fillRect(CANVAS_WIDTH * 0.58, sunY - 130, 280, 260);
    };

    const drawSunsetDetails = (ctx: CanvasRenderingContext2D, time: number): void => {
        const horizon = CANVAS_HEIGHT * 0.64;
        const mountain = (baseY: number, amp: number, color: string, speed: number) => {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.moveTo(0, CANVAS_HEIGHT);
            for (let x = 0; x <= CANVAS_WIDTH; x += 18) {
                const w = Math.sin(x * 0.008 + time * speed) * amp;
                ctx.lineTo(x, baseY + w);
            }
            ctx.lineTo(CANVAS_WIDTH, CANVAS_HEIGHT);
            ctx.closePath();
            ctx.fill();
        };
        mountain(horizon - 68, 20, 'rgba(145, 100, 128, 0.36)', 0.12);
        mountain(horizon - 24, 14, 'rgba(118, 76, 96, 0.5)', 0.18);

        // distant town silhouettes
        ctx.fillStyle = 'rgba(86, 52, 70, 0.58)';
        const townSpacing = 38;
        const townDrift = (((-time * 10) % townSpacing) + townSpacing) % townSpacing;
        const townCount = Math.ceil((CANVAS_WIDTH + 360) / townSpacing);
        for (let i = -4; i < townCount; i++) {
            const seed = i * 131 + 79;
            const x = i * townSpacing - 140 + townDrift;
            const h = 22 + (Math.abs(seed) % 32);
            ctx.fillRect(x, horizon - h, 28, h);
        }

        // warm haze
        const haze = ctx.createLinearGradient(0, horizon - 110, 0, horizon + 20);
        haze.addColorStop(0, 'rgba(255, 220, 140, 0)');
        haze.addColorStop(1, 'rgba(255, 198, 128, 0.2)');
        ctx.fillStyle = haze;
        ctx.fillRect(0, horizon - 120, CANVAS_WIDTH, 170);

        // cloud streaks
        for (let i = 0; i < 6; i++) {
            const sunsetCloudCycle = CANVAS_WIDTH + 280;
            const cx = ((((-time * (10 + i * 2.3)) + i * 210) % sunsetCloudCycle) + sunsetCloudCycle) % sunsetCloudCycle - 140;
            const cy = CANVAS_HEIGHT * (0.16 + i * 0.055) + Math.sin(time * 0.7 + i) * 6;
            const w = 170 + i * 28;
            const h = 36 + i * 7;
            const cloud = ctx.createRadialGradient(cx, cy, 12, cx, cy, w);
            cloud.addColorStop(0, 'rgba(255, 245, 226, 0.18)');
            cloud.addColorStop(0.75, 'rgba(255, 201, 154, 0.12)');
            cloud.addColorStop(1, 'rgba(255, 201, 154, 0)');
            ctx.fillStyle = cloud;
            ctx.fillRect(cx - w, cy - h, w * 2, h * 2);
        }

        // extra skyline objects (yellow map detail boost)
        const skylineSpacing = 58;
        const skylineDrift = (((-time * 14) % skylineSpacing) + skylineSpacing) % skylineSpacing;
        const skylineCount = Math.ceil((CANVAS_WIDTH + 420) / skylineSpacing);
        for (let i = -4; i < skylineCount; i++) {
            const seed = i * 173 + 43;
            const x = i * skylineSpacing - 180 + skylineDrift;
            const base = horizon - 6;
            const w = 30 + (Math.abs(seed) % 16);
            const h = 34 + ((Math.abs(seed * 3) % 46));
            ctx.fillStyle = 'rgba(95, 56, 78, 0.62)';
            ctx.fillRect(x, base - h, w, h);

            if (i % 3 === 0) {
                // antenna/spire
                ctx.strokeStyle = 'rgba(255, 218, 152, 0.45)';
                ctx.lineWidth = 1.2;
                ctx.beginPath();
                ctx.moveTo(x + w * 0.5, base - h);
                ctx.lineTo(x + w * 0.5, base - h - 12);
                ctx.stroke();
            }

            ctx.fillStyle = 'rgba(255, 228, 174, 0.28)';
            let row = 0;
            for (let wy = base - h + 6; wy < base - 4; wy += 10) {
                if (((Math.abs(seed) + row * 5) % 4) === 0) {
                    row++;
                    continue;
                }
                ctx.fillRect(x + 5, wy, Math.max(4, w - 10), 2.6);
                row++;
            }
        }

        // foreground lantern posts
        const postBaseY = CANVAS_HEIGHT * 0.66;
        for (let i = 0; i < 9; i++) {
            const postCycle = CANVAS_WIDTH + 180;
            const px = ((((-time * 44) + i * 140) % postCycle) + postCycle) % postCycle - 90;
            const postH = 36 + (i % 3) * 8;
            ctx.strokeStyle = 'rgba(92, 56, 76, 0.68)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(px, postBaseY);
            ctx.lineTo(px, postBaseY - postH);
            ctx.stroke();

            const lampY = postBaseY - postH;
            const pulse = 0.16 + (Math.sin(time * 3.6 + i) + 1) * 0.09;
            ctx.fillStyle = `rgba(255, 231, 170, ${pulse.toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(px, lampY, 3.4, 0, Math.PI * 2);
            ctx.fill();
        }

        // large foreground silhouettes (map feels less empty)
        const fgSpacing = 120;
        const fgDrift = (((-time * 30) % fgSpacing) + fgSpacing) % fgSpacing;
        const fgCount = Math.ceil((CANVAS_WIDTH + 560) / fgSpacing);
        for (let i = -4; i < fgCount; i++) {
            const seed = i * 211 + 61;
            const x = i * fgSpacing - 280 + fgDrift;
            const base = CANVAS_HEIGHT * 0.68;
            const towerW = 54 + (Math.abs(seed) % 18);
            const towerH = 82 + (Math.abs(seed * 5) % 70);
            ctx.fillStyle = 'rgba(68, 40, 58, 0.54)';
            ctx.fillRect(x, base - towerH, towerW, towerH);
            ctx.fillStyle = 'rgba(255, 214, 156, 0.2)';
            for (let wy = base - towerH + 10; wy < base - 8; wy += 14) {
                ctx.fillRect(x + 8, wy, towerW - 16, 3);
            }
        }
    };

    const renderLanes = (ctx: CanvasRenderingContext2D): void => {
        ctx.save();
        ctx.translate(shakeX, shakeY);

        const topY = CANVAS_HEIGHT * LANE_TOP_Y;
        const bottomY = CANVAS_HEIGHT * LANE_BOTTOM_Y;

        [topY, bottomY].forEach((y, i) => {
            const color = i === 0 ? COLORS.noteTop : COLORS.noteBottom;
            const laneGrad = ctx.createLinearGradient(CANVAS_WIDTH * JUDGE_LINE_X - 40, y, CANVAS_WIDTH, y);
            laneGrad.addColorStop(0, `${color}20`);
            laneGrad.addColorStop(0.45, `${color}38`);
            laneGrad.addColorStop(1, `${color}10`);
            ctx.strokeStyle = laneGrad;
            ctx.lineWidth = 6;
            ctx.beginPath();
            ctx.moveTo(CANVAS_WIDTH * JUDGE_LINE_X - 30, y);
            ctx.lineTo(CANVAS_WIDTH, y);
            ctx.stroke();

            // lane sparkle
            for (let x = CANVAS_WIDTH * JUDGE_LINE_X + 35; x < CANVAS_WIDTH; x += 175) {
                const seed = x + i * 123;
                const pulse = (Math.sin(state.bgTime * 3 + seed * 0.017) + 1) * 0.5;
                const laneTone = i === 0 ? '120, 224, 255' : '255, 136, 196';
                ctx.fillStyle = `rgba(${laneTone},${0.03 + pulse * 0.085})`;
                ctx.beginPath();
                ctx.arc(x, y, 2 + pulse * 2, 0, Math.PI * 2);
                ctx.fill();
            }

            const laneAura = 0.08 + musicHighlight * 0.11 + comboDrive * 0.09;
            const auraGrad = ctx.createLinearGradient(CANVAS_WIDTH * JUDGE_LINE_X, y - 24, CANVAS_WIDTH, y + 24);
            auraGrad.addColorStop(0, `${color}00`);
            auraGrad.addColorStop(0.45, `${color}${Math.round(Math.min(255, laneAura * 255)).toString(16).padStart(2, '0')}`);
            auraGrad.addColorStop(1, `${color}00`);
            ctx.fillStyle = auraGrad;
            ctx.fillRect(CANVAS_WIDTH * JUDGE_LINE_X + 12, y - 20, CANVAS_WIDTH - CANVAS_WIDTH * JUDGE_LINE_X, 40);
        });

        const judgeX = CANVAS_WIDTH * JUDGE_LINE_X;
        const glowAlpha = 0.3 + state.beatPulse * 0.5;

        ctx.strokeStyle = `rgba(180,212,255,0.12)`;
        ctx.lineWidth = 16 + state.beatPulse * 16;
        ctx.beginPath();
        ctx.moveTo(judgeX, topY - 40);
        ctx.lineTo(judgeX, bottomY + 40);
        ctx.stroke();

        const judgeGrad = ctx.createLinearGradient(judgeX, topY - 40, judgeX, bottomY + 40);
        judgeGrad.addColorStop(0, `rgba(75, 217, 255, ${glowAlpha})`);
        judgeGrad.addColorStop(0.5, `rgba(255, 236, 140, ${glowAlpha + 0.08})`);
        judgeGrad.addColorStop(1, `rgba(255, 95, 168, ${glowAlpha})`);
        ctx.strokeStyle = judgeGrad;
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(judgeX, topY - 40);
        ctx.lineTo(judgeX, bottomY + 40);
        ctx.stroke();

        ctx.restore();
    };

    const triggerBeatPulse = (): void => {
        state = { ...state, beatPulse: 1 };
    };

    const triggerHitShake = (lane: number, intensity = 10): void => {
        if (lane === 1) {
            shakeY = intensity;
        } else {
            shakeY = -intensity;
        }
        shakeX = (Math.random() - 0.5) * intensity * 0.3;
    };

    const triggerCameraBeat = (
        lane: number,
        intensity = 1,
        mode: 'hit' | 'sustain' = 'hit'
    ): void => {
        const sign = lane === 0 ? -1 : 1;
        const comboMul = 1 + comboDriveTarget * (mode === 'sustain' ? 0.24 : 0.5);
        const mul = (mode === 'sustain' ? 0.72 : 1) * (1 + musicHighlight * 0.86) * comboMul;
        cameraImpulseX += sign * 9.2 * intensity * mul;
        cameraImpulseY += sign * 6.4 * intensity * mul;
        cameraImpulseZoom += (mode === 'sustain' ? -0.008 : 0.016) * intensity * (1 + musicHighlight * 0.54);
        cameraImpulseTilt += sign * 0.016 * intensity * mul;
        cameraImpulseX = Math.max(-40, Math.min(40, cameraImpulseX));
        cameraImpulseY = Math.max(-30, Math.min(30, cameraImpulseY));
        cameraImpulseZoom = Math.max(-0.1, Math.min(0.1, cameraImpulseZoom));
        cameraImpulseTilt = Math.max(-0.2, Math.min(0.2, cameraImpulseTilt));
    };

    const setGameplayMotion = (yRatio: number | null, airborne: boolean): void => {
        if (yRatio === null || !airborne) {
            cameraFlowTarget = 0;
            return;
        }
        cameraFlowTarget = 1;
        cameraFlowRatio = Math.max(0, Math.min(1, yRatio));
    };
    const setMusicDrive = (time: number, bpm?: number, drive?: number, highlight?: number, motionMode?: number): void => {
        musicTime = Math.max(0, time);
        if (typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0) {
            musicBpm = bpm;
        }
        if (typeof drive === 'number' && Number.isFinite(drive)) {
            musicDriveTarget = Math.max(0.72, Math.min(1.95, drive));
        }
        if (typeof highlight === 'number' && Number.isFinite(highlight)) {
            musicHighlightTarget = Math.max(0, Math.min(1, highlight));
        }
        if (typeof motionMode === 'number' && Number.isFinite(motionMode)) {
            musicMotionModeTarget = Math.max(0, Math.min(1, motionMode));
        }
    };

    const setComboDrive = (value: number): void => {
        comboDriveTarget = Math.max(0, Math.min(1, value));
    };

    const setFailSlowMo = (value: number): void => {
        failSlowMoTarget = Math.max(0.35, Math.min(1, value));
    };

    const updateBeatPulse = (dt: number): void => {
        if (state.beatPulse > 0) {
            state = { ...state, beatPulse: Math.max(0, state.beatPulse - dt * 6) };
        }
        shakeX = lerp(shakeX, 0, dt * 20);
        shakeY = lerp(shakeY, 0, dt * 20);
        musicDrive = lerp(musicDrive, musicDriveTarget, dt * 3.2);
        musicHighlight = lerp(musicHighlight, musicHighlightTarget, dt * 3.6);
        musicMotionMode = lerp(musicMotionMode, musicMotionModeTarget, dt * 2.8);
        comboDrive = lerp(comboDrive, comboDriveTarget, dt * 4.1);
        failSlowMo = lerp(failSlowMo, failSlowMoTarget, dt * 6.4);

        cameraFlow = lerp(cameraFlow, cameraFlowTarget, dt * 4.4);
        const beatPhase = musicTime * (musicBpm / 60) * Math.PI * 2;
        const beatSin = Math.sin(beatPhase);
        const beatCos = Math.cos(beatPhase * 0.5);
        const idleX = Math.sin(state.bgTime * 0.62) * 7.6;
        const idleY = Math.cos(state.bgTime * 0.44) * 4.8;
        const flowX = (cameraFlowRatio - 0.5) * 78 * cameraFlow;
        const flowY = (0.5 - cameraFlowRatio) * 52 * cameraFlow;
        const flowTilt = (cameraFlowRatio - 0.5) * 0.08 * cameraFlow;
        const flowZoom = (-0.064 + Math.sin(state.bgTime * 2.1) * 0.01) * cameraFlow;
        const modeBlend = Math.max(0, Math.min(1,
            0.4 + musicMotionMode * 0.6 + Math.sin(state.bgTime * 0.32 + musicHighlight * 2.4) * 0.18
        ));
        const orbitX = Math.sin(beatPhase * 0.52 + state.bgTime * 1.4) * (2.2 + musicHighlight * 4.8) * modeBlend;
        const orbitY = Math.cos(beatPhase * 0.36 + state.bgTime * 1.1) * (1.6 + musicHighlight * 3.4) * (1 - modeBlend * 0.36);
        const zigzag = Math.sin(beatPhase * 0.25) >= 0 ? 1 : -1;
        const phraseSwingX = zigzag * (1.4 + musicHighlight * 4.2) * (0.35 + modeBlend * 0.65);
        const phraseSwingY = Math.sin(beatPhase * 0.18 + Math.PI / 4) * (1 + musicHighlight * 2.2) * (0.35 + (1 - modeBlend) * 0.65);
        const driveMul = musicDrive * (1 + musicHighlight * 0.78 + comboDrive * 0.44);
        const beatDriveX = beatSin * 5.8 * driveMul;
        const beatDriveY = beatCos * 3.8 * driveMul;
        const beatDriveTilt = beatSin * 0.03 * (1 + musicHighlight * 1.1 + comboDrive * 0.38) + Math.sin(beatPhase * 0.5) * 0.012 * modeBlend;
        const beatDriveZoom = beatCos * 0.017 * (1 + musicHighlight * 0.72 + comboDrive * 0.32);
        const pulseZoom = state.beatPulse * (0.026 + musicHighlight * 0.018 + comboDrive * 0.016);
        const cinematicSlowMo = 0.88
            + (Math.sin(beatPhase * 0.25 + state.bgTime * 0.42) * 0.5 + 0.5)
            * (0.16 + musicHighlight * 0.06);
        const motionSlowMo = cinematicSlowMo * failSlowMo;

        cameraX = lerp(cameraX, idleX + flowX + beatDriveX + orbitX + phraseSwingX + cameraImpulseX, dt * (5.8 + musicHighlight * 1.2 + comboDrive * 1.2) * motionSlowMo);
        cameraY = lerp(cameraY, idleY + flowY + beatDriveY + orbitY + phraseSwingY + cameraImpulseY, dt * (5.8 + musicHighlight * 1.2 + comboDrive * 1.1) * motionSlowMo);
        cameraTilt = lerp(cameraTilt, flowTilt + beatDriveTilt + cameraImpulseTilt, dt * (5.1 + musicHighlight * 1.25 + comboDrive * 0.9) * motionSlowMo);
        const targetZoom = 1.01 + pulseZoom + flowZoom + beatDriveZoom + cameraImpulseZoom;
        cameraZoom = lerp(cameraZoom, Math.max(0.98, Math.min(1.23, targetZoom)), dt * (4.05 + musicHighlight * 1.55 + comboDrive * 1.2) * motionSlowMo);

        const maxOffsetX = Math.max(6, (cameraZoom - 1) * CANVAS_WIDTH * 0.48);
        const maxOffsetY = Math.max(5, (cameraZoom - 1) * CANVAS_HEIGHT * 0.46);
        cameraX = Math.max(-maxOffsetX, Math.min(maxOffsetX, cameraX));
        cameraY = Math.max(-maxOffsetY, Math.min(maxOffsetY, cameraY));

        cameraImpulseX = lerp(cameraImpulseX, 0, dt * (8.8 * Math.max(0.62, failSlowMo)));
        cameraImpulseY = lerp(cameraImpulseY, 0, dt * (8.8 * Math.max(0.62, failSlowMo)));
        cameraImpulseZoom = lerp(cameraImpulseZoom, 0, dt * (7.4 * Math.max(0.62, failSlowMo)));
        cameraImpulseTilt = lerp(cameraImpulseTilt, 0, dt * (7.2 * Math.max(0.62, failSlowMo)));
    };

    const getBeatPulse = (): number => state.beatPulse;
    const getShake = () => ({ x: shakeX, y: shakeY });
    const getGameplayCamera = (): GameplayCamera => ({
        x: cameraX,
        y: cameraY,
        zoom: cameraZoom,
        tilt: cameraTilt,
    });

    /** 간주 중 배경 스크롤 정지/재개 */
    const setBackgroundPaused = (paused: boolean): void => {
        backgroundPaused = paused;
    };

    const isBackgroundPaused = (): boolean => backgroundPaused;

    const setVideoBackground = (enabled: boolean): void => {
        hasVideoBackground = enabled;
    };

    const setTheme = (theme: VisualTheme): void => {
        visualTheme = theme;
    };

    return {
        renderBackground,
        renderLanes,
        triggerBeatPulse,
        triggerHitShake,
        updateBeatPulse,
        getBeatPulse,
        getShake,
        getGameplayCamera,
        triggerCameraBeat,
        setGameplayMotion,
        setMusicDrive,
        setComboDrive,
        setFailSlowMo,
        setBackgroundPaused,
        isBackgroundPaused,
        setVideoBackground,
        setTheme,
        renderScreenOverlay,
    };
};

export type Renderer = ReturnType<typeof createRenderer>;
