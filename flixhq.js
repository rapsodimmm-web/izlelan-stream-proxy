/**
 * FlixHQ Scraper — @consumet/extensions gerektirmez
 * Doğrudan flixhq.to/moviee.net'ten M3U8 çeker
 */
const axios = require('axios');

const BASE_URL = 'https://flixhq.to';
const TIMEOUT = 12000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';

const headers = {
  'User-Agent': UA,
  'Referer': BASE_URL + '/',
  'X-Requested-With': 'XMLHttpRequest',
};

/**
 * Film/dizi ara
 */
async function searchFlixHQ(query) {
  const url = `${BASE_URL}/search/${encodeURIComponent(query.replace(/\s+/g, '-'))}`;
  const res = await axios.get(url, { headers, timeout: TIMEOUT });

  const results = [];
  const re = /href="\/(?:movie|tv)\/watch-([^"]+)-(\d+)" title="([^"]+)"/g;
  let m;
  while ((m = re.exec(res.data)) !== null) {
    results.push({ slug: m[1], id: m[2], title: m[3] });
  }
  return results;
}

/**
 * Sunucu ID'lerini al (embed sunucuları)
 */
async function getServerIds(mediaId, type, season = null, episode = null) {
  let url;
  if (type === 'movie') {
    url = `${BASE_URL}/ajax/movie/episodes/${mediaId}`;
  } else {
    // Önce sezon/bölüm ID'lerini al
    const seasonsUrl = `${BASE_URL}/ajax/v2/tv/seasons/${mediaId}`;
    const seasRes = await axios.get(seasonsUrl, { headers, timeout: TIMEOUT });

    // Sezon listesi parse
    const seasonRe = /data-id="(\d+)"/g;
    const seasonIds = [];
    let sm;
    while ((sm = seasonRe.exec(seasRes.data)) !== null) {
      seasonIds.push(sm[1]);
    }

    const targetSeason = season || 1;
    const seasonId = seasonIds[targetSeason - 1] || seasonIds[0];
    if (!seasonId) return [];

    const epsUrl = `${BASE_URL}/ajax/v2/season/episodes/${seasonId}`;
    const epsRes = await axios.get(epsUrl, { headers, timeout: TIMEOUT });

    const epRe = /data-id="(\d+)"/g;
    const epIds = [];
    let em;
    while ((em = epRe.exec(epsRes.data)) !== null) {
      epIds.push(em[1]);
    }

    const targetEp = episode || 1;
    const epId = epIds[targetEp - 1] || epIds[0];
    if (!epId) return [];

    url = `${BASE_URL}/ajax/v2/episode/servers/${epId}`;
  }

  const res = await axios.get(url, { headers, timeout: TIMEOUT });
  const serverRe = /data-id="(\d+)"[^>]*>([^<]+)</g;
  const servers = [];
  let sv;
  while ((sv = serverRe.exec(res.data)) !== null) {
    servers.push({ id: sv[1], name: sv[2].trim() });
  }
  return servers;
}

/**
 * Embed URL'den M3U8 çıkar
 */
async function extractM3U8FromEmbed(serverId, type) {
  // Önce embed URL'yi al
  const linkUrl = `${BASE_URL}/ajax/${type === 'movie' ? 'movie' : 'v2/episode'}/sources/${serverId}`;
  const linkRes = await axios.get(linkUrl, { headers, timeout: TIMEOUT });
  const embedData = typeof linkRes.data === 'string' ? JSON.parse(linkRes.data) : linkRes.data;

  let embedUrl = embedData?.link || embedData?.url;
  if (!embedUrl) return null;

  // UpCloud/VidCloud için özel işlem
  if (embedUrl.includes('upcloud') || embedUrl.includes('vidcloud')) {
    return await extractFromUpCloud(embedUrl);
  }

  // Genel M3U8 arama
  try {
    const res = await axios.get(embedUrl, {
      headers: { ...headers, Referer: BASE_URL + '/' },
      timeout: TIMEOUT,
    });
    const m3u8Match = res.data.match(/["']([^"']+\.m3u8[^"']*)/);
    if (m3u8Match?.[1]?.startsWith('http')) return m3u8Match[1];
  } catch { /* devam */ }

  return null;
}

/**
 * UpCloud/VidCloud embed'den M3U8
 */
async function extractFromUpCloud(embedUrl) {
  try {
    const id = embedUrl.split('/').pop()?.split('?')[0];
    if (!id) return null;

    const isUpCloud = embedUrl.includes('upcloud');
    const apiBase = isUpCloud
      ? 'https://dokicloud.one/ajax/embed-4/getSources'
      : 'https://rabbitstream.net/ajax/embed-4/getSources';

    const apiRes = await axios.get(`${apiBase}?id=${id}`, {
      headers: {
        ...headers,
        Referer: embedUrl,
        'X-Requested-With': 'XMLHttpRequest',
      },
      timeout: TIMEOUT,
    });

    const data = typeof apiRes.data === 'string' ? JSON.parse(apiRes.data) : apiRes.data;

    if (Array.isArray(data?.sources)) {
      const m3u8 = data.sources.find(s => s.file && (s.file.includes('.m3u8') || s.type === 'hls'));
      if (m3u8?.file) return m3u8.file;
    }

    // Şifreli kaynak — decrypt gerekir (şimdilik atla)
    if (typeof data?.sources === 'string') {
      // Şifreli, decrypt etmeyi dene
      return null;
    }
  } catch { /* devam */ }
  return null;
}

/**
 * Ana fonksiyon: title + type ile M3U8 URL döndür
 */
async function getFlixHQStream(title, year, type, season = 1, episode = 1) {
  // Arama
  const query = year ? `${title} ${year}` : title;
  let results = await searchFlixHQ(query);

  if (!results.length && year) {
    results = await searchFlixHQ(title); // Yıl olmadan tekrar dene
  }

  if (!results.length) return null;

  // En iyi eşleşme
  const titleLower = title.toLowerCase();
  const match = results.find(r => {
    const t = r.title.toLowerCase();
    return t === titleLower || t.includes(titleLower) || titleLower.includes(t);
  }) || results[0];

  if (!match) return null;
  console.log(`[FLIXHQ] Eşleşme: "${match.title}" id=${match.id}`);

  // Sunucuları al
  const servers = await getServerIds(match.id, type, season, episode);
  if (!servers.length) return null;

  console.log(`[FLIXHQ] ${servers.length} sunucu bulundu:`, servers.map(s => s.name).join(', '));

  // Sırayla dene
  for (const server of servers) {
    try {
      const m3u8 = await extractM3U8FromEmbed(server.id, type);
      if (m3u8) {
        console.log(`[FLIXHQ ✅] ${server.name}: ${m3u8.slice(0, 80)}`);
        return { url: m3u8, server: server.name, isM3U8: true };
      }
    } catch (e) {
      console.log(`[FLIXHQ ❌] ${server.name}: ${e.message}`);
    }
  }

  return null;
}

module.exports = { getFlixHQStream };
