/* === UI 매니저 - HTML 기반 UI 오버레이 관리 === */
import type { GameScreen } from '../utils/Constants';

export const createUIManager = () => {
    const overlay = document.getElementById('ui-overlay')!;
    let screens: Map<string, HTMLElement> = new Map();

    /** 화면 등록 */
    const registerScreen = (name: string, element: HTMLElement): void => {
        element.classList.add('screen');
        overlay.appendChild(element);
        screens = new Map(screens);
        screens.set(name, element);
    };

    /** 화면 전환 */
    const showScreen = (name: GameScreen | 'none'): void => {
        screens.forEach((el, key) => {
            if (key === name) {
                el.classList.add('active');
            } else {
                el.classList.remove('active');
            }
        });
    };

    /** 모든 UI 숨기기 */
    const hideAll = (): void => {
        screens.forEach(el => el.classList.remove('active'));
    };

    /** 특정 화면의 DOM 가져오기 */
    const getScreen = (name: string): HTMLElement | undefined => screens.get(name);

    return { registerScreen, showScreen, hideAll, getScreen };
};

export type UIManager = ReturnType<typeof createUIManager>;
