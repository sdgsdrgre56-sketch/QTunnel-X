'use strict';
// Фотон: рукопожатие и кадры. Не зависит от транспорта: то же самое идёт и поверх TLS/TCP, и поверх потока QUIC.
// Все примитивы стандартные (X25519, HKDF-SHA256, ChaCha20-Poly1305), своих шифров здесь нет. Полное описание: SPEC.md.
const crypto = require('crypto');
const KEM = require('./mlkem');

const MAX_PAYLOAD = 16384;
const SKEW = 30;          // допустимый разбег часов, секунды
const TAG = 16;

const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function genKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  return { priv: privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32), pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32) };
}
const X_PRIV = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X_PUB = Buffer.from('302a300506032b656e032100', 'hex');
const privObj = (raw) => crypto.createPrivateKey({ key: Buffer.concat([X_PRIV, raw]), format: 'der', type: 'pkcs8' });
const pubObj = (raw) => crypto.createPublicKey({ key: Buffer.concat([X_PUB, raw]), format: 'der', type: 'spki' });
const dh = (priv, pub) => crypto.diffieHellman({ privateKey: privObj(priv), publicKey: pubObj(pub) });
const hkdf = (ikm, salt, info, n = 32) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, n));

function nonce(counter) { const n = Buffer.alloc(12); n.writeBigUInt64BE(BigInt(counter), 4); return n; }
function seal(key, ctr, data, aad) {
  const c = crypto.createCipheriv('chacha20-poly1305', key, nonce(ctr), { authTagLength: TAG });
  if (aad) c.setAAD(aad);
  return Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
}
function open(key, ctr, data, aad) {
  if (data.length < TAG) throw new Error('короткий кадр');
  const d = crypto.createDecipheriv('chacha20-poly1305', key, nonce(ctr), { authTagLength: TAG });
  if (aad) d.setAAD(aad);
  d.setAuthTag(data.subarray(data.length - TAG));
  return Buffer.concat([d.update(data.subarray(0, data.length - TAG)), d.final()]);
}

// ---------- рукопожатие ----------
// Клиент → сервер: epk(32) | mask(len)(2) | AEAD(k1, ts(8) | token(16) | plen(2) | pad)
// k1 = HKDF(DH(epk, S), "photon/1 hello"); S — постоянный открытый ключ сервера, он есть в ссылке.
function clientHello(serverPub, token, now = Date.now(), pq = false) {
  const e = genKeyPair();
  const k1 = hkdf(dh(e.priv, serverPub), Buffer.alloc(0), 'photon/1 hello');
  const pad = crypto.randomBytes(crypto.randomInt(0, 96));
  // Antohin: в конец приветствия добавлен открытый ключ ML-KEM-768 (1184 байта); он внутри AEAD, снаружи виден только шум
  const kem = pq ? KEM.keygen() : null;
  const pt = Buffer.alloc(8 + 16 + 2 + pad.length + (kem ? KEM.EK_LEN : 0));
  pt.writeBigUInt64BE(BigInt(Math.floor(now / 1000)), 0); token.copy(pt, 8); pt.writeUInt16BE(pad.length, 24); pad.copy(pt, 26);
  if (kem) kem.ek.copy(pt, 26 + pad.length);
  const ct = seal(k1, 0, pt, e.pub);
  const mask = hkdf(k1, Buffer.alloc(0), 'photon/1 len', 2);
  const len = Buffer.alloc(2); len.writeUInt16BE(ct.length); len[0] ^= mask[0]; len[1] ^= mask[1];
  return { bytes: Buffer.concat([e.pub, len, ct]), e, k1, kem };
}

// Читает приветствие из читалки read(n) → Promise<Buffer>. Возвращает данные клиента или бросает ошибку (тогда соединение — не наше).
// pq: 'allow' (по умолчанию: v1 и Antohin на одном порту), 'only' (только Antohin), 'off' (только v1)
async function serverReadHello(read, serverPriv, tokens, replay, now = Date.now(), pq = 'allow') {
  const epk = await read(32);
  const k1 = hkdf(dh(serverPriv, epk), Buffer.alloc(0), 'photon/1 hello');
  const mask = hkdf(k1, Buffer.alloc(0), 'photon/1 len', 2);
  const lb = await read(2); const len = ((lb[0] ^ mask[0]) << 8) | (lb[1] ^ mask[1]);
  // длины v1 и Antohin не пересекаются, поэтому порт один и тот же
  const isPq = len >= 26 + KEM.EK_LEN + TAG && len <= 26 + KEM.EK_LEN + 255 + TAG;
  const isV1 = len >= 26 + TAG && len <= 26 + 255 + TAG;
  if (!(isPq && pq !== 'off') && !(isV1 && pq !== 'only')) throw new Error('bad len');
  const pt = open(k1, 0, await read(len), epk);
  const ts = Number(pt.readBigUInt64BE(0)), token = pt.subarray(8, 24);
  let ek = null;
  if (isPq) { if (pt.length !== 26 + pt.readUInt16BE(24) + KEM.EK_LEN) throw new Error('bad pq'); ek = pt.subarray(pt.length - KEM.EK_LEN); if (!KEM.checkEk(ek)) throw new Error('bad ek'); }
  if (Math.abs(ts - now / 1000) > SKEW) throw new Error('bad time');
  const key = epk.toString('hex');
  for (const [k, t] of replay) if (now - t > 2 * SKEW * 1000) replay.delete(k);
  if (replay.has(key)) throw new Error('replay');
  if (!tokens.some((t) => t.length === 16 && crypto.timingSafeEqual(t, token))) throw new Error('bad token');
  replay.set(key, now);
  return { epk, token, ek };
}

// Ключи сеанса: ikm = DH(epc, eps) | DH(epc, S); соль = SHA256(epc | eps)
function sessionKeys(epc, eps, dh1, dh2, isClient) {
  const salt = crypto.createHash('sha256').update(Buffer.concat([epc, eps])).digest();
  const ikm = Buffer.concat([dh1, dh2]);
  const c2s = hkdf(ikm, salt, 'photon/1 c2s'), s2c = hkdf(ikm, salt, 'photon/1 s2c');
  return isClient ? { tx: c2s, rx: s2c } : { tx: s2c, rx: c2s };
}

// Antohin: к двум DH добавляется секрет ML-KEM. Ключи безопасны, пока цел хотя бы один из двух (X25519 или ML-KEM).
// Сначала сервер шлёт eps | AEAD(k2, шифртекст ML-KEM), где k2 зависит только от DH, затем идут кадры на итоговых ключах.
function stageKey(epc, eps, dh1, dh2) {
  const salt = crypto.createHash('sha256').update(Buffer.concat([epc, eps])).digest();
  return hkdf(Buffer.concat([dh1, dh2]), salt, 'antohin/1 stage');
}
function sessionKeysPQ(epc, eps, dh1, dh2, ss, ek, ct, isClient) {
  const salt = crypto.createHash('sha256').update(Buffer.concat([epc, eps, ek, ct])).digest();
  const ikm = Buffer.concat([dh1, dh2, ss]);
  const c2s = hkdf(ikm, salt, 'antohin/1 c2s'), s2c = hkdf(ikm, salt, 'antohin/1 s2c');
  return isClient ? { tx: c2s, rx: s2c } : { tx: s2c, rx: c2s };
}

// ---------- кадры ----------
// кадр = AEAD(len, 2 байта) | AEAD(данные); счётчик nonce растёт на каждую операцию
class Framer {
  constructor(tx, rx) { this.tx = tx; this.rx = rx; this.txc = 0; this.rxc = 0; this.buf = Buffer.alloc(0); this.need = null; }
  seal(data) {
    const out = [];
    for (let i = 0; i === 0 || i < data.length; i += MAX_PAYLOAD) {
      const part = data.subarray(i, i + MAX_PAYLOAD);
      const l = Buffer.alloc(2); l.writeUInt16BE(part.length);
      out.push(seal(this.tx, this.txc++, l), seal(this.tx, this.txc++, part));
      if (!data.length) break;
    }
    return Buffer.concat(out);
  }
  // Принимает байты из сети, возвращает расшифрованные куски; бросает ошибку при подделке
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out = [];
    for (;;) {
      if (this.need === null) {
        if (this.buf.length < 2 + TAG) break;
        this.need = open(this.rx, this.rxc++, this.buf.subarray(0, 2 + TAG)).readUInt16BE(0);
        this.buf = this.buf.subarray(2 + TAG);
      }
      if (this.buf.length < this.need + TAG) break;
      out.push(open(this.rx, this.rxc++, this.buf.subarray(0, this.need + TAG)));
      this.buf = this.buf.subarray(this.need + TAG); this.need = null;
    }
    return out;
  }
}

// ---------- запрос на соединение (первый кадр клиента): atyp | адрес | порт | plen | pad ----------
function encodeRequest(host, port) {
  let a;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) a = Buffer.concat([Buffer.from([1]), Buffer.from(host.split('.').map(Number))]);
  else if (host.includes(':')) { const net = require('net'); if (!net.isIPv6(host)) throw new Error('bad ipv6'); a = Buffer.concat([Buffer.from([4]), ipv6Bytes(host)]); }
  else { const h = Buffer.from(host, 'utf8'); if (!h.length || h.length > 255) throw new Error('bad host'); a = Buffer.concat([Buffer.from([3, h.length]), h]); }
  const p = Buffer.alloc(2); p.writeUInt16BE(port);
  const pad = crypto.randomBytes(crypto.randomInt(0, 64)); const pl = Buffer.alloc(2); pl.writeUInt16BE(pad.length);
  return Buffer.concat([a, p, pl, pad]);
}
function ipv6Bytes(s) {
  const [head, tail = ''] = s.split('::'); const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const parts = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]; const b = Buffer.alloc(16);
  parts.forEach((x, i) => b.writeUInt16BE(parseInt(x || '0', 16), i * 2)); return b;
}
function decodeRequest(b) {
  let i = 0, host; const t = b[i++];
  if (t === 1) { host = [...b.subarray(i, i + 4)].join('.'); i += 4; }
  else if (t === 3) { const n = b[i++]; host = b.subarray(i, i + n).toString('utf8'); i += n; if (!host || /[\s/]/.test(host)) throw new Error('bad host'); }
  else if (t === 4) { const g = []; for (let k = 0; k < 8; k++) g.push(b.readUInt16BE(i + k * 2).toString(16)); host = g.join(':'); i += 16; }
  else throw new Error('bad atyp');
  const port = b.readUInt16BE(i); if (!port) throw new Error('bad port');
  return { host, port };
}

module.exports = { MAX_PAYLOAD, b64u, unb64u, genKeyPair, dh, hkdf, seal, open, clientHello, serverReadHello, sessionKeys, stageKey, sessionKeysPQ, KEM, Framer, encodeRequest, decodeRequest };
