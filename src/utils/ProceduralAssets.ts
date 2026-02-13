export class ProceduralAssets {
    static createSlimeSprite(width: number, height: number, color: string): HTMLCanvasElement {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;

        const cx = width / 2;
        const cy = height * 0.65;
        const r = width * 0.55; // Slightly larger

        // 1. Shadow
        ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.beginPath();
        ctx.ellipse(cx, cy + r * 0.7, r * 0.6, r * 0.15, 0, 0, Math.PI * 2);
        ctx.fill();

        // 2. Thick Outline (Muse Dash Style)
        ctx.lineWidth = 4;
        ctx.strokeStyle = '#2d1b4e'; // Dark Purple/Black
        ctx.beginPath();
        // Slime shape: slightly flatter bottom
        ctx.beginPath();
        ctx.moveTo(cx - r * 0.8, cy);
        // Need to draw a blob shape manually
        this.drawBlob(ctx, cx, cy, r, 0.85);
        ctx.stroke();

        // 3. Body Gradient
        const grad = ctx.createLinearGradient(0, cy - r, 0, cy + r);
        grad.addColorStop(0, this.lighten(color, 40));
        grad.addColorStop(1, color);
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.stroke(); // Stroke again to be crisp

        // 4. Highlight (Rim Light)
        ctx.save();
        ctx.clip();
        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.beginPath();
        ctx.ellipse(cx, cy - r * 0.5, r * 0.6, r * 0.3, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // 5. Eyes (Big & Shiny)
        this.drawEye(ctx, cx - r * 0.3, cy - r * 0.1, r * 0.25);
        this.drawEye(ctx, cx + r * 0.3, cy - r * 0.1, r * 0.25);

        // 6. Mouth / Expression
        ctx.strokeStyle = '#2d1b4e';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(cx, cy + r * 0.2, r * 0.1, 0, Math.PI);
        ctx.stroke();

        return canvas;
    }

    static createBatSprite(width: number, height: number, color: string): HTMLCanvasElement {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;

        const cx = width / 2;
        const cy = height / 2;
        const size = width * 0.95;

        // 1. Shadow
        ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.beginPath();
        ctx.ellipse(cx, cy + size * 0.4, size * 0.4, size * 0.1, 0, 0, Math.PI * 2);
        ctx.fill();

        // 2. Wings (Behind)
        ctx.fillStyle = color;
        ctx.strokeStyle = '#2d1b4e';
        ctx.lineWidth = 4;
        ctx.lineJoin = 'round';

        // Left Wing
        ctx.beginPath();
        ctx.moveTo(cx - size * 0.2, cy);
        ctx.quadraticCurveTo(cx - size * 0.6, cy - size * 0.4, cx - size * 0.6, cy); // Upper curve
        ctx.lineTo(cx - size * 0.5, cy + size * 0.2); // Tip
        ctx.quadraticCurveTo(cx - size * 0.3, cy + size * 0.1, cx - size * 0.2, cy + size * 0.2); // Bottom curve
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Right Wing
        ctx.beginPath();
        ctx.moveTo(cx + size * 0.2, cy);
        ctx.quadraticCurveTo(cx + size * 0.6, cy - size * 0.4, cx + size * 0.6, cy);
        ctx.lineTo(cx + size * 0.5, cy + size * 0.2);
        ctx.quadraticCurveTo(cx + size * 0.3, cy + size * 0.1, cx + size * 0.2, cy + size * 0.2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // 3. Body (Round)
        ctx.beginPath();
        ctx.arc(cx, cy, size * 0.22, 0, Math.PI * 2);
        const bodyGrad = ctx.createRadialGradient(cx - 5, cy - 5, 2, cx, cy, size * 0.22);
        bodyGrad.addColorStop(0, this.lighten(color, 30));
        bodyGrad.addColorStop(1, color);
        ctx.fillStyle = bodyGrad;
        ctx.fill();
        ctx.stroke();

        // 4. Ears
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(cx - size * 0.15, cy - size * 0.1);
        ctx.lineTo(cx - size * 0.18, cy - size * 0.35);
        ctx.lineTo(cx - size * 0.05, cy - size * 0.18);
        ctx.fill();
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(cx + size * 0.15, cy - size * 0.1);
        ctx.lineTo(cx + size * 0.18, cy - size * 0.35);
        ctx.lineTo(cx + size * 0.05, cy - size * 0.18);
        ctx.fill();
        ctx.stroke();

        // 5. Eye (Cyclops or Two Eyes)
        this.drawEye(ctx, cx, cy, size * 0.12);

        // 6. Fangs
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.moveTo(cx - 3, cy + 10);
        ctx.lineTo(cx - 1, cy + 16);
        ctx.lineTo(cx + 1, cy + 10);
        ctx.fill();

        return canvas;
    }

    static createCityBackground(width: number, height: number): HTMLCanvasElement {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;

        // 1) Sky
        const skyGrad = ctx.createLinearGradient(0, 0, 0, height);
        skyGrad.addColorStop(0, '#05101a');
        skyGrad.addColorStop(0.45, '#0a1f30');
        skyGrad.addColorStop(1, '#071018');
        ctx.fillStyle = skyGrad;
        ctx.fillRect(0, 0, width, height);

        // 2) Stars (deterministic)
        for (let i = 0; i < 220; i++) {
            const h = this.hash(i * 1973 + 17);
            const x = (h % 10000) / 10000 * width;
            const y = (this.hash(h + 77) % 10000) / 10000 * height * 0.58;
            const s = 0.4 + ((this.hash(h + 191) % 1000) / 1000) * 1.8;
            const alpha = 0.16 + ((this.hash(h + 313) % 1000) / 1000) * 0.6;
            ctx.fillStyle = `rgba(210, 240, 255, ${alpha})`;
            ctx.beginPath();
            ctx.arc(x, y, s, 0, Math.PI * 2);
            ctx.fill();
        }

        // 3) Moon + haze
        const moonX = width * 0.72;
        const moonY = height * 0.29;
        const moonR = height * 0.2;
        const moon = ctx.createRadialGradient(moonX - moonR * 0.25, moonY - moonR * 0.2, moonR * 0.12, moonX, moonY, moonR);
        moon.addColorStop(0, 'rgba(255, 225, 160, 0.95)');
        moon.addColorStop(1, 'rgba(255, 165, 90, 0.02)');
        ctx.fillStyle = moon;
        ctx.beginPath();
        ctx.arc(moonX, moonY, moonR, 0, Math.PI * 2);
        ctx.fill();

        // 4) Atmosphere stripe
        const stripe = ctx.createLinearGradient(0, height * 0.4, 0, height * 0.75);
        stripe.addColorStop(0, 'rgba(0, 200, 255, 0.08)');
        stripe.addColorStop(1, 'rgba(0, 200, 255, 0)');
        ctx.fillStyle = stripe;
        ctx.fillRect(0, height * 0.35, width, height * 0.5);

        // 5) Distant mountains
        ctx.fillStyle = 'rgba(10, 30, 40, 0.45)';
        ctx.beginPath();
        ctx.moveTo(0, height * 0.68);
        for (let x = 0; x <= width; x += 120) {
            const y = height * (0.62 + (this.hash(x + 99) % 1000) / 1000 * 0.08);
            ctx.lineTo(x, y);
        }
        ctx.lineTo(width, height);
        ctx.lineTo(0, height);
        ctx.closePath();
        ctx.fill();

        // 6) City layers
        this.drawSkyline(ctx, width, height, height * 0.74, '#0b2133', 40, 80, false);
        this.drawSkyline(ctx, width, height, height * 0.82, '#0a1a29', 55, 120, true);
        this.drawSkyline(ctx, width, height, height * 0.92, '#08111b', 70, 150, true);

        return canvas;
    }

    private static drawBlob(ctx: CanvasRenderingContext2D, dx: number, dy: number, r: number, squash: number) {
        // Simple circle for now, distorted
        ctx.ellipse(dx, dy, r, r * squash, 0, 0, Math.PI * 2);
    }

    private static drawEye(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
        ctx.save();
        ctx.fillStyle = '#fff';
        ctx.shadowColor = '#fff';
        ctx.shadowBlur = 5;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();

        // Pupil
        ctx.fillStyle = '#2d1b4e'; // Dark color matches outline
        ctx.shadowBlur = 0;
        ctx.beginPath();
        ctx.arc(x, y, r * 0.4, 0, Math.PI * 2);
        ctx.fill();

        // Reflection
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(x - r * 0.4, y - r * 0.4, r * 0.25, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    private static drawSkyline(ctx: CanvasRenderingContext2D, w: number, h: number, groundY: number, color: string, minW: number, maxW: number, windows: boolean) {
        ctx.fillStyle = color;
        let x = -50;
        let seed = Math.floor(groundY * 13 + minW * 17);
        while (x < w + 50) {
            seed = this.hash(seed + 31);
            const rw = (seed % 1000) / 1000;
            seed = this.hash(seed + 73);
            const rh = (seed % 1000) / 1000;
            const bw = minW + rw * (maxW - minW);
            const bh = rh * (h - groundY) * (windows ? 0.9 : 0.6) + 40;

            // Building Body
            ctx.fillRect(x, groundY - bh, bw, bh + 200); // extends down

            // Roof detail
            if ((seed % 10) > 4) {
                ctx.fillRect(x + 5, groundY - bh - 10, bw - 10, 10);
                // Antenna
                if ((seed % 100) > 70) {
                    ctx.beginPath();
                    ctx.moveTo(x + bw / 2, groundY - bh - 10);
                    ctx.lineTo(x + bw / 2, groundY - bh - 30);
                    ctx.strokeStyle = color;
                    ctx.lineWidth = 2;
                    ctx.stroke();
                }
            }

            if (windows && (seed % 10) > 1) {
                const winColor = (seed % 2) === 0 ? '#00e7ff' : '#ffd86b';
                ctx.fillStyle = winColor;

                const winW = 4;
                const winH = 6;
                const spacingX = 8;
                const spacingY = 12;

                // Ensure strict positive dimensions
                if (bh > 20 && bw > 12) {
                    const rows = Math.floor((bh - 20) / spacingY);
                    const cols = Math.floor((bw - 12) / spacingX);

                    if ((seed % 3) !== 0) {
                        // Grid Pattern
                        for (let r = 0; r < rows; r++) {
                            for (let c = 0; c < cols; c++) {
                                if (((r * 31 + c * 17 + seed) % 7) < 4) {
                                    ctx.shadowColor = winColor;
                                    ctx.shadowBlur = 5;
                                    ctx.fillRect(x + 6 + c * spacingX, groundY - bh + 10 + r * spacingY, winW, winH);
                                    ctx.shadowBlur = 0;
                                }
                            }
                        }
                    } else {
                        // Vertical Strips
                        ctx.shadowColor = winColor;
                        ctx.shadowBlur = 8;
                        ctx.fillRect(x + 10, groundY - bh + 10, 4, bh - 20);
                        ctx.fillRect(x + bw - 14, groundY - bh + 10, 4, bh - 20);
                        ctx.shadowBlur = 0;
                    }
                }

                ctx.fillStyle = color; // Restore
            }

            x += bw - 1; // overlap slightly
        }
    }

    private static hash(n: number): number {
        let x = n | 0;
        x = ((x >>> 16) ^ x) * 0x45d9f3b;
        x = ((x >>> 16) ^ x) * 0x45d9f3b;
        x = (x >>> 16) ^ x;
        return Math.abs(x);
    }

    private static lighten(color: string, percent: number): string {
        const num = parseInt(color.replace('#', ''), 16);
        const amt = Math.round(2.55 * percent);
        const R = (num >> 16) + amt;
        const G = (num >> 8 & 0x00FF) + amt;
        const B = (num & 0x0000FF) + amt;
        return '#' + (0x1000000 + (R < 255 ? R < 1 ? 0 : R : 255) * 0x10000 + (G < 255 ? G < 1 ? 0 : G : 255) * 0x100 + (B < 255 ? B < 1 ? 0 : B : 255)).toString(16).slice(1);
    }
}
