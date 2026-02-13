/// <reference lib="webworker" />
/* eslint-disable no-restricted-globals */
import { generateMap } from './MapGenerator';
import type { Difficulty } from '../utils/Constants';
import { computeWasmBpmHint } from '../audio/WasmAudioAnalyzer';
import type { WasmBpmHint } from '../audio/WasmAudioAnalyzer';

declare const self: DedicatedWorkerGlobalScope;

interface GenerateRequest {
    readonly type: 'generate';
    readonly id: string;
    readonly difficulty: Difficulty;
    readonly sampleRate: number;
    readonly length: number;
    readonly duration: number;
    readonly channels: readonly ArrayBuffer[];
    readonly perfHint?: {
        readonly cores: number;
        readonly memoryGb: number;
    };
    readonly useWasmAnalyzer?: boolean;
}

interface AudioBufferLike {
    readonly sampleRate: number;
    readonly length: number;
    readonly duration: number;
    readonly numberOfChannels: number;
    getChannelData: (index: number) => Float32Array;
    __wasmBpmHint?: WasmBpmHint;
}

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<null>((resolve) => {
                timer = setTimeout(() => resolve(null), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
};

const createBufferLike = (req: GenerateRequest): AudioBufferLike => {
    const channelData = req.channels.map(buf => new Float32Array(buf));
    return {
        sampleRate: req.sampleRate,
        length: req.length,
        duration: req.duration,
        numberOfChannels: channelData.length,
        getChannelData: (index: number) => channelData[index],
    };
};

self.onmessage = async (event: MessageEvent<GenerateRequest>) => {
    const req = event.data;
    if (!req || req.type !== 'generate') return;

    try {
        (globalThis as { __MAPGEN_PERF_HINT?: { cores: number; memoryGb: number } }).__MAPGEN_PERF_HINT = req.perfHint;
        const bufferLike = createBufferLike(req);
        if (req.useWasmAnalyzer) {
            try {
                const hint = await withTimeout(computeWasmBpmHint(bufferLike as unknown as AudioBuffer), 700);
                if (hint) {
                    bufferLike.__wasmBpmHint = hint;
                }
            } catch {
                // wasm 분석 실패 시 기존 JS 분석 경로 유지
            }
        }
        const map = await generateMap(
            bufferLike as unknown as AudioBuffer,
            req.difficulty,
            (stage, progress) => {
                self.postMessage({
                    type: 'progress',
                    id: req.id,
                    stage,
                    progress,
                });
            }
        );

        self.postMessage({
            type: 'done',
            id: req.id,
            map,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        self.postMessage({
            type: 'error',
            id: req.id,
            message,
        });
    }
};

export { };
