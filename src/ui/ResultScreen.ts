/* === 결과 화면 === */

export interface ResultData {
    readonly score: number;
    readonly maxCombo: number;
    readonly accuracy: number;
    readonly rank: string;
    readonly failed?: boolean;
    readonly perfects: number;
    readonly greats: number;
    readonly goods: number;
    readonly misses: number;
}

export interface ResultCallbacks {
    readonly onRetry: () => void;
    readonly onBack: () => void;
}

export const createResultScreen = (callbacks: ResultCallbacks): HTMLElement & { show: (data: ResultData) => void } => {
    const container = document.createElement('div');
    container.className = 'screen result-screen';
    container.id = 'result-screen';

    container.innerHTML = `
    <div class="result__rank" id="result-rank">S</div>
    <div class="result__score" id="result-score">0</div>
    <div class="result__stats">
      <div class="result__stat result__stat--perfect">
        <div class="result__stat-value" id="stat-perfect">0</div>
        <div class="result__stat-label">Perfect</div>
      </div>
      <div class="result__stat result__stat--great">
        <div class="result__stat-value" id="stat-great">0</div>
        <div class="result__stat-label">Great</div>
      </div>
      <div class="result__stat result__stat--good">
        <div class="result__stat-value" id="stat-good">0</div>
        <div class="result__stat-label">Good</div>
      </div>
      <div class="result__stat result__stat--miss">
        <div class="result__stat-value" id="stat-miss">0</div>
        <div class="result__stat-label">Miss</div>
      </div>
    </div>
    <div style="display: flex; gap: 1rem;">
      <button class="btn btn--primary" id="btn-retry">🔄 다시 하기</button>
      <button class="btn" id="btn-result-back">🏠 메뉴로</button>
    </div>
  `;

    container.querySelector('#btn-retry')!.addEventListener('click', callbacks.onRetry);
    container.querySelector('#btn-result-back')!.addEventListener('click', callbacks.onBack);

    /** 결과 데이터 표시 */
    const show = (data: ResultData): void => {
        const rankEl = container.querySelector('#result-rank')!;
        const rankText = data.failed ? 'F' : data.rank;
        rankEl.textContent = rankText;
        rankEl.className = `result__rank result__rank--${rankText.toLowerCase()}`;

        container.querySelector('#result-score')!.textContent = data.score.toLocaleString();
        container.querySelector('#stat-perfect')!.textContent = String(data.perfects);
        container.querySelector('#stat-great')!.textContent = String(data.greats);
        container.querySelector('#stat-good')!.textContent = String(data.goods);
        container.querySelector('#stat-miss')!.textContent = String(data.misses);
    };

    return Object.assign(container, { show });
};
