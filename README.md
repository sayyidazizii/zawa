# ZAWA CORS Proxy

Proxy kecil buat dipasang di Vercel, biar dashboard ZAWA Console (HTML/JS)
bisa langsung manggil API ZAWA dari browser tanpa kena error CORS.

## Cara deploy

1. Push folder ini ke repo GitHub baru (atau pakai repo yang udah ada).
2. Buka [vercel.com](https://vercel.com) → New Project → import repo ini.
3. Vercel otomatis detect `api/proxy.js` sebagai serverless function, ngga perlu setting tambahan.
4. Setelah deploy, kamu bakal dapet URL kayak `https://zawa-proxy-xxxx.vercel.app`.

(Opsional) Kalau ZAWA API base URL berubah, set environment variable di Vercel:
- Key: `ZAWA_BASE_URL`
- Value: `https://api-zawa.azickri.com` (atau base URL baru)

## Cara pakai dari dashboard ZAWA Console

Di dashboard, isi field **Base URL** dengan URL proxy kamu + `/api/proxy`, contoh:

```
https://zawa-proxy-xxxx.vercel.app/api/proxy
```

Dashboard udah otomatis mendukung mode proxy ini — dia bakal nambahin
`?path=/session` dkk secara otomatis kalau base URL kamu mengandung
`/api/proxy`.

## Test manual proxy (opsional)

```bash
curl -X POST "https://zawa-proxy-xxxx.vercel.app/api/proxy?path=/session"
```

Kalau berhasil, harusnya keluar JSON `{ "id": "...", "sessionId": "..." }`
sama seperti response asli dari ZAWA API.

## Kenapa perlu proxy ini?

Server `api-zawa.azickri.com` ngga ngirim header `Access-Control-Allow-Origin`,
jadi browser otomatis blokir request langsung dari halaman HTML manapun
(CORS policy). Proxy ini jalan di server (Vercel), bukan di browser, jadi
ngga kena aturan CORS — dia yang manggil ZAWA API atas nama dashboard kamu,
lalu hasilnya dikirim balik ke browser dengan header CORS yang udah dibuka.
