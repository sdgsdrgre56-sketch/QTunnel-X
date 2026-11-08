'use strict';
// ML-KEM-768 (FIPS 203) на чистом JS: в Node 22 встроенного нет. Сверено с эталоном Go crypto/mlkem (tools/mlkem-xcheck).
// Только хэши из node:crypto (SHA3, SHAKE). Параметры: k=3, eta1=eta2=2, du=10, dv=4.
const crypto = require('crypto');

const Q = 3329, K = 3, DU = 10, DV = 4;
const EK_LEN = 384 * K + 32, DK_LEN = 768 * K + 96, CT_LEN = 32 * (DU * K + DV), SS_LEN = 32;

const H = (alg, len, ...parts) => crypto.createHash(alg, len ? { outputLength: len } : undefined).update(Buffer.concat(parts)).digest();
const sha3_256 = (...p) => H('sha3-256', 0, ...p);
const sha3_512 = (...p) => H('sha3-512', 0, ...p);
const shake256 = (len, ...p) => H('shake256', len, ...p);

function powmod(b, e) { let r = 1; b %= Q; while (e > 0) { if (e & 1) r = (r * b) % Q; b = (b * b) % Q; e >>= 1; } return r; }
function bitrev7(i) { let r = 0; for (let b = 0; b < 7; b++) if ((i >> b) & 1) r |= 1 << (6 - b); return r; }
const ZETAS = [], GAMMAS = [];
for (let i = 0; i < 128; i++) { ZETAS.push(powmod(17, bitrev7(i))); GAMMAS.push(powmod(17, 2 * bitrev7(i) + 1)); }

function ntt(a) {
  const f = Int32Array.from(a); let i = 1;
  for (let len = 128; len >= 2; len >>= 1) for (let s = 0; s < 256; s += 2 * len) {
    const z = ZETAS[i++];
    for (let j = s; j < s + len; j++) { const t = (z * f[j + len]) % Q; f[j + len] = (f[j] - t + Q) % Q; f[j] = (f[j] + t) % Q; }
  }
  return f;
}
function invNtt(a) {
  const f = Int32Array.from(a); let i = 127;
  for (let len = 2; len <= 128; len <<= 1) for (let s = 0; s < 256; s += 2 * len) {
    const z = ZETAS[i--];
    for (let j = s; j < s + len; j++) { const t = f[j]; f[j] = (t + f[j + len]) % Q; f[j + len] = (z * ((f[j + len] - t + Q) % Q)) % Q; }
  }
  for (let j = 0; j < 256; j++) f[j] = (f[j] * 3303) % Q;
  return f;
}
function mulNtt(f, g) {
  const h = new Int32Array(256);
  for (let i = 0; i < 128; i++) {
    const a0 = f[2 * i], a1 = f[2 * i + 1], b0 = g[2 * i], b1 = g[2 * i + 1];
    h[2 * i] = (a0 * b0 + ((a1 * b1) % Q) * GAMMAS[i]) % Q;
    h[2 * i + 1] = (a0 * b1 + a1 * b0) % Q;
  }
  return h;
}
const add = (a, b) => { const r = new Int32Array(256); for (let i = 0; i < 256; i++) r[i] = (a[i] + b[i]) % Q; return r; };
const sub = (a, b) => { const r = new Int32Array(256); for (let i = 0; i < 256; i++) r[i] = (a[i] - b[i] + Q) % Q; return r; };

function byteEncode(f, d) {
  const out = Buffer.alloc(32 * d); let pos = 0;
  for (let i = 0; i < 256; i++) for (let b = 0; b < d; b++, pos++) if ((f[i] >> b) & 1) out[pos >> 3] |= 1 << (pos & 7);
  return out;
}
function byteDecode(buf, d) {
  const f = new Int32Array(256); let pos = 0;
  for (let i = 0; i < 256; i++) { let v = 0; for (let b = 0; b < d; b++, pos++) v |= ((buf[pos >> 3] >> (pos & 7)) & 1) << b; f[i] = v; }
  return f;
}
const compress = (f, d) => { const r = new Int32Array(256); for (let i = 0; i < 256; i++) r[i] = Math.floor((((f[i] << d) * 2) + Q) / (2 * Q)) & ((1 << d) - 1); return r; };
const decompress = (f, d) => { const r = new Int32Array(256); for (let i = 0; i < 256; i++) r[i] = (f[i] * Q + (1 << (d - 1))) >> d; return r; };

function sampleNtt(rho, j, i) {
  const seed = Buffer.concat([rho, Buffer.from([j, i])]);
  let len = 840;
  for (;;) {
    const c = H('shake128', len, seed), a = new Int32Array(256); let n = 0, p = 0;
    while (n < 256 && p + 3 <= len) {
      const d1 = c[p] + 256 * (c[p + 1] & 15), d2 = (c[p + 1] >> 4) + 16 * c[p + 2]; p += 3;
      if (d1 < Q) a[n++] = d1;
      if (d2 < Q && n < 256) a[n++] = d2;
    }
    if (n === 256) return a;
    len *= 2;
  }
}
function cbd2(b) {
  const f = new Int32Array(256), bit = (j) => (b[j >> 3] >> (j & 7)) & 1;
  for (let i = 0; i < 256; i++) f[i] = (bit(4 * i) + bit(4 * i + 1) - bit(4 * i + 2) - bit(4 * i + 3) + Q) % Q;
  return f;
}
const prf = (s, n) => shake256(128, s, Buffer.from([n]));
const genA = (rho) => Array.from({ length: K }, (_, i) => Array.from({ length: K }, (_, j) => sampleNtt(rho, j, i)));

function pkeKeygen(d) {
  const g = sha3_512(d, Buffer.from([K])), rho = g.subarray(0, 32), sigma = g.subarray(32);
  let n = 0;
  const s = [], e = [];
  for (let i = 0; i < K; i++) s.push(ntt(cbd2(prf(sigma, n++))));
  for (let i = 0; i < K; i++) e.push(ntt(cbd2(prf(sigma, n++))));
  const A = genA(rho), t = [];
  for (let i = 0; i < K; i++) { let acc = e[i]; for (let j = 0; j < K; j++) acc = add(acc, mulNtt(A[i][j], s[j])); t.push(acc); }
  return { ek: Buffer.concat([...t.map((x) => byteEncode(x, 12)), rho]), dkPke: Buffer.concat(s.map((x) => byteEncode(x, 12))) };
}
function pkeEncrypt(ek, m, r) {
  const t = []; for (let i = 0; i < K; i++) t.push(byteDecode(ek.subarray(384 * i, 384 * (i + 1)), 12));
  const A = genA(ek.subarray(384 * K));
  let n = 0; const y = [], e1 = [];
  for (let i = 0; i < K; i++) y.push(cbd2(prf(r, n++)));
  for (let i = 0; i < K; i++) e1.push(cbd2(prf(r, n++)));
  const e2 = cbd2(prf(r, n));
  const yh = y.map(ntt), u = [];
  for (let i = 0; i < K; i++) { let acc = new Int32Array(256); for (let j = 0; j < K; j++) acc = add(acc, mulNtt(A[j][i], yh[j])); u.push(add(invNtt(acc), e1[i])); }
  const mu = decompress(byteDecode(m, 1), 1);
  let acc = new Int32Array(256); for (let i = 0; i < K; i++) acc = add(acc, mulNtt(t[i], yh[i]));
  const v = add(add(invNtt(acc), e2), mu);
  return Buffer.concat([...u.map((x) => byteEncode(compress(x, DU), DU)), byteEncode(compress(v, DV), DV)]);
}
function pkeDecrypt(dkPke, c) {
  const u = []; for (let i = 0; i < K; i++) u.push(decompress(byteDecode(c.subarray(32 * DU * i, 32 * DU * (i + 1)), DU), DU));
  const v = decompress(byteDecode(c.subarray(32 * DU * K), DV), DV);
  let acc = new Int32Array(256);
  for (let i = 0; i < K; i++) acc = add(acc, mulNtt(byteDecode(dkPke.subarray(384 * i, 384 * (i + 1)), 12), ntt(u[i])));
  return byteEncode(compress(sub(v, invNtt(acc)), 1), 1);
}

/** Проверка ключа инкапсуляции: длина и все коэффициенты < q (FIPS 203, п. 7.2) */
function checkEk(ek) {
  if (!Buffer.isBuffer(ek) || ek.length !== EK_LEN) return false;
  for (let i = 0; i < K; i++) { const f = byteDecode(ek.subarray(384 * i, 384 * (i + 1)), 12); for (let j = 0; j < 256; j++) if (f[j] >= Q) return false; }
  return true;
}
/** d, z — по 32 случайных байта (для тестов можно подать свои) */
function keygen(d = crypto.randomBytes(32), z = crypto.randomBytes(32)) {
  const { ek, dkPke } = pkeKeygen(d);
  return { ek, dk: Buffer.concat([dkPke, ek, sha3_256(ek), z]) };
}
function encapsulate(ek, m = crypto.randomBytes(32)) {
  if (!checkEk(ek)) throw new Error('ML-KEM: плохой ключ');
  const g = sha3_512(m, sha3_256(ek)), ss = g.subarray(0, 32);
  return { ct: pkeEncrypt(ek, m, g.subarray(32)), ss: Buffer.from(ss) };
}
function decapsulate(dk, ct) {
  if (dk.length !== DK_LEN || ct.length !== CT_LEN) throw new Error('ML-KEM: плохая длина');
  const dkPke = dk.subarray(0, 384 * K), ek = dk.subarray(384 * K, 768 * K + 32), h = dk.subarray(768 * K + 32, 768 * K + 64), z = dk.subarray(768 * K + 64);
  const m2 = pkeDecrypt(dkPke, ct), g = sha3_512(m2, h);
  const bad = shake256(32, z, ct), ct2 = pkeEncrypt(ek, m2, g.subarray(32));
  return Buffer.from(crypto.timingSafeEqual(ct, ct2) ? g.subarray(0, 32) : bad);
}

module.exports = { EK_LEN, DK_LEN, CT_LEN, SS_LEN, keygen, encapsulate, decapsulate, checkEk };
