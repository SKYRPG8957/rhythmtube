interface AudioState {
    readonly context: AudioContext | null;
    readonly buffer: AudioBuffer | null;
    readonly sourceNode: AudioBufferSourceNode | null;
    readonly gainNode: GainNode | null;
    readonly analyserNode: AnalyserNode | null;
    readonly timelineAnchorTime: number;
    readonly timelineAnchorOffset: number;
    readonly pauseOffset: number;
    readonly playbackRate: number;
    readonly playing: boolean;
    readonly volume: number;
    readonly duration: number;
    readonly lastError: string | null;
    readonly isLoading: boolean;
}

const STORAGE_VOLUME_KEY = 'rhythmtube_volume';
const LEGACY_STORAGE_VOLUME_KEY = 'beatrunner_volume';

export const createAudioManager = () => {
    // 외부 종료 콜백 목록
    let endedCallbacks: (() => void)[] = [];

    let state: AudioState = {
        context: null,
        buffer: null,
        sourceNode: null,
        gainNode: null,
        analyserNode: null,
        timelineAnchorTime: 0,
        timelineAnchorOffset: 0,
        pauseOffset: 0,
        playbackRate: 1,
        playing: false,
        volume: parseFloat(localStorage.getItem(STORAGE_VOLUME_KEY) || localStorage.getItem(LEGACY_STORAGE_VOLUME_KEY) || '0.7'),
        duration: 0,
        lastError: null,
        isLoading: false,
    };

    const initContext = (): AudioContext => {
        if (state.context) {
            if (state.context.state === 'suspended') {
                state.context.resume();
            }
            return state.context;
        }

        try {
            const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();

            if (ctx.state === 'suspended') {
                ctx.resume();
            }

            const gain = ctx.createGain();
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 2048;
            analyser.smoothingTimeConstant = 0.8;
            gain.gain.value = state.volume;
            gain.connect(analyser);
            analyser.connect(ctx.destination);

            state = {
                ...state,
                context: ctx,
                gainNode: gain,
                analyserNode: analyser,
                lastError: null
            };
            return ctx;
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'AudioContext creation failed';
            state = { ...state, lastError: errorMsg };
            throw new Error(errorMsg);
        }
    };

    const loadAudio = async (source: File | ArrayBuffer): Promise<AudioBuffer> => {
        state = { ...state, isLoading: true, lastError: null };

        try {
            const ctx = initContext();
            const arrayBuffer = source instanceof File
                ? await source.arrayBuffer()
                : source;

            const buffer = await decodeAudioDataWithFallback(ctx, arrayBuffer);
            state = {
                ...state,
                buffer,
                duration: buffer.duration,
                isLoading: false,
                lastError: null
            };
            return buffer;
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Audio loading failed';
            state = { ...state, lastError: errorMsg, isLoading: false };
            throw new Error(errorMsg);
        }
    };

    const setBuffer = (buffer: AudioBuffer): void => {
        const ctx = initContext(); // Ensure context is ready
        state = {
            ...state,
            buffer,
            duration: buffer.duration,
            isLoading: false,
            lastError: null
        };
    };

    const loadFromUrl = async (url: string): Promise<AudioBuffer> => {
        state = { ...state, isLoading: true, lastError: null };

        try {
            const ctx = initContext();

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'audio/*,*/*;q=0.9',
                },
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const arrayBuffer = await response.arrayBuffer();

            if (arrayBuffer.byteLength === 0) {
                throw new Error('Empty audio file');
            }

            const buffer = await decodeAudioDataWithFallback(ctx, arrayBuffer);
            state = {
                ...state,
                buffer,
                duration: buffer.duration,
                isLoading: false,
                lastError: null
            };
            return buffer;
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Failed to load audio from URL';
            state = { ...state, lastError: errorMsg, isLoading: false };
            throw new Error(errorMsg);
        }
    };

    const decodeAudioDataWithFallback = async (
        ctx: AudioContext,
        arrayBuffer: ArrayBuffer
    ): Promise<AudioBuffer> => {
        // 폴백을 위해 버퍼 복제 (첫 시도에서 버퍼가 detach 될 수 있음)
        const backupBuffer = arrayBuffer.slice(0);

        try {
            return await ctx.decodeAudioData(arrayBuffer);
        } catch (error) {
            try {
                // 백업 버퍼로 재시도 (Promise 기반이 아닌 구형 콜백 방식)
                return await new Promise((resolve, reject) => {
                    ctx.decodeAudioData(backupBuffer, resolve, reject);
                });
            } catch {
                throw new Error('Audio format not supported. Please use MP3, WAV, or OGG files.');
            }
        }
    };

    const play = (offset = 0, fadeInSec = 0): void => {
        if (!state.context || !state.buffer || !state.gainNode) {
            state = { ...state, lastError: 'Audio not loaded' };
            return;
        }

        if (state.sourceNode) {
            try {
                state.sourceNode.stop();
                state.sourceNode.disconnect();
            } catch {
            }
        }

        try {
            const source = state.context.createBufferSource();
            source.buffer = state.buffer;
            source.playbackRate.value = state.playbackRate;
            source.connect(state.gainNode);

            if (state.context.state === 'suspended') {
                state.context.resume();
            }

            const clampedOffset = Math.max(0, Math.min(offset, state.duration));
            const fade = Math.max(0, Math.min(1.2, fadeInSec));
            if (fade > 0) {
                const now = state.context.currentTime;
                state.gainNode.gain.cancelScheduledValues(now);
                state.gainNode.gain.setValueAtTime(0.0001, now);
                state.gainNode.gain.linearRampToValueAtTime(state.volume, now + fade);
            } else {
                state.gainNode.gain.cancelScheduledValues(state.context.currentTime);
                state.gainNode.gain.setValueAtTime(state.volume, state.context.currentTime);
            }
            source.start(0, clampedOffset);

            state = {
                ...state,
                sourceNode: source,
                timelineAnchorTime: state.context.currentTime,
                timelineAnchorOffset: clampedOffset,
                pauseOffset: clampedOffset,
                playing: true,
                lastError: null,
            };

            source.onended = () => {
                if (state.playing && state.sourceNode === source) {
                    // pauseOffset을 duration으로 설정 → getProgress()가 1.0 유지
                    state = {
                        ...state,
                        playing: false,
                        pauseOffset: state.duration,
                        timelineAnchorOffset: state.duration,
                    };
                    // 외부 종료 콜백 호출
                    endedCallbacks.forEach(cb => cb());
                }
            };
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Playback failed';
            state = { ...state, lastError: errorMsg, playing: false };
        }
    };

    const pause = (): void => {
        if (!state.playing || !state.sourceNode) return;

        try {
            const current = getCurrentTime();
            state.sourceNode.stop();
            state.sourceNode.disconnect();
            state = {
                ...state,
                playing: false,
                pauseOffset: current,
                timelineAnchorOffset: current,
                sourceNode: null
            };
        } catch (error) {
            state = { ...state, playing: false };
        }
    };

    const resume = (): void => {
        if (state.playing) return;
        play(state.pauseOffset);
    };

    const stop = (): void => {
        if (state.sourceNode) {
            try {
                state.sourceNode.stop();
                state.sourceNode.disconnect();
            } catch {
            }
        }
        state = {
            ...state,
            playing: false,
            pauseOffset: 0,
            timelineAnchorOffset: 0,
            sourceNode: null
        };
    };

    const getCurrentTime = (): number => {
        if (!state.context || !state.playing) return state.pauseOffset;
        const elapsed = Math.max(0, state.context.currentTime - state.timelineAnchorTime);
        return state.timelineAnchorOffset + elapsed * state.playbackRate;
    };

    const getProgress = (): number => {
        if (state.duration <= 0) return 0;
        return Math.min(getCurrentTime() / state.duration, 1);
    };

    const setVolume = (vol: number): void => {
        const clamped = Math.max(0, Math.min(1, vol));
        state = { ...state, volume: clamped };
        if (state.gainNode) {
            state.gainNode.gain.setValueAtTime(clamped, state.context?.currentTime || 0);
        }
        localStorage.setItem(STORAGE_VOLUME_KEY, String(clamped));
    };

    const setPlaybackRate = (rate: number): void => {
        const clamped = Math.max(0.45, Math.min(1.35, rate));
        if (state.playing && state.context) {
            const current = getCurrentTime();
            try {
                state.sourceNode?.playbackRate.setValueAtTime(clamped, state.context.currentTime);
            } catch {
                // noop
            }
            state = {
                ...state,
                playbackRate: clamped,
                pauseOffset: current,
                timelineAnchorOffset: current,
                timelineAnchorTime: state.context.currentTime,
            };
            return;
        }
        state = { ...state, playbackRate: clamped };
    };

    const getFrequencyData = (): Uint8Array => {
        if (!state.analyserNode) return new Uint8Array(0);
        const data = new Uint8Array(state.analyserNode.frequencyBinCount);
        state.analyserNode.getByteFrequencyData(data);
        return data;
    };

    const getTimeDomainData = (): Uint8Array => {
        if (!state.analyserNode) return new Uint8Array(0);
        const data = new Uint8Array(state.analyserNode.frequencyBinCount);
        state.analyserNode.getByteTimeDomainData(data);
        return data;
    };

    const getBuffer = (): AudioBuffer | null => state.buffer;
    const getDuration = (): number => state.duration;
    const isPlaying = (): boolean => state.playing;
    const getVolume = (): number => state.volume;
    const getPlaybackRate = (): number => state.playbackRate;
    const getLastError = (): string | null => state.lastError;
    const isLoading = (): boolean => state.isLoading;

    /** 곡 종료 이벤트 등록 */
    const onEnded = (cb: () => void): (() => void) => {
        endedCallbacks = [...endedCallbacks, cb];
        return () => {
            endedCallbacks = endedCallbacks.filter(c => c !== cb);
        };
    };

    return {
        initContext,
        loadAudio,
        loadFromUrl,
        play,
        pause,
        resume,
        stop,
        getCurrentTime,
        getProgress,
        setVolume,
        setPlaybackRate,
        getFrequencyData,
        getTimeDomainData,
        getBuffer,
        getDuration,
        isPlaying,
        getVolume,
        getPlaybackRate,
        getLastError,
        isLoading,
        setBuffer,
        onEnded,
    };
};

export type AudioManager = ReturnType<typeof createAudioManager>;
