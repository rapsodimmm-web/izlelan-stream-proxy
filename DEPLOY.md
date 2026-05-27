# 🚀 izlelan Stream Proxy — Deploy Rehberi

## Adım 1: GitHub'a Yükle

stream-proxy klasörünü GitHub'a yükleyin:
1. github.com → New repository → "izlelan-stream-proxy" 
2. Public veya Private (fark etmez)
3. Klasörü push edin

## Adım 2: Render.com'da Deploy Et (ÜCRETSİZ)

1. [render.com](https://render.com) → Sign up (GitHub ile giriş)
2. **New +** → **Web Service**
3. GitHub repo'nuzu seçin: `izlelan-stream-proxy`
4. Ayarlar:
   - **Name:** `izlelan-stream-proxy`
   - **Region:** Frankfurt (Türkiye'ye yakın)
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** Free
5. **Create Web Service** → Deploy başlar (~2 dakika)
6. URL alırsınız: `https://izlelan-stream-proxy.onrender.com`

## Adım 3: IPTV Paneline Import Et

veryplayer.site admin panelinde:
1. **Playlist Ekle** → M3U URL seçin
2. Şu URL'yi girin:
   ```
   https://izlelan-stream-proxy.onrender.com/m3u/all
   ```
3. İsim: "izlelan Film & Dizi"
4. ✅ Kategorik olarak tüm film ve diziler görünür!

## Endpoint'ler (Deploy Sonrası)

| Ne | URL |
|----|-----|
| Tüm içerikler M3U | `https://...onrender.com/m3u/all` |
| Sadece filmler | `https://...onrender.com/m3u/all?type=movie` |
| Sadece diziler | `https://...onrender.com/m3u/all?type=tv` |
| Tek film stream | `https://...onrender.com/stream?id=603&type=movie` |
| Tek dizi bölümü | `https://...onrender.com/stream?id=1396&type=tv&s=1&e=1` |
| Sağlık kontrolü | `https://...onrender.com/health` |

## Nasıl Çalışır?

Müşteri IPTV uygulamasında bir filme tıklar:
1. IPTV app → `https://proxy/stream?id=603&type=movie` çağırır
2. Sunucu sırayla dener:
   - moviesapi.club → M3U8 var mı?
   - vidsrc.me → M3U8 var mı?
   - autoembed.cc → M3U8 var mı?
   - embed.su → M3U8 var mı?
3. Bulursa → gerçek M3U8'e redirect eder → **Film oynar! ✅**
4. Bulamazsa → embed URL → IPTV Smarters'da oynar ✅

## Kategoriler (M3U'da group-title)

🎬 Filmler: Aksiyon, Macera, Komedi, Dram, Korku, Bilim Kurgu, Romantik, Gerilim, Suç, Animasyon
📺 Diziler: Aksiyon Macera, Komedi, Dram, Bilim Kurgu Fantezi, Suç, Anime
