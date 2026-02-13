/* === 수학 유틸리티 === */

/** 값을 [min, max] 범위로 클램핑 */
export const clamp = (value: number, min: number, max: number): number =>
    Math.max(min, Math.min(max, value));

/** 선형 보간 */
export const lerp = (a: number, b: number, t: number): number =>
    a + (b - a) * clamp(t, 0, 1);

/** 두 값 사이를 0~1로 매핑 */
export const inverseLerp = (a: number, b: number, value: number): number =>
    clamp((value - a) / (b - a), 0, 1);

/** 범위 리맵 */
export const remap = (
    inMin: number, inMax: number,
    outMin: number, outMax: number,
    value: number
): number => lerp(outMin, outMax, inverseLerp(inMin, inMax, value));

/** easeOutCubic */
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/** easeInOutQuad */
export const easeInOutQuad = (t: number): number =>
    t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

/** easeOutElastic */
export const easeOutElastic = (t: number): number => {
    const c = (2 * Math.PI) / 3;
    return t === 0 ? 0 : t === 1 ? 1 :
        Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c) + 1;
};

/** 랜덤 정수 (min~max 포함) */
export const randomInt = (min: number, max: number): number =>
    Math.floor(Math.random() * (max - min + 1)) + min;

/** 랜덤 실수 */
export const randomFloat = (min: number, max: number): number =>
    Math.random() * (max - min) + min;

/** 배열 셔플 (Fisher-Yates, 새 배열 반환) */
export const shuffle = <T>(arr: readonly T[]): T[] => {
    const result = [...arr];
    for (let i = result.length - 1; i > 0; i--) {
        const j = randomInt(0, i);
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
};

/** RMS(Root Mean Square) 계산 */
export const rms = (data: Float32Array, start: number, length: number): number => {
    let sum = 0;
    const end = Math.min(start + length, data.length);
    for (let i = start; i < end; i++) {
        sum += data[i] * data[i];
    }
    return Math.sqrt(sum / (end - start));
};
