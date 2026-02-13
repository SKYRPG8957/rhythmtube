/* === 곡 선택 화면 === */
import type { Difficulty } from '../utils/Constants';

export interface SongSelectCallbacks {
    readonly onFileSelect: (file: File) => void;
    readonly onYoutubeUrl: (url: string) => void;
    readonly onBack: () => void;
}

interface YoutubeSearchItem {
    readonly id: string;
    readonly title: string;
    readonly url: string;
    readonly durationSec: number;
    readonly channel: string;
    readonly thumbnail: string;
    readonly viewCount: number;
}

export const createSongSelect = (
    callbacks: SongSelectCallbacks
): HTMLElement & {
    getDifficulty: () => Difficulty;
    isInfiniteMode: () => boolean;
} => {
    const API_BASE_RAW = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() ?? '';
    const API_BASE = API_BASE_RAW.endsWith('/') ? API_BASE_RAW.slice(0, -1) : API_BASE_RAW;
    const apiUrl = (path: string): string => `${API_BASE}${path}`;

    const container = document.createElement('div');
    container.className = 'screen song-select';
    container.id = 'song-select';

    let selectedDifficulty: Difficulty = 'normal';
    let infiniteMode = false;

    container.innerHTML = `
    <button class="back-btn" id="song-back">← 뒤로</button>
    <h2 class="song-select__header">🎶 곡 선택</h2>
    
    <div class="file-upload" id="file-drop-zone">
      <div class="file-upload__icon">📁</div>
      <div class="file-upload__text">
        <span class="file-upload__text--highlight">클릭</span>하거나 오디오 파일을 드래그하세요
      </div>
      <div class="file-upload__text" style="font-size: 0.8rem; margin-top: 0.3rem; color: var(--text-dim);">
        MP3, WAV, OGG, FLAC 지원
      </div>
      <input type="file" id="file-input" accept="audio/*" style="display: none;" />
    </div>

    <div class="or-divider">또는</div>

    <div class="song-select__input-group">
      <label class="song-select__label">YouTube URL</label>
      <input 
        type="url" 
        class="song-select__input" 
        id="youtube-url" 
        placeholder="https://www.youtube.com/watch?v=..." 
      />
    </div>

    <div class="song-select__input-group">
      <label class="song-select__label">YouTube 검색</label>
      <div class="song-select__search-row">
        <input
          type="text"
          class="song-select__input"
          id="youtube-search-query"
          placeholder="곡/아티스트 이름으로 검색"
        />
        <button class="btn btn--secondary song-select__search-btn" id="youtube-search-btn">검색</button>
      </div>
      <div class="song-select__search-status" id="youtube-search-status"></div>
      <div class="song-select__search-results" id="youtube-search-results"></div>
    </div>

    <div class="difficulty-selector">
      <button class="difficulty-btn" data-diff="easy">Easy</button>
      <button class="difficulty-btn active" data-diff="normal">Normal</button>
      <button class="difficulty-btn" data-diff="hard">Hard</button>
      <button class="difficulty-btn" data-diff="expert">Expert</button>
    </div>

    <button class="btn-toggle" id="btn-infinite">∞ 무한모드: OFF</button>

    <button class="btn btn--primary song-select__play-btn" id="btn-play" disabled>
      ▶ 플레이
    </button>

    <div class="song-select__selected-file" id="selected-file-name"></div>
  `;

    const fileInput = container.querySelector('#file-input') as HTMLInputElement;
    const dropZone = container.querySelector('#file-drop-zone') as HTMLElement;
    const playBtn = container.querySelector('#btn-play') as HTMLButtonElement;
    const fileNameDisplay = container.querySelector('#selected-file-name') as HTMLElement;
    const youtubeInput = container.querySelector('#youtube-url') as HTMLInputElement;
    const infiniteBtn = container.querySelector('#btn-infinite') as HTMLButtonElement;
    const youtubeSearchInput = container.querySelector('#youtube-search-query') as HTMLInputElement;
    const youtubeSearchBtn = container.querySelector('#youtube-search-btn') as HTMLButtonElement;
    const youtubeSearchStatus = container.querySelector('#youtube-search-status') as HTMLElement;
    const youtubeSearchResults = container.querySelector('#youtube-search-results') as HTMLElement;

    let selectedFile: File | null = null;
    let activeSearchToken = 0;
    let searchAbortController: AbortController | null = null;
    let searchDebounceTimer: number | null = null;
    const SEARCH_DEBOUNCE_MS = 320;

    dropZone.addEventListener('click', () => fileInput.click());

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('active');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('active');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('active');
        const file = (e as DragEvent).dataTransfer?.files[0];
        if (file && file.type.startsWith('audio/')) {
            selectFile(file);
        }
    });

    fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        if (file) selectFile(file);
    });

    const selectFile = (file: File): void => {
        selectedFile = file;
        fileNameDisplay.textContent = `✅ ${file.name}`;
        playBtn.disabled = false;
        youtubeInput.value = '';
    };

    youtubeInput.addEventListener('input', () => {
        const url = youtubeInput.value.trim();
        if (isValidYoutubeUrl(url)) {
            playBtn.disabled = false;
            selectedFile = null;
            fileNameDisplay.textContent = '🔗 YouTube URL 입력됨';
        } else if (!selectedFile) {
            playBtn.disabled = true;
            fileNameDisplay.textContent = '';
        }
    });

    const formatDuration = (sec: number): string => {
        const s = Math.max(0, Math.floor(sec));
        const m = Math.floor(s / 60);
        const r = s % 60;
        return `${m}:${r.toString().padStart(2, '0')}`;
    };

    const clearSearchResults = (): void => {
        youtubeSearchResults.innerHTML = '';
    };

    const setSearchStatus = (text: string, isError = false): void => {
        youtubeSearchStatus.textContent = text;
        youtubeSearchStatus.classList.toggle('error', isError);
    };

    const applyYoutubeUrl = (url: string): void => {
        youtubeInput.value = url;
        selectedFile = null;
        playBtn.disabled = false;
        fileNameDisplay.textContent = '🔗 YouTube URL 선택됨';
        youtubeInput.dispatchEvent(new Event('input'));
    };

    const renderSearchItems = (items: readonly YoutubeSearchItem[]): void => {
        clearSearchResults();
        if (!items.length) return;

        const frag = document.createDocumentFragment();
        items.forEach((item) => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'song-select__search-item';

            const thumb = document.createElement('img');
            thumb.className = 'song-select__search-thumb';
            thumb.alt = item.title;
            thumb.loading = 'lazy';
            thumb.src = item.thumbnail || `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`;

            const meta = document.createElement('div');
            meta.className = 'song-select__search-meta';

            const title = document.createElement('div');
            title.className = 'song-select__search-title';
            title.textContent = item.title;

            const sub = document.createElement('div');
            sub.className = 'song-select__search-sub';
            const views = item.viewCount > 0 ? `조회수 ${item.viewCount.toLocaleString()}` : '조회수 -';
            sub.textContent = `${item.channel} · ${formatDuration(item.durationSec)} · ${views}`;

            meta.appendChild(title);
            meta.appendChild(sub);
            row.appendChild(thumb);
            row.appendChild(meta);
            row.addEventListener('click', () => applyYoutubeUrl(item.url));
            frag.appendChild(row);
        });
        youtubeSearchResults.appendChild(frag);
    };

    const runYoutubeSearch = async (): Promise<void> => {
        const query = youtubeSearchInput.value.trim();
        if (query.length < 2) {
            setSearchStatus('검색어를 2자 이상 입력하세요.', true);
            clearSearchResults();
            return;
        }

        const token = ++activeSearchToken;
        if (searchAbortController) {
            searchAbortController.abort();
        }
        const controller = new AbortController();
        searchAbortController = controller;
        youtubeSearchBtn.disabled = true;
        setSearchStatus('YouTube 검색 중...');

        try {
            const response = await fetch(apiUrl(`/api/youtube/search?q=${encodeURIComponent(query)}&limit=8`), {
                signal: controller.signal,
            });
            const raw = await response.json().catch(() => ({} as unknown));
            if (token !== activeSearchToken) return;
            if (!response.ok) {
                const msg = (typeof raw === 'object' && raw && 'error' in raw && typeof (raw as { error?: unknown }).error === 'string')
                    ? (raw as { error: string }).error
                    : `HTTP ${response.status}`;
                throw new Error(msg);
            }
            const items = (typeof raw === 'object' && raw && 'items' in raw && Array.isArray((raw as { items?: unknown }).items))
                ? (raw as { items: YoutubeSearchItem[] }).items
                : [];
            renderSearchItems(items);
            setSearchStatus(items.length > 0 ? `${items.length}개 결과` : '검색 결과가 없습니다.');
        } catch (err) {
            if (token !== activeSearchToken) return;
            if (err instanceof DOMException && err.name === 'AbortError') return;
            clearSearchResults();
            setSearchStatus(`검색 실패: ${err instanceof Error ? err.message : '알 수 없는 오류'}`, true);
        } finally {
            if (token === activeSearchToken) {
                youtubeSearchBtn.disabled = false;
            }
            if (searchAbortController === controller) {
                searchAbortController = null;
            }
        }
    };

    const scheduleYoutubeSearch = (): void => {
        if (searchDebounceTimer !== null) {
            window.clearTimeout(searchDebounceTimer);
        }
        searchDebounceTimer = window.setTimeout(() => {
            searchDebounceTimer = null;
            void runYoutubeSearch();
        }, SEARCH_DEBOUNCE_MS);
    };

    youtubeSearchBtn.addEventListener('click', () => {
        if (searchDebounceTimer !== null) {
            window.clearTimeout(searchDebounceTimer);
            searchDebounceTimer = null;
        }
        void runYoutubeSearch();
    });

    youtubeSearchInput.addEventListener('input', () => {
        const query = youtubeSearchInput.value.trim();
        if (query.length < 2) {
            setSearchStatus('검색어를 2자 이상 입력하세요.');
            clearSearchResults();
            if (searchAbortController) {
                searchAbortController.abort();
                searchAbortController = null;
            }
            if (searchDebounceTimer !== null) {
                window.clearTimeout(searchDebounceTimer);
                searchDebounceTimer = null;
            }
            return;
        }
        scheduleYoutubeSearch();
    });

    youtubeSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (searchDebounceTimer !== null) {
                window.clearTimeout(searchDebounceTimer);
                searchDebounceTimer = null;
            }
            void runYoutubeSearch();
        }
    });

    const diffBtns = container.querySelectorAll('.difficulty-btn');
    diffBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            diffBtns.forEach((b) => {
                b.classList.remove('active');
            });
            btn.classList.add('active');
            selectedDifficulty = btn.getAttribute('data-diff') as Difficulty;
        });
    });

    infiniteBtn.addEventListener('click', () => {
        infiniteMode = !infiniteMode;
        infiniteBtn.textContent = `∞ 무한모드: ${infiniteMode ? 'ON' : 'OFF'}`;
        infiniteBtn.classList.toggle('active', infiniteMode);
    });

    playBtn.addEventListener('click', () => {
        if (selectedFile) {
            callbacks.onFileSelect(selectedFile);
            return;
        }
        const url = youtubeInput.value.trim();
        if (isValidYoutubeUrl(url)) {
            callbacks.onYoutubeUrl(url);
        }
    });

    container.querySelector('#song-back')!.addEventListener('click', callbacks.onBack);

    const getDifficulty = (): Difficulty => selectedDifficulty;
    const isInfiniteMode = (): boolean => infiniteMode;

    return Object.assign(container, { getDifficulty, isInfiniteMode });
};

/** YouTube URL 유효성 검사 */
const isValidYoutubeUrl = (url: string): boolean => {
    const input = url.trim();
    if (!input) return false;
    if (/^[\w-]{11}$/.test(input)) return true;
    try {
        const parsed = new URL(input);
        const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
        const allowedHost = host === 'youtube.com'
            || host === 'youtu.be'
            || host === 'm.youtube.com'
            || host === 'music.youtube.com'
            || host === 'youtube-nocookie.com';
        if (!allowedHost) return false;
        const pathParts = parsed.pathname.split('/').filter(Boolean);
        const v = parsed.searchParams.get('v');
        const id = v
            || (host === 'youtu.be' ? pathParts[0] : null)
            || ((pathParts[0] === 'shorts' || pathParts[0] === 'embed' || pathParts[0] === 'live') ? pathParts[1] : null);
        return !!id && /^[\w-]{11}$/.test(id);
    } catch {
        return false;
    }
};
