/**
 * izlelan Stream Proxy v2 — Consumet + FlixHQ
 * =============================================
 * Gerçek M3U8 stream URL'leri çeker.
 * IPTV Smarters, TiviMate, VLC, Smart TV — hepsinde çalışır.
 *
 * Endpoint'ler:
 *   GET /stream?id=603&type=movie          → Gerçek M3U8'e redirect
 *   GET /stream?id=1396&type=tv&s=1&e=1   → Dizi bölümü M3U8
 *   GET /stream-info?id=603&type=movie     → Stream bilgisi JSON
 *   GET /m3u/all                           → Tam kategorik M3U playlist
 *   GET /m3u/all?type=movie                → Sadece filmler
 *   GET /m3u/all?type=tv                   → Sadece diziler
 *   GET /health                            → Sunucu durumu
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const NodeCache = require('node-cache');

const app = express();
const PORT = process.env.PORT || 3001;

// Önbellek: M3U8 URL'leri 2 saat, embed 15 dk
const streamCache = new NodeCache({ stdTTL: 7200 });
const metaCache  = new NodeCache({ stdTTL: 86400 }); // 24 saat

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────
// AYARLAR
// ─────────────────────────────────────────
const TMDB_KEY  = process.env.TMDB_KEY || '8265bd1679663a7ea12ac168da84d2e8';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMG_BASE  = 'https://image.tmdb.org/t/p/w500';
const TIMEOUT   = 12000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';

// ─────────────────────────────────────────
// CONSUMET / FlixHQ ENTEGRASYONU
// ─────────────────────────────────────────
let FlixHQ = null;
let flixhq = null;

try {
  const consumet = require('@consumet/extensions');
  FlixHQ = consumet.MOVIES?.FlixHQ;
  if (FlixHQ) {
    flixhq = new FlixHQ();
    console.log('✅ Consumet/FlixHQ yüklendi');
  }
} catch (e) {
  console.log('⚠️ Consumet yüklenemedi:', e.message);
}

// ─────────────────────────────────────────
// TMDB YARDIMCI FONKSİYONLAR
// ─────────────────────────────────────────
async function tmdbGet(endpoint, params = {}) {
  const res = await axios.get(`${TMDB_BASE}${endpoint}`, {
    params: { api_key: TMDB_KEY, language: 'tr-TR', ...params },
    timeout: TIMEOUT,
  });
  return res.data;
}

async function getTmdbMeta(tmdbId, type) {
  const cacheKey = `meta_${type}_${tmdbId}`;
  const cached = metaCache.get(cacheKey);
  if (cached) return cached;

  const data = await tmdbGet(`/${type}/${tmdbId}`, {
    append_to_response: 'external_ids',
    language: 'en-US', // Arama için İngilizce başlık lazım
  });

  const result = {
    title:   data.title || data.name || '',
    year:    (data.release_date || data.first_air_date || '').slice(0, 4),
    imdbId:  data.external_ids?.imdb_id || null,
    poster:  data.poster_path ? `${IMG_BASE}${data.poster_path}` : '',
    overview: data.overview || '',
    rating:  data.vote_average?.toFixed(1) || '',
    seasons: data.number_of_seasons || 1,
  };

  metaCache.set(cacheKey, result);
  return result;
}

// ─────────────────────────────────────────
// STREAM KAYNAKLARI
// ─────────────────────────────────────────

/**
 * Kaynak 1: Consumet/FlixHQ — gerçek M3U8 döndürür
 */
async function fromConsumet(title, year, type, season = 1, episode = 1) {
  if (!flixhq) return null;

  try {
    console.log(`[CONSUMET] Aranıyor: "${title}" (${year}) ${type}`);
    const searchRes = await flixhq.search(`${title} ${year}`);

    if (!searchRes?.results?.length) {
      // Yıl olmadan tekrar dene
      const res2 = await flixhq.search(title);
      if (!res2?.results?.length) return null;
      searchRes.results = res2.results;
    }

    // En iyi eşleşmeyi bul
    const target = searchRes.results.find(r => {
      const t = (r.title || r.name || '').toLowerCase();
      const q = title.toLowerCase();
      return t === q || t.includes(q) || q.includes(t);
    }) || searchRes.results[0];

    if (!target) return null;
    console.log(`[CONSUMET] Bulundu: "${target.title || target.name}" id=${target.id}`);

    // Media bilgisi al
    const info = await flixhq.fetchMediaInfo(target.id);
    if (!info?.episodes?.length) return null;

    // Doğru bölümü bul
    let episode_obj;
    if (type === 'movie') {
      episode_obj = info.episodes[0];
    } else {
      episode_obj = info.episodes.find(
        ep => ep.season === season && ep.number === episode
      ) || info.episodes.find(ep => ep.season === season) || info.episodes[0];
    }

    if (!episode_obj) return null;

    // Stream al — birden fazla server dene
    const servers = ['upcloud', 'vidcloud', 'server'];
    for (const server of servers) {
      try {
        const sources = await flixhq.fetchEpisodeSources(episode_obj.id, target.id, server);
        if (!sources?.sources?.length) continue;

        // M3U8 URL'leri filtrele ve sırala (en yüksek kalite önce)
        const m3u8Sources = sources.sources
          .filter(s => s.url && (s.url.includes('.m3u8') || s.isM3U8))
          .sort((a, b) => {
            const qa = parseInt(a.quality) || 0;
            const qb = parseInt(b.quality) || 0;
            return qb - qa;
          });

        if (m3u8Sources.length) {
          const best = m3u8Sources[0];
          console.log(`[CONSUMET ✅] ${server}: ${best.url.slice(0, 80)}...`);
          return {
            url: best.url,
            quality: best.quality || 'auto',
            subtitles: sources.subtitles || [],
            headers: sources.headers || {},
            server,
          };
        }

        // M3U8 yoksa normal URL
        const anySource = sources.sources[0];
        if (anySource?.url) {
          console.log(`[CONSUMET ✅] ${server} (non-m3u8): ${anySource.url.slice(0, 80)}`);
          return {
            url: anySource.url,
            quality: anySource.quality || 'auto',
            subtitles: sources.subtitles || [],
            headers: sources.headers || {},
            server,
          };
        }
      } catch (serverErr) {
        console.log(`[CONSUMET ❌] Server ${server}: ${serverErr.message}`);
      }
    }
  } catch (e) {
    console.log(`[CONSUMET ❌] ${e.message}`);
  }
  return null;
}

/**
 * Kaynak 2: vidsrc.to — HTML'den M3U8 parse et
 */
async function fromVidsrcTo(imdbId, tmdbId, type, season = 1, episode = 1) {
  const id = imdbId || tmdbId;
  const url = type === 'movie'
    ? `https://vidsrc.to/embed/movie/${id}`
    : `https://vidsrc.to/embed/tv/${id}/${season}/${episode}`;

  try {
    const res = await axios.get(url, {
      timeout: TIMEOUT,
      headers: { 'User-Agent': UA, Referer: 'https://vidsrc.to/' },
    });
    const patterns = [
      /file:\s*["']([^"']+\.m3u8[^"']*)/,
      /"src"\s*:\s*["']([^"']+\.m3u8[^"']*)/,
      /source\s+src=["']([^"']+\.m3u8[^"']*)/,
      /hls\.loadSource\(["']([^"']+)/,
    ];
    for (const p of patterns) {
      const m = res.data.match(p);
      if (m?.[1]?.startsWith('http')) {
        console.log(`[VIDSRC.TO ✅] ${m[1].slice(0, 80)}`);
        return { url: m[1], quality: 'auto', server: 'vidsrc.to' };
      }
    }
  } catch (e) {
    console.log(`[VIDSRC.TO ❌] ${e.message}`);
  }
  return null;
}

/**
 * Kaynak 3: 2embed.cc
 */
async function from2Embed(imdbId, tmdbId, type, season = 1, episode = 1) {
  const id = imdbId || tmdbId;
  const url = type === 'movie'
    ? `https://www.2embed.cc/embed/${id}`
    : `https://www.2embed.cc/embedtv/${id}&s=${season}&e=${episode}`;

  try {
    const res = await axios.get(url, {
      timeout: TIMEOUT,
      headers: { 'User-Agent': UA, Referer: 'https://www.2embed.cc/' },
    });
    const m = res.data.match(/file:\s*["']([^"']+\.m3u8[^"']*)/);
    if (m?.[1]?.startsWith('http')) {
      console.log(`[2EMBED ✅] ${m[1].slice(0, 80)}`);
      return { url: m[1], quality: 'auto', server: '2embed' };
    }
  } catch (e) {
    console.log(`[2EMBED ❌] ${e.message}`);
  }
  return null;
}

/**
 * Kaynak 4: moviesapi.club
 */
async function fromMoviesApi(tmdbId, type, season = 1, episode = 1) {
  const url = type === 'movie'
    ? `https://moviesapi.club/movie/${tmdbId}`
    : `https://moviesapi.club/tv/${tmdbId}-${season}-${episode}`;

  try {
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
        console.log(`[MOVIESAPI ✅] ${m[1].slice(0, 80)}`);
        return { url: m[1], quality: 'auto', server: 'moviesapi' };
      }
    }
  } catch (e) {
    console.log(`[MOVIESAPI ❌] ${e.message}`);
  }
  return null;
}

/**
 * ANA STREAM BULMA FONKSİYONU
 */
async function findStream(tmdbId, type, season = 1, episode = 1) {
  const cacheKey = `stream_${type}_${tmdbId}_s${season}e${episode}`;
  const cached = streamCache.get(cacheKey);
  if (cached) {
    console.log(`[CACHE] ${cacheKey}`);
    return cached;
  }

  // TMDB meta al
  let meta = { title: '', year: '', imdbId: null };
  try {
    meta = await getTmdbMeta(tmdbId, type);
    console.log(`[META] "${meta.title}" (${meta.year}) imdb=${meta.imdbId}`);
  } catch (e) {
    console.log(`[META ❌] ${e.message}`);
  }

  // Kaynakları sırayla dene
  const sources = [
    () => fromConsumet(meta.title, meta.year, type, season, episode),
    () => fromVidsrcTo(meta.imdbId, tmdbId, type, season, episode),
    () => from2Embed(meta.imdbId, tmdbId, type, season, episode),
    () => fromMoviesApi(tmdbId, type, season, episode),
  ];

  for (const source of sources) {
    try {
      const result = await source();
      if (result?.url) {
        const isM3U8 = result.url.includes('.m3u8') || result.isM3U8 === true;
        const final = {
          ...result,
          isM3U8,
          title: meta.title,
          poster: meta.poster,
          cachedAt: new Date().toISOString(),
        };
        // M3U8 ise uzun, değilse kısa cache
        streamCache.set(cacheKey, final, isM3U8 ? 7200 : 900);
        return final;
      }
    } catch (e) {
      console.log(`[SOURCE ERR] ${e.message}`);
    }
  }

  // Hiçbirinden alınamadı — embed fallback
  const embedUrl = meta.imdbId
    ? `https://vidsrc.to/embed/${type === 'movie' ? 'movie' : 'tv'}/${meta.imdbId}${type === 'tv' ? `/${season}/${episode}` : ''}`
    : `https://vidsrc.to/embed/${type === 'movie' ? 'movie' : 'tv'}/${tmdbId}${type === 'tv' ? `/${season}/${episode}` : ''}`;

  const fallback = {
    url: embedUrl,
    isM3U8: false,
    server: 'embed-fallback',
    title: meta.title,
    poster: meta.poster,
    cachedAt: new Date().toISOString(),
  };
  streamCache.set(cacheKey, fallback, 900);
  return fallback;
}

// ─────────────────────────────────────────
// KATEGORİLER
// ─────────────────────────────────────────
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

// ─────────────────────────────────────────
// ENDPOINT'LER
// ─────────────────────────────────────────

/** GET /health */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    consumet: flixhq ? 'active' : 'unavailable',
    cache_streams: streamCache.keys().length,
    cache_meta: metaCache.keys().length,
    uptime_minutes: Math.floor(process.uptime() / 60),
  });
});

/** GET /stream — M3U8'e redirect */
app.get('/stream', async (req, res) => {
  const { id, type = 'movie', s = 1, e = 1 } = req.query;
  if (!id) return res.status(400).json({ error: 'id gerekli' });

  try {
    const result = await findStream(id, type, parseInt(s), parseInt(e));

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Stream-Source', result.server || 'unknown');
    res.setHeader('X-Is-M3U8', result.isM3U8?.toString() || 'false');

    if (result.isM3U8) {
      // Gerçek M3U8 — header gerekebilir, proxy üzerinden servis et
      if (result.headers && Object.keys(result.headers).length > 0) {
        // Header gerektiren stream'leri proxy üzerinden ilet
        try {
          const streamRes = await axios.get(result.url, {
            headers: { ...result.headers, 'User-Agent': UA },
            responseType: 'stream',
            timeout: TIMEOUT,
          });
          res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
          streamRes.data.pipe(res);
          return;
        } catch {
          // Pipe başarısız olursa redirect dene
        }
      }
      return res.redirect(302, result.url);
    }

    return res.redirect(302, result.url);
  } catch (err) {
    console.error('[STREAM ERR]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/** GET /stream-info — JSON stream bilgisi */
app.get('/stream-info', async (req, res) => {
  const { id, type = 'movie', s = 1, e = 1 } = req.query;
  if (!id) return res.status(400).json({ error: 'id gerekli' });

  try {
    const result = await findStream(id, type, parseInt(s), parseInt(e));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /m3u/all — Tam kategorik M3U playlist */
app.get('/m3u/all', async (req, res) => {
  const host = req.query.host || `${req.protocol}://${req.get('host')}`;
  const type = req.query.type || 'all';

  const lines = ['#EXTM3U x-tvg-url=""'];
  const seen = new Set();

  const fetchGenre = async (genreId, genreName, contentType) => {
    try {
      const data = await tmdbGet(`/discover/${contentType}`, {
        with_genres: genreId,
        sort_by: 'popularity.desc',
        page: 1,
        language: 'tr-TR',
      });

      for (const item of (data.results || [])) {
        const uid = `${contentType}-${item.id}`;
        if (seen.has(uid)) continue;
        seen.add(uid);

        const title = (item.title || item.name || '').replace(/,/g, ' ');
        const year  = (item.release_date || item.first_air_date || '').slice(0, 4);
        const poster  = item.poster_path ? `${IMG_BASE}${item.poster_path}` : '';
        const overview = (item.overview || '').replace(/[\r\n"]/g, ' ').slice(0, 120);
        const rating  = item.vote_average?.toFixed(1) || '';

        // Stream URL → proxy'e işaret eder, her zaman M3U8 çekmeye çalışır
        const streamUrl = `${host}/stream?id=${item.id}&type=${contentType}`;

        lines.push(
          `#EXTINF:-1 tvg-id="tmdb-${item.id}" tvg-name="${title}" tvg-logo="${poster}" tvg-year="${year}" tvg-rating="${rating}" tvg-plot="${overview}" group-title="${genreName}",${title}${year ? ` (${year})` : ''}`,
          streamUrl
        );
      }
    } catch (e) {
      console.error(`Genre ${genreId} hatası:`, e.message);
    }
  };

  const tasks = [];
  if (type !== 'tv')    MOVIE_GENRES.forEach(g => tasks.push(fetchGenre(g.id, g.name, 'movie')));
  if (type !== 'movie') TV_GENRES.forEach(g => tasks.push(fetchGenre(g.id, g.name, 'tv')));
  await Promise.all(tasks);

  res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="izlelan.m3u"');
  res.send(lines.join('\n'));
});

/** GET / — API dokümantasyonu */
app.get('/', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    name: 'izlelan Stream Proxy v2',
    consumet_status: flixhq ? '✅ aktif' : '⚠️ yok',
    endpoints: {
      film_stream:     `${base}/stream?id=603&type=movie`,
      dizi_stream:     `${base}/stream?id=1396&type=tv&s=1&e=1`,
      stream_bilgi:    `${base}/stream-info?id=603&type=movie`,
      m3u_hepsi:      `${base}/m3u/all`,
      m3u_filmler:    `${base}/m3u/all?type=movie`,
      m3u_diziler:    `${base}/m3u/all?type=tv`,
      saglik:         `${base}/health`,
    },
    iptv_paneli_icin: `${base}/m3u/all`,
  });
});

// ─────────────────────────────────────────
// BAŞLAT
// ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║     izlelan Stream Proxy v2 — Consumet/FlixHQ   ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`🚀 Port: ${PORT}`);
  console.log(`🎬 Consumet: ${flixhq ? 'AKTİF ✅' : 'DEVRE DIŞI ⚠️'}`);
  console.log(`📺 M3U: http://localhost:${PORT}/m3u/all`);
});
