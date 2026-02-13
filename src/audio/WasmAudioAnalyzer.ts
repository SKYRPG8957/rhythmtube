export interface WasmBpmHint {
    readonly bpm: number;
    readonly confidence: number;
    readonly firstBeatOffset: number;
}

const ESSENTIA_ENABLED = true;

let cachedLoader: Promise<((signal: Float32Array) => WasmBpmHint | null) | null> | null = null;

const toFinite = (value: unknown): number | null => {
    if (typeof value !== 'number') return null;
    if (!Number.isFinite(value)) return null;
    return value;
};

const pickArray = (value: unknown): number[] => {
    if (!value) return [];
    if (Array.isArray(value)) {
        return value.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    }
    if (value instanceof Float32Array || value instanceof Float64Array) {
        return Array.from(value).filter(v => Number.isFinite(v));
    }
    return [];
};

const tryBuildEssentiaRunner = async (): Promise<((signal: Float32Array) => WasmBpmHint | null) | null> => {
    const candidates: Array<{ wasmUrl: string; coreUrl: string }> = [
        {
            wasmUrl: 'https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/essentia-wasm.es.js',
            coreUrl: 'https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/essentia.js-core.es.js',
        },
        {
            wasmUrl: 'https://unpkg.com/essentia.js@0.1.3/dist/essentia-wasm.es.js',
            coreUrl: 'https://unpkg.com/essentia.js@0.1.3/dist/essentia.js-core.es.js',
        },
    ];

    for (const entry of candidates) {
        try {
            const wasmMod = await import(/* @vite-ignore */ entry.wasmUrl) as Record<string, unknown>;
            const coreMod = await import(/* @vite-ignore */ entry.coreUrl) as Record<string, unknown>;
            const wasmFactory = (wasmMod.default ?? wasmMod.EssentiaWASM) as ((opts?: unknown) => Promise<unknown>) | undefined;
            const EssentiaCtor = (coreMod.default ?? coreMod.Essentia) as (new (module: unknown) => Record<string, unknown>) | undefined;
            if (!wasmFactory || !EssentiaCtor) continue;

            const wasmInstance = await wasmFactory();
            const essentia = new EssentiaCtor(wasmInstance);
            const rhythmExtractor = essentia.RhythmExtractor2013 as ((signal: Float32Array, ...rest: unknown[]) => Record<string, unknown>) | undefined;
            if (typeof rhythmExtractor !== 'function') continue;

            return (signal: Float32Array): WasmBpmHint | null => {
                try {
                    const raw = rhythmExtractor(signal);
                    const bpmRaw = toFinite(raw?.bpm) ?? toFinite(raw?.BPM) ?? toFinite(raw?.tempo);
                    if (!bpmRaw || bpmRaw <= 0) return null;

                    const beats = pickArray(raw?.ticks ?? raw?.beats ?? raw?.beat_positions);
                    const confRaw = toFinite(raw?.confidence) ?? toFinite(raw?.confidenceBandRatio) ?? 0.74;
                    const firstBeatOffset = beats.length > 0 ? Math.max(0, beats[0]) : 0;
                    return {
                        bpm: bpmRaw,
                        confidence: Math.max(0.4, Math.min(0.98, confRaw)),
                        firstBeatOffset,
                    };
                } catch {
                    return null;
                }
            };
        } catch {
            continue;
        }
    }

    return null;
};

const getRunner = async (): Promise<((signal: Float32Array) => WasmBpmHint | null) | null> => {
    if (!ESSENTIA_ENABLED) return null;
    if (!cachedLoader) {
        cachedLoader = tryBuildEssentiaRunner();
    }
    return cachedLoader;
};

const toMono = (buffer: AudioBuffer): Float32Array => {
    const channels = Math.max(1, buffer.numberOfChannels);
    const mono = new Float32Array(buffer.length);
    for (let ch = 0; ch < channels; ch++) {
        const data = buffer.getChannelData(ch);
        for (let i = 0; i < mono.length; i++) {
            mono[i] += data[i] / channels;
        }
    }
    return mono;
};

export const computeWasmBpmHint = async (buffer: AudioBuffer): Promise<WasmBpmHint | null> => {
    try {
        const runner = await getRunner();
        if (!runner) return null;
        const mono = toMono(buffer);
        return runner(mono);
    } catch {
        return null;
    }
};
