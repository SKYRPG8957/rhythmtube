/* === 인게임 HUD === */

export const createGameHUD = (): HTMLElement & {
  update: (score: number, combo: number, accuracy: number, progress: number, hp: number) => void;
  toggle: (show: boolean) => void;
  onAutoPlay: (cb: (enabled: boolean) => void) => void;
  isAutoPlayEnabled: () => boolean;
} => {
  const container = document.createElement('div');
  container.className = 'game-hud hidden';
  container.id = 'game-hud';

  container.innerHTML = `
      <div class="hud__top-left">
          <div class="hud__hp-bar">
              <div class="hud__hp-icon">❤️</div>
              <div class="hud__hp-track">
                  <div class="hud__hp-fill" style="width: 100%;"></div>
              </div>
          </div>
          <div class="hud__score">0000000</div>
      </div>
      
      <div class="hud__center">
          <div class="hud__combo">
            <div class="hud__combo-count">0</div>
            <div class="hud__combo-label">COMBO</div>
          </div>
      </div>

      <div class="hud__top-right">
          <div class="hud__info">
            <div class="hud__accuracy">100.0%</div>
            <div class="hud__progress">
              <div class="hud__progress-fill" style="width: 0%;"></div>
            </div>
          </div>
          <button class="btn-autoplay" id="btn-autoplay">🤖 Auto: OFF</button>
      </div>
    `;

  const scoreEl = container.querySelector('.hud__score')!;
  const comboEl = container.querySelector('.hud__combo-count')!;
  const accuracyEl = container.querySelector('.hud__accuracy')!;
  const progressFill = container.querySelector('.hud__progress-fill') as HTMLElement;
  const hpFill = container.querySelector('.hud__hp-fill') as HTMLElement;
  const autoPlayBtn = container.querySelector('#btn-autoplay') as HTMLButtonElement;

  let currentScore = 0;
  let targetScore = 0;
  let isAutoPlay = false;
  let onAutoPlayCallback: ((enabled: boolean) => void) | null = null;

  autoPlayBtn.addEventListener('click', () => {
    isAutoPlay = !isAutoPlay;
    autoPlayBtn.textContent = `🤖 Auto: ${isAutoPlay ? 'ON' : 'OFF'}`;
    autoPlayBtn.classList.toggle('active', isAutoPlay);
    onAutoPlayCallback?.(isAutoPlay);
    autoPlayBtn.blur();
  });

  /** HUD 업데이트 */
  const update = (score: number, combo: number, accuracy: number, progress: number, hp: number): void => {
    // Score Lerp
    targetScore = score;
    currentScore += Math.ceil((targetScore - currentScore) * 0.2);
    scoreEl.textContent = currentScore.toString().padStart(7, '0');

    // Combo
    comboEl.textContent = String(combo);

    // Pop animation logic (using data attribute to track change)
    const prevCombo = parseInt(comboEl.getAttribute('data-last') || '0');
    if (combo > 0 && combo > prevCombo) {
      comboEl.classList.remove('pop');
      void (comboEl as HTMLElement).offsetWidth; // Trigger reflow
      comboEl.classList.add('pop');
    }
    comboEl.setAttribute('data-last', String(combo));

    accuracyEl.textContent = `${accuracy.toFixed(1)}%`;
    progressFill.style.width = `${Math.min(100, progress * 100)}%`;

    // HP Bar Update
    if (hpFill) {
      hpFill.style.width = `${Math.max(0, Math.min(100, hp))}%`;
      hpFill.style.backgroundColor = hp > 50 ? 'var(--neon-green)' : hp > 20 ? 'var(--neon-yellow)' : 'var(--neon-pink)';
    }
  };

  /** 표시/숨김 */
  const toggle = (show: boolean): void => {
    if (show) {
      container.classList.remove('hidden');
    } else {
      container.classList.add('hidden');
    }
  };

  const onAutoPlay = (cb: (enabled: boolean) => void) => {
    onAutoPlayCallback = cb;
  };

  const isAutoPlayEnabled = (): boolean => isAutoPlay;

  return Object.assign(container, { update, toggle, onAutoPlay, isAutoPlayEnabled });
};
