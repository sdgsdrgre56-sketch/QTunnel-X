'use strict';
// Сетевые мелочи без внешних пакетов: пинг, задержка до сайта через прокси, HTTPS-запрос напрямую или через прокси.
const net = require('net');
const tls = require('tls');
const https = require('https');

function tcpPing(host, port, timeout = 3000) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const s = net.connect({ host, port });
    let done = false;
    const fin = (v) => { if (done) return; done = true; s.destroy(); resolve(v); };
    s.setTimeout(timeout, () => fin(null));
    s.once('error', () => fin(null));
    s.once('connect', () => fin(Number(process.hrtime.bigint() - t0) / 1e6));
  });
}

// Медиана из n замеров, мс (целое) или null, если сервер не отвечает.
async function pingMedian(host, port, n = 3, timeout = 3000) {
  const r = [];
  for (let i = 0; i < n; i++) { const v = await tcpPing(host, port, timeout); if (v !== null) r.push(v); }
  if (!r.length) return null;
  r.sort((a, b) => a - b);
  return Math.max(1, Math.round(r[Math.floor(r.length / 2)]));
}

// HTTP CONNECT через локальный прокси (mixed-вход ядра). Возвращает открытый сокет до host:port.
function connectViaProxy(proxyPort, host, port, { timeout = 8000, auth } = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port: proxyPort });
    let buf = '';
    const fail = (e) => { s.destroy(); reject(e instanceof Error ? e : new Error(e)); };
    s.setTimeout(timeout, () => fail('Прокси не ответил вовремя'));
    s.once('error', fail);
    const onClose = () => fail('Прокси закрыл соединение, не ответив');   // иначе при обрыве без ошибки запрос висел бы вечно
    s.once('close', onClose);
    s.once('connect', () => {
      const a = auth ? `Proxy-Authorization: Basic ${Buffer.from(auth).toString('base64')}\r\n` : '';
      s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${a}\r\n`);
    });
    s.on('data', function onData(d) {
      buf += d.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      s.removeListener('data', onData); s.removeListener('close', onClose);
      s.setTimeout(0);
      if (/^HTTP\/1\.[01] 200/.test(buf)) {
        const rest = Buffer.from(buf.slice(end + 4), 'latin1');
        if (rest.length) s.unshift(rest);
        resolve(s);
      } else fail('Прокси отказал: ' + buf.split('\r\n')[0]);
    });
  });
}

// Время до ответа цели через прокси. Открылось — ответ есть; «отказ» (RST/недоступно) тоже ответ: время такое же, как до цели.
// Молчание (пакеты отбрасываются) — ответа нет. Возвращает { ms, kind: 'open' | 'refused' } или null.
async function probeVia(proxyPort, host, port, { timeout = 2500, auth } = {}) {
  const t0 = process.hrtime.bigint();
  const ms = () => Math.max(1, Math.round(Number(process.hrtime.bigint() - t0) / 1e6));
  try { const s = await connectViaProxy(proxyPort, host, port, { timeout, auth }); const v = ms(); s.destroy(); return { ms: v, kind: 'open' }; }
  catch (e) { return /^Прокси отказал: HTTP\/1\.[01] (5\d\d|4\d\d)/.test(e.message) ? { ms: ms(), kind: 'refused' } : null; }
}

// Задержка до сайта через прокси: от запроса CONNECT до готового TLS-рукопожатия, мс.
async function siteLatency({ proxyPort, host, port = 443, timeout = 8000, ca, auth, tlsHandshake = true }) {
  const t0 = process.hrtime.bigint();
  const sock = await connectViaProxy(proxyPort, host, port, { timeout, auth });
  if (!tlsHandshake) { sock.destroy(); return Math.max(1, Math.round(Number(process.hrtime.bigint() - t0) / 1e6)); }   // порт не 443: меряем только соединение сквозь протокол
  await new Promise((resolve, reject) => {
    const t = tls.connect({ socket: sock, servername: host, ca, timeout }, () => { t.destroy(); resolve(); });
    t.once('error', reject);
    t.setTimeout(timeout, () => { t.destroy(); reject(new Error('TLS не ответил вовремя')); });
  });
  return Math.max(1, Math.round(Number(process.hrtime.bigint() - t0) / 1e6));
}

// Тот же замер напрямую, без прокси (чтобы показать пинг и без VPN).
async function siteLatencyDirect({ host, port = 443, timeout = 8000, ca }) {
  const t0 = process.hrtime.bigint();
  await new Promise((resolve, reject) => {
    const t = tls.connect({ host, port, servername: host, ca, timeout }, () => { t.destroy(); resolve(); });
    t.once('error', reject);
    t.setTimeout(timeout, () => { t.destroy(); reject(new Error('таймаут')); });
  });
  return Math.max(1, Math.round(Number(process.hrtime.bigint() - t0) / 1e6));
}

// HTTPS GET (текст). proxyPort задан — через прокси.
function httpsGet(url, { proxyPort, timeout = 8000, ca, maxBytes = 64 * 1024, auth } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:') return reject(new Error('Только https'));
    const opts = { method: 'GET', hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, timeout, ca, headers: { 'User-Agent': 'Quasar', Accept: 'text/plain' } };
    if (proxyPort) {
      opts.createConnection = (o, cb) => {
        connectViaProxy(proxyPort, u.hostname, Number(u.port || 443), { timeout, auth })
          .then((sock) => { const t = tls.connect({ socket: sock, servername: u.hostname, ca }); t.once('secureConnect', () => cb(null, t)); t.once('error', cb); })
          .catch(cb);
        return undefined;
      };
    }
    const req = https.request(opts, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > maxBytes) { req.destroy(); reject(new Error('Ответ слишком большой')); } });
      res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve(body) : reject(new Error('HTTP ' + res.statusCode))));
    });
    req.on('timeout', () => req.destroy(new Error('Таймаут запроса')));
    req.on('error', reject);
    req.end();
  });
}

const IP_RE = /^[0-9a-fA-F:.]{3,45}$/;
async function whatIsMyIp({ proxyPort, ca, url = 'https://api.ipify.org', auth } = {}) {
  const t = (await httpsGet(url, { proxyPort, ca, auth })).trim();
  if (!IP_RE.test(t)) throw new Error('Сервис вернул не IP');
  return t;
}


// Скачивание через прокси: проверка, что поток не «замерзает». У части провайдеров соединение с зарубежным сервером
// открывается и TLS проходит, но после первых 15–20 КБ данные перестают идти — короткий URL-тест этого не видит.
function downloadVia({ proxyPort, host = 'speed.cloudflare.com', path = '/__down?bytes=262144', bytes = 262144, timeout = 15000, auth } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    let got = 0, headDone = false, head = '', done = false, sock = null, tlsSock = null;
    const finish = (err, v) => { if (done) return; done = true; clearTimeout(timer); try { tlsSock && tlsSock.destroy(); } catch { /* закрыт */ } try { sock && sock.destroy(); } catch { /* закрыт */ } err ? reject(err) : resolve(v); };
    const timer = setTimeout(() => finish(new Error(got ? `поток замер на ${Math.round(got / 1024)} КБ из ${Math.round(bytes / 1024)} — похоже, провайдер «замораживает» такие соединения` : 'данные не пошли совсем')), timeout);
    connectViaProxy(proxyPort, host, 443, { timeout, auth }).then((s) => {
      sock = s;
      tlsSock = tls.connect({ socket: s, servername: host }, () => tlsSock.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: Quasar\r\nAccept: */*\r\nConnection: close\r\n\r\n`));
      tlsSock.on('data', (d) => {
        if (!headDone) {
          head += d.toString('latin1'); const i = head.indexOf('\r\n\r\n'); if (i < 0) return;
          headDone = true;
          if (!/^HTTP\/1\.[01] 200/.test(head)) return finish(new Error('сайт проверки ответил: ' + head.split('\r\n')[0]));
          got += Buffer.byteLength(head.slice(i + 4), 'latin1');
        } else got += d.length;
        if (got >= bytes) { const ms = Number(process.hrtime.bigint() - t0) / 1e6; finish(null, { ms: Math.round(ms), bytes: got, kbps: Math.round(got / 1024 / (ms / 1000)) }); }
      });
      tlsSock.once('error', (e) => finish(e));
      tlsSock.once('close', () => finish(new Error(`соединение закрылось на ${Math.round(got / 1024)} КБ`)));
    }, (e) => finish(e));
  });
}

module.exports = { probeVia, downloadVia, tcpPing, pingMedian, connectViaProxy, siteLatency, siteLatencyDirect, httpsGet, whatIsMyIp };
