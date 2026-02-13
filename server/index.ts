/* === Express 서버 - YouTube 오디오 추출 === */
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractYoutubeAudio, searchYoutubeVideos } from './youtube';

const app = express();
const PORT = Number(process.env.PORT || 3001);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_DIR = path.resolve(__dirname, '..', 'dist');

app.use(cors());
app.use(express.json());

app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
});

const extractYoutubeId = (rawUrl: string): string | null => {
    const input = rawUrl.trim();
    if (!input) return null;
    if (/^[\w-]{11}$/.test(input)) return input;
    try {
        const parsed = new URL(input);
        const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
        const pathParts = parsed.pathname.split('/').filter(Boolean);
        const v = parsed.searchParams.get('v');
        const id = v
            || (host === 'youtu.be' ? pathParts[0] : null)
            || ((pathParts[0] === 'shorts' || pathParts[0] === 'embed' || pathParts[0] === 'live') ? pathParts[1] : null);
        return id && /^[\w-]{11}$/.test(id) ? id : null;
    } catch {
        return null;
    }
};

/** YouTube 검색 엔드포인트 */
app.get('/api/youtube/search', async (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : 8;
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(12, Math.floor(limitRaw))) : 8;

    if (query.length < 2) {
        res.status(400).json({ error: '검색어는 2자 이상이어야 합니다' });
        return;
    }

    try {
        const items = await searchYoutubeVideos(query, limit);
        res.json({ items });
    } catch (err) {
        const message = err instanceof Error ? err.message : '알 수 없는 오류';
        res.status(500).json({ error: `검색 실패: ${message}` });
    }
});

/** YouTube 오디오 추출 엔드포인트 */
app.post('/api/youtube/audio', async (req, res) => {
    const { url, preferMp4Only } = req.body;

    // 입력 검증
    if (!url || typeof url !== 'string') {
        res.status(400).json({ error: 'URL이 필요합니다' });
        return;
    }

    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        res.status(400).json({ error: '유효하지 않은 URL 형식입니다' });
        return;
    }

    // YouTube URL 검증 (watch / youtu.be / shorts / embed / live 허용)
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const isYoutubeHost = host === 'youtube.com'
        || host === 'youtu.be'
        || host === 'm.youtube.com'
        || host === 'music.youtube.com'
        || host === 'youtube-nocookie.com';
    const videoId = extractYoutubeId(url);
    if (!isYoutubeHost || !videoId) {
        res.status(400).json({ error: '유효하지 않은 YouTube URL입니다' });
        return;
    }

    try {
        const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const result = await extractYoutubeAudio(canonicalUrl, {
            preferMp4Only: !!preferMp4Only,
        });
        res.set('Content-Type', result.contentType);
        res.set('Content-Length', String(result.buffer.length));
        res.set('Cache-Control', 'no-store');
        res.send(result.buffer);
    } catch (err) {
        const message = err instanceof Error ? err.message : '알 수 없는 오류';
        const lower = message.toLowerCase();
        if (lower.includes('봇/로그인 확인') || lower.includes('sign in') || lower.includes('captcha') || lower.includes('bot')) {
            res.status(429).json({ error: `오디오 추출 실패: ${message}` });
            return;
        }
        if (lower.includes('타임아웃') || lower.includes('timeout')) {
            res.status(504).json({ error: `오디오 추출 실패: ${message}` });
            return;
        }
        res.status(502).json({ error: `오디오 추출 실패: ${message}` });
    }
});

if (fs.existsSync(DIST_DIR)) {
    app.use(express.static(DIST_DIR));
    app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api/')) {
            next();
            return;
        }
        res.sendFile(path.join(DIST_DIR, 'index.html'));
    });
}

app.listen(PORT, () => {
    // 서버 시작 로그
    process.stdout.write(`\n🎵 리듬튜브 서버 실행 중: http://localhost:${PORT}\n`);
    if (fs.existsSync(DIST_DIR)) {
        process.stdout.write(`📦 정적 파일 서빙: ${DIST_DIR}\n`);
    }
});
