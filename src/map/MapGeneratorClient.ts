import { generateMap } from './MapGenerator';
import type { MapData, ProgressCallback } from './MapData';
import type { Difficulty } from '../utils/Constants';

interface WorkerProgress {
    readonly type: 'progress';
    readonly id: string;
    readonly stage: string;
    readonly progress: number;
}

interface WorkerDone {
    readonly type: 'done';
    readonly id: string;
    readonly map: MapData;
}

interface WorkerError {
    readonly type: 'error';
    readonly id: string;
    readonly message: string;
}

type WorkerResponse = WorkerProgress | WorkerDone | WorkerError;
interface WorkerPerfHint {
    readonly cores: number;
    readonly memoryGb: number;
}
interface PendingRequest {
    readonly resolve: (map: MapData) => void;
    readonly reject: (reason?: unknown) => void;
    readonly onProgress?: ProgressCallback;
}

const canUseWorker = (): boolean =>
    typeof Worker !== 'undefined' && typeof window !== 'undefined';
const CACHE_LIMIT = 8;
const MAPGEN_FORCE_REBUILD = false;
const MAPGEN_USE_WASM_ANALYZER = true;
const MAP_CACHE = new Map<string, MapData>();
let sharedWorker: Worker | null = null;
const pending = new Map<string, PendingRequest>();

const getAudioFingerprint = (buffer: AudioBuffer): string => {
    let hash = 2166136261 >>> 0;
    const mix = (value: number): void => {
        hash ^= value & 0xffff;
        hash = Math.imul(hash, 16777619) >>> 0;
    };
    mix(buffer.sampleRate | 0);
    mix(buffer.length | 0);
    mix(buffer.numberOfChannels | 0);

    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        const data = buffer.getChannelData(ch);
        const step = Math.max(1, Math.floor(data.length / 96));
        for (let i = 0; i < data.length; i += step) {
            const q = Math.round(Math.max(-1, Math.min(1, data[i])) * 32767);
            mix(q);
        }
    }
    return hash.toString(16);
};

const getCachePerfStamp = (): string => {
    if (typeof navigator === 'undefined') return '4c4m';
    const nav = navigator as Navigator & { deviceMemory?: number };
    const cores = Math.max(2, nav.hardwareConcurrency || 4);
    const memoryGb = Math.max(2, nav.deviceMemory || 4);
    return `${cores}c${memoryGb}m`;
};

const shouldUseWasmAnalyzer = (): boolean => {
    if (!MAPGEN_USE_WASM_ANALYZER) return false;
    if (typeof navigator === 'undefined') return true;
    const nav = navigator as Navigator & { deviceMemory?: number };
    const cores = Math.max(2, nav.hardwareConcurrency || 4);
    const mem = Number.isFinite(nav.deviceMemory) ? (nav.deviceMemory as number) : 4;
    return cores >= 4 && mem >= 4;
};

const makeCacheKey = (buffer: AudioBuffer, difficulty: Difficulty): string =>
    `v30:${getCachePerfStamp()}:${difficulty}:${buffer.sampleRate}:${buffer.length}:${buffer.numberOfChannels}:${getAudioFingerprint(buffer)}`;

const putCache = (key: string, map: MapData): void => {
    if (MAP_CACHE.has(key)) MAP_CACHE.delete(key);
    MAP_CACHE.set(key, map);
    while (MAP_CACHE.size > CACHE_LIMIT) {
        const first = MAP_CACHE.keys().next();
        if (first.done) break;
        MAP_CACHE.delete(first.value);
    }
};

const disposeSharedWorker = (): void => {
    if (!sharedWorker) return;
    sharedWorker.onmessage = null;
    sharedWorker.onerror = null;
    sharedWorker.terminate();
    sharedWorker = null;
};

const getSharedWorker = (): Worker => {
    if (sharedWorker) return sharedWorker;
    const worker = new Worker(new URL('./MapWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const msg = event.data;
        if (!msg || !('id' in msg)) return;
        const req = pending.get(msg.id);
        if (!req) return;

        if (msg.type === 'progress') {
            req.onProgress?.(msg.stage, msg.progress);
            return;
        }
        pending.delete(msg.id);
        if (msg.type === 'done') {
            req.resolve(msg.map);
            return;
        }
        req.reject(new Error(msg.message));
    };
    worker.onerror = (err) => {
        const reason = new Error(err.message || 'Map worker failed');
        for (const [, req] of pending) {
            req.reject(reason);
        }
        pending.clear();
        disposeSharedWorker();
    };
    sharedWorker = worker;
    return worker;
};

export const generateMapFast = async (
    buffer: AudioBuffer,
    difficulty: Difficulty,
    onProgress?: ProgressCallback
): Promise<MapData> => {
    const cacheKey = makeCacheKey(buffer, difficulty);
    if (!MAPGEN_FORCE_REBUILD) {
        const cached = MAP_CACHE.get(cacheKey);
        if (cached) {
            onProgress?.('캐시된 맵 로드 중...', 1);
            return cached;
        }
    }

    if (!canUseWorker()) {
        const map = await generateMap(buffer, difficulty, onProgress);
        if (!MAPGEN_FORCE_REBUILD) {
            putCache(cacheKey, map);
        }
        return map;
    }

    const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const nav = (typeof navigator !== 'undefined' ? (navigator as Navigator & { deviceMemory?: number }) : null);
    const runtimeCores = Math.max(2, nav?.hardwareConcurrency || 4);
    const runtimeMemory = Number.isFinite(nav?.deviceMemory)
        ? (nav?.deviceMemory as number)
        : Math.max(4, Math.round(runtimeCores * 0.9));
    const perfHint: WorkerPerfHint = {
        cores: runtimeCores,
        memoryGb: Math.max(2, runtimeMemory),
    };
    const channels: ArrayBuffer[] = [];
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        const src = buffer.getChannelData(ch);
        const copy = new Float32Array(src.length);
        copy.set(src);
        channels.push(copy.buffer);
    }

    return new Promise<MapData>((resolve, reject) => {
        let worker: Worker;
        try {
            worker = getSharedWorker();
        } catch (err) {
            reject(err);
            return;
        }
        pending.set(id, { resolve, reject, onProgress });
        worker.postMessage({
            type: 'generate',
            id,
            difficulty,
            sampleRate: buffer.sampleRate,
            length: buffer.length,
            duration: buffer.duration,
            channels,
            perfHint,
            useWasmAnalyzer: shouldUseWasmAnalyzer(),
        }, channels);
    }).then((map) => {
        if (!MAPGEN_FORCE_REBUILD) {
            putCache(cacheKey, map);
        }
        return map;
    }).catch(async (err) => {
        pending.delete(id);
        // 워커 실패 시 메인 스레드 폴백
        onProgress?.('워커 실패, 폴백 생성 중...', 0.1);
        const fallbackMap = await generateMap(buffer, difficulty, onProgress);
        if (!MAPGEN_FORCE_REBUILD) {
            putCache(cacheKey, fallbackMap);
        }
        return fallbackMap;
    });
};
