import { ProceduralAssets } from './ProceduralAssets';

export interface SpriteFrame {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface SpriteFrameAlignment {
    offsetX: number;
    offsetY: number;
}

export class SpriteManager {
    private static instance: SpriteManager;
    private image: HTMLImageElement | null = null;
    private frames: Map<string, SpriteFrame> = new Map();
    private alignments: Map<string, SpriteFrameAlignment> = new Map();
    private frameScale: Map<string, number> = new Map();
    private loaded = false;

    private constructor() { }

    static getInstance(): SpriteManager {
        if (!SpriteManager.instance) {
            SpriteManager.instance = new SpriteManager();
        }
        return SpriteManager.instance;
    }

    async load(): Promise<void> {
        if (this.loaded) return;

        // 1. 이미지 로드
        this.image = new Image();
        this.image.src = '/assets/spritesheet.png';
        await new Promise<void>((resolve, reject) => {
            if (!this.image) return reject();
            this.image.onload = () => resolve();
            this.image.onerror = () => reject(new Error('Failed to load spritesheet.png'));
        });

        // 2. 메타데이터 로드 (sprites.txt)
        const response = await fetch('/assets/sprites.txt');
        if (!response.ok) throw new Error('Failed to load sprites.txt');
        const text = await response.text();

        // 3. 파싱 (format: name,x,y,w,h)
        text.split('\n').forEach(line => {
            const parts = line.trim().split(',');
            if (parts.length >= 5) {
                const name = parts[0];
                const x = parseInt(parts[1], 10);
                const y = parseInt(parts[2], 10);
                const w = parseInt(parts[3], 10);
                const h = parseInt(parts[4], 10);
                if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(w) || Number.isNaN(h)) return;
                this.frames.set(name, { x, y, w, h });
            }
        });

        this.validateFrameBounds();
        this.buildCharacterFrameAlignments();

        this.loaded = true;
        console.log(`SpriteManager: Loaded ${this.frames.size} frames.`);
    }



    /**
     * Get frame by index (1-based -> "spriteN")
     */
    getFrameByIndex(index: number): { image: CanvasImageSource, frame: SpriteFrame, alignment: SpriteFrameAlignment, scale: number } | null {
        return this.getFrame(`sprite${index}`);
    }

    isLoaded(): boolean {
        return this.loaded;
    }

    // === Procedural Assets Integration ===
    private background: HTMLCanvasElement | null = null;

    loadProcedural(): void {
        // ProceduralAssets is already imported at top level

        // 1. Slime (Ground Note)
        const slimeCanvas = ProceduralAssets.createSlimeSprite(64, 64, '#FF0055'); // Hot Pink
        this.storeProceduralFrame('slime', slimeCanvas);

        // 2. Bat (Air Note)
        const batCanvas = ProceduralAssets.createBatSprite(64, 64, '#00D1FF'); // Cyan
        this.storeProceduralFrame('bat', batCanvas);

        // 3. Background
        try {
            this.background = ProceduralAssets.createCityBackground(1920, 1080); // Full HD
        } catch (e) {
            console.error('Failed to generate city background', e);
        }
    }

    private storeProceduralFrame(name: string, canvas: HTMLCanvasElement) {
        // Creates an Image element from canvas to be compatible with drawImage
        const img = new Image();
        img.src = canvas.toDataURL();

        // We handle this synchronously-ish for now, or we can just use the canvas directly if we change the type
        // But SpriteManager returns { image, frame }.
        // Hack: We can't easily add it to the *same* main image.
        // We should extend getFrame to support individual images.

        this.customImages.set(name, img);
        this.frames.set(name, { x: 0, y: 0, w: canvas.width, h: canvas.height });
    }

    private customImages: Map<string, HTMLImageElement> = new Map();

    getFrame(name: string): { image: CanvasImageSource, frame: SpriteFrame, alignment: SpriteFrameAlignment, scale: number } | null {
        if (this.customImages.has(name)) {
            return {
                image: this.customImages.get(name)!,
                frame: this.frames.get(name)!,
                alignment: this.alignments.get(name) ?? { offsetX: 0, offsetY: 0 },
                scale: this.frameScale.get(name) ?? 1,
            };
        }

        if (!this.image || !this.loaded) return null;
        const frame = this.frames.get(name);
        if (!frame) return null;
        return {
            image: this.image,
            frame,
            alignment: this.alignments.get(name) ?? { offsetX: 0, offsetY: 0 },
            scale: this.frameScale.get(name) ?? 1,
        };
    }

    getBackground(): HTMLCanvasElement | null {
        return this.background;
    }

    private validateFrameBounds(): void {
        if (!this.image) return;
        const maxW = this.image.width;
        const maxH = this.image.height;

        this.frames.forEach((frame, name) => {
            const x = Math.max(0, frame.x);
            const y = Math.max(0, frame.y);
            const w = Math.max(1, Math.min(frame.w, maxW - x));
            const h = Math.max(1, Math.min(frame.h, maxH - y));
            this.frames.set(name, { x, y, w, h });
        });
    }

    private buildCharacterFrameAlignments(): void {
        if (!this.image) return;

        const characterFrameNames: string[] = [];
        for (let i = 1; i <= 37; i++) {
            characterFrameNames.push(`sprite${i}`);
        }

        const canvas = document.createElement('canvas');
        canvas.width = this.image.width;
        canvas.height = this.image.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(this.image, 0, 0);

        const tempOffsets: Map<string, SpriteFrameAlignment> = new Map();
        const bodyHeights: Map<string, number> = new Map();
        let totalOffsetX = 0;
        let totalOffsetY = 0;
        let measuredCount = 0;
        let runBodyHeightTotal = 0;
        let runBodyCount = 0;

        for (const name of characterFrameNames) {
            const frame = this.frames.get(name);
            if (!frame || frame.w < 8 || frame.h < 8) continue;

            const bounds = this.findOpaqueBounds(ctx, frame);
            if (!bounds) continue;

            const centerX = (bounds.minX + bounds.maxX) / 2;
            const footY = bounds.maxY;
            const bodyHeight = Math.max(1, bounds.maxY - bounds.minY + 1);
            bodyHeights.set(name, bodyHeight);
            const idx = parseInt(name.replace('sprite', ''), 10);
            if (idx >= 1 && idx <= 25 && idx !== 4) {
                runBodyHeightTotal += bodyHeight;
                runBodyCount++;
            }

            const offset = {
                offsetX: frame.w / 2 - centerX,
                offsetY: frame.h - 1 - footY,
            };
            tempOffsets.set(name, offset);
            totalOffsetX += offset.offsetX;
            totalOffsetY += offset.offsetY;
            measuredCount++;
        }

        if (measuredCount === 0) {
            return;
        }
        const meanOffsetX = totalOffsetX / measuredCount;
        const meanOffsetY = totalOffsetY / measuredCount;
        const meanBodyHeight = runBodyCount > 0
            ? runBodyHeightTotal / runBodyCount
            : 56;

        tempOffsets.forEach((offset, name) => {
            const boundedY = Math.max(-8, Math.min(8, offset.offsetY - meanOffsetY));
            const boundedX = Math.max(-10, Math.min(10, offset.offsetX - meanOffsetX));
            this.alignments.set(name, { offsetX: boundedX, offsetY: boundedY });

            const idx = parseInt(name.replace('sprite', ''), 10);
            const bodyHeight = bodyHeights.get(name) ?? meanBodyHeight;
            let scale = meanBodyHeight / Math.max(1, bodyHeight);
            if (idx >= 27 && idx <= 33) {
                scale *= 0.94; // 점프/착지 대형 프레임 과확대 억제
            } else if (idx >= 34 && idx <= 37) {
                scale *= 0.96; // 아이들 프레임도 러닝과 체급 맞춤
            }
            scale = Math.max(0.72, Math.min(1.08, scale));
            this.frameScale.set(name, scale);
        });
    }

    private findOpaqueBounds(
        ctx: CanvasRenderingContext2D,
        frame: SpriteFrame
    ): { minX: number; minY: number; maxX: number; maxY: number } | null {
        const imageData = ctx.getImageData(frame.x, frame.y, frame.w, frame.h);
        const data = imageData.data;
        let minX = frame.w;
        let minY = frame.h;
        let maxX = -1;
        let maxY = -1;

        for (let y = 0; y < frame.h; y++) {
            for (let x = 0; x < frame.w; x++) {
                const alpha = data[(y * frame.w + x) * 4 + 3];
                if (alpha < 20) continue;
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
            }
        }

        if (maxX < minX || maxY < minY) return null;
        return { minX, minY, maxX, maxY };
    }
}

