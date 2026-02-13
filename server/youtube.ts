/* === YouTube 오디오 추출 (yt-dlp 사용 - Browser-Compatible Audio) === */
console.log('🚀 YouTube Audio Module Loaded (v3 - MP3 Output)');

import fs from 'fs';
import path from 'path';
import https from 'https';
import os from 'os';
import { execFile } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const YtDlpWrap = require('yt-dlp-wrap').default;

// yt-dlp 바이너리 경로 설정 (cross-platform)
const YTDLP_BINARY_NAME = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const YTDLP_BINARY_PATH = path.join(process.cwd(), YTDLP_BINARY_NAME);
const YTDLP_BINARY_URL = process.platform === 'win32'
    ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
    : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

// YtDlpWrap 인스턴스 (바이너리가 있으면 사용, 없으면 다운로드 후 로드)
let ytDlpWrap: any;

/** yt-dlp 초기화 (바이너리 확인 및 다운로드) */
const initYtDlp = async (): Promise<void> => {
    if (ytDlpWrap) return;

    const useBinary = (binaryPath: string): void => {
        ytDlpWrap = new YtDlpWrap(binaryPath);
    };
    const ensureExecutable = (filePath: string): void => {
        if (process.platform !== 'win32') {
            try {
                fs.chmodSync(filePath, 0o755);
            } catch {
                // noop
            }
        }
    };
    const hasSystemBinary = async (): Promise<string | null> => {
        const candidates = process.platform === 'win32' ? ['yt-dlp.exe', 'yt-dlp'] : ['yt-dlp'];
        for (const candidate of candidates) {
            const ok = await new Promise<boolean>((resolve) => {
                execFile(candidate, ['--version'], (error) => resolve(!error));
            });
            if (ok) return candidate;
        }
        return null;
    };

    // 0바이트 파일 체크 및 삭제 (이전 다운로드 실패 잔재)
    if (fs.existsSync(YTDLP_BINARY_PATH)) {
        const stats = fs.statSync(YTDLP_BINARY_PATH);
        if (stats.size === 0) {
            console.log('🗑️ 손상된 yt-dlp 바이너리 삭제');
            fs.unlinkSync(YTDLP_BINARY_PATH);
        }
    }

    if (fs.existsSync(YTDLP_BINARY_PATH)) {
        ensureExecutable(YTDLP_BINARY_PATH);
        useBinary(YTDLP_BINARY_PATH);
        return;
    }

    const systemBinary = await hasSystemBinary();
    if (systemBinary) {
        useBinary(systemBinary);
        return;
    }

    console.log('⬇️ yt-dlp 바이너리 다운로드 중... (최초 1회 - 약 10MB)');

    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(YTDLP_BINARY_PATH);

        // 리다이렉트 처리 로직 포함
        const download = (url: string) => {
            https.get(url, (response) => {
                // 리다이렉트 (3xx)
                if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    download(response.headers.location);
                    return;
                }

                if (response.statusCode !== 200) {
                    file.close();
                    fs.unlink(YTDLP_BINARY_PATH, () => { }); // 실패 파일 삭제
                    reject(new Error(`다운로드 실패 Status: ${response.statusCode}`));
                    return;
                }

                response.pipe(file);

                file.on('finish', () => {
                    file.close();
                    console.log('✅ yt-dlp 설치 완료');
                    ensureExecutable(YTDLP_BINARY_PATH);
                    useBinary(YTDLP_BINARY_PATH);
                    resolve();
                });
            }).on('error', (err) => {
                fs.unlink(YTDLP_BINARY_PATH, () => { });
                reject(err);
            });
        };

        download(YTDLP_BINARY_URL);
    });
};

// 서버 시작 시 초기화 시도
initYtDlp().catch(console.error);

/** ffmpeg 존재 여부 체크 */
const checkFfmpeg = (): Promise<boolean> => {
    return new Promise((resolve) => {
        execFile('ffmpeg', ['-version'], (error) => {
            resolve(!error);
        });
    });
};

const runYtDlpVersion = (): Promise<string> =>
    new Promise((resolve) => {
        execFile(YTDLP_BINARY_PATH, ['--version'], (error, stdout) => {
            if (error) {
                resolve('unknown');
                return;
            }
            resolve((stdout || '').toString().trim() || 'unknown');
        });
    });

const updateYtDlpBinary = (): Promise<void> =>
    new Promise((resolve) => {
        if (!fs.existsSync(YTDLP_BINARY_PATH)) {
            resolve();
            return;
        }
        execFile(YTDLP_BINARY_PATH, ['-U'], { timeout: 90000 }, () => {
            resolve();
        });
    });

export interface YoutubeSearchItem {
    readonly id: string;
    readonly title: string;
    readonly url: string;
    readonly durationSec: number;
    readonly channel: string;
    readonly thumbnail: string;
    readonly viewCount: number;
}

interface YtDlpSearchEntry {
    readonly id?: unknown;
    readonly title?: unknown;
    readonly webpage_url?: unknown;
    readonly duration?: unknown;
    readonly uploader?: unknown;
    readonly channel?: unknown;
    readonly thumbnail?: unknown;
    readonly thumbnails?: unknown;
    readonly view_count?: unknown;
}

interface YtDlpSearchResponse {
    readonly entries?: unknown;
}

interface SearchCacheEntry {
    readonly expiresAt: number;
    readonly items: YoutubeSearchItem[];
}

const SEARCH_CACHE_TTL_MS = 45_000;
const SEARCH_CACHE_MAX_ENTRIES = 64;
const searchCache = new Map<string, SearchCacheEntry>();
const inflightSearches = new Map<string, Promise<YoutubeSearchItem[]>>();

interface AudioCacheEntry {
    readonly expiresAt: number;
    readonly buffer: Buffer;
    readonly contentType: string;
}

const AUDIO_CACHE_TTL_MS = 8 * 60_000;
const AUDIO_CACHE_MAX_ENTRIES = 6;
const AUDIO_CACHE_MAX_BYTES = 28 * 1024 * 1024;
const audioCache = new Map<string, AudioCacheEntry>();
const inflightAudios = new Map<string, Promise<{ buffer: Buffer; contentType: string }>>();

const parseCsvEnv = (value: string | undefined): string[] =>
    (value || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

const DEFAULT_PLAYER_CLIENTS = ['android', 'ios', 'mweb', 'web'];
const getPlayerClients = (): string[] => {
    const fromEnv = parseCsvEnv(process.env.YTDLP_PLAYER_CLIENTS);
    return fromEnv.length > 0 ? fromEnv : DEFAULT_PLAYER_CLIENTS;
};

const getCookieBrowsers = (): Array<'chrome' | 'edge' | 'firefox'> => {
    const fromEnv = parseCsvEnv(process.env.YTDLP_COOKIE_BROWSERS).map(v => v.toLowerCase());
    return fromEnv
        .filter((v): v is 'chrome' | 'edge' | 'firefox' => v === 'chrome' || v === 'edge' || v === 'firefox');
};

let cachedCookieFilePath: string | null | undefined;
const getCookieFilePath = (): string | null => {
    if (cachedCookieFilePath !== undefined) return cachedCookieFilePath;

    const explicit = (process.env.YTDLP_COOKIES_PATH || '').trim();
    if (explicit) {
        cachedCookieFilePath = explicit;
        return cachedCookieFilePath;
    }

    const b64 = (process.env.YTDLP_COOKIES_B64 || '').trim();
    if (!b64) {
        cachedCookieFilePath = null;
        return null;
    }

    try {
        const raw = Buffer.from(b64, 'base64').toString('utf8');
        const normalized = raw.replace(/\r\n/g, '\n');
        const filePath = path.join(os.tmpdir(), 'rhythmtube-ytdlp-cookies.txt');
        fs.writeFileSync(filePath, normalized, { mode: 0o600 });
        cachedCookieFilePath = filePath;
        return filePath;
    } catch {
        cachedCookieFilePath = null;
        return null;
    }
};

const appendCookieArgs = (args: string[], cookieBrowser?: 'chrome' | 'edge' | 'firefox'): void => {
    const cookieFile = getCookieFilePath();
    if (cookieFile) {
        args.push('--cookies', cookieFile);
        return;
    }
    if (cookieBrowser) {
        args.push('--cookies-from-browser', cookieBrowser);
    }
};

const isBotGateError = (message: string): boolean => {
    const m = message.toLowerCase();
    return m.includes('sign in') || m.includes('bot') || m.includes('captcha');
};

const parsePositiveIntEnv = (key: string, fallback: number): number => {
    const raw = (process.env[key] || '').trim();
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(6, parsed);
};

const parseNonNegativeIntEnv = (key: string, fallback: number): number => {
    const raw = (process.env[key] || '').trim();
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed < 0) return fallback;
    return Math.min(30, parsed);
};

const appendPolitenessArgs = (args: string[]): void => {
    // Free reliability lever: slow down slightly to reduce rate-limit/bot triggers.
    // Controlled via env vars so you can tune without redeploy.
    const sleepMin = parseNonNegativeIntEnv('YTDLP_SLEEP_INTERVAL', 0);
    const sleepMax = parseNonNegativeIntEnv('YTDLP_MAX_SLEEP_INTERVAL', 0);
    if (sleepMin > 0) {
        args.push('--sleep-interval', String(sleepMin));
        if (sleepMax >= sleepMin) {
            args.push('--max-sleep-interval', String(sleepMax));
        }
    }
};

let activeExtracts = 0;
const extractWaiters: Array<() => void> = [];
const withExtractSemaphore = async <T>(fn: () => Promise<T>): Promise<T> => {
    const max = parsePositiveIntEnv('YTDLP_MAX_CONCURRENT', 1);
    if (activeExtracts >= max) {
        await new Promise<void>((resolve) => extractWaiters.push(resolve));
    }
    activeExtracts += 1;
    try {
        return await fn();
    } finally {
        activeExtracts = Math.max(0, activeExtracts - 1);
        const next = extractWaiters.shift();
        if (next) next();
    }
};

const pruneExpiredAudioCache = (): void => {
    const now = Date.now();
    for (const [key, entry] of audioCache) {
        if (entry.expiresAt <= now) {
            audioCache.delete(key);
        }
    }
};

const getCachedAudio = (cacheKey: string): { buffer: Buffer; contentType: string } | null => {
    const cached = audioCache.get(cacheKey);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
        audioCache.delete(cacheKey);
        return null;
    }
    return { buffer: cached.buffer, contentType: cached.contentType };
};

const setCachedAudio = (cacheKey: string, result: { buffer: Buffer; contentType: string }): void => {
    if (result.buffer.length > AUDIO_CACHE_MAX_BYTES) return;

    pruneExpiredAudioCache();
    if (audioCache.size >= AUDIO_CACHE_MAX_ENTRIES) {
        const firstKey = audioCache.keys().next().value;
        if (typeof firstKey === 'string') {
            audioCache.delete(firstKey);
        }
    }
    audioCache.set(cacheKey, {
        expiresAt: Date.now() + AUDIO_CACHE_TTL_MS,
        buffer: result.buffer,
        contentType: result.contentType,
    });
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null;

const asString = (v: unknown): string =>
    typeof v === 'string' ? v : '';

const asNumber = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0;

const runYtDlpJson = async (args: readonly string[], timeoutMs: number): Promise<unknown> =>
    new Promise((resolve, reject) => {
        execFile(
            YTDLP_BINARY_PATH,
            [...args],
            { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
            (error, stdout, stderr) => {
                if (error) {
                    reject(new Error((stderr || error.message || 'yt-dlp 실행 실패').toString().trim()));
                    return;
                }
                try {
                    resolve(JSON.parse((stdout || '').toString()));
                } catch (parseErr) {
                    reject(new Error(parseErr instanceof Error ? parseErr.message : 'yt-dlp JSON 파싱 실패'));
                }
            }
        );
    });

const pickThumbnail = (entry: YtDlpSearchEntry): string => {
    const direct = asString(entry.thumbnail);
    if (direct) return direct;
    if (!Array.isArray(entry.thumbnails)) return '';
    for (let i = entry.thumbnails.length - 1; i >= 0; i--) {
        const item = entry.thumbnails[i];
        if (!isRecord(item)) continue;
        const url = asString(item.url);
        if (url) return url;
    }
    return '';
};

const mapSearchEntries = (entriesRaw: unknown, maxResults: number): YoutubeSearchItem[] => {
    if (!Array.isArray(entriesRaw)) return [];
    const out: YoutubeSearchItem[] = [];
    for (const raw of entriesRaw) {
        if (!isRecord(raw)) continue;
        const entry = raw as YtDlpSearchEntry;
        const id = asString(entry.id).trim();
        const title = asString(entry.title).trim();
        if (!id || !title) continue;
        const pageUrl = asString(entry.webpage_url).trim();
        const url = pageUrl || `https://www.youtube.com/watch?v=${id}`;
        const channel = asString(entry.uploader).trim() || asString(entry.channel).trim() || 'Unknown';
        const durationSec = Math.max(0, Math.round(asNumber(entry.duration)));
        const thumbnail = pickThumbnail(entry);
        const viewCount = Math.max(0, Math.round(asNumber(entry.view_count)));
        out.push({
            id,
            title,
            url,
            durationSec,
            channel,
            thumbnail,
            viewCount,
        });
        if (out.length >= maxResults) break;
    }
    return out;
};

const pruneExpiredSearchCache = (): void => {
    const now = Date.now();
    for (const [key, entry] of searchCache) {
        if (entry.expiresAt <= now) {
            searchCache.delete(key);
        }
    }
};

const getCachedSearch = (cacheKey: string): YoutubeSearchItem[] | null => {
    const cached = searchCache.get(cacheKey);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
        searchCache.delete(cacheKey);
        return null;
    }
    return cached.items;
};

const setCachedSearch = (cacheKey: string, items: YoutubeSearchItem[]): void => {
    pruneExpiredSearchCache();
    if (searchCache.size >= SEARCH_CACHE_MAX_ENTRIES) {
        const firstKey = searchCache.keys().next().value;
        if (typeof firstKey === 'string') {
            searchCache.delete(firstKey);
        }
    }
    searchCache.set(cacheKey, {
        expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
        items,
    });
};

export const searchYoutubeVideos = async (query: string, maxResults = 8): Promise<YoutubeSearchItem[]> => {
    const trimmed = query.trim();
    if (!trimmed) return [];

    if (!ytDlpWrap) {
        await initYtDlp();
    }

    const safeMax = Math.max(1, Math.min(12, Math.floor(maxResults)));
    const cacheKey = `${safeMax}:${trimmed.toLowerCase()}`;
    const cached = getCachedSearch(cacheKey);
    if (cached) {
        return cached;
    }

    const inflight = inflightSearches.get(cacheKey);
    if (inflight) {
        return await inflight;
    }

    const attempts = getPlayerClients();
    const cookieFile = getCookieFilePath();
    const task = (async (): Promise<YoutubeSearchItem[]> => {
        let lastErr: Error | null = null;
        let sawBotGate = false;

        for (const client of attempts) {
            try {
                const args = [
                    `ytsearch${safeMax}:${trimmed}`,
                    '--dump-single-json',
                    '--skip-download',
                    '--no-playlist',
                    '--no-warnings',
                    '--extractor-args', `youtube:player_client=${client}`,
                ];
                appendPolitenessArgs(args);
                if (cookieFile) {
                    args.push('--cookies', cookieFile);
                }
                const raw = await runYtDlpJson(args, 30000);
                if (!isRecord(raw)) {
                    setCachedSearch(cacheKey, []);
                    return [];
                }
                const resp = raw as YtDlpSearchResponse;
                const items = mapSearchEntries(resp.entries, safeMax);
                if (items.length > 0) {
                    setCachedSearch(cacheKey, items);
                    return items;
                }
            } catch (err) {
                lastErr = err instanceof Error ? err : new Error(String(err));
                if (isBotGateError(lastErr.message)) {
                    sawBotGate = true;
                }
            }
        }

        if (lastErr) {
            if (sawBotGate) {
                // 검색은 실패로 끊지 않고 빈 결과를 반환해 UX를 유지
                setCachedSearch(cacheKey, []);
                return [];
            }
            throw lastErr;
        }
        setCachedSearch(cacheKey, []);
        return [];
    })();

    inflightSearches.set(cacheKey, task);
    try {
        return await task;
    } finally {
        inflightSearches.delete(cacheKey);
    }
};

/**
 * YouTube URL에서 오디오 스트림 추출 (브라우저 호환 포맷)
 *
 * ffmpeg가 있으면: bestaudio → mp3 변환 (100% 브라우저 호환)
 * ffmpeg가 없으면: m4a/mp4 오디오 우선 → webm 폴백
 *
 * @param url - YouTube 비디오 URL
 * @returns 오디오 데이터 Buffer와 Content-Type
 */
export const extractYoutubeAudio = async (
    url: string,
    opts?: { preferMp4Only?: boolean }
): Promise<{ buffer: Buffer; contentType: string }> => {
    const cacheKey = `${opts?.preferMp4Only ? 'mp4' : 'any'}:${url}`;
    const cached = getCachedAudio(cacheKey);
    if (cached) {
        return cached;
    }

    const inflight = inflightAudios.get(cacheKey);
    if (inflight) {
        return await inflight;
    }

    const task = withExtractSemaphore(async (): Promise<{ buffer: Buffer; contentType: string }> => {
        if (!ytDlpWrap) {
            await initYtDlp();
        }

        const hasFfmpeg = await checkFfmpeg();
        const version = await runYtDlpVersion();
        console.log(`[YouTube] yt-dlp version: ${version}, ffmpeg available: ${hasFfmpeg}`);

        const playerClients = getPlayerClients();
        const cookieBrowsers = getCookieBrowsers();

        // 차단/봇감지 대응: 여러 전략을 순차 시도
        const attempts: Array<{ name: string; run: () => Promise<{ buffer: Buffer; contentType: string }> }> = [];
        if (hasFfmpeg) {
            for (const client of playerClients) {
                attempts.push({ name: `ffmpeg+${client}-client`, run: () => extractWithFfmpeg(url, client) });
            }
            for (const browser of cookieBrowsers) {
                for (const client of playerClients) {
                    attempts.push({
                        name: `ffmpeg+${client}+${browser}-cookies`,
                        run: () => extractWithFfmpeg(url, client, browser),
                    });
                }
            }
        }
        for (const client of playerClients) {
            attempts.push({
                name: `direct+${client}-client`,
                run: () => extractWithoutFfmpeg(url, client, undefined, opts?.preferMp4Only),
            });
        }
        for (const browser of cookieBrowsers) {
            for (const client of playerClients) {
                attempts.push({
                    name: `direct+${client}+${browser}-cookies`,
                    run: () => extractWithoutFfmpeg(url, client, browser, opts?.preferMp4Only),
                });
            }
        }

        let lastError: Error | null = null;
        let sawBotGate = false;
        let sawCookieDatabaseMissing = false;
        let updatedOnce = false;
        for (let round = 0; round < 2; round++) {
            for (const attempt of attempts) {
                try {
                    console.log(`[YouTube] attempt: ${attempt.name}${round > 0 ? ' (retry)' : ''}`);
                    const result = await attempt.run();
                    console.log(`[YouTube] success: ${attempt.name}`);
                    return result;
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    console.warn(`[YouTube] failed: ${attempt.name} -> ${message}`);
                    lastError = err instanceof Error ? err : new Error(message);
                    const lower = message.toLowerCase();
                    if (isBotGateError(lower)) {
                        sawBotGate = true;
                        break;
                    }
                    if (lower.includes('could not find') && lower.includes('cookies database')) {
                        sawCookieDatabaseMissing = true;
                    }
                }
            }

            // 봇/로그인 요구는 다른 전략을 돌려도 거의 해결되지 않음 (불필요한 트래픽 감소)
            if (sawBotGate) break;
            if (updatedOnce) break;
            const message = (lastError?.message || '').toLowerCase();
            const shouldUpdate = message.includes('signature')
                || message.includes('http error 403')
                || message.includes('unable to extract')
                || message.includes('requested format is not available')
                || message.includes('unsupported url');
            if (!shouldUpdate) break;
            console.log('[YouTube] updating yt-dlp binary and retrying...');
            await updateYtDlpBinary();
            updatedOnce = true;
            await initYtDlp();
            const newVersion = await runYtDlpVersion();
            console.log(`[YouTube] yt-dlp updated version: ${newVersion}`);
            const ffmpegNow = await checkFfmpeg();
            if (ffmpegNow && !hasFfmpeg) {
                for (const client of playerClients.slice().reverse()) {
                    attempts.unshift({ name: `ffmpeg+${client}-client(retry)`, run: () => extractWithFfmpeg(url, client) });
                }
            }
        }

        if (sawBotGate) {
            throw new Error('YouTube에서 봇/로그인 확인을 요구했습니다. 다른 영상 URL로 재시도하거나 잠시 후 다시 시도해주세요.');
        }
        if (sawCookieDatabaseMissing && cookieBrowsers.length > 0) {
            throw new Error('서버에 브라우저 쿠키 프로필이 없어 쿠키 기반 추출을 사용할 수 없습니다. 쿠키 옵션 없이 재시도합니다.');
        }
        throw new Error(lastError?.message || '오디오 추출에 실패했습니다.');
    });

    inflightAudios.set(cacheKey, task);
    try {
        const result = await task;
        setCachedAudio(cacheKey, result);
        return result;
    } finally {
        inflightAudios.delete(cacheKey);
    }
};

/** ffmpeg를 이용한 MP3 변환 추출 */
const extractWithFfmpeg = (
    url: string,
    playerClient: string,
    cookieBrowser?: 'chrome' | 'edge' | 'firefox'
): Promise<{ buffer: Buffer; contentType: string }> => {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let stderrData = '';
        let settled = false;
        let closed = false;
        const safeReject = (message: string): void => {
            if (settled) return;
            settled = true;
            reject(new Error(message));
        };
        const safeResolve = (result: { buffer: Buffer; contentType: string }): void => {
            if (settled) return;
            settled = true;
            resolve(result);
        };

        // yt-dlp: bestaudio를 다운로드하고 ffmpeg로 mp3 변환 (stdout 출력)
        const args = [
            url,
            '--no-playlist',
            '--no-warnings',
            ...(() => {
                const extra: string[] = [];
                appendPolitenessArgs(extra);
                return extra;
            })(),
            '--retries', '2',
            '--fragment-retries', '2',
            '--extractor-retries', '2',
            '--geo-bypass',
            '--force-ipv4',
            '--socket-timeout', '15',
            '--extractor-args', `youtube:player_client=${playerClient}`,
            '-f', 'bestaudio*/bestaudio/best',
            '--extract-audio',
            '--audio-format', 'mp3',
            '--audio-quality', '192K',
            '-o', '-',
        ];
        appendCookieArgs(args, cookieBrowser);
        const proc = ytDlpWrap.exec(args);

        const stream = proc.ytDlpProcess?.stdout;
        const stderr = proc.ytDlpProcess?.stderr;

        if (!stream) {
            safeReject('yt-dlp 프로세스 시작 실패 (stdout null)');
            return;
        }

        if (typeof proc.on === 'function') {
            proc.on('error', (err: Error) => {
                console.error('[YouTube] wrapper error:', err.message);
                console.error('[YouTube] stderr:', stderrData);
                safeReject(`YouTube 오디오 추출 실패: ${stderrData || err.message}`);
            });
        }

        proc.ytDlpProcess?.on('error', (err: Error) => {
            console.error('[YouTube] process error:', err.message);
            console.error('[YouTube] stderr:', stderrData);
            safeReject(`YouTube 오디오 추출 실패: ${stderrData || err.message}`);
        });

        stream.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
        });

        if (stderr) {
            stderr.on('data', (chunk: Buffer) => {
                stderrData += chunk.toString();
            });
            stderr.on('error', (err: Error) => {
                console.error('[YouTube] stderr stream error:', err.message);
            });
        }

        stream.on('end', () => {
            if (settled) return;
            if (chunks.length === 0 && closed) {
                console.error('[YouTube] stderr:', stderrData);
                safeReject(stderrData || '오디오 데이터를 가져올 수 없습니다.');
                return;
            }
            if (closed) {
                console.log(`[YouTube] Extracted ${Buffer.concat(chunks).length} bytes (mp3 via ffmpeg)`);
                safeResolve({ buffer: Buffer.concat(chunks), contentType: 'audio/mpeg' });
            }
        });

        stream.on('error', (err: Error) => {
            if (settled) return;
            console.error('[YouTube] stderr:', stderrData);
            safeReject(`YouTube 오디오 추출 실패: ${stderrData || err.message}`);
        });

        proc.ytDlpProcess?.on('close', (code: number | null) => {
            closed = true;
            if (settled) return;
            const buf = Buffer.concat(chunks);
            if (code !== 0) {
                safeReject(`yt-dlp 종료 코드 ${code ?? -1}: ${stderrData || '알 수 없는 오류'}`);
                return;
            }
            if (buf.length < 2048) {
                safeReject(stderrData || '추출된 오디오 데이터가 비정상적으로 작습니다.');
                return;
            }
            safeResolve({ buffer: buf, contentType: 'audio/mpeg' });
        });

        // 타임아웃 (2분)
        setTimeout(() => {
            if (settled) return;
            try { proc.ytDlpProcess?.kill(); } catch { }
            safeReject('오디오 추출 타임아웃 (2분)');
        }, 120000);
    });
};

/** ffmpeg 없이 브라우저 호환 포맷으로 직접 추출 */
const extractWithoutFfmpeg = (
    url: string,
    playerClient: string,
    cookieBrowser?: 'chrome' | 'edge' | 'firefox',
    preferMp4Only?: boolean
): Promise<{ buffer: Buffer; contentType: string }> => {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let stderrData = '';
        let settled = false;
        let closed = false;
        const safeReject = (message: string): void => {
            if (settled) return;
            settled = true;
            reject(new Error(message));
        };
        const safeResolve = (result: { buffer: Buffer; contentType: string }): void => {
            if (settled) return;
            settled = true;
            resolve(result);
        };

        // m4a(AAC)를 우선 시도 - 대부분의 브라우저에서 지원
        // webm/opus는 Safari에서 문제가 있을 수 있음
        const formatSelector = preferMp4Only
            ? 'bestaudio[ext=m4a]/bestaudio[ext=mp4]/bestaudio'
            : 'bestaudio[ext=m4a]/bestaudio[ext=mp4]/bestaudio[ext=webm]/bestaudio';
        const args: string[] = [
            url,
            '--no-playlist',
            '--no-warnings',
            ...(() => {
                const extra: string[] = [];
                appendPolitenessArgs(extra);
                return extra;
            })(),
            '--retries', '2',
            '--fragment-retries', '2',
            '--extractor-retries', '2',
            '--geo-bypass',
            '--force-ipv4',
            '--socket-timeout', '15',
            '--extractor-args', `youtube:player_client=${playerClient}`,
            '-f', formatSelector,
            '-o', '-',
        ];
        appendCookieArgs(args, cookieBrowser);
        const proc = ytDlpWrap.exec(args);

        const stream = proc.ytDlpProcess?.stdout;
        const stderr = proc.ytDlpProcess?.stderr;

        if (!stream) {
            safeReject('yt-dlp 프로세스 시작 실패 (stdout null)');
            return;
        }

        if (typeof proc.on === 'function') {
            proc.on('error', (err: Error) => {
                console.error('[YouTube] wrapper error:', err.message);
                console.error('[YouTube] stderr:', stderrData);
                safeReject(`YouTube 오디오 추출 실패: ${stderrData || err.message}`);
            });
        }

        proc.ytDlpProcess?.on('error', (err: Error) => {
            console.error('[YouTube] process error:', err.message);
            console.error('[YouTube] stderr:', stderrData);
            safeReject(`YouTube 오디오 추출 실패: ${stderrData || err.message}`);
        });

        stream.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
        });

        if (stderr) {
            stderr.on('data', (chunk: Buffer) => {
                stderrData += chunk.toString();
            });
            stderr.on('error', (err: Error) => {
                console.error('[YouTube] stderr stream error:', err.message);
            });
        }

        stream.on('end', () => {
            if (settled) return;
            if (chunks.length === 0 && closed) {
                console.error('[YouTube] stderr:', stderrData);
                settled = true;
                reject(new Error(stderrData || '오디오 데이터를 가져올 수 없습니다.'));
                return;
            }
            if (closed) {
                const buf = Buffer.concat(chunks);
                console.log(`[YouTube] Extracted ${buf.length} bytes (direct stream)`);

                // Content-Type 추측 (매직 바이트 기반)
                let contentType = 'audio/webm'; // default
                if (buf.length > 8) {
                    // MP4/M4A: starts with ftyp at offset 4
                    if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
                        contentType = 'audio/mp4';
                    }
                    // WebM: starts with 0x1A45DFA3
                    else if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) {
                        contentType = 'audio/webm';
                    }
                    // MP3: ID3 / frame header
                    else if ((buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) || (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0)) {
                        contentType = 'audio/mpeg';
                    }
                }
                console.log(`[YouTube] Detected content-type: ${contentType}`);
                safeResolve({ buffer: buf, contentType });
            }
        });

        stream.on('error', (err: Error) => {
            if (settled) return;
            console.error('[YouTube] stderr:', stderrData);
            safeReject(`YouTube 오디오 추출 실패: ${stderrData || err.message}`);
        });

        proc.ytDlpProcess?.on('close', (code: number | null) => {
            closed = true;
            if (settled) return;
            const buf = Buffer.concat(chunks);
            if (code !== 0) {
                safeReject(`yt-dlp 종료 코드 ${code ?? -1}: ${stderrData || '알 수 없는 오류'}`);
                return;
            }
            if (buf.length < 1024) {
                safeReject(stderrData || '추출된 오디오 데이터가 비정상적으로 작습니다.');
                return;
            }
            let contentType = 'audio/webm';
            if (buf.length > 8) {
                if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) contentType = 'audio/mp4';
                else if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) contentType = 'audio/webm';
                else if ((buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) || (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0)) contentType = 'audio/mpeg';
            }
            safeResolve({ buffer: buf, contentType });
        });

        // 타임아웃 (2분)
        setTimeout(() => {
            if (settled) return;
            try { proc.ytDlpProcess?.kill(); } catch { }
            safeReject('오디오 추출 타임아웃 (2분)');
        }, 120000);
    });
};
