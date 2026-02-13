/* === 메인 메뉴 화면 === */

export interface MainMenuCallbacks {
    readonly onStart: () => void;
    readonly onSettings: () => void;
}

export const createMainMenu = (callbacks: MainMenuCallbacks): HTMLElement => {
    const container = document.createElement('div');
    container.className = 'screen main-menu';
    container.id = 'main-menu';

    container.innerHTML = `
    <h1 class="main-menu__title">리듬튜브</h1>
    <p class="main-menu__subtitle">Rhythm × YouTube</p>
    <div class="menu-buttons">
      <button class="btn btn--primary" id="btn-start">🎵 게임 시작</button>
      <button class="btn" id="btn-settings">⚙ 설정</button>
    </div>
  `;

    // 이벤트 바인딩
    container.querySelector('#btn-start')!.addEventListener('click', callbacks.onStart);
    container.querySelector('#btn-settings')!.addEventListener('click', callbacks.onSettings);

    return container;
};
