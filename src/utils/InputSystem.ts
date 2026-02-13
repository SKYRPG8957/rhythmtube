/* === 키보드 입력 시스템 === */
import { DEFAULT_KEY_BINDINGS } from './Constants';

/** 키 바인딩 맵 타입 */
export interface KeyBindings {
    readonly laneBottom: string;
    readonly laneTop: string;
    readonly special: string;
}

/** 입력 액션 */
export type InputAction = 'laneTop' | 'laneBottom' | 'special';

/** 입력 이벤트 핸들러 */
type InputHandler = (action: InputAction) => void;

/** 입력 시스템 상태 */
interface InputState {
    readonly bindings: KeyBindings;
    readonly pressedKeys: ReadonlySet<string>;
    readonly handlers: {
        readonly onPress: InputHandler[];
        readonly onRelease: InputHandler[];
    };
    readonly listening: string | null; // 리바인딩 중인 액션
}

const STORAGE_KEY = 'rhythmtube_keybinds';
const LEGACY_STORAGE_KEY = 'beatrunner_keybinds';
const normalizeEventToken = (value: unknown): string =>
    typeof value === 'string' ? value.toLowerCase() : '';
const splitBindingTokens = (binding: string): string[] =>
    (binding === ' ' ? ['space'] : binding
        .split(/[|,/+]+/)
        .map((s) => {
            const lower = s.toLowerCase();
            if (lower === ' ' || lower === 'space') return 'space';
            return lower.trim();
        })
        .filter(Boolean));

/** localStorage에서 키 바인딩 로드 */
const loadBindings = (): KeyBindings => {
    try {
        const saved = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
        if (saved) {
            const parsed = JSON.parse(saved) as Partial<KeyBindings>;
            return {
                ...DEFAULT_KEY_BINDINGS,
                ...parsed,
            };
        }
    } catch {
        // 파싱 실패시 기본값 사용
    }
    return { ...DEFAULT_KEY_BINDINGS };
};

/** 키 바인딩 저장 */
const saveBindings = (bindings: KeyBindings): void => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
};

/** 키→액션 역매핑 생성 */
const buildKeyToAction = (bindings: KeyBindings): ReadonlyMap<string, InputAction> => {
    const map = new Map<string, InputAction>();

    const addBinding = (binding: string, action: InputAction) => {
        const tokens = splitBindingTokens(binding);
        for (const key of tokens) {
            map.set(key, action);

            // IME(한/영)와 무관하게 물리 키로도 인식되게 보조 매핑
            if (/^[a-z]$/.test(key)) {
                map.set(`key${key}`, action);
            } else if (/^[0-9]$/.test(key)) {
                map.set(`digit${key}`, action);
            } else if (key === ' ') {
                map.set('space', action);
            }
        }
    };

    addBinding(bindings.laneBottom, 'laneBottom');
    addBinding(bindings.laneTop, 'laneTop');
    addBinding(bindings.special, 'special');
    return map;
};

/** 입력 시스템 싱글톤 */
const createInputSystem = () => {
    let state: InputState = {
        bindings: loadBindings(),
        pressedKeys: new Set<string>(),
        handlers: { onPress: [], onRelease: [] },
        listening: null,
    };

    let keyToAction = buildKeyToAction(state.bindings);
    let rebindCallback: ((key: string) => void) | null = null;
    const normalizeHeldToken = (token: string): string => token.toLowerCase();
    const toCodeAlias = (token: string): string | null => {
        const t = token.toLowerCase();
        if (/^[a-z]$/.test(t)) return `key${t}`;
        if (/^[0-9]$/.test(t)) return `digit${t}`;
        if (t === ' ') return 'space';
        return null;
    };
    const getActionTokens = (bindings: KeyBindings, action: InputAction): string[] => {
        const raw = splitBindingTokens(bindings[action]);
        const out: string[] = [];
        for (const token of raw) {
            const normalized = normalizeHeldToken(token);
            if (!out.includes(normalized)) out.push(normalized);
            const alias = toCodeAlias(normalized);
            if (alias && !out.includes(alias)) out.push(alias);
        }
        return out;
    };
    const isActionActive = (
        action: InputAction,
        pressed: ReadonlySet<string>,
        bindings: KeyBindings = state.bindings
    ): boolean => {
        const tokens = getActionTokens(bindings, action);
        for (const token of tokens) {
            if (pressed.has(token)) return true;
        }
        return false;
    };
    const clearPressed = (): void => {
        if (state.pressedKeys.size === 0) return;
        state = { ...state, pressedKeys: new Set<string>() };
    };

    /** 키다운 이벤트 핸들러 */
    const handleKeyDown = (e: KeyboardEvent): void => {
        const key = normalizeEventToken(e.key);
        const code = normalizeEventToken(e.code);
        if (!key && !code) return;

        // 리바인딩 모드
        if (state.listening && rebindCallback) {
            e.preventDefault();
            rebindCallback(key || code);
            return;
        }

        const action = keyToAction.get(key) ?? keyToAction.get(code);
        const wasActionActive = action ? isActionActive(action, state.pressedKeys) : false;

        // 이미 눌려 있으면 무시 (키 리피트 방지, key/code 둘 다 체크)
        if (state.pressedKeys.has(code) || state.pressedKeys.has(key)) return;

        const mutableKeys = new Set(state.pressedKeys);
        mutableKeys.add(normalizeHeldToken(key));
        mutableKeys.add(normalizeHeldToken(code));
        state = { ...state, pressedKeys: mutableKeys };

        if (action) {
            e.preventDefault();
            // 같은 액션에 키가 여러 개 묶여 있어도 "첫 진입"에서만 onPress 발생.
            if (!wasActionActive) {
                state.handlers.onPress.forEach((h) => {
                    h(action);
                });
            }
        }
    };

    /** 키업 이벤트 핸들러 */
    const handleKeyUp = (e: KeyboardEvent): void => {
        const key = normalizeEventToken(e.key);
        const code = normalizeEventToken(e.code);
        if (!key && !code) return;
        const action = keyToAction.get(key) ?? keyToAction.get(code);
        const wasActionActive = action ? isActionActive(action, state.pressedKeys) : false;
        const mutableKeys = new Set(state.pressedKeys);
        mutableKeys.delete(normalizeHeldToken(key));
        mutableKeys.delete(normalizeHeldToken(code));
        state = { ...state, pressedKeys: mutableKeys };

        if (action) {
            // 다중 바인딩에서 같은 액션 키가 아직 하나라도 눌려 있으면 release를 보내지 않는다.
            const stillActive = isActionActive(action, mutableKeys);
            if (wasActionActive && !stillActive) {
                state.handlers.onRelease.forEach((h) => {
                    h(action);
                });
            }
        }
    };

    /** 초기화 */
    const init = (): void => {
        // HMR Clean-up: Remove previous listeners using global reference
        if ((window as any).__INPUT_SYSTEM_DISPOSE__) {
            (window as any).__INPUT_SYSTEM_DISPOSE__();
            console.log('[InputSystem] Disposed previous instance listeners.');
        }

        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        window.addEventListener('blur', clearPressed);
        document.addEventListener('visibilitychange', clearPressed);

        // Store cleanup for next HMR
        (window as any).__INPUT_SYSTEM_DISPOSE__ = () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
            window.removeEventListener('blur', clearPressed);
            document.removeEventListener('visibilitychange', clearPressed);
            clearPressed();
        };

        console.log('[InputSystem] Initialized (Listeners attached)');
    };

    /** 정리 */
    const destroy = (): void => {
        if ((window as any).__INPUT_SYSTEM_DISPOSE__) {
            (window as any).__INPUT_SYSTEM_DISPOSE__();
            (window as any).__INPUT_SYSTEM_DISPOSE__ = undefined;
        }
    };

    /** 키 눌림 이벤트 등록 */
    const onPress = (handler: InputHandler): (() => void) => {
        const handlers = [...state.handlers.onPress, handler];
        state = { ...state, handlers: { ...state.handlers, onPress: handlers } };
        return () => {
            const filtered = state.handlers.onPress.filter(h => h !== handler);
            state = { ...state, handlers: { ...state.handlers, onPress: filtered } };
        };
    };

    /** 키 릴리즈 이벤트 등록 */
    const onRelease = (handler: InputHandler): (() => void) => {
        const handlers = [...state.handlers.onRelease, handler];
        state = { ...state, handlers: { ...state.handlers, onRelease: handlers } };
        return () => {
            const filtered = state.handlers.onRelease.filter(h => h !== handler);
            state = { ...state, handlers: { ...state.handlers, onRelease: filtered } };
        };
    };

    /** 키 리바인딩 시작 */
    const startRebind = (action: InputAction, mode: 'replace' | 'append' = 'replace'): Promise<string> => {
        return new Promise((resolve) => {
            state = { ...state, listening: action };
            rebindCallback = (key: string) => {
                const existing = splitBindingTokens(state.bindings[action] || '');
                const picked = key === ' ' ? 'space' : key.toLowerCase();
                const merged = mode === 'append'
                    ? [...new Set([...existing, picked])]
                    : [picked];
                const newBindings: KeyBindings = {
                    ...state.bindings,
                    [action]: merged.join('|'),
                };
                saveBindings(newBindings);
                keyToAction = buildKeyToAction(newBindings);
                state = { ...state, bindings: newBindings, listening: null };
                rebindCallback = null;
                resolve(merged.join('|'));
            };
        });
    };

    /** 현재 바인딩 가져오기 */
    const getBindings = (): KeyBindings => state.bindings;

    /** 리바인딩 중인지 확인 */
    const isListening = (): boolean => state.listening !== null;

    /** 특정 키가 눌려있는지 확인 */
    const isKeyPressed = (key: string): boolean => state.pressedKeys.has(key.toLowerCase());
    const isKeyPressedCompat = (key: string): boolean => {
        const tokens = splitBindingTokens(key);
        for (const normalized of tokens) {
            if (state.pressedKeys.has(normalized)) return true;
            const alias = toCodeAlias(normalized);
            if (alias && state.pressedKeys.has(alias)) return true;
        }
        return false;
    };

    return {
        init,
        destroy,
        onPress,
        onRelease,
        startRebind,
        getBindings,
        isListening,
        isKeyPressed: isKeyPressedCompat,
    };
};

export const inputSystem = createInputSystem();
