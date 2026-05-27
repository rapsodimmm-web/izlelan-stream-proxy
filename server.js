/**
 * izlelan Stream Proxy Server
 * ===========================
 * M3U8 stream URL'lerini kaynaklardan çeker ve IPTV uygulamalarına yönlendirir.
 *
 * Endpoint'ler:
 *   GET /stream?id=603&type=movie          → Film stream (TMDB ID)
 *   GET /stream?id=1396&type=tv&s=1&e=1   → Dizi bölümü stream
 *   GET /m3u?genre=28&type=movie           → Kategori M3U playlist
 *   GET /m3u/all                           → Tüm popüler içerikler M3U
 *   GET /health                            → Sunucu durumu
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const NodeCache = require('node-cache');

const app = express();
const PORT = process.env.PORT || 3001;
const cache = new NodeCache({ stdTTL: 3600 }); // 1 saatlik önbellek

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────
// AYARLAR
// ─────────────────────────────────────────
const TMDB_KEY = process.env.TMDB_KEY || '8265bd1679663a7ea12ac168da84d2e8';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMG_BASE = 'https://image.tmdb.org/t/p/w500';
const TIMEOUT = 8000;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8',
};

// ─────────────────────────────────────────
// STREAM KAYNAKLARI
// ─────────────────────────────────────────

/**
 * moviesapi.club — M3U8 URL'i HTML içinden parse eder
 */
async function fromMoviesApiClub(tmdbId, type, season = 1, episode = 1) {
  const url = type === 'movie'
    ? `https://moviesapi.club/movie/${tmdbId}`
    : `https://moviesapi.club/tv/${tmdbId}-${season}-${episode}`;

  const res = await axios.get(url, {
    timeout: TIMEOUT,
    headers: { ...HEADERS, Referer: 'https://moviesapi.club/' },
  });

  // Farklı m3u8 pattern'leri dene
  const patterns = [
    /file:\s*"([^"]+\.m3u8[^"]*)"/,
    /file:\s*'([^']+\.m3u8[^']*)'/,
    /"file"\s*:\s*"([^"]+\.m3u8[^"]*)"/,
    /source\s*src="([^"]+\.m3u8[^"]*)"/,
    /hls\.loadSource\(['"]([^'"]+\.m3u8[^'"]*)['"]\)/,
  ];

  for (const p of patterns) {
    const m = res.data.match(p);
    if (m && m[1].startsWith('http')) return m[1];
  }
  return null;
}

/**
 * vidsrc.me — JSON API endpoint
 */
async function fromVidsrcMe(imdbId, type, season = 1, episode = 1) {
  if (!imdbId) return null;
  const url = type === 'movie'
    ? `https://vidsrc.me/embed/movie?imdb=${imdbId}`
    : `https://vidsrc.me/embed/tv?imdb=${imdbId}&season=${season}&episode=${episode}`;

  const res = await axios.get(url, {
    timeout: TIMEOUT,
    headers: { ...HEADERS, Referer: 'https://vidsrc.me/' },
  });

  const patterns = [
    /"src"\s*:\s*"([^"]+\.m3u8[^"]*)"/,
    /file:\s*"([^"]+\.m3u8[^"]*)"/,
    /hls\.loadSource\(['"]([^'"]+\.m3u8[^'"]*)['"]\)/,
  ];

  for (const p of patterns) {
    const m = res.data.match(p);
    if (m && m[1].startsWith('http')) return m[1];
  }
  return null;
}

/**
 * autoembed.cc
 */
async function fromAutoEmbed(tmdbId, type, season = 1, episode = 1) {
  const url = type === 'movie'
    ? `https://autoembed.cc/movie/tmdb/${tmdbId}`
    : `https://autoembed.cc/tv/tmdb/${tmdbId}-${season}-${episode}`;

  const res = await axios.get(url, {
    timeout: TIMEOUT,
    headers: { ...HEADERS, Referer: 'https://autoembed.cc/' },
    maxRedirects: 5,
  });

  const patterns = [
    /file:\s*"([^"]+\.m3u8[^"]*)"/,
    /"src"\s*:\s*"([^"]+\.m3u8[^"]*)"/,
    /hls\.loadSource\(['"]([^'"]+\.m3u8[^'"]*)['"]\)/,
  ];

  for (const p of patterns) {
    const m = res.data.match(p);
    if (m && m[1].startsWith('http')) return m[1];
  }
  return null;
}

/**
 * embed.su fallback
 */
async function fromEmbedSu(imdbId, type) {
  if (!imdbId) return null;
  try {
    const url = `https://embed.su/embed/${type === 'movie' ? 'movie' : 'tv'}/${imdbId}`;
    const res = await axios.get(url, {
      timeout: TIMEOUT,
      headers: { ...HEADERS, Referer: 'https://embed.su/' },
    });
    const m = res.data.match(/file:\s*"([^"]+\.m3u8[^"]*)"/);
    if (m && m[1].startsWith('http')) return m[1];
  } catch { /* devam */ }
  return null;
}

/**
 * IMDB ID'yi TMDB'den al (önbellekli)
 */
async function getImdbId(tmdbId, type) {
  const key = `imdb_${type}_${tmdbId}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  try {
    const endpoint = type === 'movie'
      ? `${TMDB_BASE}/movie/${tmdbId}/external_ids`
      : `${TMDB_BASE}/tv/${tmdbId}/external_ids`;
    const res = await axios.get(endpoint, {
      params: { api_key: TMDB_KEY },
      timeout: TIMEOUT,
    });
    const id = res.data.imdb_id || null;
    cache.set(key, id);
    return id;
  } catch {
    return null;
  }
}

/**
 * Stream URL bul — tüm kaynakları sırayla dene
 */
async function findStreamUrl(tmdbId, type, season = 1, episode = 1) {
  const cacheKey = `stream_${type}_${tmdbId}_${season}_${episode}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    console.log(`[CACHE HIT] ${type}/${tmdbId}`);
    return cached;
  }

  console.log(`[STREAM] Searching: ${type}/${tmdbId} S${season}E${episode}`);

  const imdbId = await getImdbId(tmdbId, type);
  console.log(`[IMDB] ${tmdbId} → ${imdbId || 'bulunamadı'}`);

  // Kaynakları paralel dene (ilk başarılı olanı kullan)
  const sources = [
    { name: 'moviesapi.club', fn: () => fromMoviesApiClub(tmdbId, type, season, episode) },
    { name: 'vidsrc.me',      fn: () => fromVidsrcMe(imdbId, type, season, episode) },
    { name: 'autoembed.cc',   fn: () => fromAutoEmbed(tmdbId, type, season, episode) },
    { name: 'embed.su',       fn: () => fromEmbedSu(imdbId, type) },
  ];

  for (const source of sources) {
    try {
      const url = await source.fn();
      if (url && url.startsWith('http')) {
        console.log(`[✅ M3U8] ${source.name}: ${url.slice(0, 80)}...`);
        cache.set(cacheKey, { url, isM3U8: true, source: source.name });
        return { url, isM3U8: true, source: source.name };
      }
    } catch (e) {
      console.log(`[❌] ${source.name}: ${e.message}`);
    }
  }

  // Hiçbirinden M3U8 alınamadı — embed fallback
  const embedUrl = imdbId
    ? `https://vidsrc.to/embed/${type === 'movie' ? 'movie' : 'tv'}/${imdbId}${type === 'tv' ? `/${season}/${episode}` : ''}`
    : `https://vidsrc.to/embed/${type === 'movie' ? 'movie' : 'tv'}/${tmdbId}${type === 'tv' ? `/${season}/${episode}` : ''}`;

  console.log(`[⚠️ EMB] Fallback embed: ${embedUrl}`);
  const result = { url: embedUrl, isM3U8: false, source: 'vidsrc.to' };
  cache.set(cacheKey, result, 900); // embed URL'leri 15 dakika cache'le
  return result;
}

// ─────────────────────────────────────────
// ENDPOINT'LER
// ─────────────────────────────────────────

/**
 * GET /health
 * Sunucu durumu kontrolü
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    cache_keys: cache.keys().length,
    uptime_minutes: Math.floor(process.uptime() / 60),
  });
});

/**
 * GET /stream
 * Stream URL'ye yönlendir (IPTV uygulamaları için)
 *
 * Params:
 *   id    - TMDB ID
 *   type  - movie | tv
 *   s     - sezon (tv için, default 1)
 *   e     - bölüm (tv için, default 1)
 */
app.get('/stream', async (req, res) => {
  const { id, type = 'movie', s = 1, e = 1 } = req.query;

  if (!id) {
    return res.status(400).json({ error: 'id parametresi gerekli' });
  }

  try {
    const { url, isM3U8, source } = await findStreamUrl(id, type, parseInt(s), parseInt(e));

    // CORS & cache headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', isM3U8 ? 'no-cache' : 'max-age=900');
    res.setHeader('X-Stream-Source', source);
    res.setHeader('X-Is-M3U8', isM3U8.toString());

    // IPTV uygulaması için redirect
    return res.redirect(302, url);

  } catch (err) {
    console.error('[ERROR]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /stream-info
 * Stream bilgisini JSON olarak döndür (test için)
 */
app.get('/stream-info', async (req, res) => {
  const { id, type = 'movie', s = 1, e = 1 } = req.query;

  if (!id) return res.status(400).json({ error: 'id gerekli' });

  try {
    const result = await findStreamUrl(id, type, parseInt(s), parseInt(e));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /m3u
 * Kategori bazlı M3U playlist oluştur
 *
 * Params:
 *   genre - TMDB genre ID (28=Aksiyon, 35=Komedi vb.)
 *   type  - movie | tv
 *   page  - sayfa no (default 1)
 *   host  - bu sunucunun URL'si (default: isteğin adresi)
 */
app.get('/m3u', async (req, res) => {
  const { genre, type = 'movie', page = 1 } = req.query;
  const host = req.query.host || `${req.protocol}://${req.get('host')}`;

  if (!genre) return res.status(400).json({ error: 'genre parametresi gerekli' });

  try {
    // TMDB'den içerik listesi al
    const tmdbRes = await axios.get(`${TMDB_BASE}/discover/${type}`, {
      params: {
        api_key: TMDB_KEY, language: 'tr-TR',
        with_genres: genre, sort_by: 'popularity.desc', page,
      },
      timeout: TIMEOUT,
    });

    const items = tmdbRes.data.results || [];
    const lines = ['#EXTM3U'];

    for (const item of items) {
      const title = (item.title || item.name || 'Bilinmeyen').replace(/,/g, ' ');
      const year = (item.release_date || item.first_air_date || '').slice(0, 4);
      const poster = item.poster_path ? `${IMG_BASE}${item.poster_path}` : '';
      const overview = (item.overview || '').replace(/[\r\n"]/g, ' ').slice(0, 150);
      const rating = item.vote_average?.toFixed(1) || '';

      // Stream URL → sunucu proxy endpoint'i
      const streamUrl = `${host}/stream?id=${item.id}&type=${type}`;

      lines.push(
        `#EXTINF:-1 tvg-id="tmdb-${item.id}" tvg-name="${title}" tvg-logo="${poster}" tvg-year="${year}" tvg-rating="${rating}" tvg-plot="${overview}" group-title="izlelan",${title}${year ? ` (${year})` : ''}`,
        streamUrl
      );
    }

    res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="izlelan_genre${genre}.m3u"`);
    res.send(lines.join('\n'));

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /m3u/all
 * Popüler film ve dizilerin büyük M3U playlist'i
 * Tüm stream URL'leri bu proxy sunucuya işaret eder
 */
app.get('/m3u/all', async (req, res) => {
  const host = req.query.host || `${req.protocol}://${req.get('host')}`;
  const type = req.query.type || 'all'; // all | movie | tv

  const MOVIE_GENRES = [
    { id: 28, name: 'Aksiyon' }, { id: 35, name: 'Komedi' },
    { id: 18, name: 'Dram' }, { id: 27, name: 'Korku' },
    { id: 878, name: 'Bilim Kurgu' }, { id: 10749, name: 'Romantik' },
    { id: 12, name: 'Macera' }, { id: 53, name: 'Gerilim' },
    { id: 80, name: 'Suc' }, { id: 16, name: 'Animasyon' },
  ];

  const TV_GENRES = [
    { id: 10759, name: 'Aksiyon Macera' }, { id: 35, name: 'Komedi Dizi' },
    { id: 18, name: 'Dram Dizi' }, { id: 10765, name: 'Bilim Kurgu Fantezi' },
    { id: 80, name: 'Suc Dizi' }, { id: 16, name: 'Anime' },
  ];

  const lines = ['#EXTM3U x-tvg-url=""'];
  const seen = new Set();

  const fetchGenre = async (genreId, genreName, contentType) => {
    try {
      const tmdbRes = await axios.get(`${TMDB_BASE}/discover/${contentType}`, {
        params: {
          api_key: TMDB_KEY, language: 'tr-TR',
          with_genres: genreId, sort_by: 'popularity.desc', page: 1,
        },
        timeout: TIMEOUT,
      });

      const items = tmdbRes.data.results || [];
      for (const item of items) {
        const uid = `${contentType}-${item.id}`;
        if (seen.has(uid)) continue;
        seen.add(uid);

        const title = (item.title || item.name || 'Bilinmeyen').replace(/,/g, ' ');
        const year = (item.release_date || item.first_air_date || '').slice(0, 4);
        const poster = item.poster_path ? `${IMG_BASE}${item.poster_path}` : '';
        const overview = (item.overview || '').replace(/[\r\n"]/g, ' ').slice(0, 120);
        const rating = item.vote_average?.toFixed(1) || '';
        const groupLabel = contentType === 'movie' ? `🎬 ${genreName}` : `📺 ${genreName}`;

        const streamUrl = `${host}/stream?id=${item.id}&type=${contentType}`;

        lines.push(
          `#EXTINF:-1 tvg-id="tmdb-${item.id}" tvg-name="${title}" tvg-logo="${poster}" tvg-year="${year}" tvg-rating="${rating}" tvg-plot="${overview}" group-title="${groupLabel}",${title}${year ? ` (${year})` : ''}`,
          streamUrl
        );
      }
    } catch (e) {
      console.error(`Genre ${genreId} error:`, e.message);
    }
  };

  // Tüm kategorileri topla
  const tasks = [];
  if (type !== 'tv') {
    for (const g of MOVIE_GENRES) tasks.push(fetchGenre(g.id, g.name, 'movie'));
  }
  if (type !== 'movie') {
    for (const g of TV_GENRES) tasks.push(fetchGenre(g.id, g.name, 'tv'));
  }

  await Promise.all(tasks);

  res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="izlelan_all.m3u"');
  res.send(lines.join('\n'));
});

/**
 * GET /
 * Basit API dokümantasyonu
 */
app.get('/', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    name: 'izlelan Stream Proxy',
    version: '1.0.0',
    endpoints: {
      stream: `${base}/stream?id=603&type=movie`,
      stream_tv: `${base}/stream?id=1396&type=tv&s=1&e=1`,
      stream_info: `${base}/stream-info?id=603&type=movie`,
      m3u_genre: `${base}/m3u?genre=28&type=movie`,
      m3u_all: `${base}/m3u/all`,
      m3u_movies: `${base}/m3u/all?type=movie`,
      m3u_tv: `${base}/m3u/all?type=tv`,
      health: `${base}/health`,
    },
    example_m3u_for_iptv_panel: `${base}/m3u/all`,
    tip: 'M3U URL\'yi IPTV panelinize import edin. Stream URL\'leri otomatik olarak M3U8 çeker.',
  });
});

// ─────────────────────────────────────────
// BAŞLAT
// ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     izlelan Stream Proxy Server          ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`🚀 Sunucu: http://localhost:${PORT}`);
  console.log(`📺 M3U URL: http://localhost:${PORT}/m3u/all`);
  console.log(`🔗 Film örnek: http://localhost:${PORT}/stream?id=603&type=movie`);
  console.log(`🔗 Dizi örnek: http://localhost:${PORT}/stream?id=1396&type=tv&s=1&e=1`);
});
