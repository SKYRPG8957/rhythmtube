/* === 곡 선택 화면 === */
import type { Difficulty } from '../utils/Constants';

export interface SongSelectCallbacks {
    readonly onFileSelect: (file: File) => void;
    readonly onYoutubeUrl: (url: string) => void;
    readonly onBack: () => void;
}

const COOKIE_HANDLE_STORAGE_SESSION = 'rhythmtube_youtube_cookie_handle_session';
const COOKIE_HANDLE_STORAGE_PERSIST = 'rhythmtube_youtube_cookie_handle';

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

    <details class="song-select__cookies" id="youtube-cookies-details">
      <summary class="song-select__cookies-summary">YouTube 로그인 차단 해결 (선택)</summary>
      <div class="song-select__cookies-body">
        <div class="song-select__cookies-desc">
          일부 영상은 서버가 봇으로 판단되어 실패합니다. 이 경우 YouTube 로그인 쿠키(cookies.txt)를 업로드하면 성공률이 올라갑니다.
        </div>
        <div class="song-select__cookies-row">
          <input type="file" id="youtube-cookies-file" accept="text/plain,.txt" />
          <button class="btn btn--secondary" id="youtube-cookies-upload" type="button">업로드</button>
          <button class="btn" id="youtube-cookies-clear" type="button">삭제</button>
        </div>
        <label class="song-select__cookies-remember">
          <input type="checkbox" id="youtube-cookies-remember" /> 이 기기에서 저장
        </label>
        <div class="song-select__cookies-status" id="youtube-cookies-status"></div>
      </div>
    </details>

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

    const cookiesDetails = container.querySelector('#youtube-cookies-details') as HTMLDetailsElement;
    const cookiesFileInput = container.querySelector('#youtube-cookies-file') as HTMLInputElement;
    const cookiesUploadBtn = container.querySelector('#youtube-cookies-upload') as HTMLButtonElement;
    const cookiesClearBtn = container.querySelector('#youtube-cookies-clear') as HTMLButtonElement;
    const cookiesRemember = container.querySelector('#youtube-cookies-remember') as HTMLInputElement;
    const cookiesStatus = container.querySelector('#youtube-cookies-status') as HTMLElement;

    const getStoredCookieHandle = (): string | null => {
        return sessionStorage.getItem(COOKIE_HANDLE_STORAGE_SESSION)
            || localStorage.getItem(COOKIE_HANDLE_STORAGE_PERSIST);
    };
    const setStoredCookieHandle = (handle: string | null, remember: boolean): void => {
        sessionStorage.removeItem(COOKIE_HANDLE_STORAGE_SESSION);
        localStorage.removeItem(COOKIE_HANDLE_STORAGE_PERSIST);
        if (!handle) return;
        if (remember) {
            localStorage.setItem(COOKIE_HANDLE_STORAGE_PERSIST, handle);
        } else {
            sessionStorage.setItem(COOKIE_HANDLE_STORAGE_SESSION, handle);
        }
    };
    const setCookieStatus = (text: string, isError = false): void => {
        cookiesStatus.textContent = text;
        cookiesStatus.classList.toggle('error', isError);
    };
    const refreshCookieUi = (): void => {
        const handle = getStoredCookieHandle();
        if (handle) {
            setCookieStatus('쿠키 설정됨 (일부 영상 성공률 증가)', false);
        } else {
            setCookieStatus('쿠키 없음', false);
        }
    };

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

    const uploadCookiesFile = async (): Promise<void> => {
        const file = cookiesFileInput.files?.[0];
        if (!file) {
            setCookieStatus('cookies.txt 파일을 선택하세요.', true);
            return;
        }
        if (file.size > 256 * 1024) {
            setCookieStatus('쿠키 파일이 너무 큽니다 (256KB 제한).', true);
            return;
        }
        cookiesUploadBtn.disabled = true;
        setCookieStatus('쿠키 업로드 중...', false);
        try {
            const text = await file.text();
            const response = await fetch(apiUrl('/api/youtube/cookies'), {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain' },
                body: text,
            });
            const raw = await response.json().catch(() => ({} as unknown));
            if (!response.ok) {
                const msg = (typeof raw === 'object' && raw && 'error' in raw && typeof (raw as { error?: unknown }).error === 'string')
                    ? (raw as { error: string }).error
                    : `HTTP ${response.status}`;
                throw new Error(msg);
            }
            const handle = (typeof raw === 'object' && raw && 'cookieHandle' in raw && typeof (raw as { cookieHandle?: unknown }).cookieHandle === 'string')
                ? (raw as { cookieHandle: string }).cookieHandle
                : '';
            if (!handle) {
                throw new Error('서버 응답이 올바르지 않습니다');
            }
            setStoredCookieHandle(handle, cookiesRemember.checked);
            refreshCookieUi();
        } catch (err) {
            setCookieStatus(`업로드 실패: ${err instanceof Error ? err.message : '알 수 없는 오류'}`, true);
            cookiesDetails.open = true;
        } finally {
            cookiesUploadBtn.disabled = false;
        }
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

    cookiesUploadBtn.addEventListener('click', () => {
        void uploadCookiesFile();
    });
    cookiesClearBtn.addEventListener('click', () => {
        setStoredCookieHandle(null, false);
        cookiesFileInput.value = '';
        refreshCookieUi();
    });

    refreshCookieUi();

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
