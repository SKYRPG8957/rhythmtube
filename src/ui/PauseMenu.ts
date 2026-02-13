/* === 일시정지 메뉴 === */

export interface PauseMenuCallbacks {
    readonly onResume: () => void;
    readonly onSettings: () => void;
    readonly onExit: () => void;
}

export const createPauseMenu = (callbacks: PauseMenuCallbacks): HTMLElement => {
    const container = document.createElement('div');
    container.className = 'screen pause-menu';
    container.id = 'pause-menu';

    container.innerHTML = `
    <div class="pause-menu__panel">
      <h2 class="pause-menu__title">일시정지</h2>
      <button class="btn btn--primary pause-menu__btn" id="pause-resume">계속하기</button>
      <button class="btn pause-menu__btn" id="pause-settings">설정</button>
      <button class="btn pause-menu__btn" id="pause-exit">나가기</button>
    </div>
  `;

    container.querySelector('#pause-resume')!.addEventListener('click', callbacks.onResume);
    container.querySelector('#pause-settings')!.addEventListener('click', callbacks.onSettings);
    container.querySelector('#pause-exit')!.addEventListener('click', callbacks.onExit);

    return container;
};

