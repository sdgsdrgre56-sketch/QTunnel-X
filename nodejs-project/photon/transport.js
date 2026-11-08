'use strict';
// Фотон поверх TLS 1.3 (TCP): сервер, клиент и локальный SOCKS5. Тот же протокол можно пустить и поверх QUIC (см. SPEC.md).
const tls = require('tls');
const net = require('net');
const crypto = require('crypto');
const P = require('./proto');

class Reader {
  constructor(sock) {
    this.sock = sock; this.buf = Buffer.alloc(0); this.w = null; this.err = null;
    sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this._tick(); });
    sock.on('error', (e) => { this.err = e; this._tick(); }); sock.on('close', () => { this.err = this.err || new Error('closed'); this._tick(); });
  }
  _tick() {
    if (!this.w) return;
    if (this.buf.length >= this.w.n) { const { n, res } = this.w; this.w = null; const out = this.buf.subarray(0, n); this.buf = this.buf.subarray(n); res(out); }
    else if (this.err) { const { rej } = this.w; this.w = null; rej(this.err); }
  }
  read(n, timeout = 10000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.w = null; rej(new Error('timeout')); }, timeout);
      this.w = { n, res: (b) => { clearTimeout(t); res(b); }, rej: (e) => { clearTimeout(t); rej(e); } }; this._tick();
    });
  }
  rest() { const b = this.buf; this.buf = Buffer.alloc(0); return b; }
}

// Склеивает сырой сокет с кадрами: write(plain) → шифрует в сокет; onData(plain)
function pipeFramed(sock, framer, onPlain) {
  sock.removeAllListeners('data');
  sock.on('data', (d) => { try { for (const p of framer.push(d)) onPlain(p); } catch { sock.destroy(); } });
}

const HTML404 = 'HTTP/1.1 404 Not Found\r\nServer: nginx\r\nContent-Type: text/html\r\nContent-Length: 146\r\nConnection: close\r\n\r\n<html>\r\n<head><title>404 Not Found</title></head>\r\n<body>\r\n<center><h1>404 Not Found</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n';

/** cfg: { cert, key, priv(b64u), tokens:[b64u], pq?('allow'|'only'|'off'), connect?(host,port)→socket, log? } */
function createServer(cfg) {
  const priv = P.unb64u(cfg.priv), pub = crypto.createPublicKey(crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), priv]), format: 'der', type: 'pkcs8' })).export({ type: 'spki', format: 'der' }).subarray(-32);
  const tokens = cfg.tokens.map(P.unb64u), replay = new Map(), log = cfg.log || (() => {});
  const connect = cfg.connect || ((h, p) => net.connect({ host: h, port: p }));
  const srv = tls.createServer({ cert: cfg.cert, key: cfg.key, minVersion: 'TLSv1.3', ALPNProtocols: ['h2', 'http/1.1'] }, async (sock) => {
    sock.setNoDelay(true);
    const rd = new Reader(sock);
    let hello;
    try { hello = await P.serverReadHello((n) => rd.read(n), priv, tokens, replay, Date.now(), cfg.pq || 'allow'); }
    catch (e) { log('чужое соединение: ' + e.message); sock.end(HTML404); return; }   // выглядим как обычный веб-сервер
    try {
      const eps = P.genKeyPair();
      const d1 = P.dh(eps.priv, hello.epk), d2 = P.dh(priv, hello.epk);
      let keys, stage = Buffer.alloc(0);
      if (hello.ek) {
        const enc = P.KEM.encapsulate(hello.ek);
        stage = P.seal(P.stageKey(hello.epk, eps.pub, d1, d2), 0, enc.ct);
        keys = P.sessionKeysPQ(hello.epk, eps.pub, d1, d2, enc.ss, hello.ek, enc.ct, false);
      } else keys = P.sessionKeys(hello.epk, eps.pub, d1, d2, false);
      const fr = new P.Framer(keys.tx, keys.rx);
      sock.write(Buffer.concat([eps.pub, stage, fr.seal(Buffer.from('OK' + crypto.randomBytes(crypto.randomInt(0, 48)).toString('latin1'), 'latin1'))]));
      const pending = rd.rest();
      let target = null, state = 'req';
      const onPlain = (data) => {
        if (state === 'req') {
          state = 'wait';
          let rq; try { rq = P.decodeRequest(data); } catch { sock.destroy(); return; }
          target = connect(rq.host, rq.port);
          target.once('connect', () => { state = 'run'; sock.write(fr.seal(Buffer.from([0]))); });
          target.once('error', () => { if (state === 'wait') { sock.write(fr.seal(Buffer.from([1]))); sock.end(); } else sock.destroy(); });
          target.on('data', (d) => { if (!sock.write(fr.seal(d))) { target.pause(); sock.once('drain', () => target.resume()); } });
          target.on('close', () => sock.end()); sock.on('close', () => target.destroy());
        } else if (state === 'run') { if (!target.write(data)) { sock.pause(); target.once('drain', () => sock.resume()); } }
      };
      pipeFramed(sock, fr, onPlain);
      if (pending.length) sock.emit('data', pending);
    } catch { sock.destroy(); }
  });
  srv.on('tlsClientError', () => {});
  srv.publicKey = pub;
  return srv;
}

/** Открывает туннель к host:port через сервер Фотона. opts: { host, port, pub(b64u), token(b64u), pin?(sha256 hex сертификата), sni?, pq? (true = Antohin) } */
async function dial(opts, host, port) {
  const sock = await new Promise((res, rej) => {
    const s = tls.connect({ host: opts.host, port: opts.port, servername: opts.sni || undefined, minVersion: 'TLSv1.3', rejectUnauthorized: false, ALPNProtocols: ['h2', 'http/1.1'] }, () => res(s));
    s.once('error', rej); s.setTimeout(15000, () => s.destroy(new Error('timeout')));
  });
  try {
    if (opts.pin) {
      const fp = (sock.getPeerCertificate().fingerprint256 || '').replace(/:/g, '').toLowerCase();
      if (fp !== String(opts.pin).replace(/:/g, '').toLowerCase()) throw new Error('Отпечаток сертификата сервера не совпал');
    }
    sock.setNoDelay(true);
    const rd = new Reader(sock), spub = P.unb64u(opts.pub);
    const hello = P.clientHello(spub, P.unb64u(opts.token), Date.now(), !!opts.pq);
    sock.write(hello.bytes);
    const eps = await rd.read(32);
    const d1 = P.dh(hello.e.priv, eps), d2 = P.dh(hello.e.priv, spub);
    let keys;
    if (hello.kem) {
      const ct = P.open(P.stageKey(hello.e.pub, eps, d1, d2), 0, await rd.read(P.KEM.CT_LEN + 16));
      keys = P.sessionKeysPQ(hello.e.pub, eps, d1, d2, P.KEM.decapsulate(hello.kem.dk, ct), hello.kem.ek, ct, true);
    } else keys = P.sessionKeys(hello.e.pub, eps, d1, d2, true);
    const fr = new P.Framer(keys.tx, keys.rx);
    // Первый кадр сервера доказывает, что он знает свой постоянный ключ
    const inbox = []; let waiter = null, closed = false, st = 'hello', onData = null;
    const feed = (p) => {
      if (st === 'hello') { if (p.subarray(0, 2).toString() !== 'OK') throw new Error('bad hello'); st = 'status'; return; }
      if (st === 'status') { st = p[0] === 0 ? 'run' : 'fail'; if (waiter) waiter(st); return; }
      if (onData) onData(p); else inbox.push(p);
    };
    sock.removeAllListeners('data');
    const eat = (d) => { try { for (const p of fr.push(d)) feed(p); } catch { sock.destroy(); } };
    sock.on('data', eat); const left = rd.rest(); if (left.length) eat(left);
    sock.on('close', () => { closed = true; if (waiter) waiter('fail'); if (onData) onData(null); });
    sock.write(fr.seal(P.encodeRequest(host, port)));
    const res = await new Promise((resolve, reject) => {
      if (st === 'run' || st === 'fail') return resolve(st);
      waiter = resolve; setTimeout(() => reject(new Error('Сервер не ответил')), 15000);
    });
    if (res !== 'run' || closed) throw new Error('Сервер не смог подключиться к ' + host + ':' + port);
    sock.setTimeout(0);
    return {
      write: (b) => sock.write(fr.seal(b)), end: () => sock.end(), destroy: () => sock.destroy(), socket: sock,
      onData: (f) => { onData = f; while (inbox.length) f(inbox.shift()); if (closed) f(null); },
    };
  } catch (e) { sock.destroy(); throw e; }
}

/** Локальный SOCKS5 (только CONNECT, без пароля, только 127.0.0.1): каждое соединение идёт в новый туннель */
function createSocks(opts, log = () => {}) {
  return net.createServer((c) => {
    c.on('error', () => {});
    const rd = new Reader(c);
    (async () => {
      const g = await rd.read(2); if (g[0] !== 5) return c.destroy();
      await rd.read(g[1]); c.write(Buffer.from([5, 0]));
      const h = await rd.read(4); if (h[1] !== 1) { c.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
      let host;
      if (h[3] === 1) host = [...(await rd.read(4))].join('.');
      else if (h[3] === 3) { const n = (await rd.read(1))[0]; host = (await rd.read(n)).toString('utf8'); }
      else if (h[3] === 4) { const b = await rd.read(16); const g6 = []; for (let i = 0; i < 8; i++) g6.push(b.readUInt16BE(i * 2).toString(16)); host = g6.join(':'); }
      else return c.destroy();
      const port = (await rd.read(2)).readUInt16BE(0);
      let t;
      try { t = await dial(opts, host, port); }
      catch (e) { log('туннель: ' + e.message); c.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
      c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      const early = rd.rest(); if (early.length) t.write(early);
      c.removeAllListeners('data');
      c.on('data', (d) => { if (!t.write(d)) { c.pause(); t.socket.once('drain', () => c.resume()); } });
      t.onData((d) => { if (d === null) c.end(); else if (!c.write(d)) { t.socket.pause(); c.once('drain', () => t.socket.resume()); } });
      c.on('close', () => t.destroy());
    })().catch(() => c.destroy());
  });
}

module.exports = { createServer, createSocks, dial };
