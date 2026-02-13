/* === 설정 화면 === */
import { inputSystem } from '../utils/InputSystem';

export interface CalibrationResult {
    readonly audioOffset: number;
    readonly inputOffset: number;
    readonly visualOffset: number;
    readonly sampleCount: number;
}

export interface SettingsCallbacks {
    readonly onBack: () => void;
    readonly onVolumeChange: (vol: number) => void;
    readonly onSpeedChange: (speed: number) => void;
    readonly onOffsetChange: (offset: number) => void;
    readonly onInputOffsetChange: (offset: number) => void;
    readonly onVisualOffsetChange: (offset: number) => void;
    readonly onCalibrationResult: (result: CalibrationResult) => void;
}

const STORAGE_VOLUME_KEY = 'rhythmtube_volume';
const STORAGE_SPEED_KEY = 'rhythmtube_notespeed';
const STORAGE_AUDIO_OFFSET_KEY = 'rhythmtube_offset';
const STORAGE_INPUT_OFFSET_KEY = 'rhythmtube_input_offset';
const STORAGE_VISUAL_OFFSET_KEY = 'rhythmtube_visual_offset';
const LEGACY_STORAGE_VOLUME_KEY = 'beatrunner_volume';
const LEGACY_STORAGE_SPEED_KEY = 'beatrunner_notespeed';
const LEGACY_STORAGE_AUDIO_OFFSET_KEY = 'beatrunner_offset';
const LEGACY_STORAGE_INPUT_OFFSET_KEY = 'beatrunner_input_offset';
const LEGACY_STORAGE_VISUAL_OFFSET_KEY = 'beatrunner_visual_offset';

export const createSettings = (callbacks: SettingsCallbacks): HTMLElement => {
    const container = document.createElement('div');
    container.className = 'screen settings';
    container.id = 'settings-screen';

    const readStoredNumber = (key: string, legacyKey: string, fallback: number): number => {
        const raw = localStorage.getItem(key) || localStorage.getItem(legacyKey);
        const parsed = raw !== null ? parseFloat(raw) : Number.NaN;
        return Number.isFinite(parsed) ? parsed : fallback;
    };
    const savedVolume = readStoredNumber(STORAGE_VOLUME_KEY, LEGACY_STORAGE_VOLUME_KEY, 0.7);
    const savedSpeed = readStoredNumber(STORAGE_SPEED_KEY, LEGACY_STORAGE_SPEED_KEY, 1.0);
    const savedOffset = readStoredNumber(STORAGE_AUDIO_OFFSET_KEY, LEGACY_STORAGE_AUDIO_OFFSET_KEY, 0);
    const savedInputOffset = readStoredNumber(STORAGE_INPUT_OFFSET_KEY, LEGACY_STORAGE_INPUT_OFFSET_KEY, 0);
    const savedVisualOffset = readStoredNumber(STORAGE_VISUAL_OFFSET_KEY, LEGACY_STORAGE_VISUAL_OFFSET_KEY, 0);

    container.innerHTML = `
    <button class="back-btn" id="settings-back">← 뒤로</button>
    <h2 class="settings__header">⚙ 설정</h2>
    <div class="settings__hint">키 추가 등록: 버튼 우클릭 (기존 키 유지 + 새 키 추가)</div>

    <div class="settings__section">
      <div class="settings__section-title">키 바인딩</div>
      <div class="key-bind-row">
        <span class="key-bind-row__label">상단 레인</span>
        <button class="key-bind-row__key" id="key-top"></button>
      </div>
      <div class="key-bind-row">
        <span class="key-bind-row__label">하단 레인</span>
        <button class="key-bind-row__key" id="key-bottom"></button>
      </div>
      <div class="key-bind-row">
        <span class="key-bind-row__label">스페셜</span>
        <button class="key-bind-row__key" id="key-special"></button>
      </div>
    </div>

    <div class="settings__section">
      <div class="settings__section-title">오디오</div>
      <div class="slider-row">
        <span class="slider-row__label">볼륨</span>
        <input type="range" class="slider-row__input" id="slider-volume" min="0" max="100" value="${Math.round(savedVolume * 100)}" />
        <span class="slider-row__value" id="value-volume">${Math.round(savedVolume * 100)}%</span>
      </div>
      <div class="slider-row">
        <span class="slider-row__label">오디오 오프셋</span>
        <input type="range" class="slider-row__input" id="slider-offset" min="-200" max="200" value="${savedOffset}" />
        <span class="slider-row__value" id="value-offset">${savedOffset}ms</span>
      </div>
      <div class="slider-row">
        <span class="slider-row__label">입력 오프셋</span>
        <input type="range" class="slider-row__input" id="slider-input-offset" min="-250" max="250" value="${savedInputOffset}" />
        <span class="slider-row__value" id="value-input-offset">${savedInputOffset}ms</span>
      </div>
      <div class="slider-row">
        <span class="slider-row__label">화면 오프셋</span>
        <input type="range" class="slider-row__input" id="slider-visual-offset" min="-250" max="250" value="${savedVisualOffset}" />
        <span class="slider-row__value" id="value-visual-offset">${savedVisualOffset}ms</span>
      </div>
    </div>

    <div class="settings__section settings__section--calibration">
      <div class="settings__section-title">보정 모드</div>
      <div class="settings__calibration-status" id="calibration-status">대기 중 · 시작 버튼을 누르고 비트에 맞춰 입력하세요.</div>
      <div class="settings__calibration-progress" id="calibration-progress">샘플 0 / 12</div>
      <button class="settings__calibration-btn" id="calibration-toggle">보정 시작</button>
    </div>

    <div class="settings__section">
      <div class="settings__section-title">게임플레이</div>
      <div class="slider-row">
        <span class="slider-row__label">노트 속도</span>
        <input type="range" class="slider-row__input" id="slider-speed" min="50" max="300" value="${Math.round(savedSpeed * 100)}" />
        <span class="slider-row__value" id="value-speed">${savedSpeed.toFixed(1)}x</span>
      </div>
    </div>
  `;

    const volumeSlider = container.querySelector('#slider-volume') as HTMLInputElement;
    const volumeValue = container.querySelector('#value-volume') as HTMLElement;
    const offsetSlider = container.querySelector('#slider-offset') as HTMLInputElement;
    const offsetValue = container.querySelector('#value-offset') as HTMLElement;
    const inputOffsetSlider = container.querySelector('#slider-input-offset') as HTMLInputElement;
    const inputOffsetValue = container.querySelector('#value-input-offset') as HTMLElement;
    const visualOffsetSlider = container.querySelector('#slider-visual-offset') as HTMLInputElement;
    const visualOffsetValue = container.querySelector('#value-visual-offset') as HTMLElement;
    const speedSlider = container.querySelector('#slider-speed') as HTMLInputElement;
    const speedValue = container.querySelector('#value-speed') as HTMLElement;
    const calibrationStatus = container.querySelector('#calibration-status') as HTMLElement;
    const calibrationProgress = container.querySelector('#calibration-progress') as HTMLElement;
    const calibrationToggleBtn = container.querySelector('#calibration-toggle') as HTMLButtonElement;

    let calibrationActive = false;
    let calibrationStartAt = 0;
    let calibrationTicks = 0;
    let calibrationIntervalId: number | null = null;
    let calibrationStartTimeoutId: number | null = null;
    let calibrationSamples: number[] = [];
    let calibrationAudioCtx: AudioContext | null = null;
    let calibrationMasterGain: GainNode | null = null;
    const CALIBRATION_TAP_TARGET = 12;
    const CALIBRATION_BEAT_MS = 500;
    const CALIBRATION_TICK_SEC = 0.09;

    const ensureCalibrationAudio = (): AudioContext | null => {
        const audioCtor = window.AudioContext
            || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!audioCtor) return null;

        if (!calibrationAudioCtx || calibrationAudioCtx.state === 'closed') {
            calibrationAudioCtx = new audioCtor();
            calibrationMasterGain = calibrationAudioCtx.createGain();
            calibrationMasterGain.gain.value = 0.22;
            calibrationMasterGain.connect(calibrationAudioCtx.destination);
        }
        if (calibrationAudioCtx.state === 'suspended') {
            void calibrationAudioCtx.resume();
        }
        return calibrationAudioCtx;
    };

    const playCalibrationTick = (accent: boolean): void => {
        const ctx = ensureCalibrationAudio();
        const master = calibrationMasterGain;
        if (!ctx || !master) return;

        const now = ctx.currentTime + 0.004;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const peak = accent ? 0.26 : 0.2;
        osc.type = accent ? 'triangle' : 'square';
        osc.frequency.setValueAtTime(accent ? 1360 : 980, now);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(peak, now + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + CALIBRATION_TICK_SEC);
        osc.connect(gain);
        gain.connect(master);
        osc.start(now);
        osc.stop(now + CALIBRATION_TICK_SEC + 0.015);
        osc.onended = () => {
            osc.disconnect();
            gain.disconnect();
        };
    };

    const updateCalibrationGain = (): void => {
        if (!calibrationAudioCtx || !calibrationMasterGain) return;
        const volumeNorm = parseInt(volumeSlider.value, 10) / 100;
        const targetGain = Math.max(0.07, Math.min(0.32, volumeNorm * 0.35));
        calibrationMasterGain.gain.setValueAtTime(targetGain, calibrationAudioCtx.currentTime);
    };

    const tickCalibrationBeat = (): void => {
        calibrationTicks += 1;
        calibrationStatus.textContent = 'TAP NOW!';
        calibrationStatus.classList.remove('pulse');
        // trigger reflow for pulse restart
        void calibrationStatus.offsetWidth;
        calibrationStatus.classList.add('pulse');
        playCalibrationTick((calibrationTicks - 1) % 4 === 0);

        if (calibrationSamples.length >= CALIBRATION_TAP_TARGET) {
            completeCalibration();
            return;
        }
        if (calibrationTicks > CALIBRATION_TAP_TARGET * 3) {
            calibrationStatus.textContent = '시간 초과. 다시 시도하세요.';
            stopCalibration();
        }
    };

    const updateKeyDisplay = (): void => {
        const bindings = inputSystem.getBindings();
        const keyTop = container.querySelector('#key-top') as HTMLElement;
        const keyBottom = container.querySelector('#key-bottom') as HTMLElement;
        const keySpecial = container.querySelector('#key-special') as HTMLElement;

        keyTop.textContent = formatKey(bindings.laneTop);
        keyBottom.textContent = formatKey(bindings.laneBottom);
        keySpecial.textContent = formatKey(bindings.special);
    };

    const updateOffsetLabels = (): void => {
        offsetValue.textContent = `${offsetSlider.value}ms`;
        inputOffsetValue.textContent = `${inputOffsetSlider.value}ms`;
        visualOffsetValue.textContent = `${visualOffsetSlider.value}ms`;
    };

    const stopCalibration = (): void => {
        calibrationActive = false;
        if (calibrationStartTimeoutId !== null) {
            window.clearTimeout(calibrationStartTimeoutId);
            calibrationStartTimeoutId = null;
        }
        if (calibrationIntervalId !== null) {
            window.clearInterval(calibrationIntervalId);
            calibrationIntervalId = null;
        }
        if (calibrationAudioCtx && calibrationAudioCtx.state !== 'closed') {
            void calibrationAudioCtx.close();
        }
        calibrationAudioCtx = null;
        calibrationMasterGain = null;
        calibrationToggleBtn.textContent = '보정 시작';
        calibrationToggleBtn.classList.remove('active');
        container.classList.remove('settings--calibrating');
    };

    const completeCalibration = (): void => {
        if (calibrationSamples.length < 6) {
            calibrationStatus.textContent = '샘플이 부족합니다. 다시 시도하세요.';
            stopCalibration();
            return;
        }

        const sorted = [...calibrationSamples].sort((a, b) => a - b);
        const trim = Math.max(1, Math.floor(sorted.length * 0.2));
        const trimmed = sorted.slice(trim, Math.max(trim + 1, sorted.length - trim));
        const avgDelta = trimmed.reduce((acc, v) => acc + v, 0) / Math.max(1, trimmed.length);
        const recommendedInputOffset = Math.max(-250, Math.min(250, Math.round(-avgDelta)));

        inputOffsetSlider.value = String(recommendedInputOffset);
        callbacks.onInputOffsetChange(recommendedInputOffset);

        const result: CalibrationResult = {
            audioOffset: parseInt(offsetSlider.value, 10),
            inputOffset: recommendedInputOffset,
            visualOffset: parseInt(visualOffsetSlider.value, 10),
            sampleCount: calibrationSamples.length,
        };
        callbacks.onCalibrationResult(result);
        updateOffsetLabels();

        calibrationStatus.textContent = `보정 완료 · 입력 ${recommendedInputOffset > 0 ? '+' : ''}${recommendedInputOffset}ms 적용`;
        stopCalibration();
    };

    const startCalibration = (): void => {
        calibrationActive = true;
        calibrationStartAt = performance.now() + 900;
        calibrationTicks = 0;
        calibrationSamples = [];
        calibrationStatus.textContent = '준비... 1초 후 시작. 비트에 맞춰 키를 눌러주세요.';
        calibrationProgress.textContent = `샘플 0 / ${CALIBRATION_TAP_TARGET}`;
        calibrationToggleBtn.textContent = '보정 중지';
        calibrationToggleBtn.classList.add('active');
        container.classList.add('settings--calibrating');

        ensureCalibrationAudio();
        updateCalibrationGain();
        const startDelay = Math.max(0, calibrationStartAt - performance.now());
        calibrationStartTimeoutId = window.setTimeout(() => {
            if (!calibrationActive) return;
            tickCalibrationBeat();
            calibrationIntervalId = window.setInterval(() => {
                if (!calibrationActive) return;
                tickCalibrationBeat();
            }, CALIBRATION_BEAT_MS);
            calibrationStartTimeoutId = null;
        }, startDelay);
    };

    const isCalibrationKey = (rawKey: string): boolean => {
        const key = rawKey.toLowerCase();
        const bindings = inputSystem.getBindings();
        const split = (v: string) => v.split(/[|,/+]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
        const all = [...split(bindings.laneTop), ...split(bindings.laneBottom), ...split(bindings.special)];
        const normalized = key === ' ' ? 'space' : key;
        return all.includes(normalized) || (normalized === 'space' && all.includes(' '));
    };

    const onCalibrationKeyDown = (e: KeyboardEvent): void => {
        if (!calibrationActive || !isCalibrationKey(e.key)) return;
        const now = performance.now();
        if (now < calibrationStartAt - 120) return;
        const beatIndex = Math.round((now - calibrationStartAt) / CALIBRATION_BEAT_MS);
        const expected = calibrationStartAt + beatIndex * CALIBRATION_BEAT_MS;
        const delta = now - expected;
        if (Math.abs(delta) > 220) return;

        calibrationSamples.push(delta);
        calibrationProgress.textContent = `샘플 ${calibrationSamples.length} / ${CALIBRATION_TAP_TARGET}`;
        if (calibrationSamples.length >= CALIBRATION_TAP_TARGET) {
            completeCalibration();
        }
    };

    const setupKeyBind = (btnId: string, action: 'laneTop' | 'laneBottom' | 'special'): void => {
        const btn = container.querySelector(`#${btnId}`) as HTMLElement;
        btn.addEventListener('click', async () => {
            btn.classList.add('listening');
            btn.textContent = '키를 입력... (교체)';
            const newKey = await inputSystem.startRebind(action, 'replace');
            btn.classList.remove('listening');
            btn.textContent = formatKey(newKey);
        });
        btn.addEventListener('contextmenu', async (e) => {
            e.preventDefault();
            btn.classList.add('listening');
            btn.textContent = '키를 입력... (추가)';
            const newKey = await inputSystem.startRebind(action, 'append');
            btn.classList.remove('listening');
            btn.textContent = formatKey(newKey);
        });
    };

    setupKeyBind('key-top', 'laneTop');
    setupKeyBind('key-bottom', 'laneBottom');
    setupKeyBind('key-special', 'special');

    volumeSlider.addEventListener('input', () => {
        const vol = parseInt(volumeSlider.value, 10) / 100;
        volumeValue.textContent = `${volumeSlider.value}%`;
        callbacks.onVolumeChange(vol);
        updateCalibrationGain();
    });

    offsetSlider.addEventListener('input', () => {
        callbacks.onOffsetChange(parseInt(offsetSlider.value, 10));
        updateOffsetLabels();
    });

    inputOffsetSlider.addEventListener('input', () => {
        callbacks.onInputOffsetChange(parseInt(inputOffsetSlider.value, 10));
        updateOffsetLabels();
    });

    visualOffsetSlider.addEventListener('input', () => {
        callbacks.onVisualOffsetChange(parseInt(visualOffsetSlider.value, 10));
        updateOffsetLabels();
    });

    speedSlider.addEventListener('input', () => {
        const speed = parseInt(speedSlider.value, 10) / 100;
        speedValue.textContent = `${speed.toFixed(1)}x`;
        callbacks.onSpeedChange(speed);
    });

    calibrationToggleBtn.addEventListener('click', () => {
        if (calibrationActive) {
            calibrationStatus.textContent = '보정 중단됨';
            stopCalibration();
            return;
        }
        startCalibration();
    });

    container.querySelector('#settings-back')?.addEventListener('click', () => {
        stopCalibration();
        callbacks.onBack();
    });

    window.addEventListener('keydown', onCalibrationKeyDown);

    const refresh = (): void => {
        updateKeyDisplay();
        updateOffsetLabels();
    };

    setTimeout(() => {
        updateKeyDisplay();
        updateOffsetLabels();
    }, 0);

    return Object.assign(container, { refresh });
};

const formatKey = (key: string): string => {
    const map: Record<string, string> = {
        ' ': 'Space',
        'space': 'Space',
        'arrowup': '↑',
        'arrowdown': '↓',
        'arrowleft': '←',
        'arrowright': '→',
        'shift': 'Shift',
        'control': 'Ctrl',
        'alt': 'Alt',
        'enter': 'Enter',
        'escape': 'Esc',
        'tab': 'Tab',
    };

    const tokens = key
        .split(/[|,/+]+/)
        .map(s => s.toLowerCase().trim() === '' && s.includes(' ') ? 'space' : s.trim().toLowerCase())
        .filter(Boolean);
    if (tokens.length === 0) return '-';
    return tokens.map(t => map[t] || t.toUpperCase()).join(' / ');
};
