/* === 메인 엔트리 포인트 - 전체 앱 와이어링 === */
import { createEngine } from './core/Engine';
import { createRenderer } from './core/Renderer';
import { createAudioManager } from './audio/AudioManager';
import { createCharacter } from './game/Character';
import { createNoteManager } from './game/NoteManager';
import { createScoreManager } from './game/ScoreManager';
import { createEffectManager } from './game/EffectManager';
import { createUIManager } from './ui/UIManager';
import { createMainMenu } from './ui/MainMenu';
import { createSongSelect } from './ui/SongSelect';
import { createSettings } from './ui/Settings';
import { createGameHUD } from './ui/GameHUD';
import { createResultScreen } from './ui/ResultScreen';
import { createPauseMenu } from './ui/PauseMenu';
import { inputSystem } from './utils/InputSystem';
import { generateMapFast } from './map/MapGeneratorClient';
import type { MapData, VisualTheme } from './map/MapData';
import type { Difficulty, GameScreen, JudgeResult } from './utils/Constants';
import {
    CANVAS_WIDTH, CANVAS_HEIGHT,
    LANE_TOP_Y, LANE_BOTTOM_Y,
    JUDGE_LINE_X, LANE_TOP, LANE_BOTTOM,
    NOTE_SPEED_BASE, // Imported here
} from './utils/Constants';
import { lerp } from './utils/MathUtils';

import { SpriteManager } from './utils/SpriteManager';

/** 앱 초기화 */
const initApp = async (): Promise<void> => {
    // 모듈 인스턴스 생성
    const engine = createEngine();
    const renderer = createRenderer();
    const audioManager = createAudioManager();
    const character = createCharacter();
    const noteManager = createNoteManager();
    const scoreManager = createScoreManager();
    const effectManager = createEffectManager();
    const uiManager = createUIManager();

    // 로딩 오버레이
    const loadingOverlay = createLoadingOverlay();
    document.body.appendChild(loadingOverlay.element);
    const gameOverOverlay = createGameOverOverlay();
    document.body.appendChild(gameOverOverlay.element);
    const countdownOverlay = createCountdownOverlay();
    document.body.appendChild(countdownOverlay.element);

    // 리소스 로드
    loadingOverlay.show();
    loadingOverlay.update('리소스 로딩 중...', 0.0);
    try {
        await SpriteManager.getInstance().load();
        SpriteManager.getInstance().loadProcedural(); // Procedural Assets Load
        loadingOverlay.update('로딩 완료', 1.0);
        setTimeout(() => loadingOverlay.hide(), 500);
    } catch (e) {
        console.error('Failed to load sprites:', e);
        loadingOverlay.update('리소스 로드 실패 (콘솔 확인)', 0.0);
    }

    // 현재 맵 데이터
    let currentMap: MapData | null = null;
    let currentDifficulty: Difficulty = 'normal';
    let currentYoutubeUrl: string | null = null; // Store URL for background video
    let infiniteMode = false;
    let isPaused = false;
    let settingsReturnScreen: GameScreen = 'menu';

    /** YouTube ID 추출 헬퍼 */
    const extractYoutubeId = (rawUrl: string): string | null => {
        const input = rawUrl.trim();
        if (!input) return null;
        const direct = input.match(/^[\w-]{11}$/);
        if (direct) return direct[0];
        try {
            const parsed = new URL(input);
            const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
            const pathParts = parsed.pathname.split('/').filter(Boolean);
            const v = parsed.searchParams.get('v');
            const candidate = v
                || (host === 'youtu.be' ? pathParts[0] : null)
                || ((pathParts[0] === 'shorts' || pathParts[0] === 'embed' || pathParts[0] === 'live') ? pathParts[1] : null);
            if (candidate && /^[\w-]{11}$/.test(candidate)) return candidate;
        } catch {
            // noop
        }
        const fallback = input.match(/(?:v=|\/)([\w-]{11})(?:[?&#/]|$)/);
        return fallback ? fallback[1] : null;
    };
    const normalizeYoutubeUrl = (rawUrl: string): string => {
        const id = extractYoutubeId(rawUrl);
        return id ? `https://www.youtube.com/watch?v=${id}` : rawUrl.trim();
    };
    const API_BASE_RAW = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() ?? '';
    const API_BASE = API_BASE_RAW.endsWith('/') ? API_BASE_RAW.slice(0, -1) : API_BASE_RAW;
    const apiUrl = (path: string): string => `${API_BASE}${path}`;

    const getYoutubeCookieHandle = (): string | null => {
        try {
            return sessionStorage.getItem('rhythmtube_youtube_cookie_handle_session')
                || localStorage.getItem('rhythmtube_youtube_cookie_handle');
        } catch {
            return null;
        }
    };
    const setVideoPausedVisual = (paused: boolean): void => {
        const videoBg = document.getElementById('video-background') as HTMLElement | null;
        if (!videoBg) return;
        videoBg.style.opacity = paused ? '0' : '1';
    };
    const YOUTUBE_SYNC_INTERVAL_SEC = 1.25;
    const YOUTUBE_SYNC_OFFSET_SEC = 0.08;
    let lastYoutubeSyncAudioTime = -Infinity;
    const getYoutubeIframe = (): HTMLIFrameElement | null =>
        document.querySelector('#video-background iframe') as HTMLIFrameElement | null;
    const postYoutubeCommand = (func: string, args: readonly unknown[] = []): void => {
        const iframe = getYoutubeIframe();
        if (!iframe?.contentWindow) return;
        iframe.contentWindow.postMessage(
            JSON.stringify({ event: 'command', func, args }),
            'https://www.youtube.com'
        );
    };
    const syncYoutubeVideoToAudio = (opts?: { forceSeek?: boolean; play?: boolean }): void => {
        if (!currentYoutubeUrl) return;
        const now = audioManager.getCurrentTime();
        const needSeek = !!opts?.forceSeek || Math.abs(now - lastYoutubeSyncAudioTime) >= YOUTUBE_SYNC_INTERVAL_SEC;
        if (needSeek) {
            const target = Math.max(0, now + YOUTUBE_SYNC_OFFSET_SEC);
            postYoutubeCommand('seekTo', [Number(target.toFixed(3)), true]);
            lastYoutubeSyncAudioTime = now;
        }
        if (opts?.play) {
            postYoutubeCommand('playVideo');
        }
    };
    const pauseYoutubeVideo = (): void => {
        postYoutubeCommand('pauseVideo');
    };
    let lastVideoTransform = '';
    const syncVideoCameraTransform = (cam: { x: number; y: number; zoom: number; tilt: number } | null): void => {
        const videoBg = document.getElementById('video-background') as HTMLElement | null;
        if (!videoBg) return;

        const shouldFollowCamera = !!cam
            && !!currentYoutubeUrl
            && gameStarted
            && !isPaused
            && engine.getCurrentScreen() === 'playing';

        const baseScale = 1.1;
        const transform = shouldFollowCamera
            ? (() => {
                const vw = Math.max(1280, window.innerWidth || 1280);
                const vh = Math.max(720, window.innerHeight || 720);
                const rot = cam.tilt * 0.58;
                const zoomScale = 1 + (cam.zoom - 1) * 0.45;
                const scale = Math.max(1.16, Math.min(1.34, baseScale * zoomScale));
                const maxShiftX = Math.max(22, (scale - 1) * vw * 0.48);
                const maxShiftY = Math.max(16, (scale - 1) * vh * 0.46);
                const tx = Math.max(-maxShiftX, Math.min(maxShiftX, cam.x * 0.46));
                const ty = Math.max(-maxShiftY, Math.min(maxShiftY, cam.y * 0.46));
                return `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0) rotate(${rot.toFixed(4)}rad) scale(${scale.toFixed(4)})`;
            })()
            : `translate3d(0px, 0px, 0) rotate(0rad) scale(${baseScale})`;

        if (transform !== lastVideoTransform) {
            videoBg.style.transform = transform;
            lastVideoTransform = transform;
        }
    };
    let gameStarted = false;
    let lastSustainPulseAt = -Infinity;
    let hitStopTimer = 0;
    let isInInterlude = false; // 간주 중 여부
    let wasAirborneGuide = false;
    let cameraDriveCacheForMap: MapData | null = null;
    let baseTheme: VisualTheme = 'nightCity';
    let lastComboMilestone = 0;
    let failSequenceActive = false;
    let failSequenceTimer = 0;
    let songEndRequestedAt = -Infinity;
    let countdownActive = false;
    let countdownRemainingMs = 0;
    let countdownGoRemainingMs = 0;
    let countdownAudioTriggered = false;
    let sectionCursor = 0;
    let cameraDriveSectionStats: Array<{
        readonly sectionIndex: number;
        readonly density: number;
        readonly strongRatio: number;
    }> = [];

    /** 현재 시간이 간주(interlude) 구간인지 체크 */
    const checkInterlude = (currentTime: number): boolean => {
        if (!currentMap) return false;
        const sections = currentMap.sections;
        if (sections.length === 0) return false;
        if (sectionCursor >= sections.length) sectionCursor = sections.length - 1;
        while (sectionCursor > 0 && currentTime < sections[sectionCursor].startTime) {
            sectionCursor--;
        }
        while (sectionCursor < sections.length - 1 && currentTime >= sections[sectionCursor].endTime) {
            sectionCursor++;
        }
        const section = sections[sectionCursor];
        if (currentTime < section.startTime || currentTime >= section.endTime) return false;
        return !!section.isInterlude && section.type === 'interlude';
    };
    const logMapBalanceDiagnostics = (map: MapData, difficulty: Difficulty): void => {
        const targetRangeByDiff: Record<Difficulty, { min: number; max: number }> = {
            easy: { min: 1.7, max: 2.9 },
            normal: { min: 3.2, max: 5.6 },
            hard: { min: 4.8, max: 7.9 },
            expert: { min: 6.6, max: 10.6 },
        };
        const typeMul = (type: string): number => {
            if (type === 'drop') return 1.18;
            if (type === 'chorus') return 1.1;
            if (type === 'bridge') return 0.86;
            if (type === 'verse') return 0.96;
            return 0.55;
        };
        const range = targetRangeByDiff[difficulty];
        const rows = map.sections.map((s, idx) => {
            const dur = Math.max(0.001, s.endTime - s.startTime);
            const count = map.notes.filter(n => n.time >= s.startTime && n.time < s.endTime).length;
            const nps = count / dur;
            const midTarget = ((range.min + range.max) * 0.5) * typeMul(s.type);
            const low = range.min * typeMul(s.type);
            const high = range.max * typeMul(s.type);
            const ratio = nps / Math.max(0.001, midTarget);
            const status = nps < low ? 'sparse' : nps > high ? 'dense' : 'ok';
            return {
                idx,
                type: s.type,
                start: s.startTime.toFixed(2),
                end: s.endTime.toFixed(2),
                dur: dur.toFixed(2),
                notes: count,
                nps: nps.toFixed(2),
                target: `${low.toFixed(2)}~${high.toFixed(2)}`,
                ratio: ratio.toFixed(2),
                status,
            };
        });
        const sparse = rows.filter(r => r.status === 'sparse').length;
        const dense = rows.filter(r => r.status === 'dense').length;
        const playableRows = rows.filter(r => r.type !== 'intro' && r.type !== 'outro' && r.type !== 'interlude');
        const avgRatio = playableRows.length > 0
            ? playableRows.reduce((acc, r) => acc + Number(r.ratio), 0) / playableRows.length
            : 1;
        const ratioPenalty = Math.min(1, Math.abs(1 - avgRatio) * 1.2);
        const sparsePenalty = Math.min(1, sparse / Math.max(1, playableRows.length));
        const densePenalty = Math.min(1, dense / Math.max(1, playableRows.length));
        const balanceScore = Math.max(
            0,
            Math.min(
                100,
                Math.round((1 - (ratioPenalty * 0.45 + sparsePenalty * 0.35 + densePenalty * 0.2)) * 100)
            )
        );
        const byType = ['verse', 'chorus', 'drop', 'bridge'] as const;
        const typeSummary = byType.map((type) => {
            const chunk = playableRows.filter(r => r.type === type);
            if (chunk.length === 0) {
                return { type, sections: 0, sparse: 0, dense: 0, avgRatio: '-' };
            }
            const typeSparse = chunk.filter(r => r.status === 'sparse').length;
            const typeDense = chunk.filter(r => r.status === 'dense').length;
            const typeRatio = chunk.reduce((acc, r) => acc + Number(r.ratio), 0) / chunk.length;
            return {
                type,
                sections: chunk.length,
                sparse: typeSparse,
                dense: typeDense,
                avgRatio: typeRatio.toFixed(2),
            };
        });
        const dominantIssue = sparse > dense
            ? 'sparse-heavy'
            : dense > sparse
                ? 'dense-heavy'
                : 'balanced';
        console.log('[MapBalance]', {
            difficulty,
            totalNotes: map.totalNotes,
            duration: map.duration.toFixed(2),
            nps: (map.totalNotes / Math.max(1, map.duration)).toFixed(2),
            sparseSections: sparse,
            denseSections: dense,
            balanceScore,
            dominantIssue,
        });
        console.table(rows);
        console.table(typeSummary);
    };
    const rebuildCameraDriveCache = (): void => {
        if (!currentMap) {
            cameraDriveCacheForMap = null;
            cameraDriveSectionStats = [];
            return;
        }
        if (cameraDriveCacheForMap === currentMap && cameraDriveSectionStats.length === currentMap.sections.length) {
            return;
        }
        cameraDriveCacheForMap = currentMap;
        cameraDriveSectionStats = currentMap.sections.map((section, sectionIndex) => {
            const sectionNotes = currentMap!.notes.filter(n => n.time >= section.startTime && n.time < section.endTime);
            const secDur = Math.max(0.001, section.endTime - section.startTime);
            const density = sectionNotes.length / secDur;
            const strongCount = sectionNotes.filter(n => (n.strength ?? 0.5) >= 0.7).length;
            const strongRatio = strongCount / Math.max(1, sectionNotes.length);
            return {
                sectionIndex,
                density,
                strongRatio,
            };
        });
    };
    const getCameraDriveAt = (currentTime: number): { drive: number; highlight: number; motionMode: number } => {
        if (!currentMap) return { drive: 1, highlight: 0, motionMode: 0.5 };
        rebuildCameraDriveCache();
        const sectionIndex = currentMap.sections.findIndex(s => currentTime >= s.startTime && currentTime < s.endTime);
        if (sectionIndex < 0) return { drive: 1, highlight: 0, motionMode: 0.5 };
        const section = currentMap.sections[sectionIndex];
        if (!section) return { drive: 1, highlight: 0, motionMode: 0.5 };
        const secStat = cameraDriveSectionStats[sectionIndex];
        const type = section.type;
        const energy = Math.max(0, Math.min(1, section.avgEnergy || 0.5));
        const secDur = Math.max(0.001, section.endTime - section.startTime);
        const secProgress = Math.max(0, Math.min(1, (currentTime - section.startTime) / secDur));
        const phrasePulse = 0.5 + 0.5 * Math.sin(secProgress * Math.PI * 2 * (type === 'drop' ? 2.2 : type === 'chorus' ? 1.6 : 1.1));
        const mapNps = currentMap.totalNotes / Math.max(1, currentMap.duration);
        const densityBoost = secStat ? Math.max(-0.12, Math.min(0.24, (secStat.density - mapNps) * 0.09)) : 0;
        const strongBoost = secStat ? (secStat.strongRatio - 0.45) * 0.32 : 0;
        const typeBoost = type === 'drop'
            ? 0.52
            : type === 'chorus'
                ? 0.36
                : type === 'bridge'
                    ? -0.08
                    : type === 'intro' || type === 'outro' || type === 'interlude'
                        ? -0.16
                        : 0;
        const drive = Math.max(0.76, Math.min(2.15,
            0.9
            + energy * 0.78
            + typeBoost
            + densityBoost
            + strongBoost
            + (phrasePulse - 0.5) * 0.14
        ));
        const highlightBase = type === 'drop'
            ? 0.78
            : type === 'chorus'
                ? 0.6
                : type === 'verse'
                    ? 0.28
                    : type === 'bridge'
                        ? 0.2
                        : 0.1;
        const highlight = Math.max(0, Math.min(1,
            highlightBase
            + Math.max(-0.08, (energy - 0.55) * 0.95)
            + (phrasePulse - 0.5) * 0.22
            + densityBoost * 0.75
        ));
        const modeBase = type === 'drop'
            ? 0.92
            : type === 'chorus'
                ? 0.72
                : type === 'verse'
                    ? 0.42
                    : type === 'bridge'
                        ? 0.26
                        : 0.2;
        const phraseMode = 0.5 + 0.5 * Math.sin(secProgress * Math.PI * 2 * (type === 'drop' ? 1.4 : 0.8));
        const motionMode = Math.max(0, Math.min(1,
            modeBase * 0.72 + phraseMode * 0.2 + (secStat ? secStat.strongRatio * 0.12 : 0)
        ));
        return { drive, highlight, motionMode };
    };
    const resolveBaseTheme = (map: MapData): VisualTheme => {
        const fromMap = map.visualTheme ?? 'sunset';
        const avgEnergy = map.sections.length > 0
            ? map.sections.reduce((acc, s) => acc + (s.avgEnergy || 0.5), 0) / map.sections.length
            : 0.5;
        const calmRatio = map.sections.length > 0
            ? map.sections.filter(s => s.type === 'bridge' || s.type === 'verse' || (s.avgEnergy || 0.5) <= 0.56).length / map.sections.length
            : 0.5;
        const energeticRatio = map.sections.length > 0
            ? map.sections.filter(s => s.type === 'drop' || s.type === 'chorus' || (s.avgEnergy || 0.5) >= 0.74).length / map.sections.length
            : 0;
        const nps = map.totalNotes / Math.max(1, map.duration);

        if (fromMap === 'nightCity') {
            const softMood = avgEnergy <= 0.59
                && calmRatio >= 0.42
                && energeticRatio <= 0.26
                && nps <= 3.8;
            if (softMood) {
                return avgEnergy <= 0.5 || calmRatio >= 0.56 ? 'meadow' : 'sunset';
            }
        }

        if (fromMap === 'meadow' || fromMap === 'sunset') {
            const tooAggressive = avgEnergy >= 0.76
                && energeticRatio >= 0.46
                && nps >= 5.1;
            if (tooAggressive) {
                return 'nightCity';
            }
        }

        if (fromMap === 'sunset' && avgEnergy <= 0.48 && calmRatio >= 0.55) {
            return 'meadow';
        }
        if (fromMap === 'meadow' && avgEnergy >= 0.57 && calmRatio <= 0.44) {
            return 'sunset';
        }

        return fromMap;
    };
    const applyComboDynamics = (combo: number, currentTime: number): void => {
        const comboStep = 30;
        const comboDriveBase = Math.max(0, combo - comboStep);
        renderer.setComboDrive(Math.min(1, comboDriveBase / 150));

        const reachedMilestone = Math.floor(combo / comboStep) * comboStep;
        if (reachedMilestone > lastComboMilestone && reachedMilestone > 0) {
            for (let mark = lastComboMilestone + comboStep; mark <= reachedMilestone; mark += comboStep) {
                const lane = Math.floor(mark / comboStep) % 2 === 0 ? LANE_TOP : LANE_BOTTOM;
                const spawnTime = currentTime + Math.max(0.34, (60 / Math.max(1, currentMap?.bpm ?? 120)) * 0.55);
                if (mark % comboStep === 0 && 'injectBonusTap' in noteManager) {
                    (noteManager as ReturnType<typeof createNoteManager> & {
                        injectBonusTap: (time: number, lane: number) => void;
                    }).injectBonusTap(spawnTime, lane);
                }
                renderer.triggerCameraBeat(lane, 0.68 + Math.min(0.75, mark / 180), 'hit');
            }
            lastComboMilestone = reachedMilestone;
        }
    };
    const beginFailSequence = (): void => {
        if (failSequenceActive || !gameStarted) return;
        failSequenceActive = true;
        failSequenceTimer = 1.18;
        renderer.setFailSlowMo(0.44);
        audioManager.setPlaybackRate(0.58);
        renderer.triggerBeatPulse();
        renderer.triggerHitShake(LANE_BOTTOM, 14);
        renderer.triggerCameraBeat(LANE_BOTTOM, 1.38, 'hit');
        gameOverOverlay.show();
    };
    const resetDynamicGameplayState = (): void => {
        failSequenceActive = false;
        failSequenceTimer = 0;
        lastComboMilestone = 0;
        renderer.setComboDrive(0);
        renderer.setFailSlowMo(1);
        audioManager.setPlaybackRate(1);
        gameOverOverlay.hide();
        countdownOverlay.hide();
        songEndRequestedAt = -Infinity;
        countdownActive = false;
        countdownRemainingMs = 0;
        countdownGoRemainingMs = 0;
        countdownAudioTriggered = false;
    };

    // === UI 화면 생성 ===
    const mainMenu = createMainMenu({
        onStart: () => switchScreen('songSelect'),
        onSettings: () => {
            settingsReturnScreen = 'menu';
            switchScreen('settings');
        },
    });

    const songSelect = createSongSelect({
        onFileSelect: (file) => handleFileSelect(file),
        onYoutubeUrl: (url) => handleYoutubeUrl(url),
        onBack: () => switchScreen('menu'),
    });

    const settings = createSettings({
        onBack: () => switchScreen(settingsReturnScreen),
        onVolumeChange: (vol) => audioManager.setVolume(vol),
        onSpeedChange: (speed) => noteManager.setNoteSpeed(speed),
        onOffsetChange: (offset) => noteManager.setAudioOffset(offset),
        onInputOffsetChange: (offset) => noteManager.setInputOffset(offset),
        onVisualOffsetChange: (offset) => noteManager.setVisualOffset(offset),
        onCalibrationResult: (data) => {
            noteManager.setAudioOffset(data.audioOffset);
            noteManager.setInputOffset(data.inputOffset);
            noteManager.setVisualOffset(data.visualOffset);
        },
    });

    const gameHUD = createGameHUD();

    // 오토 플레이 연결
    if (gameHUD.onAutoPlay) {
        gameHUD.onAutoPlay((enabled) => {
            if ('setAutoPlay' in noteManager) {
                (noteManager as any).setAutoPlay(enabled);
            }
        });
    }

    const resultScreen = createResultScreen({
        onRetry: () => retryGame(),
        onBack: () => {
            audioManager.stop();
            switchScreen('menu');
        },
    });

    const pauseMenu = createPauseMenu({
        onResume: () => resumeFromPause(),
        onSettings: () => {
            settingsReturnScreen = 'pause';
            switchScreen('settings');
        },
        onExit: () => exitToSongSelect(),
    });

    // UI 등록
    uiManager.registerScreen('menu', mainMenu);
    uiManager.registerScreen('songSelect', songSelect);
    uiManager.registerScreen('settings', settings);
    uiManager.registerScreen('pause', pauseMenu);
    uiManager.registerScreen('result', resultScreen);
    document.getElementById('ui-overlay')!.appendChild(gameHUD);

    /** 화면 전환 */
    const switchScreen = (screen: GameScreen): void => {
        engine.setScreen(screen);

        if (screen === 'playing') {
            uiManager.hideAll();
            gameHUD.toggle(true);
        } else {
            gameHUD.toggle(false);
            uiManager.showScreen(screen);
            countdownOverlay.hide();
        }

        // 설정 화면 진입 시 키 표시 갱신
        if (screen === 'settings' && 'refresh' in settings) {
            (settings as ReturnType<typeof createSettings> & { refresh: () => void }).refresh();
        }
    };

    /** 오디오 파일 선택 처리 */
    const handleFileSelect = async (file: File): Promise<void> => {
        try {
            currentYoutubeUrl = null; // Reset
            loadingOverlay.show();
            loadingOverlay.update('오디오 로딩 중...', 0.05);

            // 오디오 로드
            await audioManager.loadAudio(file);
            loadingOverlay.update('BPM 분석 시작...', 0.1);
            const loadedBuffer = audioManager.getBuffer();
            if (loadedBuffer) {
                loadingOverlay.setAnalysisBuffer(loadedBuffer);
            }

            // 난이도 가져오기
            const selectState = songSelect as ReturnType<typeof createSongSelect> & {
                getDifficulty: () => Difficulty;
                isInfiniteMode: () => boolean;
            };
            const diff = selectState.getDifficulty();
            currentDifficulty = diff;
            infiniteMode = selectState.isInfiniteMode();

            // 맵 생성
            const buffer = audioManager.getBuffer()!;
            currentMap = await generateMapFast(buffer, diff, (stage, progress) => {
                loadingOverlay.update(stage, progress);
            });

            loadingOverlay.hide();
            startGame();
        } catch (err) {
            loadingOverlay.hide();
            alert(`오디오 로드 실패: ${err instanceof Error ? err.message : '알 수 없는 오류'}`);
        }
    };

    /** YouTube URL 처리 */
    const handleYoutubeUrl = async (url: string): Promise<void> => {
        try {
            currentYoutubeUrl = normalizeYoutubeUrl(url); // Save for background
            loadingOverlay.show();
            loadingOverlay.update('YouTube 오디오 추출 중...', 0.05);

            const fetchYoutubeAudio = async (): Promise<ArrayBuffer> => {
                let lastErr: Error | null = null;
                for (let attempt = 0; attempt < 4; attempt++) {
                    let retryableError = true;
                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), 95000);
                    try {
                        const isAppleLike = /iPhone|iPad|iPod|Macintosh/i.test(navigator.userAgent);
                        const cookieHandle = getYoutubeCookieHandle();
                        const response = await fetch(apiUrl('/api/youtube/audio'), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                url: currentYoutubeUrl,
                                preferMp4Only: isAppleLike,
                                cookieHandle: cookieHandle || undefined,
                            }),
                            signal: controller.signal,
                        });
                        clearTimeout(timeout);
                        if (!response.ok) {
                            const errData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
                            const msg = errData.error || `오디오 추출 실패 (HTTP ${response.status})`;
                            const e = new Error(msg) as Error & { retryable?: boolean };
                            // 429(봇/로그인 차단)은 재시도해도 대부분 해결되지 않음 → 즉시 종료
                            e.retryable = response.status >= 500 || response.status === 408;
                            throw e;
                        }
                        const ct = (response.headers.get('content-type') || '').toLowerCase();
                        const ab = await response.arrayBuffer();
                        if (ab.byteLength < 1024) {
                            throw new Error('응답 데이터가 너무 작습니다 (손상된 오디오)');
                        }
                        // 오디오 MIME 검증 — JSON이 잘못 반환된 경우 필터링
                        if (ct.includes('application/json') || ct.includes('text/html')) {
                            const text = new TextDecoder().decode(ab.slice(0, 256));
                            throw new Error(`서버가 오디오 대신 텍스트를 반환: ${text.slice(0, 100)}`);
                        }
                        return ab;
                    } catch (error) {
                        clearTimeout(timeout);
                        lastErr = error instanceof Error ? error : new Error(String(error));
                        retryableError = !!((lastErr as Error & { retryable?: boolean }).retryable ?? true);
                    }
                    if (!retryableError) break;
                    if (attempt < 3) {
                        loadingOverlay.update(`YouTube 재시도 중... (${attempt + 2}/4)`, 0.06 + attempt * 0.04);
                        await new Promise(resolve => setTimeout(resolve, 800 + attempt * 600));
                    }
                }
                throw lastErr || new Error('오디오 추출 실패');
            };

            // 백엔드에서 오디오 가져오기 (재시도 포함)
            loadingOverlay.update('YouTube 오디오 추출 중...', 0.12);
            const arrayBuffer = await fetchYoutubeAudio();

            // 실제 디코딩은 fetch 완료 이후 시작됨
            loadingOverlay.update('오디오 디코딩 중...', 0.32);
            await audioManager.loadAudio(arrayBuffer);
            const loadedBuffer = audioManager.getBuffer();
            if (loadedBuffer) {
                loadingOverlay.setAnalysisBuffer(loadedBuffer);
            }

            // 맵 생성
            const selectState = songSelect as ReturnType<typeof createSongSelect> & {
                getDifficulty: () => Difficulty;
                isInfiniteMode: () => boolean;
            };
            const diff = selectState.getDifficulty();
            currentDifficulty = diff;
            infiniteMode = selectState.isInfiniteMode();
            const buffer = audioManager.getBuffer()!;
            loadingOverlay.update('맵 분석 준비 중...', 0.36);
            currentMap = await generateMapFast(buffer, diff, (stage, progress) => {
                loadingOverlay.update(stage, 0.3 + progress * 0.7);
            });

            loadingOverlay.hide();
            startGame();
        } catch (err: any) {
            loadingOverlay.hide();
            console.error(err);
            const message = err.message || '알 수 없는 오류';
            const lower = message.toLowerCase();
            const botGate = lower.includes('봇') || lower.includes('sign in') || lower.includes('captcha') || lower.includes('bot');
            if (botGate) {
                const details = document.getElementById('youtube-cookies-details') as HTMLDetailsElement | null;
                if (details) {
                    details.open = true;
                    try {
                        details.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    } catch {
                        // noop
                    }
                }
            }
            const hint = botGate
                ? '팁: 이건 YouTube가 서버(클라우드 IP)를 봇으로 판단한 케이스입니다. 다른 영상으로 시도하거나, 로컬 mp3를 사용하세요. (서버에 쿠키를 넣으면 성공률을 올릴 수 있음)'
                : '팁: YouTube는 차단/실패가 잦습니다. 로컬 mp3 파일을 선택하거나 드래그해서 플레이해보세요! (로컬 파일은 100% 됨)';
            alert(`YouTube 오디오 로드 실패.\n\n원인: ${message}\n\n${hint}`);
        }
    };

    /** 게임 시작 */
    const startGame = (): void => {
        if (!currentMap) return;

        // 초기화
        noteManager.setNotes(currentMap.notes);
        noteManager.setMapBpm(currentMap.bpm);
        noteManager.setDifficulty(currentDifficulty);
        if ('isAutoPlayEnabled' in gameHUD) {
            noteManager.setAutoPlay((gameHUD as ReturnType<typeof createGameHUD> & { isAutoPlayEnabled: () => boolean }).isAutoPlayEnabled());
        }
        scoreManager.reset(currentMap.totalNotes);
        effectManager.clear();
        hitStopTimer = 0;
        wasAirborneGuide = false;
        isPaused = false;
        isInInterlude = false;
        sectionCursor = 0;
        resetDynamicGameplayState();
        renderer.setBackgroundPaused(false);
        const selectedTheme = resolveBaseTheme(currentMap);
        baseTheme = selectedTheme;
        console.log('[ThemeSelect]', {
            mapTheme: currentMap.visualTheme,
            finalTheme: selectedTheme,
            bpm: currentMap.bpm,
            nps: (currentMap.totalNotes / Math.max(1, currentMap.duration)).toFixed(2),
        });
        logMapBalanceDiagnostics(currentMap, currentDifficulty);
        renderer.setTheme(baseTheme);
        setVideoPausedVisual(false);
        lastSustainPulseAt = -Infinity;
        audioManager.stop();
        audioManager.setPlaybackRate(1);

        character.setState('run', LANE_BOTTOM, 0.12);
        renderer.setBackgroundPaused(false);
        const startDrive = getCameraDriveAt(0);
        renderer.setMusicDrive(0, currentMap.bpm, startDrive.drive, startDrive.highlight, startDrive.motionMode);

        gameStarted = true;
        countdownActive = true;
        countdownAudioTriggered = false;
        countdownRemainingMs = 3000;
        countdownGoRemainingMs = 450;
        countdownOverlay.show('3');

        // 화면 전환
        switchScreen('playing');

        // YouTube 비디오 배경 재생
        renderer.setVideoBackground(!!currentYoutubeUrl);
        const videoBg = document.getElementById('video-background');
        console.log('Video Background Init:', { videoBg, currentYoutubeUrl });
        lastYoutubeSyncAudioTime = -Infinity;

        if (videoBg) {
            if (currentYoutubeUrl) {
                const videoId = extractYoutubeId(currentYoutubeUrl);
                if (videoId) {
                    videoBg.innerHTML = '';
                    const iframe = document.createElement('iframe');
                    const origin = window.location.origin;
                    iframe.src = `https://www.youtube.com/embed/${videoId}?autoplay=1&controls=0&mute=1&loop=1&playlist=${videoId}&playsinline=1&enablejsapi=1&origin=${encodeURIComponent(origin)}&widget_referrer=${encodeURIComponent(origin)}&rel=0&iv_load_policy=3`;
                    iframe.frameBorder = '0';
                    iframe.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
                    iframe.allowFullscreen = true;
                    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
                    iframe.style.width = '100%';
                    iframe.style.height = '100%';
                    iframe.style.objectFit = 'cover';
                    iframe.style.pointerEvents = 'none';
                    iframe.addEventListener('load', () => {
                        window.setTimeout(() => syncYoutubeVideoToAudio({ forceSeek: true, play: true }), 280);
                        window.setTimeout(() => syncYoutubeVideoToAudio({ forceSeek: true, play: true }), 920);
                        window.setTimeout(() => syncYoutubeVideoToAudio({ forceSeek: true, play: true }), 1520);
                    }, { once: true });
                    videoBg.appendChild(iframe);
                    console.log('Video Background Set:', videoId);
                    window.setTimeout(() => syncYoutubeVideoToAudio({ forceSeek: true, play: true }), 360);
                    window.setTimeout(() => syncYoutubeVideoToAudio({ forceSeek: true, play: true }), 980);
                    window.setTimeout(() => syncYoutubeVideoToAudio({ forceSeek: true, play: true }), 1680);
                } else {
                    console.warn('Invalid YouTube URL:', currentYoutubeUrl);
                }
            } else {
                videoBg.innerHTML = ''; // Clear if not youtube
            }
        }

    };

    const pauseGame = (): void => {
        if (!gameStarted || isPaused || failSequenceActive) return;
        isPaused = true;
        audioManager.pause();
        pauseYoutubeVideo();
        renderer.setBackgroundPaused(true);
        setVideoPausedVisual(true);
        switchScreen('pause');
    };

    const resumeFromPause = (): void => {
        if (!gameStarted || !isPaused) return;
        isPaused = false;
        switchScreen('playing');
        renderer.setBackgroundPaused(false);
        setVideoPausedVisual(false);
        audioManager.setPlaybackRate(1);
        if (!countdownActive || countdownAudioTriggered) {
            audioManager.resume();
        }
        syncYoutubeVideoToAudio({ forceSeek: true, play: true });
    };

    const exitToSongSelect = (): void => {
        isPaused = false;
        gameStarted = false;
        resetDynamicGameplayState();
        pauseYoutubeVideo();
        audioManager.stop();
        renderer.setBackgroundPaused(false);
        countdownOverlay.hide();
        setVideoPausedVisual(false);
        switchScreen('songSelect');
    };

    const restartInfiniteCycle = (): void => {
        if (!currentMap) return;
        resetDynamicGameplayState();
        noteManager.setNotes(currentMap.notes);
        noteManager.setMapBpm(currentMap.bpm);
        noteManager.setDifficulty(currentDifficulty);
        effectManager.clear();
        hitStopTimer = 0;
        wasAirborneGuide = false;
        isInInterlude = false;
        renderer.setBackgroundPaused(false);
        character.setMotionGuide(null);
        character.setState('run', LANE_BOTTOM, 0.1);
        audioManager.play(0);
    };

    /** 재시도 */
    const retryGame = (): void => {
        resetDynamicGameplayState();
        pauseYoutubeVideo();
        audioManager.stop();
        startGame();
    };

    /** 게임 종료 (곡 끝) */
    const endGame = (failed = false): void => {
        gameStarted = false;
        resetDynamicGameplayState();
        pauseYoutubeVideo();
        audioManager.stop();

        const scoreState = scoreManager.getState();
        resultScreen.show({
            score: scoreState.score,
            maxCombo: scoreState.maxCombo,
            accuracy: scoreManager.getAccuracy(),
            rank: scoreManager.getRank(),
            perfects: scoreState.perfects,
            greats: scoreState.greats,
            goods: scoreState.goods,
            misses: scoreState.misses,
            failed,
        });

        switchScreen('result');
    };

    // === 입력 처리 ===
    inputSystem.onPress((action) => {
        if (!gameStarted || isPaused || failSequenceActive || engine.getCurrentScreen() !== 'playing') return;
        if (countdownActive && countdownRemainingMs > 0) return;

        if (action === 'special') {
            const currentTime = audioManager.getCurrentTime();
            noteManager.registerBufferedPress(LANE_BOTTOM, currentTime);
            let specialResult = noteManager.tryJudge(LANE_BOTTOM, currentTime);
            if (!specialResult) {
                noteManager.registerBufferedPress(LANE_TOP, currentTime);
                specialResult = noteManager.tryJudge(LANE_TOP, currentTime);
            }
            if (specialResult) {
                noteManager.clearBufferedPress(LANE_BOTTOM);
                noteManager.clearBufferedPress(LANE_TOP);
            }
            return;
        }

        const lane = action === 'laneTop' ? 0 : action === 'laneBottom' ? 1 : -1;
        if (lane === -1) return;

        const currentTime = audioManager.getCurrentTime();
        noteManager.registerBufferedPress(lane, currentTime);
        const result = noteManager.tryJudge(lane, currentTime);
        if (result) {
            noteManager.clearBufferedPress(lane);
        }

        // 판정이 없을 때만 기본 입력 피드백
        if (!result) {
            character.setState(lane === 0 ? 'attack_top' : 'attack_bottom', lane);
        }
    });

    // 키 릴리즈 처리 (롱노트/슬라이드 판정)
    inputSystem.onRelease((action) => {
        if (!gameStarted || isPaused || failSequenceActive || engine.getCurrentScreen() !== 'playing') return;
        if (countdownActive && countdownRemainingMs > 0) return;

        const lane = action === 'laneTop' ? 0 : action === 'laneBottom' ? 1 : -1;
        if (lane === -1) return;

        const currentTime = audioManager.getCurrentTime();
        noteManager.clearBufferedPress(lane);
        const bindings = inputSystem.getBindings();
        const topHeld = inputSystem.isKeyPressed(bindings.laneTop);
        const bottomHeld = inputSystem.isKeyPressed(bindings.laneBottom);
        noteManager.releaseHold(lane, currentTime, [topHeld, bottomHeld]);
    });

    // 곡 종료 콜백 (AudioManager onEnded)
    audioManager.onEnded(() => {
        if (gameStarted) {
            if (failSequenceActive) return;
            if (infiniteMode && !isPaused && engine.getCurrentScreen() === 'playing') {
                restartInfiniteCycle();
                return;
            }
            songEndRequestedAt = performance.now();
            character.setState('run', LANE_BOTTOM, 0.2);
            renderer.setBackgroundPaused(false);
            isInInterlude = false;
        }
    });

    // 판정 콜백 (오토플레이 + 자동 미스 모두 처리)
    noteManager.onJudge((result: JudgeResult, note, meta) => {
        const isLongNote = (note.type === 'slide' || note.type === 'hold') && !!note.duration && note.duration > 0.4;
        const isBurstNote = note.type === 'burst';
        const isSustainTick = !!meta?.sustainTick;
        if (isSustainTick) {
            const sustainComboEligible = (meta?.phase === 'tick')
                && (note.type === 'slide' || note.type === 'hold');
            scoreManager.addSustainTick({ countCombo: sustainComboEligible });
            const now = audioManager.getCurrentTime();
            if (now - lastSustainPulseAt >= 0.085) {
                renderer.triggerBeatPulse();
                lastSustainPulseAt = now;
            }
            const judgeX = CANVAS_WIDTH * JUDGE_LINE_X;
            const yRatio = Math.max(0, Math.min(1, meta?.tickYRatio ?? (note.lane === LANE_TOP ? 1 : 0)));
            const y = lerp(CANVAS_HEIGHT * LANE_BOTTOM_Y, CANVAS_HEIGHT * LANE_TOP_Y, yRatio);
            const tickLane = meta?.tickLane ?? (yRatio >= 0.5 ? LANE_TOP : LANE_BOTTOM);
            effectManager.spawnHitEffect(judgeX, y, 'perfect', tickLane);
            const sustainComboBoost = 1 + Math.min(0.28, scoreManager.getState().combo / 220);
            renderer.triggerCameraBeat(tickLane, 0.42 * sustainComboBoost, 'sustain');
            return;
        }

        // 일반 판정 점수 반영
        scoreManager.addJudge(result);
        const postJudgeState = scoreManager.getState();
        const comboBoost = 1 + Math.min(0.65, Math.floor(postJudgeState.combo / 25) * 0.08);

        // 캐릭터 애니메이션
        if (isBurstNote) {
            if (result === 'miss') {
                character.setState('miss', undefined);
            } else {
                character.setState('perfect', LANE_BOTTOM);
                hitStopTimer = result === 'perfect' ? 0.009 : 0.006;
            }
        } else if (result === 'perfect' && isLongNote) {
            // 롱노트는 상/하단 모두 체공 유지
            const laneHint = note.targetLane ?? note.lane;
            character.setState('jump', laneHint, Math.max(0.25, note.duration!));
            hitStopTimer = 0.006;
        } else if (result === 'perfect') {
            character.setState('perfect', note.lane);
            hitStopTimer = 0.008;
        } else if (result === 'miss') {
            // Miss: Do not pass lane to prevent jumping
            character.setState('miss', undefined);
        } else {
            if (isLongNote) {
                const laneHint = note.targetLane ?? note.lane;
                character.setState('jump', laneHint, 0.2);
            } else {
                character.setState(note.lane === 0 ? 'attack_top' : 'attack_bottom', note.lane);
            }
        }

        // 이펙트 (미스 제외한 히트 이펙트)
        if (result !== 'miss') {
            const judgeX = CANVAS_WIDTH * JUDGE_LINE_X;
            const y = isBurstNote
                ? lerp(CANVAS_HEIGHT * LANE_TOP_Y, CANVAS_HEIGHT * LANE_BOTTOM_Y, 0.5)
                : note.lane === 0
                ? CANVAS_HEIGHT * LANE_TOP_Y
                : CANVAS_HEIGHT * LANE_BOTTOM_Y;
        const laneForFx = isBurstNote ? LANE_BOTTOM : note.lane;
        effectManager.spawnHitEffect(judgeX, y, result, laneForFx);
        if (isBurstNote && meta?.phase === 'burst') {
            const hitsDone = meta?.burstHitsDone ?? 0;
            const hitsReq = Math.max(1, meta?.burstHitsRequired ?? 1);
            if (hitsDone >= hitsReq) {
                effectManager.spawnSpecialSuccessEffect(judgeX, y);
            }
        }

            if (result === 'perfect' || result === 'great') {
                renderer.triggerBeatPulse();
                renderer.triggerHitShake(laneForFx, result === 'perfect' ? 12 : 6);
            }
            renderer.triggerCameraBeat(
                laneForFx,
                (result === 'perfect' ? 1 : result === 'great' ? 0.72 : 0.52) * comboBoost,
                'hit'
            );
        } else {
            // 미스 이펙트
            const judgeX = CANVAS_WIDTH * JUDGE_LINE_X;
            const y = isBurstNote
                ? lerp(CANVAS_HEIGHT * LANE_TOP_Y, CANVAS_HEIGHT * LANE_BOTTOM_Y, 0.5)
                : note.lane === 0
                ? CANVAS_HEIGHT * LANE_TOP_Y
                : CANVAS_HEIGHT * LANE_BOTTOM_Y;
            const laneForFx = isBurstNote ? LANE_BOTTOM : note.lane;
            effectManager.spawnHitEffect(judgeX, y, 'miss', laneForFx);
            renderer.triggerCameraBeat(laneForFx, 0.42 * comboBoost, 'hit');
        }
    });

    // === 게임 루프 등록 ===
    engine.onUpdate((dt) => {
        if (engine.getCurrentScreen() !== 'playing' || !gameStarted) return;

        if (countdownActive) {
            const safeDt = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.1)) : (1 / 60);
            const countdownStepMs = safeDt * 1000;
            if (countdownRemainingMs > 0) {
                countdownRemainingMs = Math.max(0, countdownRemainingMs - countdownStepMs);
                const remainSec = Math.max(1, Math.ceil(countdownRemainingMs / 1000));
                countdownOverlay.show(String(remainSec));
            }

            if (!countdownAudioTriggered && countdownRemainingMs <= 0) {
                countdownAudioTriggered = true;
                audioManager.play(0, 0.3);
                syncYoutubeVideoToAudio({ forceSeek: true, play: true });
                countdownOverlay.show('GO!');
            }

            if (countdownRemainingMs > 0) {
                const preRollTime = -countdownRemainingMs / 1000;
                noteManager.update(preRollTime, dt);
                renderer.updateBeatPulse(dt * 0.45);
                character.setMotionGuide(null);
                renderer.setGameplayMotion(null, false);
                character.update(dt);
                effectManager.update(dt * 0.5);
                const countdownState = scoreManager.getState();
                gameHUD.update(
                    countdownState.score,
                    countdownState.combo,
                    scoreManager.getAccuracy(),
                    audioManager.getProgress(),
                    countdownState.hp
                );
                return;
            }

            countdownGoRemainingMs = Math.max(0, countdownGoRemainingMs - countdownStepMs);
            if (countdownGoRemainingMs <= 0) {
                countdownActive = false;
                countdownOverlay.hide();
            }
        }

        if (hitStopTimer > 0) {
            hitStopTimer -= dt;
            renderer.updateBeatPulse(dt);
        }

        let currentTime = audioManager.getCurrentTime();
        if (songEndRequestedAt > 0 && !audioManager.isPlaying()) {
            currentTime += Math.max(0, (performance.now() - songEndRequestedAt) / 1000);
        }
        if (currentYoutubeUrl) {
            syncYoutubeVideoToAudio();
        }
        const preState = scoreManager.getState();
        applyComboDynamics(preState.combo, currentTime);
        if (!failSequenceActive && preState.hp <= 0) {
            beginFailSequence();
        }

        if (failSequenceActive) {
            failSequenceTimer -= dt;
            const failDt = dt * 0.38;
            renderer.updateBeatPulse(failDt);
            character.setMotionGuide(null);
            renderer.setGameplayMotion(null, false);
            character.update(failDt * 0.72);
            effectManager.update(failDt * 0.72);

            const scoreState = scoreManager.getState();
            gameHUD.update(
                scoreState.score,
                scoreState.combo,
                scoreManager.getAccuracy(),
                audioManager.getProgress(),
                scoreState.hp
            );

            if (failSequenceTimer <= 0) {
                endGame(true);
            }
            return;
        }

        // === 간주(interlude) 감지 ===
        const wasInInterlude = isInInterlude;
        isInInterlude = songEndRequestedAt > 0 ? false : checkInterlude(currentTime);

        // 간주 상태 전환 시 처리
        if (isInInterlude && !wasInInterlude) {
            // 간주 시작 → 캐릭터 idle, 배경 정지
            character.setState('idle', undefined, 999);
            renderer.setBackgroundPaused(true);
        } else if (!isInInterlude && wasInInterlude) {
            // 간주 끝 → 캐릭터 달리기, 배경 재개
            character.setState('run', LANE_BOTTOM, 0.2);
            renderer.setBackgroundPaused(false);
        }

        // 렌더러 비트 펄스 업데이트
        renderer.updateBeatPulse(dt);

        // 간주 중에는 캐릭터 idle만 업데이트 (달리지 않음)
        if (isInInterlude) {
            // idle 상태 유지 (최소 업데이트만)
            character.setMotionGuide(null);
            renderer.setGameplayMotion(null, false);
            const drive = getCameraDriveAt(currentTime);
            renderer.setMusicDrive(currentTime, currentMap?.bpm ?? 120, drive.drive, drive.highlight, drive.motionMode);
            wasAirborneGuide = false;
            character.update(dt);

            // 노트 업데이트는 계속 (화면 밖 노트 정리용)
            noteManager.update(currentTime, dt);
            effectManager.update(dt);

            // HUD 업데이트
            const scoreState = scoreManager.getState();
            gameHUD.update(
                scoreState.score,
                scoreState.combo,
                scoreManager.getAccuracy(),
                audioManager.getProgress(),
                scoreState.hp
            );

            // 곡 종료 체크
            if (!infiniteMode && !audioManager.isPlaying() && audioManager.getProgress() >= 0.98 && gameStarted && songEndRequestedAt < 0) {
                endGame();
            }
            return;
        }

        // 노트 업데이트
        noteManager.update(currentTime, dt);
        const drive = getCameraDriveAt(currentTime);
        renderer.setMusicDrive(currentTime, currentMap?.bpm ?? 120, drive.drive, drive.highlight, drive.motionMode);

        // 홀드/슬라이드 상태 체크 (매 프레임 키 누름 상태 전달)
        const bindings = inputSystem.getBindings();
        const topHeld = inputSystem.isKeyPressed(bindings.laneTop);
        const bottomHeld = inputSystem.isKeyPressed(bindings.laneBottom);
        noteManager.updateHoldState([topHeld, bottomHeld], currentTime);

        // 슬라이드/롱노트 진행 중에는 캐릭터가 노트 경로를 추적
        const motionGuide = noteManager.getCharacterMotionGuide(currentTime);
        character.setMotionGuide(motionGuide ? motionGuide.yRatio : null);
        renderer.setGameplayMotion(motionGuide ? motionGuide.yRatio : null, !!motionGuide?.airborne);
        if (motionGuide?.airborne && !wasAirborneGuide) {
            character.setState('jump', undefined, 0.12);
        } else if (!motionGuide?.airborne && wasAirborneGuide) {
            character.setState('land', undefined, 0.1);
        }
        wasAirborneGuide = !!motionGuide?.airborne;

        // 캐릭터 업데이트
        character.update(dt);

        // 이펙트 업데이트
        effectManager.update(dt);

        // HUD 업데이트
        const scoreState = scoreManager.getState();
        gameHUD.update(
            scoreState.score,
            scoreState.combo,
            scoreManager.getAccuracy(),
            audioManager.getProgress(),
            scoreState.hp
        );

        // 곡 종료 체크 (onEnded 콜백이 메인이지만 폴백도 유지)
        if (!failSequenceActive && !infiniteMode && !audioManager.isPlaying() && audioManager.getProgress() >= 0.98 && gameStarted && songEndRequestedAt < 0) {
            endGame();
        }

        if (!failSequenceActive && !infiniteMode && gameStarted && songEndRequestedAt > 0) {
            if (performance.now() - songEndRequestedAt >= 3000) {
                endGame();
            }
        }
    });

    engine.onRender((ctx) => {
        const screen = engine.getCurrentScreen();
        const dt = engine.getState().deltaTime;

        // 클리어는 항상 화면 좌표계에서 수행 (카메라 변환 영향 제거).
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        ctx.restore();

        if (screen === 'playing' && gameStarted) {
            // 배경/도로는 틸트를 제외한 카메라만 적용해 진행축 왜곡을 방지
            ctx.save();
            const cam = renderer.getGameplayCamera();
            syncVideoCameraTransform(cam);
            ctx.translate(CANVAS_WIDTH * 0.5 + cam.x, CANVAS_HEIGHT * 0.5 + cam.y);
            ctx.scale(cam.zoom, cam.zoom);
            ctx.translate(-CANVAS_WIDTH * 0.5, -CANVAS_HEIGHT * 0.5);

            renderer.renderBackground(ctx, dt);
            ctx.restore();

            // 판정/노트/캐릭터 레이어에만 틸트 적용
            ctx.save();
            ctx.translate(CANVAS_WIDTH * 0.5 + cam.x, CANVAS_HEIGHT * 0.5 + cam.y);
            ctx.rotate(cam.tilt);
            ctx.scale(cam.zoom, cam.zoom);
            ctx.translate(-CANVAS_WIDTH * 0.5, -CANVAS_HEIGHT * 0.5);

            // 레인 (Renderer 내부에서 Shake 적용됨)
            renderer.renderLanes(ctx);

            // 다른 게임플레이 요소에도 Shake 적용
            const shake = renderer.getShake();
            ctx.save();
            ctx.translate(shake.x, shake.y);

            noteManager.render(ctx);
            character.render(ctx);
            effectManager.render(ctx);

            ctx.restore();
            ctx.restore();

            renderer.renderScreenOverlay(ctx);
            return;
        }

        // 비플레이 화면은 기존 렌더
        syncVideoCameraTransform(null);
        renderer.renderBackground(ctx, dt);
        renderer.renderScreenOverlay(ctx);
    });

    // === ESC 키 처리 ===
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const screen = engine.getCurrentScreen();
            if (screen === 'playing') {
                pauseGame();
            } else if (screen === 'pause') {
                resumeFromPause();
            } else if (screen === 'settings' && settingsReturnScreen === 'pause') {
                switchScreen('pause');
            } else if (screen === 'songSelect' || screen === 'settings' || screen === 'result') {
                switchScreen('menu');
            }
        }
    });

    // === 시작 ===
    inputSystem.init();
    engine.start();
    switchScreen('menu');
};

/** 로딩 오버레이 생성 */
const createLoadingOverlay = () => {
    const element = document.createElement('div');
    element.className = 'loading-overlay hidden';
    element.innerHTML = `
    <div class="loading__text" id="loading-text">로딩 중...</div>
    <div class="loading__viz">
      <canvas class="loading__canvas" id="loading-canvas" width="960" height="220"></canvas>
      <div class="loading__status" id="loading-status">분석 대기 중...</div>
    </div>
    <div class="loading__bar">
      <div class="loading__fill" id="loading-fill"></div>
    </div>
  `;

    const textEl = element.querySelector('#loading-text')!;
    const fillEl = element.querySelector('#loading-fill') as HTMLElement;
    const statusEl = element.querySelector('#loading-status') as HTMLElement;
    const canvas = element.querySelector('#loading-canvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');

    let stageText = '로딩 중...';
    let progressValue = 0;
    let progressTarget = 0;
    let progressDisplay = 0;
    let lastProgressUpdateAt = performance.now();
    let lastFrameAt = performance.now();
    let visible = false;
    let rafId = 0;
    let hasEnvelope = false;
    let envelope = new Float32Array(360);
    let bandLow = new Float32Array(360);
    let bandMid = new Float32Array(360);
    let bandHigh = new Float32Array(360);
    let lowHits = new Float32Array(360);
    let midHits = new Float32Array(360);
    let highHits = new Float32Array(360);
    let envelopePeak = 0;
    let envelopeRms = 0;
    let lowLevel = 0;
    let midLevel = 0;
    let highLevel = 0;
    let lowHitCount = 0;
    let midHitCount = 0;
    let highHitCount = 0;

    const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
    const isAnalysisStage = (text: string): boolean =>
        /(분석|BPM|비트|주파수|노트 배치|정렬|맵 생성)/.test(text);
    const getStageSoftCap = (text: string, target: number): number => {
        if (/완료|로딩 완료/.test(text)) return 1;
        if (/BPM/.test(text)) return Math.max(target, 0.18);
        if (/비트 그리드/.test(text)) return Math.max(target, 0.29);
        if (/음파 분석|Onset/.test(text)) return Math.max(target, 0.6);
        if (/비트 정렬/.test(text)) return Math.max(target, 0.68);
        if (/주파수 분석/.test(text)) return Math.max(target, 0.78);
        if (/곡 구조 분석/.test(text)) return Math.max(target, 0.86);
        if (/노트 배치/.test(text)) return Math.max(target, 0.94);
        if (/난이도 조정/.test(text)) return Math.max(target, 0.96);
        return Math.max(target, Math.min(0.97, target + 0.07));
    };
    const detectBandHits = (
        arr: Float32Array,
        baseThreshold: number,
        riseThreshold: number,
        refractory: number,
    ): Float32Array => {
        const hits = new Float32Array(arr.length);
        let lastHit = -refractory;
        for (let i = 1; i < arr.length - 1; i++) {
            if (i - lastHit < refractory) continue;
            const prev = arr[i - 1];
            const curr = arr[i];
            const next = arr[i + 1];
            const rise = curr - prev;
            const prominence = curr - (prev + next) * 0.5;
            if (
                curr >= baseThreshold &&
                curr >= next &&
                rise >= riseThreshold &&
                prominence >= riseThreshold * 0.7
            ) {
                hits[i] = clamp01(prominence * 2.3 + rise * 1.5 + curr * 0.08);
                lastHit = i;
            }
        }
        return hits;
    };

    const setAnalysisBuffer = (buffer: AudioBuffer): void => {
        const pointCount = 360;
        const out = new Float32Array(pointCount);
        const outLow = new Float32Array(pointCount);
        const outMid = new Float32Array(pointCount);
        const outHigh = new Float32Array(pointCount);
        const length = buffer.length;
        if (length <= 0) return;
        const ch0 = buffer.getChannelData(0);
        const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;

        let globalMax = 0;
        let globalRmsAcc = 0;
        let globalCount = 0;
        let lowAcc = 0;
        let midAcc = 0;
        let highAcc = 0;
        let lowMax = 0;
        let midMax = 0;
        let highMax = 0;
        let lpSlow = 0;
        let lpFast = 0;
        let prev = 0;

        for (let i = 0; i < pointCount; i++) {
            const start = Math.floor((i / pointCount) * length);
            const end = Math.min(length, Math.floor(((i + 1) / pointCount) * length));
            const span = Math.max(1, end - start);
            const step = Math.max(1, Math.floor(span / 96));

            let localPeak = 0;
            let localSq = 0;
            let localTransient = 0;
            let localLow = 0;
            let localMid = 0;
            let localHigh = 0;
            let localCount = 0;
            for (let p = start; p < end; p += step) {
                const s0 = ch0[p] || 0;
                const s = ch1 ? (s0 + (ch1[p] || 0)) * 0.5 : s0;
                const abs = Math.abs(s);
                if (abs > localPeak) localPeak = abs;
                localSq += s * s;
                localTransient += Math.abs(s - prev);
                prev = s;

                lpSlow += (s - lpSlow) * 0.035;
                lpFast += (s - lpFast) * 0.18;
                const low = Math.abs(lpSlow);
                const mid = Math.abs(lpFast - lpSlow);
                const high = Math.abs(s - lpFast);
                localLow += low;
                localMid += mid;
                localHigh += high;
                localCount++;
            }
            const inv = localCount > 0 ? 1 / localCount : 1;
            const localRms = Math.sqrt(localSq * inv);
            const lowVal = Math.min(1, localLow * inv * 4.2);
            const midVal = Math.min(1, localMid * inv * 5.4);
            const highVal = Math.min(1, localHigh * inv * 6.4);
            const transientVal = Math.min(1, localTransient * inv * 3.1);
            const value = Math.min(1, localRms * 2.6 + transientVal * 0.34 + midVal * 0.24 + highVal * 0.14);

            out[i] = value;
            outLow[i] = lowVal;
            outMid[i] = midVal;
            outHigh[i] = highVal;

            globalMax = Math.max(globalMax, localPeak);
            globalRmsAcc += localRms;
            lowAcc += lowVal;
            midAcc += midVal;
            highAcc += highVal;
            lowMax = Math.max(lowMax, lowVal);
            midMax = Math.max(midMax, midVal);
            highMax = Math.max(highMax, highVal);
            globalCount++;
        }

        const smooth = (arr: Float32Array): void => {
            for (let i = 1; i < arr.length - 1; i++) {
                arr[i] = arr[i] * 0.55 + arr[i - 1] * 0.225 + arr[i + 1] * 0.225;
            }
        };
        smooth(out);
        smooth(outLow);
        smooth(outMid);
        smooth(outHigh);

        const normalize = (arr: Float32Array, maxValue: number): Float32Array => {
            if (maxValue <= 1e-4) return arr;
            const inv = 1 / (maxValue * 1.02);
            for (let i = 0; i < arr.length; i++) {
                arr[i] = clamp01(arr[i] * inv);
            }
            return arr;
        };
        normalize(outLow, lowMax);
        normalize(outMid, midMax);
        normalize(outHigh, highMax);

        const avgLow = clamp01(globalCount > 0 ? lowAcc / globalCount : 0);
        const avgMid = clamp01(globalCount > 0 ? midAcc / globalCount : 0);
        const avgHigh = clamp01(globalCount > 0 ? highAcc / globalCount : 0);
        const lowThreshold = clamp01(0.22 + avgLow * 0.45);
        const midThreshold = clamp01(0.2 + avgMid * 0.42);
        const highThreshold = clamp01(0.18 + avgHigh * 0.4);
        const lowHitArr = detectBandHits(outLow, lowThreshold, 0.035, 6);
        const midHitArr = detectBandHits(outMid, midThreshold, 0.03, 4);
        const highHitArr = detectBandHits(outHigh, highThreshold, 0.026, 3);

        envelope = out;
        bandLow = outLow;
        bandMid = outMid;
        bandHigh = outHigh;
        if (lowHits.length !== pointCount) lowHits = new Float32Array(pointCount);
        if (midHits.length !== pointCount) midHits = new Float32Array(pointCount);
        if (highHits.length !== pointCount) highHits = new Float32Array(pointCount);
        lowHits.set(lowHitArr);
        midHits.set(midHitArr);
        highHits.set(highHitArr);
        hasEnvelope = true;
        envelopePeak = clamp01(globalMax);
        envelopeRms = clamp01(globalCount > 0 ? globalRmsAcc / globalCount : 0);
        lowLevel = avgLow;
        midLevel = avgMid;
        highLevel = avgHigh;
        lowHitCount = lowHits.reduce((acc, v) => acc + (v > 0 ? 1 : 0), 0);
        midHitCount = midHits.reduce((acc, v) => acc + (v > 0 ? 1 : 0), 0);
        highHitCount = highHits.reduce((acc, v) => acc + (v > 0 ? 1 : 0), 0);
    };

    const drawAnalysis = (): void => {
        if (!ctx) return;
        const w = canvas.width;
        const h = canvas.height;
        const nowMs = performance.now();
        const dt = Math.max(0.001, Math.min(0.1, (nowMs - lastFrameAt) / 1000));
        lastFrameAt = nowMs;
        const stalledSec = (nowMs - lastProgressUpdateAt) / 1000;
        const stageCap = getStageSoftCap(stageText, progressTarget);
        let desiredProgress = progressTarget;
        if (isAnalysisStage(stageText) && stalledSec > 0.22) {
            const creep = dt * (0.035 + Math.min(0.07, stalledSec * 0.015));
            desiredProgress = Math.min(stageCap, Math.max(progressTarget, progressDisplay + creep));
        }
        const smoothing = 1 - Math.exp(-dt * 9);
        progressDisplay += (desiredProgress - progressDisplay) * smoothing;
        if (progressTarget >= 0.999) {
            progressDisplay = 1;
        }
        progressValue = clamp01(progressDisplay);
        fillEl.style.width = `${Math.round(progressValue * 100)}%`;

        const t = nowMs * 0.001;
        const p = clamp01(progressValue);
        const scanX = p * w;

        ctx.clearRect(0, 0, w, h);

        const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
        bgGrad.addColorStop(0, 'rgba(16, 28, 56, 0.96)');
        bgGrad.addColorStop(1, 'rgba(7, 12, 28, 0.96)');
        ctx.fillStyle = bgGrad;
        ctx.fillRect(0, 0, w, h);

        // grid
        ctx.strokeStyle = 'rgba(120, 180, 255, 0.08)';
        ctx.lineWidth = 1;
        for (let x = 0; x <= w; x += 40) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
            ctx.stroke();
        }
        for (let y = 0; y <= h; y += 28) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }

        // waveform
        const centerY = h * 0.55;
        const amp = h * 0.36;
        ctx.save();
        ctx.beginPath();
        for (let i = 0; i < envelope.length; i++) {
            const x = (i / (envelope.length - 1)) * w;
            const base = hasEnvelope
                ? envelope[i]
                : (0.2 + Math.sin(t * 2.2 + i * 0.09) * 0.08 + Math.sin(t * 4.1 + i * 0.04) * 0.05);
            const y = centerY - base * amp;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        for (let i = envelope.length - 1; i >= 0; i--) {
            const x = (i / (envelope.length - 1)) * w;
            const base = hasEnvelope
                ? envelope[i] * 0.7
                : (0.14 + Math.sin(t * 2.8 + i * 0.08) * 0.06);
            const y = centerY + base * amp * 0.78;
            ctx.lineTo(x, y);
        }
        ctx.closePath();
        const waveFill = ctx.createLinearGradient(0, centerY - amp, 0, centerY + amp);
        waveFill.addColorStop(0, 'rgba(85, 194, 255, 0.34)');
        waveFill.addColorStop(1, 'rgba(85, 194, 255, 0.05)');
        ctx.fillStyle = waveFill;
        ctx.fill();
        ctx.restore();

        ctx.beginPath();
        for (let i = 0; i < envelope.length; i++) {
            const x = (i / (envelope.length - 1)) * w;
            const base = hasEnvelope
                ? envelope[i]
                : (0.22 + Math.sin(t * 2.5 + i * 0.09) * 0.08);
            const y = centerY - base * amp;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = 'rgba(96, 218, 255, 0.95)';
        ctx.lineWidth = 2.2;
        ctx.shadowColor = 'rgba(96, 218, 255, 0.6)';
        ctx.shadowBlur = 8;
        ctx.stroke();
        ctx.shadowBlur = 0;

        // low/mid/high line overlays (실시간 악기 성향 시각화)
        const drawBandLine = (arr: Float32Array, color: string, width: number, yScale: number, yOffset: number) => {
            ctx.beginPath();
            for (let i = 0; i < arr.length; i++) {
                const x = (i / (arr.length - 1)) * w;
                const v = hasEnvelope ? arr[i] : 0.2;
                const y = yOffset - v * yScale;
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.strokeStyle = color;
            ctx.lineWidth = width;
            ctx.stroke();
        };
        const bandBaseY = h * 0.36;
        drawBandLine(bandLow, 'rgba(255, 214, 88, 0.92)', 1.5, h * 0.12, bandBaseY + 18);
        drawBandLine(bandMid, 'rgba(113, 252, 162, 0.92)', 1.5, h * 0.13, bandBaseY + 10);
        drawBandLine(bandHigh, 'rgba(118, 205, 255, 0.96)', 1.6, h * 0.15, bandBaseY + 2);
        const drawBandHits = (
            arr: Float32Array,
            color: string,
            baselineY: number,
            shape: 'circle' | 'diamond' | 'spike',
        ) => {
            for (let i = 0; i < arr.length; i++) {
                const intensity = arr[i];
                if (intensity <= 0) continue;
                const x = (i / (arr.length - 1)) * w;
                const nearScan = 1 - Math.min(1, Math.abs(x - scanX) / 128);
                const size = 2 + intensity * 2.8 + nearScan * 1.4;
                const alpha = clamp01(0.22 + intensity * 0.62 + nearScan * 0.18);
                ctx.fillStyle = color.replace('0.95', alpha.toFixed(3)).replace('0.9)', `${alpha.toFixed(3)})`);
                ctx.strokeStyle = `rgba(255,255,255,${Math.min(0.9, alpha * 0.8).toFixed(3)})`;
                ctx.lineWidth = 1;
                if (shape === 'circle') {
                    ctx.beginPath();
                    ctx.arc(x, baselineY, size, 0, Math.PI * 2);
                    ctx.fill();
                } else if (shape === 'diamond') {
                    ctx.beginPath();
                    ctx.moveTo(x, baselineY - size);
                    ctx.lineTo(x + size * 0.9, baselineY);
                    ctx.lineTo(x, baselineY + size);
                    ctx.lineTo(x - size * 0.9, baselineY);
                    ctx.closePath();
                    ctx.fill();
                    ctx.stroke();
                } else {
                    ctx.beginPath();
                    ctx.moveTo(x, baselineY - size * 1.4);
                    ctx.lineTo(x + size * 0.7, baselineY + size * 0.25);
                    ctx.lineTo(x - size * 0.7, baselineY + size * 0.25);
                    ctx.closePath();
                    ctx.fill();
                }
            }
        };
        drawBandHits(lowHits, 'rgba(255, 208, 102, 0.95)', h * 0.78, 'circle');
        drawBandHits(midHits, 'rgba(123, 250, 171, 0.95)', h * 0.69, 'diamond');
        drawBandHits(highHits, 'rgba(123, 214, 255, 0.95)', h * 0.6, 'spike');

        // scan line
        const scan = ctx.createLinearGradient(scanX - 24, 0, scanX + 24, 0);
        scan.addColorStop(0, 'rgba(255,255,255,0)');
        scan.addColorStop(0.5, 'rgba(255,255,255,0.85)');
        scan.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = scan;
        ctx.fillRect(scanX - 24, 0, 48, h);

        // pseudo spectrum bars
        const bars = 56;
        const barW = w / bars;
        const focus = Math.max(0, Math.min(envelope.length - 1, Math.floor(p * (envelope.length - 1))));
        for (let i = 0; i < bars; i++) {
            const envIdx = Math.max(0, Math.min(envelope.length - 1, focus + i - Math.floor(bars / 2)));
            const env = hasEnvelope ? envelope[envIdx] : 0.25;
            const wobble = (Math.sin(t * 9 + i * 0.4) + 1) * 0.5;
            const barH = (0.12 + env * 0.58 + wobble * 0.28) * h * 0.34;
            const x = i * barW + 1;
            const y = h - barH - 8;
            ctx.fillStyle = `rgba(255, 170, 90, ${0.16 + env * 0.35})`;
            ctx.fillRect(x, y, Math.max(1, barW - 2), barH);
        }

        const pct = Math.round(p * 100);
        const mode = isAnalysisStage(stageText) ? '실시간 분석중' : '준비중';
        statusEl.textContent = `${mode} · ${pct}% · RMS ${Math.round(envelopeRms * 100)} · PEAK ${Math.round(envelopePeak * 100)} · L ${Math.round(lowLevel * 100)} / M ${Math.round(midLevel * 100)} / H ${Math.round(highLevel * 100)} · HIT ${lowHitCount}/${midHitCount}/${highHitCount}`;
    };

    const loop = (): void => {
        if (!visible) return;
        drawAnalysis();
        rafId = requestAnimationFrame(loop);
    };

    const show = (): void => {
        if (!visible) {
            progressTarget = 0;
            progressDisplay = 0;
            progressValue = 0;
            lastProgressUpdateAt = performance.now();
            lastFrameAt = lastProgressUpdateAt;
            fillEl.style.width = '0%';
            statusEl.textContent = '분석 대기 중...';
        }
        visible = true;
        element.classList.remove('hidden');
        if (!rafId) {
            rafId = requestAnimationFrame(loop);
        }
    };

    const hide = (): void => {
        visible = false;
        element.classList.add('hidden');
        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = 0;
        }
    };

    return {
        element,
        show,
        hide,
        setAnalysisBuffer,
        update: (text: string, progress: number) => {
            stageText = text;
            const clamped = clamp01(progress);
            if (clamped < progressTarget - 0.18) {
                progressTarget = clamped;
                progressDisplay = Math.min(progressDisplay, clamped);
            } else {
                progressTarget = Math.max(progressTarget, clamped);
            }
            lastProgressUpdateAt = performance.now();
            textEl.textContent = text;
        },
    };
};

const createCountdownOverlay = () => {
    const element = document.createElement('div');
    element.style.position = 'fixed';
    element.style.left = '50%';
    element.style.top = '34%';
    element.style.transform = 'translate(-50%, -50%)';
    element.style.zIndex = '60';
    element.style.pointerEvents = 'none';
    element.style.display = 'none';
    element.style.alignItems = 'center';
    element.style.justifyContent = 'center';
    element.style.minWidth = '220px';
    element.style.padding = '14px 28px';
    element.style.borderRadius = '18px';
    element.style.background = 'radial-gradient(circle at 50% 40%, rgba(24,18,34,0.78), rgba(24,18,34,0.15))';
    element.style.backdropFilter = 'blur(3px)';

    const text = document.createElement('div');
    text.style.fontFamily = 'Orbitron, Exo 2, system-ui, sans-serif';
    text.style.fontWeight = '900';
    text.style.fontSize = '110px';
    text.style.lineHeight = '1';
    text.style.letterSpacing = '0.03em';
    text.style.color = '#fff';
    text.style.textShadow = '0 0 20px rgba(255,214,86,0.72), 0 0 44px rgba(255,214,86,0.35)';
    text.textContent = '3';

    element.appendChild(text);

    const show = (label: string): void => {
        text.textContent = label;
        text.style.fontSize = label === 'GO!' ? '96px' : '110px';
        element.style.display = 'flex';
    };

    const hide = (): void => {
        element.style.display = 'none';
    };

    return { element, show, hide };
};

const createGameOverOverlay = () => {
    const element = document.createElement('div');
    element.className = 'game-over-overlay hidden';
    element.innerHTML = `
      <div class="game-over-overlay__title">GAME OVER</div>
      <div class="game-over-overlay__sub">체력이 모두 소진되었습니다</div>
    `;

    const show = (): void => {
        element.classList.remove('hidden');
    };

    const hide = (): void => {
        element.classList.add('hidden');
    };

    return { element, show, hide };
};

// DOM 준비 후 초기화
document.addEventListener('DOMContentLoaded', initApp);
