'use strict';
// Ссылки на протоколы и единая ссылка quasar://, внутри которой весь набор протоколов сервера.
// Принимает на вход: quasar://…, подписку (base64 от списка ссылок) или просто ссылки по строкам.

const MAX_TEXT = 256 * 1024;   // защита от случайной вставки огромного текста
const MAX_ITEMS = 256;   // до 20 серверов по 7 протоколов с запасом

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64 = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const enc = encodeURIComponent;
const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
const tag = (s) => '#' + enc(s || '');
const q = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${enc(v)}`).join('&');
const hostPart = (h, p) => (h.includes(':') && !h.startsWith('[') ? `[${h}]` : h) + ':' + p;

// ---------- сборка ссылок ----------
const build = {
  vless: (i) => `vless://${enc(i.uuid)}@${hostPart(i.host, i.port)}?${q({
    encryption: 'none', flow: i.transport === 'xhttp' ? undefined : (i.flow || 'xtls-rprx-vision'), security: 'reality', sni: i.sni, fp: 'chrome',
    pbk: i.publicKey, sid: i.shortId, type: i.transport === 'xhttp' ? 'xhttp' : 'tcp', path: i.transport === 'xhttp' ? i.path : undefined, mode: i.transport === 'xhttp' ? i.mode : undefined, host: i.transport === 'xhttp' ? i.xhost : undefined,
  })}${tag(i.name)}`,
  hysteria2: (i) => `hysteria2://${enc(i.password)}@${hostPart(i.host, i.port)}?${q({
    sni: i.sni, insecure: i.insecure ? 1 : undefined, pinSHA256: i.pin, obfs: i.obfsPassword ? 'salamander' : undefined, 'obfs-password': i.obfsPassword,
  })}${tag(i.name)}`,
  tuic: (i) => `tuic://${enc(i.uuid)}:${enc(i.password)}@${hostPart(i.host, i.port)}?${q({
    congestion_control: 'bbr', udp_relay_mode: 'native', alpn: 'h3', sni: i.sni, allow_insecure: i.insecure ? 1 : undefined,
  })}${tag(i.name)}`,
  // с Reality (pbk, sid) — как в VLESS-ссылках; без них — обычный TLS
  trojan: (i) => `trojan://${enc(i.password)}@${hostPart(i.host, i.port)}?${q({
    security: i.publicKey ? 'reality' : 'tls', sni: i.sni, type: 'tcp', allowInsecure: !i.publicKey && i.insecure ? 1 : undefined,
    fp: i.publicKey ? 'chrome' : undefined, pbk: i.publicKey, sid: i.publicKey ? i.shortId : undefined,
  })}${tag(i.name)}`,
  anytls: (i) => `anytls://${enc(i.password)}@${hostPart(i.host, i.port)}?${q({
    sni: i.sni, insecure: !i.publicKey && i.insecure ? 1 : undefined,
    security: i.publicKey ? 'reality' : undefined, fp: i.publicKey ? 'chrome' : undefined, pbk: i.publicKey, sid: i.publicKey ? i.shortId : undefined,
  })}${tag(i.name)}`,
  http: (i) => `${i.tls ? 'https' : 'http'}://${enc(i.username || '')}${i.password ? ':' + enc(i.password) : ''}${i.username ? '@' : ''}${hostPart(i.host, i.port)}${i.tls ? '?' + q({ sni: i.sni, insecure: i.insecure ? 1 : undefined }) : ''}${tag(i.name)}`,
  socks: (i) => `socks5://${enc(i.username || '')}${i.password ? ':' + enc(i.password) : ''}${i.username ? '@' : ''}${hostPart(i.host, i.port)}${tag(i.name)}`,
  shadowsocks: (i) => `ss://${b64u(`${i.method}:${i.password}`)}@${hostPart(i.host, i.port)}${tag(i.name)}`,
};

function buildLink(item) {
  const f = build[item.proto];
  if (!f) throw new Error('Для протокола «' + item.proto + '» нет обычной ссылки');
  return f(item);
}

// ---------- разбор одной ссылки ----------
function parseLink(text) {
  const s = String(text).trim();
  const m = /^([a-z0-9+.-]+):\/\//i.exec(s);
  if (!m) throw new Error('Это не ссылка: ' + s.slice(0, 30));
  let scheme = m[1].toLowerCase();
  if (scheme === 'hy2') scheme = 'hysteria2';
  if (scheme === 'ss') scheme = 'shadowsocks';
  const tlsHttp = scheme === 'https';
  if (scheme === 'https') scheme = 'http';
  if (scheme === 'socks5' || scheme === 'socks5h' || scheme === 'socks4') scheme = 'socks';
  if (!build[scheme]) throw new Error('Протокол «' + m[1] + '» пока не поддерживается');
  let u;
  // «особая» схема (https/http) молча отбрасывает порт 443/80, поэтому разбираем под нейтральной схемой
  try { u = new URL(s.replace(/^[a-z0-9+.-]+:/i, 'x-q:')); } catch { throw new Error('Ссылка повреждена: ' + s.slice(0, 40)); }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = Number(u.port);
  if (!host || !(port > 0 && port < 65536)) throw new Error('В ссылке нет адреса или порта: ' + s.slice(0, 40));
  const p = Object.fromEntries(u.searchParams.entries());
  if (scheme === 'socks' && /^socks4/i.test(m[1])) throw new Error('SOCKS4 не поддерживается, нужен SOCKS5');
  const item = { proto: scheme, name: dec(u.hash.replace(/^#/, '')) || host, host, port, uri: s, params: p };
  const user = dec(u.username), pass = dec(u.password);
  switch (scheme) {
    case 'vless':
      item.uuid = user; item.flow = p.flow || ''; item.sni = p.sni || ''; item.publicKey = p.pbk || ''; item.shortId = p.sid || '';
      item.security = p.security || 'none';
      if (p.type === 'xhttp') { item.transport = 'xhttp'; item.path = p.path || '/'; item.mode = p.mode || 'auto'; item.xhost = p.host || ''; }
      break;
    case 'hysteria2':
      item.password = pass ? `${user}:${pass}` : user; item.sni = p.sni || ''; item.insecure = p.insecure === '1';
      break;
    case 'tuic':
      item.uuid = user; item.password = pass; item.sni = p.sni || ''; item.insecure = p.allow_insecure === '1';
      break;
    case 'trojan':
      item.password = user; item.sni = p.sni || ''; item.insecure = p.allowInsecure === '1' || p.insecure === '1';
      if (p.security === 'reality' && p.pbk) { item.publicKey = p.pbk; item.shortId = p.sid || ''; item.insecure = false; }
      break;
    case 'anytls':
      item.password = user; item.sni = p.sni || ''; item.insecure = p.insecure === '1';
      if (p.security === 'reality' && p.pbk) { item.publicKey = p.pbk; item.shortId = p.sid || ''; item.insecure = false; }
      break;
    case 'http':
      item.username = user; item.password = pass; item.tls = tlsHttp; item.sni = p.sni || ''; item.insecure = p.insecure === '1';
      break;
    case 'socks':
      item.username = user; item.password = pass;
      break;
    case 'shadowsocks': {
      const raw = fromB64(u.username).toString('utf8');
      const i = raw.indexOf(':');
      if (i < 1) throw new Error('Ссылка Shadowsocks без метода шифрования');
      item.method = raw.slice(0, i); item.password = raw.slice(i + 1);
      break;
    }
  }
  return item;
}

// ---------- единая ссылка ----------
const EXT = new Set(['warp', 'naive', 'shadowquic', 'sudoku', 'dnstt', 'photon', 'antohin', 'mieru', 'juicity', 'brook', 'restls', 'snell', 'tlsmirror']);   // протоколы внешних ядер: хранятся структурой, а не ссылкой

function packBundle({ name, host, items }) {
  const out = items.map((it) => {
    const base = { proto: it.proto, name: it.name };
    if (EXT.has(it.proto)) return { ...base, host: it.host, port: it.port, x: it.x || {} };
    return it.proto === 'shadowtls' ? { ...base, host: it.host, port: it.port, version: 3, password: it.password, sni: it.sni, ss: it.ss } : { ...base, uri: it.uri || buildLink(it) };
  });
  const json = JSON.stringify({ v: 1, name, host, items: out });
  return 'quasar://' + b64u(Buffer.from(json, 'utf8'));
}

// Всё, что понимает обычная подписка (NekoBox, v2rayN и т.п.): base64 от ссылок по строкам.
function toSubscription(items) {
  const lines = items.filter((i) => i.proto !== 'shadowtls' && !EXT.has(i.proto)).map((i) => i.uri || buildLink(i));
  return Buffer.from(lines.join('\n'), 'utf8').toString('base64');
}

function isLinkLine(l) { return /^[a-z0-9+.-]+:\/\//i.test(l); }

// Универсальный вход: вставили что угодно — получили список. Нераспознанные строки возвращаются отдельно.
function importText(text) {
  const t = String(text || '').trim();
  if (!t) throw new Error('Пусто: вставь ссылку');
  if (t.length > MAX_TEXT) throw new Error('Слишком длинный текст для ссылки');
  if (t.startsWith('quasar://')) return unpackBundle(t);
  let lines = t.split(/\s+/).filter(Boolean);
  if (!lines.every(isLinkLine)) {               // возможно, это подписка в base64
    const decoded = fromB64(t).toString('utf8');
    const dl = decoded.split(/\s+/).filter(Boolean);
    if (dl.length && dl.every(isLinkLine)) lines = dl;
    else throw new Error('Не похоже на ссылку или подписку');
  }
  if (lines.length > MAX_ITEMS) throw new Error('Слишком много ссылок (больше ' + MAX_ITEMS + ')');
  const items = [], skipped = [];
  for (const l of lines) { try { items.push(parseLink(l)); } catch (e) { skipped.push({ link: l.slice(0, 60), reason: e.message }); } }
  if (!items.length) throw new Error(skipped[0] ? skipped[0].reason : 'Нет ни одной рабочей ссылки');
  return { name: items[0].host, host: items[0].host, items, skipped };
}

function unpackBundle(text) {
  let obj;
  try { obj = JSON.parse(fromB64(text.replace(/^quasar:\/\//, '')).toString('utf8')); } catch { throw new Error('Ссылка quasar:// повреждена'); }
  if (!obj || obj.v !== 1 || !Array.isArray(obj.items)) throw new Error('Эта ссылка от другой версии Квазара');
  if (obj.items.length > MAX_ITEMS) throw new Error('Слишком много протоколов в ссылке');
  const items = [], skipped = [];
  for (const it of obj.items) {
    try {
      if (EXT.has(it.proto)) {
        if (!it.host || !(it.port > 0) || typeof it.x !== 'object' || !it.x) throw new Error('неполные данные ' + it.proto);
        items.push({ proto: it.proto, name: String(it.name || it.proto), host: String(it.host), port: Number(it.port), x: it.x });
      } else if (it.proto === 'shadowtls') {
        if (!it.host || !(it.port > 0) || !it.password || !it.ss) throw new Error('неполные данные ShadowTLS');
        items.push({ proto: 'shadowtls', name: String(it.name || 'ShadowTLS'), host: String(it.host), port: Number(it.port), version: 3, password: it.password, sni: it.sni, ss: it.ss });
      } else {
        const p = parseLink(String(it.uri || ''));
        if (it.name) p.name = String(it.name);
        items.push(p);
      }
    } catch (e) { skipped.push({ link: String(it && it.name || '?'), reason: e.message }); }
  }
  if (!items.length) throw new Error('В ссылке нет рабочих протоколов');
  return { name: String(obj.name || obj.host || 'Сервер'), host: String(obj.host || items[0].host), items, skipped };
}

module.exports = { EXT, b64u, fromB64, buildLink, parseLink, packBundle, unpackBundle, toSubscription, importText };
