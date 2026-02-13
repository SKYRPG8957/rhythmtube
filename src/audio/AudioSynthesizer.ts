/* === 프로시저럴 오디오 생성기 (테스트용) === */
import { CANCELLED } from "dns";

/**
 * 테스트용 테크노 트랙 생성 (130 BPM)
 * YouTube 차단 시 로컬 파일 없이 즉시 게임 테스트 가능하도록 함.
 */
export const generateTestTrack = async (): Promise<AudioBuffer> => {
    const SAMPLE_RATE = 44100;
    const BPM = 130;
    const DURATION_SECONDS = 120; // 2분
    const TOTAL_SAMPLES = SAMPLE_RATE * DURATION_SECONDS;

    // OfflineContext 생성
    const offlineCtx = new OfflineAudioContext(2, TOTAL_SAMPLES, SAMPLE_RATE);

    const beatInterval = 60 / BPM;
    const sixteenth = beatInterval / 4;

    // === 1. Kick Drum (매 비트) ===
    // 둥-둥-둥-둥
    for (let time = 0; time < DURATION_SECONDS; time += beatInterval) {
        const osc = offlineCtx.createOscillator();
        const gain = offlineCtx.createGain();

        osc.frequency.setValueAtTime(150, time);
        osc.frequency.exponentialRampToValueAtTime(0.01, time + 0.5);

        gain.gain.setValueAtTime(0.8, time);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.5);

        osc.connect(gain);
        gain.connect(offlineCtx.destination);

        osc.start(time);
        osc.stop(time + 0.5);
    }

    // === 2. Hi-hat (16비트 오프비트) ===
    // 츠-츠-츠-츠
    // White Noise Buffer
    const noiseBuffer = offlineCtx.createBuffer(1, SAMPLE_RATE * 2, SAMPLE_RATE);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < output.length; i++) {
        output[i] = Math.random() * 2 - 1;
    }

    for (let time = beatInterval * 0.5; time < DURATION_SECONDS; time += beatInterval) {
        const src = offlineCtx.createBufferSource();
        src.buffer = noiseBuffer;
        const gain = offlineCtx.createGain();
        const filter = offlineCtx.createBiquadFilter();

        filter.type = 'highpass';
        filter.frequency.value = 7000;

        gain.gain.setValueAtTime(0.3, time);
        gain.gain.exponentialRampToValueAtTime(0.01, time + 0.1);

        src.connect(filter);
        filter.connect(gain);
        gain.connect(offlineCtx.destination);

        src.start(time);
        src.stop(time + 0.1);
    }

    // === 3. Bassline (사이드체인 느낌) ===
    // 웅-웅-웅-웅 (엇박)
    for (let time = beatInterval * 0.5; time < DURATION_SECONDS; time += beatInterval) {
        const osc = offlineCtx.createOscillator();
        const gain = offlineCtx.createGain();

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(55, time); // A1

        // 필터링
        const filter = offlineCtx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(400, time);
        filter.frequency.exponentialRampToValueAtTime(100, time + 0.4);

        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(0.4, time + 0.1);
        gain.gain.linearRampToValueAtTime(0, time + beatInterval * 0.9);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(offlineCtx.destination);

        osc.start(time);
        osc.stop(time + beatInterval);
    }

    // === 4. Melody (Arpeggio) ===
    // 간단한 아르페지오 (C Minor)
    const notes = [261.63, 311.13, 392.00, 523.25]; // C4, Eb4, G4, C5
    let index = 0;

    // 8마디 이후부터 멜로디 시작
    const melodyStart = beatInterval * 32;

    for (let time = melodyStart; time < DURATION_SECONDS; time += sixteenth * 2) {
        if (time > DURATION_SECONDS - 5) break;

        const osc = offlineCtx.createOscillator();
        const gain = offlineCtx.createGain();

        osc.type = 'square';
        osc.frequency.value = notes[index % notes.length];
        index++;

        gain.gain.setValueAtTime(0.1, time);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.2);

        osc.connect(gain);
        gain.connect(offlineCtx.destination);

        osc.start(time);
        osc.stop(time + 0.2);
    }

    return await offlineCtx.startRendering();
};
