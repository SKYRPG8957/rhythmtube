const monoCache = new WeakMap<object, Float32Array>();
const hannCache = new Map<number, Float32Array>();

export const extractSharedMono = (buffer: AudioBuffer): Float32Array => {
    const key = buffer as unknown as object;
    const cached = monoCache.get(key);
    if (cached) return cached;

    const length = buffer.length;
    const channels = Math.max(1, buffer.numberOfChannels);
    const mono = new Float32Array(length);
    for (let ch = 0; ch < channels; ch++) {
        const chData = buffer.getChannelData(ch);
        for (let i = 0; i < length; i++) {
            mono[i] += chData[i] / channels;
        }
    }

    monoCache.set(key, mono);
    return mono;
};

export const getSharedHannWindow = (size: number): Float32Array => {
    const cached = hannCache.get(size);
    if (cached) return cached;

    const window = new Float32Array(size);
    for (let i = 0; i < size; i++) {
        window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
    }
    hannCache.set(size, window);
    return window;
};
