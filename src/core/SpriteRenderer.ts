
import { CHARACTER_SIZE } from '../utils/Constants';

/**
 * 2D Sprite Animator
 * Handles frame-based animation from a sprite sheet.
 */
export class SpriteRenderer {
    private image: HTMLImageElement;
    private isLoaded: boolean = false;

    // Grid configuration
    private frameWidth: number;
    private frameHeight: number;
    private rows: number;
    private cols: number;

    // Animation state
    private currentFrame: number = 0;
    private timer: number = 0;
    private currentRow: number = 0;
    private fps: number = 12;

    constructor(src: string, cols: number = 4, rows: number = 3) {
        this.image = new Image();
        this.image.src = src;
        this.image.onload = () => {
            this.isLoaded = true;
            this.frameWidth = this.image.width / cols;
            this.frameHeight = this.image.height / rows;
        };
        this.cols = cols;
        this.rows = rows;
        this.frameWidth = 0; // init
        this.frameHeight = 0;
    }

    public update(dt: number) {
        if (!this.isLoaded) return;

        this.timer += dt;
        if (this.timer >= 1 / this.fps) {
            this.timer = 0;
            this.currentFrame = (this.currentFrame + 1) % this.cols;
        }
    }

    public setRow(row: number) {
        if (this.currentRow !== row) {
            this.currentRow = row;
            this.currentFrame = 0;
        }
    }

    public render(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number) {
        if (!this.isLoaded) return;

        ctx.drawImage(
            this.image,
            this.currentFrame * this.frameWidth,
            this.currentRow * this.frameHeight,
            this.frameWidth,
            this.frameHeight,
            x - width / 2,
            y - height / 2,
            width,
            height
        );
    }
}
