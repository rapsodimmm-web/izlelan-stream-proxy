/**
 * izlelan Stream Proxy v3
 * ========================
 * Gerçek M3U8 stream URL'leri çeker — harici büyük kütüphane yok.
 * IPTV Smarters, TiviMate, VLC, Smart TV'de çalışır.
 */

const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const NodeCache = require('node-cache');
const { getFlixHQStream } = require('./flixhq');

const app  = express();
const PORT = process.env.PORT || 3001;

const streamCache = new NodeCache({ stdTTL: 7200  }); // 2 saat
const metaCache   = new NodeCache({ stdTTL: 86400 }); // 24 saat

app.use(cors());
app.use(express.json());

const TMDB_KEY  = process.env.TMDB_KEY || '8265bd1679663a7ea12ac168da84d2e8';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMG_BASE  = 'https://image.tmdb.org/t/p/w500';
const TIMEOUT   = 12000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';

// ─── TMDB ───────────────────────────────────────────────────────────────────

async function tmdbGet(endpoint, params = {}) {
  const res = await axios.get(`${TMDB_BASE}${endpoint}`, {
    params: { api_key: TMDB_KEY, language: 'tr-TR', ...params },
    timeout: TIMEOUT,
  });
  return res.data;
}

async function getTmdbMeta(tmdbId, type) {
  const key = `meta_${type}_${tmdbId}`;
  const hit = metaCache.get(key);
  if (hit) return hit;

  const data = await tmdbGet(`/${type}/${tmdbId}`, {
    append_to_response: 'external_ids',
    language: 'en-US',
  });

  const result = {
    title:   data.title || data.name || '',
    year:    (data.release_date || data.first_air_date || '').slice(0, 4),
    imdbId:  data.external_ids?.imdb_id || null,
    poster:  data.poster_path ? `${IMG_BASE}${data.poster_path}` : '',
    overview: (data.overview || '').replace(/[\r\n"]/g, ' ').slice(0, 200),
    rating:  data.vote_average?.toFixed(1) || '',
  };

  metaCache.set(key, result);
  return result;
}

// ─── FALLBACK KAYNAKLARI ────────────────────────────────────────────────────

async function fromVidsrc(imdbId, tmdbId, type, s, e) {
  const id  = imdbId || tmdbId;
  const url = type === 'movie'
    ? `https://vidsrc.to/embed/movie/${id}`
    : `https://vidsrc.to/embed/tv/${id}/${s}/${e}`;

  const res = await axios.get(url, {
    timeout: TIMEOUT,
    headers: { 'User-Agent': UA, Referer: 'https://vidsrc.to/' },
  });

  const patterns = [
    /file:\s*["']([^"']+\.m3u8[^"']*)/,
    /"src"\s*:\s*["']([^"']+\.m3u8[^"']*)/,
    /hls\.loadSource\(["']([^"']+)/,
  ];
  for (const p of patterns) {
    const m = res.data.match(p);
    if (m?.[1]?.startsWith('http')) {
      return { url: m[1], isM3U8: true, server: 'vidsrc.to' };
    }
  }
  return null;
}

async function fromMoviesApi(tmdbId, type, s, e) {
  const url = type === 'movie'
    ? `https://moviesapi.club/movie/${tmdbId}`
    : `https://moviesapi.club/tv/${tmdbId}-${s}-${e}`;

  const res = await axios.get(url, {
    timeout: TIMEOUT,
    headers: { 'User-Agent': UA, Referer: 'https://moviesapi.club/' },
  });

  const patterns = [
    /file:\s*["']([^"']+\.m3u8[^"']*)/,
    /"file"\s*:\s*["']([^"']+\.m3u8[^"']*)/,
  ];
  for (const p of patterns) {
    const m = res.data.match(p);
    if (m?.[1]?.startsWith('http')) {
      return { url: m[1], isM3U8: true, server: 'moviesapi' };
    }
  }
  return null;
}

// ─── ANA STREAM BULUCU ──────────────────────────────────────────────────────

async function findStream(tmdbId, type, season = 1, episode = 1) {
  const cacheKey = `stream_${type}_${tmdbId}_s${season}e${episode}`;
  const cached = streamCache.get(cacheKey);
  if (cached) { console.log(`[CACHE] ${cacheKey}`); return cached; }

  let meta = { title: '', year: '', imdbId: null, poster: '' };
  try {
    meta = await getTmdbMeta(tmdbId, type);
    console.log(`[META] "${meta.title}" (${meta.year}) imdb=${meta.imdbId}`);
  } catch (e) { console.log(`[META ERR] ${e.message}`); }

  // Kaynaklar sırayla denenir
  const sources = [
    // 1. FlixHQ — gerçek M3U8
    async () => {
      if (!meta.title) return null;
      return getFlixHQStream(meta.title, meta.year, type, season, episode);
    },
    // 2. vidsrc.to — M3U8 parse
    async () => fromVidsrc(meta.imdbId, tmdbId, type, season, episode),
    // 3. moviesapi.club
    async () => fromMoviesApi(tmdbId, type, season, episode),
  ];

  for (const src of sources) {
    try {
      const r = await src();
      if (r?.url) {
        const final = {
          ...r,
          isM3U8: r.isM3U8 ?? r.url.includes('.m3u8'),
          title: meta.title,
          poster: meta.poster,
          cachedAt: new Date().toISOString(),
        };
        streamCache.set(cacheKey, final, final.isM3U8 ? 7200 : 900);
        return final;
      }
    } catch (e) { console.log(`[SRC ERR] ${e.message}`); }
  }

  // Embed fallback
  const id = meta.imdbId || tmdbId;
  const embedUrl = type === 'movie'
    ? `https://vidsrc.to/embed/movie/${id}`
    : `https://vidsrc.to/embed/tv/${id}/${season}/${episode}`;

  const fallback = {
    url: embedUrl, isM3U8: false, server: 'embed-fallback',
    title: meta.title, poster: meta.poster,
    cachedAt: new Date().toISOString(),
  };
  streamCache.set(cacheKey, fallback, 900);
  return fallback;
}

// ─── KATEGORİLER ────────────────────────────────────────────────────────────

const MOVIE_GENRES = [
  { id: 28,    name: '🔥 Aksiyon' },
  { id: 35,    name: '😂 Komedi' },
  { id: 18,    name: '🎭 Dram' },
  { id: 27,    name: '👻 Korku' },
  { id: 878,   name: '🚀 Bilim Kurgu' },
  { id: 10749, name: '❤️ Romantik' },
  { id: 12,    name: '🗺️ Macera' },
  { id: 53,    name: '😰 Gerilim' },
  { id: 80,    name: '🔍 Suc' },
  { id: 16,    name: '🎨 Animasyon' },
  { id: 14,    name: '🧙 Fantezi' },
  { id: 36,    name: '⚔️ Tarih' },
];

const TV_GENRES = [
  { id: 10759, name: '💥 Aksiyon Dizi' },
  { id: 35,    name: '😂 Komedi Dizi' },
  { id: 18,    name: '🎭 Dram Dizi' },
  { id: 10765, name: '🚀 Sci-Fi Fantezi' },
  { id: 80,    name: '🔍 Suc Dizi' },
  { id: 16,    name: '🎌 Anime' },
];

// ─── ENDPOINT'LER ───────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({
  status: 'ok',
  version: 'v3',
  cache_streams: streamCache.keys().length,
  cache_meta: metaCache.keys().length,
  uptime_minutes: Math.floor(process.uptime() / 60),
}));

app.get('/stream', async (req, res) => {
  const { id, type = 'movie', s = 1, e = 1 } = req.query;
  if (!id) return res.status(400).json({ error: 'id gerekli' });

  try {
    const result = await findStream(id, type, +s, +e);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Stream-Source', result.server || '');
    res.setHeader('X-Is-M3U8', String(result.isM3U8));
    return res.redirect(302, result.url);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/stream-info', async (req, res) => {
  const { id, type = 'movie', s = 1, e = 1 } = req.query;
  if (!id) return res.status(400).json({ error: 'id gerekli' });
  try {
    res.json(await findStream(id, type, +s, +e));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/m3u/all', async (req, res) => {
  const host = req.query.host || `${req.protocol}://${req.get('host')}`;
  const type = req.query.type || 'all';

  const lines = ['#EXTM3U x-tvg-url=""'];
  const seen  = new Set();

  const fetchGenre = async (genreId, genreName, ct) => {
    try {
      const data = await tmdbGet(`/discover/${ct}`, {
        with_genres: genreId, sort_by: 'popularity.desc', page: 1,
      });
      for (const item of (data.results || [])) {
        const uid = `${ct}-${item.id}`;
        if (seen.has(uid)) continue;
        seen.add(uid);
        const title    = (item.title || item.name || '').replace(/,/g, ' ');
        const year     = (item.release_date || item.first_air_date || '').slice(0, 4);
        const poster   = item.poster_path ? `${IMG_BASE}${item.poster_path}` : '';
        const overview = (item.overview || '').replace(/[\r\n"]/g, ' ').slice(0, 120);
        const rating   = item.vote_average?.toFixed(1) || '';
        lines.push(
          `#EXTINF:-1 tvg-id="tmdb-${item.id}" tvg-name="${title}" tvg-logo="${poster}" tvg-year="${year}" tvg-rating="${rating}" tvg-plot="${overview}" group-title="${genreName}",${title}${year ? ` (${year})` : ''}`,
          `${host}/stream?id=${item.id}&type=${ct}`
        );
      }
    } catch (e) { console.error(`Genre ${genreId}:`, e.message); }
  };

  const tasks = [];
  if (type !== 'tv')    MOVIE_GENRES.forEach(g => tasks.push(fetchGenre(g.id, g.name, 'movie')));
  if (type !== 'movie') TV_GENRES.forEach(g => tasks.push(fetchGenre(g.id, g.name, 'tv')));
  await Promise.all(tasks);

  res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="izlelan.m3u"');
  res.send(lines.join('\n'));
});

app.get('/', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    name: 'izlelan Stream Proxy v3',
    iptv_m3u: `${base}/m3u/all`,
    test_film: `${base}/stream-info?id=603&type=movie`,
    test_dizi: `${base}/stream-info?id=1396&type=tv&s=1&e=1`,
  });
});

// ─── BAŞLAT ─────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   izlelan Stream Proxy v3 — FlixHQ  ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`🚀 Port: ${PORT}`);
  console.log(`📺 M3U: http://localhost:${PORT}/m3u/all`);
  console.log(`🎬 Test: http://localhost:${PORT}/stream-info?id=603&type=movie`);
});
