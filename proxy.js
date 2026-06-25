/**
 * ZAWA CORS Proxy — /api/proxy.js
 *
 * Vercel serverless function yang forward request dari browser ke
 * ZAWA API (https://api-zawa.azickri.com), supaya ngga kena CORS.
 *
 * Cara pakai dari frontend:
 *   fetch('/api/proxy?path=/session', { method: 'POST', headers: {...} })
 *
 * Header dari browser (id, session-id, content-type) diteruskan apa
 * adanya ke ZAWA API. Body juga diteruskan apa adanya.
 *
 * Kalau mau ganti target API, ubah ZAWA_BASE_URL di bawah atau set
 * environment variable ZAWA_BASE_URL di Vercel project settings.
 */

const ZAWA_BASE_URL = process.env.ZAWA_BASE_URL || 'https://api-zawa.azickri.com';

// Header yang AMAN buat diteruskan dari browser ke ZAWA API.
// Sengaja whitelist, bukan blacklist, biar ngga ada header
// berbahaya/ngga relevan (host, cookie browser, dll) yang nyasar.
const FORWARD_REQUEST_HEADERS = ['id', 'session-id', 'content-type'];

export default async function handler(req, res) {
  // ---- CORS headers (selalu dipasang, termasuk untuk preflight) ----
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, id, session-id');

  if (req.method === 'OPTIONS') {
    // Preflight request, ngga perlu diteruskan ke ZAWA, langsung jawab OK.
    res.status(204).end();
    return;
  }

  const { path } = req.query;

  if (!path || typeof path !== 'string' || !path.startsWith('/')) {
    res.status(400).json({
      statusCode: 400,
      message: 'Query param "path" wajib diisi dan harus mulai dengan "/", contoh: /api/proxy?path=/session',
    });
    return;
  }

  // Cegah path aneh2 (cuma izinin huruf, angka, /, -, _, ., @)
  if (!/^\/[a-zA-Z0-9/_\-.@]*$/.test(path)) {
    res.status(400).json({ statusCode: 400, message: 'Path tidak valid' });
    return;
  }

  const targetUrl = ZAWA_BASE_URL + path;

  // Siapin header yang diteruskan
  const forwardHeaders = {};
  for (const key of FORWARD_REQUEST_HEADERS) {
    const value = req.headers[key.toLowerCase()];
    if (value) forwardHeaders[key] = value;
  }
  if (!forwardHeaders['content-type']) {
    forwardHeaders['content-type'] = 'application/json';
  }

  try {
    const fetchOpts = {
      method: req.method,
      headers: forwardHeaders,
    };

    // Cuma kirim body kalau method-nya emang butuh body
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      // req.body dari Vercel udah otomatis di-parse kalau content-type json
      fetchOpts.body = JSON.stringify(req.body || {});
    }

    const upstreamRes = await fetch(targetUrl, fetchOpts);
    const text = await upstreamRes.text();

    res.status(upstreamRes.status);
    res.setHeader('Content-Type', upstreamRes.headers.get('content-type') || 'application/json');

    // Coba return as-is kalau JSON, kalau bukan ya kirim text aja
    res.send(text);
  } catch (err) {
    res.status(502).json({
      statusCode: 502,
      message: 'Gagal terhubung ke ZAWA API: ' + err.message,
    });
  }
}
