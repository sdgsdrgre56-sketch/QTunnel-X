'use strict';
// «Тревога: блокировка» и смена маскировки. Вся работа с сетью и сервером приходит через ctx, поэтому логику можно проверять тестами.
const { portsFor, PORT_ORDER } = require('./serverconf');
const { REALITY_CANDIDATES, HOST_RE } = require('./reality');

const PREF = ['vless', 'hysteria2', 'shadowquic', 'tuic', 'photon', 'antohin', 'mieru', 'naive', 'anytls', 'trojan', 'shadowtls', 'brook', 'juicity', 'restls', 'snell', 'tlsmirror', 'sudoku', 'http', 'shadowsocks', 'socks', 'dnstt'];
const SHADOWTLS_SITES = ['www.apple.com', 'www.microsoft.com', 'www.amazon.com', 'www.nvidia.com', 'www.oracle.com', 'www.intel.com'];
const SQ_SITES = ['cloudflare.com', 'www.cloudflare.com', 'www.google.com', 'www.youtube.com', 'www.apple.com'];

const label = (it) => (it.transport === 'xhttp' ? 'VLESS XHTTP' : it.proto);

// Где у протокола «маскировка» и можно ли её поменять только в приложении
function maskInfo(it) {
  if (it.proto === 'vless') return { value: it.sni || '', where: 'server', key: 'reality' };
  if (it.proto === 'shadowtls') return { value: it.sni || '', where: 'server', key: 'shadowtls' };
  if (it.proto === 'shadowquic') return { value: (it.x && it.x.sni) || '', where: 'server', key: 'shadowquic' };
  // Trojan и AnyTLS с Reality: сайт-маска общий с VLESS и прописан на сервере — меняется переустановкой вместе с VLESS
  if ((it.proto === 'trojan' || it.proto === 'anytls') && it.publicKey) return { value: it.sni || '', where: 'fixed', why: 'Reality: сайт общий с VLESS, меняется вместе с ним при переустановке' };
  if (it.proto === 'photon' || it.proto === 'antohin') return { value: (it.x && it.x.sni) || '', where: 'client', key: 'x.sni' };
  if (['hysteria2', 'tuic', 'trojan', 'anytls'].includes(it.proto) || (it.proto === 'http' && it.tls)) {
    // с самоподписанным сертификатом (insecure) SNI клиента сервер не проверяет — меняем только у себя
    return it.insecure ? { value: it.sni || '', where: 'client', key: 'sni' } : { value: it.sni || '', where: 'fixed', why: 'сертификат на твой домен: маскировка — сам домен' };
  }
  return null;
}

// Порты, которые сейчас занимают протоколы сервера (чтобы смена маскировки их не трогала)
function portsOf(items) {
  const known = {};
  for (const it of items) {
    const k = it.proto === 'vless' ? (it.transport === 'xhttp' ? 'xhttp' : 'vless') : it.proto;
    if (PORT_ORDER.includes(k)) known[k] = it.port;
  }
  for (let i = 0; i < 20; i++) {
    const r = { ...portsFor('random'), ...known };
    if (new Set(Object.values(r)).size === PORT_ORDER.length) return r;
  }
  throw new Error('Не удалось подобрать свободные порты');
}

// Текущие маскировки сервера — их сохраняем, если меняем что-то одно
function masksOf(items) {
  const v = items.find((x) => x.proto === 'vless'), st = items.find((x) => x.proto === 'shadowtls'), sq = items.find((x) => x.proto === 'shadowquic');
  return { realitySni: v && v.sni, shadowtlsSni: st && st.sni, shadowquicSni: sq && sq.x && sq.x.sni };
}
const pickOther = (list, cur) => { const l = list.filter((x) => x !== cur); return l[Math.floor(Math.random() * l.length)] || cur; };

/**
 * ctx: { servers(), group(host), access(host), connect(id), disconnect(), works() → bool, tcpPing(host, port, ms),
 *        redeploy(host, overrides, route) → items, viaProxySock(host, port) → socket, log(msg), maskSites() }
 */
async function runAlarm(ctx, { current } = {}) {
  const L = ctx.log;
  const all = ctx.servers();
  const byHost = new Map(); for (const it of all) { if (!byHost.has(it.host)) byHost.set(it.host, []); byHost.get(it.host).push(it); }
  const warp = all.find((x) => x.proto === 'warp');
  byHost.delete(warp && warp.host);
  const hosts = [...byHost.keys()].sort((a, b) => (a === current ? -1 : b === current ? 1 : 0));
  if (!hosts.length && !warp) { L('Серверов нет: добавь или установи свой сервер'); return { ok: false }; }

  const ordered = (items) => items.slice().sort((a, b) => PREF.indexOf(a.proto) - PREF.indexOf(b.proto));
  async function tryItems(items) {
    for (const it of ordered(items)) {
      L(`Пробую ${ctx.group(it.host)} · ${label(it)} (порт ${it.port})`);
      try { await ctx.connect(it.id); if (await ctx.works()) { L('Есть связь через ' + label(it)); return it; } L('  не пробился'); }
      catch (e) { L('  ошибка: ' + e.message); }
    }
    return null;
  }

  // 1. Что вообще доступно
  L('Шаг 1. Проверяю, что заблокировано');
  const reach = {};
  for (const h of hosts) {
    const acc = ctx.access(h), tcp = byHost.get(h).filter((x) => !['hysteria2', 'tuic', 'shadowquic', 'juicity', 'dnstt', 'warp'].includes(x.proto)).map((x) => x.port);
    const ports = [...new Set([acc ? acc.port : 22, ...tcp])].slice(0, 6);
    const res = await Promise.all(ports.map((p) => ctx.tcpPing(h, p, 3000)));
    reach[h] = res.some((ms) => ms !== null);
    L(`${ctx.group(h)}: ${reach[h] ? 'IP отвечает' : 'IP не отвечает ни на один порт — похоже, заблокирован'}`);
  }

  // 2. Перебор протоколов на всех серверах
  L('Шаг 2. Перебираю протоколы');
  for (const h of hosts) {
    if (!reach[h]) { L(`${ctx.group(h)}: TCP не отвечает, пробую только протоколы на UDP`); }
    const items = reach[h] ? byHost.get(h) : byHost.get(h).filter((x) => ['hysteria2', 'tuic', 'shadowquic', 'juicity'].includes(x.proto));
    const got = await tryItems(items);
    if (got) return { ok: true, how: 'protocol', item: got };
  }

  // 3. Смена маскировки и портов на сервере
  L('Шаг 3. Меняю маскировку и порты на серверах, где сохранён доступ');
  const own = ctx.maskSites();
  for (const h of hosts) {
    const acc = ctx.access(h);
    if (!acc) { L(`${ctx.group(h)}: доступ не сохранён — пропускаю (включи «Запомнить доступ» при установке)`); continue; }
    let route = null;
    if (reach[h] && (await ctx.tcpPing(h, acc.port, 3000)) !== null) route = { kind: 'direct' };
    else if (warp) {
      L(`${ctx.group(h)}: напрямую не достучаться, иду на сервер через WARP`);
      try { await ctx.connect(warp.id); if (await ctx.works()) route = { kind: 'warp', sock: () => ctx.viaProxySock(h, acc.port) }; else L('  WARP тоже не работает'); }
      catch (e) { L('  WARP не запустился: ' + e.message); }
    }
    if (!route) { L(`${ctx.group(h)}: к серверу не пробиться. Если IP заблокирован целиком, нужен новый IP у хостера`); continue; }
    const cur = masksOf(byHost.get(h));
    const reality = [...own, ...REALITY_CANDIDATES].filter((x) => x !== cur.realitySni);
    const overrides = { portMode: 'random', realityCandidates: reality, shadowtlsSni: pickOther([...own, ...SHADOWTLS_SITES], cur.shadowtlsSni), shadowquicSni: pickOther(SQ_SITES, cur.shadowquicSni) };
    L(`${ctx.group(h)}: переустанавливаю с новыми портами и маскировкой (было: ${cur.realitySni || '—'})`);
    try {
      const items = await ctx.redeploy(h, overrides, route);
      L(`${ctx.group(h)}: готово, протоколов: ${items.length}`);
      const got = await tryItems(items);
      if (got) return { ok: true, how: 'rotate', item: got };
    } catch (e) { L(`${ctx.group(h)}: не получилось: ${e.message}`); }
  }

  // 4. Запасной выход — WARP
  if (warp) {
    L('Шаг 4. Свои серверы не пробились, включаю WARP, чтобы был хоть какой-то выход');
    try { await ctx.connect(warp.id); if (await ctx.works()) { L('Работаю через WARP'); return { ok: true, how: 'warp', item: warp }; } } catch (e) { L('  WARP: ' + e.message); }
  }
  await ctx.disconnect().catch(() => {});
  L('Ничего не пробилось. Проверь интернет без VPN; если он есть — у серверов, скорее всего, заблокированы IP: нужен новый IP у хостера');
  return { ok: false };
}

function checkMask(v) { const s = String(v || '').trim().toLowerCase(); if (!HOST_RE.test(s)) throw new Error('Маскировка: нужен адрес сайта, например www.apple.com'); return s; }

module.exports = { runAlarm, maskInfo, portsOf, masksOf, checkMask, PREF };
