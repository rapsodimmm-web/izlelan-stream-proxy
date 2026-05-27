# izlelan Stream Proxy

Film ve diziler için otomatik M3U8 stream çeken proxy sunucu.

## Yerel Test

```bash
npm install
npm start
```

Tarayıcıda aç: http://localhost:3001

## API Endpoint'leri

| Endpoint | Açıklama |
|----------|----------|
| `GET /stream?id=603&type=movie` | Film stream'e yönlendir |
| `GET /stream?id=1396&type=tv&s=1&e=1` | Dizi bölümüne yönlendir |
| `GET /stream-info?id=603&type=movie` | Stream bilgisi (JSON) |
| `GET /m3u/all` | Tüm içeriklerin M3U playlist'i |
| `GET /m3u/all?type=movie` | Sadece filmler |
| `GET /m3u/all?type=tv` | Sadece diziler |
| `GET /m3u?genre=28&type=movie` | Belirli kategori M3U |
| `GET /health` | Sunucu durumu |

## IPTV Paneline Import Etme

1. Bu sunucuyu deploy edin (Render.com - ücretsiz)
2. Sunucu URL'inizi alın: `https://izlelan-stream-proxy.onrender.com`
3. veryplayer.site admin panelinde → **Playlist Ekle**
4. M3U URL olarak girin: `https://izlelan-stream-proxy.onrender.com/m3u/all`
5. ✅ Tüm filmler ve diziler kategorik olarak görünür!

## Render.com Ücretsiz Deploy

1. GitHub'a push edin: `git push`
2. [render.com](https://render.com) → New → Web Service
3. GitHub repo'nuzu seçin
4. Ayarlar otomatik gelir (`render.yaml` sayesinde)
5. Deploy edin → URL alın

## Nasıl Çalışır?

```
IPTV Uygulaması → proxy/stream?id=603&type=movie
                        ↓
              moviesapi.club → M3U8 bulunamazsa
              vidsrc.me      → M3U8 bulunamazsa
              autoembed.cc   → M3U8 bulunamazsa
              embed.su       → bulunamazsa
                        ↓
              embed URL fallback (IPTV Smarters ile çalışır)
                        ↓
              302 Redirect → Film oynar ✅
```

## Kategoriler

### Filmler
Aksiyon, Macera, Komedi, Dram, Korku, Bilim Kurgu, Romantik,
Gerilim, Suç, Animasyon, Fantezi, Tarih, Savaş, Gizem

### Diziler  
Aksiyon Macera, Komedi, Dram, Bilim Kurgu Fantezi, Suç, Anime
