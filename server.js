/**
 * izlelan Stream Proxy v4
 * ========================
 * Gerçek M3U8 stream URL'leri çeker.
 * IPTV Smarters, TiviMate, VLC, Smart TV'de çalışır.
 */

const express   = require('express');
const axios     = require('axios');
const cors      = require('cors');
const NodeCache = require('node-cache');
const https     = require('https');

const app  = express();
const PORT = process.env.PORT || 3001;

const streamCache = new NodeCache({ stdTTL: 7200  }); // 2 saat
const metaCache   = new NodeCache({ stdTTL: 86400 }); // 24 saat

app.use(cors());
app.use(express.json());

// Crash guard
process.on('uncaughtException',  err => console.error('[UncaughtException]', err.message));
process.on('unhandledRejection', err => console.error('[UnhandledRejection]', err));

const TMDB_KEY  = process.env.TMDB_KEY || '8265bd1679663a7ea12ac168da84d2e8';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMG_BASE  = 'https://image.tmdb.org/t/p/w500';
const TIMEOUT   = 15000;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
};

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
    title:    data.title || data.name || '',
    titleTR:  data.title || data.name || '',
    year:     (data.release_date || data.first_air_date || '').slice(0, 4),
    imdbId:   data.external_ids?.imdb_id || null,
    poster:   data.poster_path ? `${IMG_BASE}${data.poster_path}` : '',
    overview: (data.overview || '').replace(/[\r\n"]/g, ' ').slice(0, 200),
    rating:   data.vote_average?.toFixed(1) || '',
  };

  metaCache.set(key, result);
  return result;
}

// ─── STREAM KAYNAKLAR ───────────────────────────────────────────────────────

// Kaynak 1: vidsrc.me (M3U8 parse)
async function fromVidsrcMe(imdbId, tmdbId, type, s, e) {
  const id  = imdbId || `tmdb:${tmdbId}`;
  const url = type === 'movie'
    ? `https://vidsrc.me/embed/movie?imdb=${imdbId || ''}&tmdb=${tmdbId}`
    : `https://vidsrc.me/embed/tv?imdb=${imdbId || ''}&tmdb=${tmdbId}&season=${s}&episode=${e}`;

  const res = await axios.get(url, {
    timeout: TIMEOUT,
    headers: { ...HEADERS, Referer: 'https://vidsrc.me/' },
  });

  const patterns = [
    /file:\s*["']([^"']+\.m3u8[^"']*)/g,
    /"src"\s*:\s*["']([^"']+\.m3u8[^"']*)/g,
    /hls\.loadSource\(["']([^"']+)/g,
    /source\s*=\s*["']([^"']+\.m3u8[^"']*)/g,
  ];

  for (const p of patterns) {
    const m = p.exec(res.data);
    if (m?.[1]?.startsWith('http')) {
      return { url: m[1], isM3U8: true, server: 'vidsrc.me' };
    }
  }
  return null;
}

// Kaynak 2: vidsrc.to (embed page parse)
async function fromVidsrcTo(imdbId, tmdbId, type, s, e) {
  const id  = imdbId || tmdbId;
  const url = type === 'movie'
    ? `https://vidsrc.to/embed/movie/${id}`
    : `https://vidsrc.to/embed/tv/${id}/${s}/${e}`;

  const res = await axios.get(url, {
    timeout: TIMEOUT,
    headers: { ...HEADERS, Referer: 'https://vidsrc.to/' },
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

// Kaynak 3: moviesapi.club
async function fromMoviesApi(tmdbId, type, s, e) {
  const url = type === 'movie'
    ? `https://moviesapi.club/movie/${tmdbId}`
    : `https://moviesapi.club/tv/${tmdbId}-${s}-${e}`;

  const res = await axios.get(url, {
    timeout: TIMEOUT,
    headers: { ...HEADERS, Referer: 'https://moviesapi.club/' },
  });

  const patterns = [
    /file:\s*["']([^"']+\.m3u8[^"']*)/,
    /"file"\s*:\s*["']([^"']+\.m3u8[^"']*)/,
    /"url"\s*:\s*["']([^"']+\.m3u8[^"']*)/,
  ];

  for (const p of patterns) {
    const m = res.data.match(p);
    if (m?.[1]?.startsWith('http')) {
      return { url: m[1], isM3U8: true, server: 'moviesapi' };
    }
  }
  return null;
}

// Kaynak 4: 2embed.cc
async function from2Embed(imdbId, type, s, e) {
  if (!imdbId) return null;
  const url = type === 'movie'
    ? `https://www.2embed.cc/embed/${imdbId}`
    : `https://www.2embed.cc/embedtv/${imdbId}&s=${s}&e=${e}`;

  const res = await axios.get(url, {
    timeout: TIMEOUT,
    headers: { ...HEADERS, Referer: 'https://www.2embed.cc/' },
  });

  const m = res.data.match(/file:\s*["']([^"']+\.m3u8[^"']*)/);
  if (m?.[1]?.startsWith('http')) {
    return { url: m[1], isM3U8: true, server: '2embed' };
  }
  return null;
}

// ─── ANA STREAM BULUCU ──────────────────────────────────────────────────────

async function findStream(tmdbId, type, season = 1, episode = 1) {
  const cacheKey = `stream_${type}_${tmdbId}_s${season}e${episode}`;
  const cached = streamCache.get(cacheKey);
  if (cached) { console.log(`[CACHE HIT] ${cacheKey}`); return cached; }

  let meta = { title: '', year: '', imdbId: null, poster: '', overview: '' };
  try {
    meta = await getTmdbMeta(tmdbId, type === 'tv' ? 'tv' : 'movie');
    console.log(`[META] "${meta.title}" (${meta.year}) imdb=${meta.imdbId}`);
  } catch (e) { console.log(`[META ERR] ${e.message}`); }

  // Kaynakları sırayla dene
  const sources = [
    () => fromVidsrcMe(meta.imdbId, tmdbId, type, season, episode),
    () => fromVidsrcTo(meta.imdbId, tmdbId, type, season, episode),
    () => fromMoviesApi(tmdbId, type, season, episode),
    () => from2Embed(meta.imdbId, type, season, episode),
  ];

  for (const src of sources) {
    try {
      const r = await src();
      if (r?.url && r.isM3U8) {
        const final = {
          ...r,
          title: meta.title,
          poster: meta.poster,
          cachedAt: new Date().toISOString(),
        };
        console.log(`[STREAM ✅] ${r.server} → ${r.url.slice(0, 60)}...`);
        streamCache.set(cacheKey, final, 7200);
        return final;
      }
    } catch (e) { console.log(`[SRC ERR] ${e.constructor.name}: ${e.message.slice(0,80)}`); }
  }

  // Embed fallback (M3U8 bulunamazsa)
  const id = meta.imdbId || tmdbId;
  const embedUrl = type === 'movie'
    ? `https://vidsrc.to/embed/movie/${id}`
    : `https://vidsrc.to/embed/tv/${id}/${season}/${episode}`;

  console.log(`[FALLBACK] embed → ${embedUrl}`);
  const fallback = {
    url: embedUrl, isM3U8: false, server: 'embed-fallback',
    title: meta.title, poster: meta.poster,
    note: 'HLS bulunamadı — tarayıcıda açın',
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
  { id: 80,    name: '🔍 Suç' },
  { id: 16,    name: '🎨 Animasyon' },
  { id: 14,    name: '🧙 Fantezi' },
  { id: 36,    name: '⚔️ Tarih' },
];

const TV_GENRES = [
  { id: 10759, name: '💥 Aksiyon Dizi' },
  { id: 35,    name: '😂 Komedi Dizi' },
  { id: 18,    name: '🎭 Dram Dizi' },
  { id: 10765, name: '🚀 Sci-Fi Fantezi' },
  { id: 80,    name: '🔍 Suç Dizi' },
  { id: 16,    name: '🎌 Anime' },
];

// ─── ENDPOINT'LER ───────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({
  status: 'ok', version: 'v4',
  cache_streams: streamCache.keys().length,
  cache_meta: metaCache.keys().length,
  uptime_minutes: Math.floor(process.uptime() / 60),
}));

// Stream (yönlendirme)
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

// Stream info (JSON)
app.get('/stream-info', async (req, res) => {
  const { id, type = 'movie', s = 1, e = 1 } = req.query;
  if (!id) return res.status(400).json({ error: 'id gerekli' });
  try { res.json(await findStream(id, type, +s, +e)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// M3U içerik üretici (ortak fonksiyon)
async function buildM3U(host, type, page) {
  // Railway arkasında https olduğunu garanti et
  const safeHost = host.replace(/^http:/, 'https:');
  const baseHost = safeHost;

  const lines = ['#EXTM3U x-tvg-url=""'];
  const seen  = new Set();

  const fetchGenre = async (genreId, genreName, ct) => {
    try {
      const data = await tmdbGet(`/discover/${ct}`, {
        with_genres: genreId, sort_by: 'popularity.desc',
        page, language: 'tr-TR',
      });
      for (const item of (data.results || [])) {
        const uid = `${ct}-${item.id}`;
        if (seen.has(uid)) continue;
        seen.add(uid);
        const title    = (item.title || item.name || '').replace(/[,\r\n"]/g, ' ').trim();
        const year     = (item.release_date || item.first_air_date || '').slice(0, 4);
        const poster   = item.poster_path ? `${IMG_BASE}${item.poster_path}` : '';
        const overview = (item.overview || '').replace(/[\r\n",]/g, ' ').slice(0, 120).trim();
        const rating   = item.vote_average?.toFixed(1) || '';
        lines.push(
          `#EXTINF:-1 tvg-id="tmdb-${item.id}" tvg-name="${title}" tvg-logo="${poster}" tvg-year="${year}" tvg-rating="${rating}" tvg-plot="${overview}" group-title="${genreName}",${title}${year ? ` (${year})` : ''}`,
          `${baseHost}/stream?id=${item.id}&type=${ct}`
        );
      }
    } catch (e) { console.error(`Genre ${genreId} err: ${e.message}`); }
  };

  const tasks = [];
  if (type !== 'tv')    MOVIE_GENRES.forEach(g => tasks.push(fetchGenre(g.id, g.name, 'movie')));
  if (type !== 'movie') TV_GENRES.forEach(g    => tasks.push(fetchGenre(g.id, g.name, 'tv')));
  await Promise.all(tasks);

  return lines.join('\n');
}

// M3U Playlist — tüm içerikler
app.get('/m3u/all', async (req, res) => {
  const host = req.query.host || `${req.protocol}://${req.get('host')}`;
  const type = req.query.type || 'all';
  const page = parseInt(req.query.page) || 1;
  try {
    const m3uContent = await buildM3U(host, type, page);
    res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="izlelan.m3u"');
    res.end(Buffer.from(m3uContent, 'utf8'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// M3U sadece filmler
app.get('/m3u/filmler', async (req, res) => {
  const host = `${req.protocol}://${req.get('host')}`;
  try {
    const m3uContent = await buildM3U(host, 'movie', 1);
    res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="izlelan-filmler.m3u"');
    res.end(Buffer.from(m3uContent, 'utf8'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// M3U sadece diziler
app.get('/m3u/diziler', async (req, res) => {
  const host = `${req.protocol}://${req.get('host')}`;
  try {
    const m3uContent = await buildM3U(host, 'tv', 1);
    res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="izlelan-diziler.m3u"');
    res.end(Buffer.from(m3uContent, 'utf8'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// M3U Canlı TV (TRT Resmi Akışları - Direct M3U8)
app.get('/m3u/canli-tv', (req, res) => {
  const m3uContent = `#EXTM3U x-tvg-url=""
#EXTINF:-1 tvg-id="trt1" tvg-name="TRT 1 HD" tvg-logo="https://upload.wikimedia.org/wikipedia/commons/thumb/c/ca/TRT_1_logo.svg/512px-TRT_1_logo.svg.png" group-title="Ulusal Kanallar",TRT 1 HD
https://tv-trt1.medya.trt.com.tr/master.m3u8
#EXTINF:-1 tvg-id="trt-spor" tvg-name="TRT Spor HD" tvg-logo="https://upload.wikimedia.org/wikipedia/commons/thumb/a/ad/TRT_Spor_logo.svg/512px-TRT_Spor_logo.svg.png" group-title="Spor",TRT Spor HD
https://tv-trtspor1.medya.trt.com.tr/master.m3u8
#EXTINF:-1 tvg-id="trt-haber" tvg-name="TRT Haber HD" tvg-logo="https://upload.wikimedia.org/wikipedia/commons/thumb/e/e7/TRT_Haber_logo.svg/512px-TRT_Haber_logo.svg.png" group-title="Haber",TRT Haber HD
https://tv-trthaber.medya.trt.com.tr/master.m3u8
#EXTINF:-1 tvg-id="trt-belgesel" tvg-name="TRT Belgesel HD" tvg-logo="https://upload.wikimedia.org/wikipedia/commons/thumb/4/4e/TRT_Belgesel_logo.svg/512px-TRT_Belgesel_logo.svg.png" group-title="Belgesel",TRT Belgesel HD
https://tv-trtbelgesel.medya.trt.com.tr/master.m3u8
#EXTINF:-1 tvg-id="trt-cocuk" tvg-name="TRT Çocuk HD" tvg-logo="https://upload.wikimedia.org/wikipedia/commons/thumb/1/14/TRT_%C3%87ocuk_logo.svg/512px-TRT_%C3%87ocuk_logo.svg.png" group-title="Çocuk",TRT Çocuk HD
https://tv-trtcocuk.medya.trt.com.tr/master.m3u8
#EXTINF:-1 tvg-id="trt-muzik" tvg-name="TRT Müzik HD" tvg-logo="https://upload.wikimedia.org/wikipedia/commons/thumb/e/eb/TRT_M%C3%BCzik_logo.svg/512px-TRT_M%C3%BCzik_logo.svg.png" group-title="Müzik",TRT Müzik HD
https://tv-trtmuzik.medya.trt.com.tr/master.m3u8`;

  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="izlelan-canli-tv.m3u"');
  res.end(Buffer.from(m3uContent, 'utf8'));
});

// Cache temizle
app.post('/cache/clear', (req, res) => {
  streamCache.flushAll();
  metaCache.flushAll();
  res.json({ cleared: true });
});

// Ana sayfa
app.get('/', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    name: 'izlelan Stream Proxy v4',
    version: '4.0.0',
    endpoints: {
      m3u_all:      `${base}/m3u/all`,
      m3u_filmler:  `${base}/m3u/filmler`,
      m3u_diziler:  `${base}/m3u/diziler`,
      m3u_canli_tv: `${base}/m3u/canli-tv`,
      stream_film:  `${base}/stream?id=603&type=movie`,
      stream_dizi:  `${base}/stream?id=1396&type=tv&s=1&e=1`,
      stream_info:  `${base}/stream-info?id=603&type=movie`,
      health:       `${base}/health`,
    },
    test_players: {
      vlc:           'Medya → Ağ Akışı Aç → M3U URL yapıştır',
      iptv_smarters: 'Oynatıcı Ekle → M3U URL → URL yapıştır',
      tivimate:      'Oynatıcı Ekle → M3U URL',
      smart_tv:      'IPTV uygulamasına M3U URL ekle',
    },
  });
});

// ─── BAŞLAT ─────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   izlelan Stream Proxy v4            ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`🚀 Port: ${PORT}`);
  console.log(`📺 M3U: http://localhost:${PORT}/m3u/all`);
  console.log(`🎬 Test: http://localhost:${PORT}/stream-info?id=603&type=movie`);
});
