'use strict';
// Квазар: локальный сервер приложения. Слушает только 127.0.0.1, все запросы к API требуют случайный токен,
// чужие сайты в браузере не могут обращаться к нему (проверка Host и Origin), страницы отдаются с жёстким CSP.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const M = require('./index');
const { Store } = require('./lib/store');
const { Core } = require('./lib/core');
const { buildClientConfig } = require('./lib/clientconf');
const NET = require('./lib/net');
const { SysProxy } = require('./lib/sysproxy');
const { portsFor } = require('./lib/serverconf');
const REAL = require('./lib/reality');
const UNINST = require('./lib/uninstall');
const ALARM = require('./lib/alarm');
const TUNE = require('./lib/tune');
const { Secret } = require('./lib/secret');
const SHARE = require('./lib/share');
const COREREG = require('./lib/cores');
const { installCore } = require('./lib/coreinstall');

const UI_DIR = path.join(__dirname, 'ui');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const TCP_PROTOS = new Set(['vless', 'trojan', 'anytls', 'shadowsocks', 'shadowtls', 'http', 'socks', 'naive', 'photon', 'antohin', 'sudoku', 'mieru', 'brook', 'restls', 'snell', 'tlsmirror', 'warp']);   // остальные (QUIC/UDP) пингуем через соседний TCP-порт того же сервера
const HOST_OK = /^[a-z0-9.\-:]{1,253}$/i;
const PREF = ['vless', 'hysteria2', 'tuic', 'anytls', 'trojan', 'shadowtls', 'shadowsocks', 'http', 'socks', 'naive', 'warp', 'shadowquic', 'sudoku', 'dnstt', 'photon', 'antohin', 'mieru', 'brook', 'juicity', 'restls', 'snell', 'tlsmirror'];   // какой протокол брать у сервера по умолчанию
const MAX_BATCH = 10, POOL = 3;
const POPULAR = ['google.com', 'youtube.com', 'discord.com', 'api.telegram.org', 'github.com', 'cloudflare.com', 'www.instagram.com', 'x.com', 'www.facebook.com', 'www.reddit.com', 'chatgpt.com', 'claude.ai', 'store.steampowered.com', 'www.twitch.tv', 'www.tiktok.com', 'web.whatsapp.com'];   // чтобы сразу было с чем сравнить пинг

function lanAddresses(port) {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(`${a.address}:${port}`);
  return out;
}

// Регистрация бесплатного WARP: usque сам создаёт ключи и конфиг. Согласие с условиями Cloudflare подтверждается ответом «y».
function registerWarp(exe, conf) {
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    const p = spawn(exe, ['-c', conf, 'register'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = ''; const on = (d) => { out += d; if (out.length > 4000) out = out.slice(-4000); };
    p.stdout.on('data', on); p.stderr.on('data', on);
    p.stdin.write('y\n'); p.stdin.end();
    const t = setTimeout(() => { p.kill(); reject(new Error('Регистрация WARP не завершилась за 60 секунд')); }, 60000);
    p.once('error', (e) => { clearTimeout(t); reject(e); });
    p.once('exit', (c) => { clearTimeout(t); fs.existsSync(conf) ? resolve() : reject(new Error('WARP не зарегистрировался (код ' + c + '). ' + out.trim().split('\n').slice(-2).join(' '))); });
  });
}

const ANDROID = !!process.env.QUASAR_ANDROID;   // Android-сборка: Node внутри APK, TUN поднимает само приложение

function createApp({ dataDir, appDir = __dirname, token, core, pollMs = 1000, sysproxy, deps: deps0 = {}, onQuit, onElevate, appLog, autoFallback = false, quitGraceMs = 4000, idleQuitMs = 180000 } = {}) {
  const store = new Store(dataDir);
  const tok = token || crypto.randomBytes(18).toString('base64url');
  const kore = core || new Core({ dataDir, appDir });
  const sysp = sysproxy || new SysProxy({ dataDir });
  if (ANDROID) {
    // Android: sing-box работает без TUN (локальный порт), а VpnService в приложении гонит весь трафик телефона в этот порт
    const ctl = (a, p) => { try { require('http').get(`http://127.0.0.1:${process.env.QUASAR_CTL}/tun/${a}?port=${p || 0}`, (r) => r.resume()).on('error', () => {}); } catch { /* приложение закрыто */ } };
    kore.on('started', (s) => { if (store.data.settings.tun) ctl('start', s.mixedPort); else ctl('stop'); });
    kore.on('exit', () => ctl('stop'));
    const was = kore.stop.bind(kore); kore.stop = async () => { await was(); ctl('stop'); };
  }
  const ext = new COREREG.ExtCore({ dataDir, appDir, log: (l) => kore.log(l) });
  // Ядро протокола за постоянным туннелем (для протоколов самого sing-box); внешние ядра — ext. Оба на порту innerPort.
  const inner = new Core({ dataDir: path.join(dataDir, 'inner'), appDir, exe: kore.exe || null });   // тот же sing-box, что и у туннеля
  inner.on('log', (l) => kore.log('[протокол] ' + l));
  let innerPort = null, tunName = SHARE.TUN_NAMES[1];   // первый запуск переключит на quasar-tun
  const tunSecret = crypto.randomBytes(16).toString('hex');
  // программы ядер протоколов: их трафик к серверу идёт мимо туннеля
  const INNER_PROCS = [...new Set(['sing-box', ...Object.values(COREREG.CORES).map((c) => c.exe).filter(Boolean)])].map(COREREG.exeName);
  const secret = deps0.secret || new Secret(dataDir);
  const share = deps0.share || new SHARE.Share({ run: SHARE.psRunner() });
  let shareInfo = { busy: false, ssid: '', pass: '', error: '', log: [] };
  let shareQ = Promise.resolve();                        // операции раздачи строго по очереди: выключение и включение не должны обгонять друг друга
  const shareOp = (fn) => (shareQ = shareQ.then(fn, fn));
  // Как в NekoBox, но без утечки: когда ядро не работает, общий доступ и точку доступа снимаем,
  // иначе Windows сама переключит раздачу на обычный адаптер и приставка пойдёт мимо VPN (известная проблема neko-tun).
  // Пока раздача включена, а карта к приставке ещё не появилась (USB не вставлена) — проверяем раз в несколько секунд
  const shareWatch = setInterval(() => {
    const sh = store.data.settings.share;
    if (!sh || !sh.on || shareInfo.up || shareInfo.busy || !kore.state.running || !store.data.settings.tun || !share.supported) return;
    shareOp(applyShare).catch((e) => { shareInfo.error = e.message; });
  }, deps0.shareWatchMs || 8000);
  shareWatch.unref();
  const shareDown = () => shareOp(async () => {
    const sh = store.data.settings.share;
    if (!sh || !sh.on || !share.supported || !shareInfo.up) return;   // снимаем только то, что реально поднимали, и один раз
    shareInfo.up = false;
    await share.icsOff().catch(() => {});
    if (sh.via === 'wifi') await share.stopWifi().catch(() => {});
    shareInfo.ssid = ''; shareInfo.pass = '';
  });
  let maint = { running: false, kind: '', host: '', logs: [], ok: null, error: '' };   // тревога и смена маскировки
  const coreJobs = {};
  const setupInfo = { ssh2: null };   // id -> { status: 'run'|'ok'|'error', msg }
  const deps = {};
  const pings = new Map();                      // id -> { ms, at }
  let job = { running: false, servers: [], link: '' };
  let pingProg = { running: false, total: 0, done: 0 };   // шкала «пинг идёт: n из N»
  let ipCache = { at: 0, v: null };
  let lastTotals = { down: 0, up: 0 };
  let session = { down: 0, up: 0 };
  let speed = { down: 0, up: 0 }, lastPoll = 0;

  // ---------- трафик от ядра (clash API) ----------
  function clashGet(p) {
    const st = kore.state;
    return new Promise((resolve, reject) => {
      if (!st.running) return reject(new Error('Ядро не запущено'));
      const req = http.get({ host: '127.0.0.1', port: st.apiPort, path: p, headers: { Authorization: 'Bearer ' + st.secret }, timeout: 3000 }, (res) => {
        let b = ''; res.setEncoding('utf8'); res.on('data', (c) => { b += c; if (b.length > 4e6) req.destroy(); });
        res.on('end', () => { try { resolve(JSON.parse(b)); } catch { reject(new Error('Ядро вернуло не JSON')); } });
      });
      req.on('error', reject); req.on('timeout', () => req.destroy(new Error('таймаут')));
    });
  }
  // Журнал соединений: из списка активных соединений ядра собираем «что куда и по какому правилу», открытые и закрытые
  let connSeq = 0; const connLive = new Map(); let connLog = [];
  const baseName = (p) => String(p || '').split(/[\\/]/).pop();
  function whyRoute(x) {
    const r = String(x.rule || '').trim(), pl = x.rulePayload ? ` (${x.rulePayload})` : '';
    if (!r || /^final/i.test(r)) return 'правил нет — по умолчанию через сервер';
    if (/direct/i.test(r)) return 'правило «напрямую»: ' + r + pl;
    if (/reject|block/i.test(r)) return 'заблокировано: ' + r + pl;
    return 'правило: ' + r + pl;
  }
  function trackConns(list, now) {
    const seen = new Set();
    for (const x of list) {
      seen.add(x.id);
      let e = connLive.get(x.id);
      if (!e) {
        const m = x.metadata || {}, chain = (x.chains || []).slice().reverse();
        const direct = chain.includes('direct');
        const lan = /lan-in/.test(m.type || '') || ((m.type || '').startsWith('mixed') && m.sourceIP && !/^(127\.|::1)/.test(m.sourceIP));
        e = { seq: ++connSeq, id: x.id, at: Date.now(), host: m.host || m.destinationIP || '', ip: m.destinationIP || '', port: Number(m.destinationPort) || 0, net: String(m.network || 'tcp').toLowerCase(),
          proc: baseName(m.processPath) || '', inb: lan ? 'приставка' : /tun/i.test(m.type || '') ? 'весь компьютер (TUN)' : 'прокси', src: baseName(m.processPath) || (m.sourceIP ? m.sourceIP + (m.sourcePort ? ':' + m.sourcePort : '') : ''),
          out: direct ? 'direct' : 'proxy', route: chain.join(' → '), why: whyRoute(x), up: 0, down: 0, open: true, closedAt: 0 };
        connLive.set(x.id, e); connLog.push(e);
      }
      e.up = Number(x.upload) || 0; e.down = Number(x.download) || 0;
    }
    for (const [id, e] of connLive) if (!seen.has(id)) { e.open = false; e.closedAt = now; connLive.delete(id); }
    if (connLog.length > 600) connLog = connLog.slice(-400);
  }
  async function pollOnce() {
    if (!kore.state.running) return;
    try {
      const c = await clashGet('/connections');
      trackConns(c.connections || [], Date.now());
      const down = Number(c.downloadTotal) || 0, up = Number(c.uploadTotal) || 0;
      const dd = down >= lastTotals.down ? down - lastTotals.down : down, du = up >= lastTotals.up ? up - lastTotals.up : up;
      lastTotals = { down, up };
      const now = Date.now(), dt = lastPoll ? (now - lastPoll) / 1000 : 0; lastPoll = now;
      if (dt > 0) speed = { down: Math.round(dd / dt), up: Math.round(du / dt) };
      session.down += dd; session.up += du;
      store.addUsage(dd, du); store.addServerUsage(kore.state.itemId, dd, du);   // трафик по каждому профилю отдельно
    } catch { /* ядро занято или остановилось — попробуем в следующий раз */ }
  }
  const timer = setInterval(pollOnce, pollMs); timer.unref();
  const closeLive = () => { const t = Date.now(); for (const e of connLive.values()) { e.open = false; e.closedAt = t; } connLive.clear(); };   // история остаётся, пока не очистишь
  kore.on('started', () => { closeLive(); lastTotals = { down: 0, up: 0 }; session = { down: 0, up: 0 }; speed = { down: 0, up: 0 }; lastPoll = 0; });
  kore.on('exit', () => { closeLive(); lastTotals = { down: 0, up: 0 }; sysp.restore().catch(() => {}); shareDown(); });

  // ---------- представление данных для интерфейса (без ключей) ----------
  const view = (s) => ({ id: s.id, name: s.name, proto: s.proto, host: s.host, port: s.port, group: s.group, insecure: !!s.insecure, transport: s.transport, tls: !!s.tls, mask: ALARM.maskInfo(s), tunable: TUNE.portTunable(s) });
  let admin = null;   // есть ли права администратора; проверяем при старте и после каждой смены режима
  const checkAdmin = () => Promise.resolve().then(() => sysp.isAdmin()).then((v) => { admin = !!v; }, () => { admin = false; });
  checkAdmin();
  function stateView() {
    const set = store.data.settings;
    const lan = set.lan ? { addresses: lanAddresses(set.lanPort), port: set.lanPort, auth: set.lanAuth !== false, device: set.lanDevice || '', user: 'quasar', pass: set.lanPass } : null;
    return {
      servers: store.data.servers.map((s) => ({ ...view(s), ping: pings.get(s.id) || null, traffic: (store.data.traffic || {})[s.id] || null })),
      settings: { skin: set.skin, lan: set.lan, lanAuth: set.lanAuth !== false, lanDevice: set.lanDevice || '', lanPort: set.lanPort, adblock: set.adblock, tun: set.tun, sysproxy: set.sysproxy, bigAds: set.bigAds, autoFallback: fbOn(), trayKeep: !!set.trayKeep, limitGb: set.limitGb, rules: set.rules || [] },
      cores: COREREG.status(appDir, store.data.servers).map((c) => ({ ...c, job: coreJobs[c.id] || null })),
      mode: !kore.state.running ? null : set.tun ? 'TUN' : set.sysproxy ? 'Системный прокси' : 'Локальный прокси',
      speed: kore.state.running ? speed : { down: 0, up: 0 },
      check: connCheck, lan, sites: store.data.sites, own: (store.data.own || []).filter((h) => store.data.servers.some((x) => x.host === h)), admin, canElevate: !!onElevate,
      usage: { ...store.usageSummary(), session },
      core: { running: kore.state.running, itemId: kore.state.itemId, since: kore.state.since, logs: kore.logs.slice(-30) },
      maint: { running: maint.running, stopping: maintStop && maint.running, kind: maint.kind, host: maint.host, logs: maint.logs.slice(-60), ok: maint.ok, error: maint.error },
      share: { ...(set.share || {}), waiting: !!shareInfo.waiting, busy: shareInfo.busy, ssid: shareInfo.ssid, pass: shareInfo.pass, error: shareInfo.error, log: shareInfo.log.slice(-20), supported: share.supported },
      appLog: appLog ? appLog().slice(-200) : [], setup: { singbox: coreJobs.singbox || null, ssh2: setupInfo.ssh2 },
      pingProg: { ...pingProg }, maskList: REAL.REALITY_CANDIDATES,
      maskSites: store.data.maskSites, access: Object.keys(store.data.access || {}),
      deploy: {
        running: job.running, link: job.link,
        servers: job.servers.map((x) => ({ host: x.host, name: x.name, status: x.status, error: x.error, added: x.added, link: x.link, logs: x.logs.slice(-400) })),
        error: job.servers.filter((x) => x.error).map((x) => `${x.host}: ${x.error}`).join('; '),
        added: job.servers.reduce((a, x) => a + x.added, 0),
      },
    };
  }

  function pingPort(item) {
    if (TCP_PROTOS.has(item.proto)) return item.port;
    const sib = store.data.servers.find((s) => s.host === item.host && TCP_PROTOS.has(s.proto));
    return sib ? sib.port : null;
  }

  // ---------- API ----------
  const routes = {
    'GET /api/state': async () => stateView(),
    'POST /api/import': async ({ text }) => {
      const r = M.importText(text);
      const added = store.addServers(r.items, r.name);
      return { added, total: r.items.length, skipped: r.skipped, state: stateView() };
    },
    'POST /api/servers/delete': async ({ id, ids }) => {
      const list = [...new Set((Array.isArray(ids) ? ids : [id]).map(String))].filter((i) => store.server(i));
      if (list.includes(kore.state.itemId)) await stopAll();
      for (const i of list) { store.removeServer(i); pings.delete(i); }
      return stateView();
    },
    // Что сейчас открыто и идёт через туннель: по программам (на ПК в режиме TUN видно имя процесса), у каждой — самый «тяжёлый» адрес
    'GET /api/games': async () => {
      if (!kore.state.running) return { running: false, apps: [] };
      const priv = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|198\.18\.|fe80|::1)/i;
      const by = new Map();
      for (const e of connLive.values()) {
        if (e.out !== 'proxy' || !e.ip || priv.test(e.ip)) continue;
        const key = e.proc || 'программа (имя не видно)';
        const g = by.get(key) || { app: key, bytes: 0, dst: new Map() };
        const b = e.up + e.down; g.bytes += b;
        const k = e.net + '|' + e.ip + '|' + e.port, d = g.dst.get(k) || { net: e.net, ip: e.ip, port: e.port, host: e.host, bytes: 0 };
        d.bytes += b; g.dst.set(k, d); by.set(key, g);
      }
      const apps = [...by.values()].map((g) => {
        const all = [...g.dst.values()].sort((a, b) => b.bytes - a.bytes);
        const udp = all.filter((d) => d.net === 'udp' && d.bytes > 2048);   // игровой поток — это обычно UDP с заметным трафиком
        const t = udp[0] || all[0];
        return { app: g.app, bytes: g.bytes, target: t, game: /fortnite|epic|valorant|riot|cs2|csgo|dota|apex|pubg|warzone|overwatch|minecraft|steam/i.test(g.app) };
      }).sort((a, b) => (b.game - a.game) || (b.bytes - a.bytes)).slice(0, 8);
      return { running: true, apps };
    },
    'POST /api/ping': async ({ ids, mode, site, game }) => {
      let target = null, gtarget = null;
      if (mode === 'game') {   // «Пинг до игры»: адрес, к которому игра подключена сейчас, сквозь каждый протокол
        const ip = String((game && game.ip) || '').trim(), gp = Number(game && game.port) || 0;
        if (!/^[0-9a-fA-F:.]{3,45}$/.test(ip)) throw new Error('Не выбрана игра: нажми «Найти игру», когда она запущена');
        gtarget = { ip, host: String((game && game.host) || ip), port: gp, net: game && game.net === 'tcp' ? 'tcp' : 'udp', app: String((game && game.app) || '').slice(0, 60) };
        mode = 'url';
      }
      if (mode === 'site') {   // «Пинг до сайта»: задержка до выбранного сайта сквозь каждый протокол
        target = parseSite(site);
        if (!target) throw new Error('Укажи сайт, например www.epicgames.com или host:порт');
        mode = 'url';
      }
      const list = (Array.isArray(ids) && ids.length ? ids.map((i) => store.server(i)).filter(Boolean) : store.data.servers);
      const deep = mode === 'deep'; if (deep) mode = 'url';
      const STEPS = mode === 'url' ? 1 : 3;   // TCP-пинг — три замера на профиль; шкала идёт по замерам, а не по профилям
      pingProg = { running: true, total: list.length * STEPS, done: 0 };
      const tick = () => { pingProg.done++; };
      try {
        if (mode === 'url') {
          // «URL-тест»: настоящая задержка через сервер (запрос до сайта сквозь протокол), как в NekoBox
          const queue = list.slice();
          await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
            while (queue.length) {
              const s = queue.shift();
              const md = gtarget ? 'game' : target ? 'site' : deep ? 'deep' : 'url', sn = target ? target.host + (target.port !== 443 ? ':' + target.port : '') : undefined;
              try { const v = await urlTest(s, { deep, site: target, game: gtarget }); pings.set(s.id, typeof v === 'object' ? (v.how ? { ms: v.ms, at: Date.now(), mode: 'game', how: v.how, site: gtarget.app || gtarget.ip } : { ms: v.ms, kbps: v.kbps, at: Date.now(), mode: 'deep' }) : { ms: v, at: Date.now(), mode: md, site: sn }); }
              catch (e) { pings.set(s.id, { ms: null, at: Date.now(), mode: md, site: gtarget ? (gtarget.app || gtarget.ip) : sn, err: e.message }); }
              tick();
            }
          }));
        } else {
          const queue = list.slice();
          await Promise.all(Array.from({ length: Math.min(8, queue.length) }, async () => {
            while (queue.length) {
              const s = queue.shift(), port = pingPort(s);
              const r = [];
              for (let k = 0; k < 3; k++) { const v = port ? await (deps.tcpPing || NET.tcpPing)(s.host, port, 2500) : null; if (v !== null) r.push(v); tick(); if (!port) { pingProg.done += 2; break; } }
              r.sort((a, b) => a - b);
              const ms = r.length ? Math.max(1, Math.round(r[Math.floor(r.length / 2)])) : null;
              pings.set(s.id, { ms, at: Date.now(), mode: 'tcp', via: port && port !== s.port ? 'tcp:' + port : null, tun: !!(kore.state.running && store.data.settings.tun) });
            }
          }));
        }
      } finally { pingProg = { running: false, total: list.length * STEPS, done: list.length * STEPS }; }
      return stateView();
    },
    // Проверка портов сервера с этого компьютера: TCP-порты открываем напрямую, UDP по соединению не проверить
    'POST /api/ports-check': async ({ host }) => {
      const list = store.data.servers.filter((x) => x.host === String(host || ''));
      if (!list.length) throw new Error('Сервер не найден');
      const rows = await Promise.all(list.map(async (x) => {
        const tcp = TCP_PROTOS.has(x.proto);
        const ms = tcp ? await (deps.tcpPing || NET.tcpPing)(x.host, x.port, 3000) : undefined;
        return { id: x.id, name: x.name, proto: x.proto, port: x.port, kind: tcp ? 'tcp' : 'udp', ok: tcp ? ms !== null : null, ms: tcp ? ms : null };
      }));
      const open = rows.filter((r) => r.ok === true), shut = rows.filter((r) => r.ok === false);
      let verdict;
      if (!shut.length) verdict = 'Все TCP-порты отвечают. Если какой-то протокол не работает, дело не в порте: смотри карточку после подключения.';
      else if (!open.length) verdict = 'Ни один TCP-порт не отвечает: сервер выключен, IP заблокирован или адрес введён неверно.';
      else verdict = `Закрыты порты: ${shut.map((r) => r.port).join(', ')}, а ${open.map((r) => r.port).join(', ')} открыты. Сервер работает, значит эти порты режет файрвол хостера (открой их в панели хостинга) или твой провайдер. Быстрый выход: переустанови сервер с режимом портов «Ходовые» (443, 8443, 2053…) — их почти никогда не закрывают.`;
      return { rows, verdict };
    },
    'POST /api/cores/install': async ({ id }) => {
      if (!COREREG.CORES[id] || !COREREG.CORES[id].repo) throw new Error('Это ядро нельзя скачать автоматически');
      if (coreJobs[id] && coreJobs[id].status === 'run') throw new Error('Уже скачивается');
      coreJobs[id] = { status: 'run', msg: 'скачиваю…' };
      (deps.installCore || installCore)(id, { appDir, ...(deps.install || {}) })
        .then((r) => { coreJobs[id] = { status: 'ok', msg: r.version || 'готово' }; })
        .catch((e) => { coreJobs[id] = { status: 'error', msg: e.message }; });
      return stateView();
    },
    'POST /api/cores/add': async ({ core, values }) => {
      const c = COREREG.CORES[core];
      if (!c || !c.makeItem) throw new Error('Для этого ядра нельзя добавить сервер');
      const it = c.makeItem(values || {});
      it.name = String((values && values.name) || (core === 'usque' ? 'Cloudflare WARP' : c.title + ' · ' + it.host)).slice(0, 60);
      store.addServers([it], it.name);
      return stateView();
    },
    'POST /api/warp/register': async () => {
      const exe = COREREG.findExe(appDir, 'usque');
      if (!exe) throw new Error('Сначала скачай ядро WARP (usque) на вкладке «Ядра»');
      const dir = path.join(dataDir, 'warp'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      await (deps.registerWarp || registerWarp)(exe, path.join(dir, 'config.json'));
      const it = COREREG.CORES.usque.makeItem(); it.name = 'Cloudflare WARP';
      store.addServers([it], 'Cloudflare WARP');
      return stateView();
    },
    'POST /api/alarm': async () => {
      if (maint.running || job.running) throw new Error('Уже идёт установка, тревога или смена маскировки');
      const cur = store.server(kore.state.itemId);
      startMaint('alarm', cur ? cur.host : '', (log) => ALARM.runAlarm(alarmCtx(log), { current: cur && cur.host }));
      return stateView();
    },
    'POST /api/mask': async ({ id, value }) => {
      const it = store.server(id); if (!it) throw new Error('Сервер не найден');
      const info = ALARM.maskInfo(it);
      if (!info || info.where === 'fixed') throw new Error(info ? info.why : 'У этого протокола нет маскировки');
      const v = ALARM.checkMask(value);
      if (info.where === 'client') {
        store.updateServer(id, info.key === 'x.sni' ? { x: { sni: v } } : { sni: v });
        if (kore.state.running && kore.state.itemId === id) await startCore(id);
        return stateView();
      }
      if (!store.data.access[it.host]) throw new Error('Эта маскировка прописана и на сервере. Чтобы менять её из приложения, переустанови сервер с галочкой «Запомнить доступ для Тревоги»');
      if (maint.running || job.running) throw new Error('Уже идёт установка, тревога или смена маскировки');
      const items = store.data.servers.filter((x) => x.host === it.host), m = ALARM.masksOf(items);
      const ov = { ports: ALARM.portsOf(items), realitySni: m.realitySni, realityForce: !!m.realitySni, shadowtlsSni: m.shadowtlsSni, shadowquicSni: m.shadowquicSni };
      if (info.key === 'reality') { ov.realitySni = v; ov.realityForce = true; }
      if (info.key === 'shadowtls') ov.shadowtlsSni = v;
      if (info.key === 'shadowquic') ov.shadowquicSni = v;
      startMaint('mask', it.host, async (log) => {
        log(`Меняю маскировку ${it.proto} на ${v}: захожу на сервер, порты остаются прежними`);
        const route = (await (deps.tcpPing || NET.tcpPing)(it.host, store.data.access[it.host].port, 3000)) !== null ? { kind: 'direct' }
          : kore.state.running ? { kind: 'proxy', sock: () => viaProxySock(it.host, store.data.access[it.host].port) } : null;
        if (!route) throw new Error('До сервера по SSH не достучаться ни напрямую, ни через текущее подключение');
        const wasOn = kore.state.running && store.server(kore.state.itemId) && store.server(kore.state.itemId).host === it.host;
        const fresh = await redeploy(it.host, ov, route, log);
        log('Готово: маскировка сменилась, протоколы сервера обновлены в списке');
        if (wasOn) { const same = fresh.find((x) => x.proto === it.proto && x.transport === it.transport) || fresh[0]; await startCore(same.id); log('Переподключился'); }
        return { ok: true };
      });
      return stateView();
    },
    // ---- быстрая смена порта и маскировки на сервере (по SSH, без переустановки), ручная и автоматическая ----
    'POST /api/maint/stop': async () => { if (!maint.running) return stateView(); maintStop = true; maint.logs.push('Останавливаю после текущего шага…'); return stateView(); },
    'POST /api/port': async ({ id, port }) => {
      const it = store.server(id); if (!it) throw new Error('Сервер не найден');
      if (!TUNE.portTunable(it)) throw new Error('Порт этого протокола меняется только переустановкой сервера');
      const n = Number(port); if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('Порт: число от 1 до 65535');
      if (n === it.port) throw new Error('Этот порт уже стоит');
      if (maint.running || job.running) throw new Error('Уже идёт установка, тревога или смена настроек');
      if (!store.data.access[it.host]) throw new Error('Чтобы менять порт из приложения, нужен сохранённый доступ к серверу (галочка «Запомнить доступ» при установке)');
      if (TUNE.candidatePorts({ ...it, port: -1 }, store.data.servers.filter((x) => x.host === it.host), [n]).length === 0) throw new Error('Этот порт уже занят другим протоколом сервера');
      startMaint('port', it.host, (log) => tunePorts(it, [n], log, false));
      return stateView();
    },
    'POST /api/port-auto': async ({ id }) => {
      const it = store.server(id); if (!it) throw new Error('Сервер не найден');
      if (!TUNE.portTunable(it)) throw new Error('Порт этого протокола меняется только переустановкой сервера');
      if (maint.running || job.running) throw new Error('Уже идёт установка, тревога или смена настроек');
      if (!store.data.access[it.host]) throw new Error('Для автоподбора нужен сохранённый доступ к серверу (галочка «Запомнить доступ» при установке)');
      const cands = TUNE.candidatePorts(it, store.data.servers.filter((x) => x.host === it.host));
      startMaint('port-auto', it.host, (log) => tunePorts(it, cands, log, true));
      return stateView();
    },
    'POST /api/mask-auto': async ({ id }) => {
      const it = store.server(id); if (!it) throw new Error('Сервер не найден');
      if (it.proto !== 'vless') throw new Error('Автоподбор маскировки есть у VLESS Reality; остальные меняются вручную');
      if (maint.running || job.running) throw new Error('Уже идёт установка, тревога или смена настроек');
      if (!store.data.access[it.host]) throw new Error('Для автоподбора нужен сохранённый доступ к серверу (галочка «Запомнить доступ» при установке)');
      startMaint('mask-auto', it.host, (log) => tuneMasks(it, log));
      return stateView();
    },
    'POST /api/mask-sites': async ({ add, remove }) => { if (add) store.addMaskSite(add); if (remove) store.removeMaskSite(String(remove)); return stateView(); },
    'POST /api/access/forget': async ({ host }) => { delete store.data.access[String(host || '')]; store.save(); return stateView(); },
    'GET /api/share/adapters': async () => ({ adapters: await share.adapters() }),
    'POST /api/share/start': async ({ via, adapter }) => {
      if (shareInfo.busy) throw new Error('Раздача уже включается');
      if (!['wifi', 'cable'].includes(via)) throw new Error('Выбери: Wi-Fi от ПК или кабель');
      if (via === 'cable' && !adapter) throw new Error('Выбери адаптер, к которому подключена приставка');
      const set = store.data.settings;
      if (!(await sysp.isAdmin())) throw new Error('Раздача и режим TUN требуют прав администратора: закрой Квазар и нажми «Перезапустить от администратора» вверху окна');
      shareInfo = { busy: true, ssid: '', pass: '', error: '', log: [] };
      try {
        let adapterDesc = '';
        if (via === 'cable') {
          const a = (await share.adapters()).find((x) => x.name === String(adapter));
          if (a && a.internet) throw new Error(`«${a.name}» — адаптер, через который сам ПК выходит в интернет. Выбери карту, к которой подключена приставка`);
          adapterDesc = a ? a.desc : '';
        }
        set.share = { on: true, via, adapter: via === 'cable' ? String(adapter) : '', adapterDesc };
        if (!set.tun) set.tun = true;                       // раздаём весь трафик ПК — без TUN нечего раздавать
        store.save();
        if (!kore.state.running) throw new Error('Сначала подключись к серверу: раздаётся уже проксированный интернет');
        await startCore(kore.state.itemId);                  // перезапуск с TUN (и без strict_route), затем общий доступ
        if (shareInfo.error) throw new Error(shareInfo.error);
      } catch (e) { set.share.on = false; store.save(); shareInfo.error = e.message; throw e; }
      finally { shareInfo.busy = false; }
      return stateView();
    },
    'POST /api/share/stop': async () => {
      const set = store.data.settings;
      const errs = [];
      await shareOp(async () => {
        shareInfo.up = false;
        await share.icsOff().catch((e) => errs.push(e.message));
        if (set.share.via === 'wifi') await share.stopWifi().catch((e) => errs.push(e.message));
      });
      set.share = { ...set.share, on: false }; store.save();
      shareInfo = { busy: false, ssid: '', pass: '', error: errs.join('; '), log: [] };
      if (kore.state.running) await startCore(kore.state.itemId);
      return stateView();
    },
    // Добавить сервер вручную, как «Новый профиль» в NekoBox: собираем обычную ссылку и разбираем её тем же кодом, что и импорт
    'POST /api/add-manual': async ({ proto, f = {} }) => {
      const NEED = { vless: ['uuid', 'publicKey'], trojan: ['password'], shadowsocks: ['method', 'password'], hysteria2: ['password'], tuic: ['uuid', 'password'], anytls: ['password'], http: [], socks: [] };
      if (!NEED[proto]) throw new Error('Этот тип добавляется на вкладке «Ядра» или ссылкой');
      const host = String(f.host || '').trim(), port = Number(f.port);
      if (!HOST_OK.test(host)) throw new Error('Неверный адрес сервера');
      if (!(Number.isInteger(port) && port > 0 && port < 65536)) throw new Error('Неверный порт');
      const str = (k) => String(f[k] == null ? '' : f[k]).trim();
      for (const k of NEED[proto]) if (!str(k)) throw new Error('Заполни поле «' + k + '»');
      const it = { proto, name: str('name') || `${proto} ${host}`, host, port, uuid: str('uuid'), password: str('password'), sni: str('sni'), insecure: !!f.insecure,
        publicKey: str('publicKey'), shortId: str('shortId'), flow: str('flow'), method: str('method'), obfsPassword: str('obfsPassword'), username: str('username'), tls: !!f.tls };
      const imp = M.importText(M.buildLink(it));
      const added = store.addServers(imp.items, it.name);
      return { added, state: stateView() };
    },
    'POST /api/elevate': async () => {
      if (!onElevate) throw new Error('Перезапуск от администратора доступен только в Windows');
      if (await sysp.isAdmin()) { admin = true; return { ok: true, already: true }; }
      setTimeout(() => onElevate(), 100);
      return { ok: true };
    },
    'POST /api/rename': async ({ id, host, name }) => { if (host) store.renameHost(String(host), name); else store.renameServer(String(id || ''), name); return stateView(); },
    'POST /api/quit': async () => { if (onQuit) setTimeout(onQuit, 50); return { ok: true }; },
    'POST /api/rules': async (p) => { store.addRule(p); await restartIfRunning(); return stateView(); },
    'POST /api/rules/delete': async ({ kind, value }) => { store.removeRule(kind, value); await restartIfRunning(); return stateView(); },
    'POST /api/sites': async ({ host }) => { store.addSite(host); return stateView(); },
    'POST /api/sites/preset': async () => {
      let added = 0;
      for (const h of [...REAL.REALITY_CANDIDATES, ...POPULAR]) { if (store.data.sites.length >= 120) break; if (!store.data.sites.includes(h)) { store.addSite(h); added++; } }
      return { ...stateView(), added };
    },
    'POST /api/sites/delete': async ({ host }) => { store.removeSite(String(host || '')); return stateView(); },
    'POST /api/sites/ping': async () => {
      const viaProxy = kore.state.running ? kore.state.mixedPort : null;
      const lanAuth = undefined;   // приложение ходит через свой вход 127.0.0.1, ему пароль не нужен
      const out = await Promise.all(store.data.sites.map(async (host) => {
        const one = async (f) => { try { return await f(); } catch { return null; } };
        const direct = await one(() => NET.siteLatencyDirect({ host, timeout: 5000 }));
        const via = viaProxy ? await one(() => NET.siteLatency({ proxyPort: viaProxy, host, timeout: 8000, auth: lanAuth })) : null;
        return { host, direct, via };
      }));
      return { results: out, viaProxy: !!viaProxy };
    },
    'POST /api/settings': async (p) => {
      const was = JSON.stringify(store.data.settings);
      store.setSettings(p);
      let restarted = false;
      if (kore.state.running && JSON.stringify(store.data.settings) !== was && (p.lan !== undefined || p.lanAuth !== undefined || p.lanDevice !== undefined || p.lanPort !== undefined || p.adblock !== undefined || p.tun !== undefined || p.sysproxy !== undefined || p.bigAds !== undefined)) {
        const id = kore.state.itemId; await startCore(id); restarted = true;   // настройки ядра применяются только при перезапуске
      }
      return { restarted, state: stateView() };
    },
    'POST /api/connect': async ({ id }) => { fbTried = []; fbNotes = []; await startCore(id); return stateView(); },
    'POST /api/disconnect': async () => { await stopAll(); return stateView(); },
    'GET /api/ip': async () => {
      if (Date.now() - ipCache.at < 15000 && ipCache.v) return ipCache.v;
      const auth = undefined;
      const g = async (proxyPort) => { try { return await NET.whatIsMyIp({ proxyPort, auth: proxyPort ? auth : undefined }); } catch { return null; } };
      const v = { direct: await g(null), via: kore.state.running ? await g(kore.state.mixedPort) : null };
      ipCache = { at: Date.now(), v };
      return v;
    },
    'GET /api/connlog': async () => ({ running: kore.state.running, seq: connSeq, items: connLog.slice(-300) }),
    'GET /api/traffic': async () => {
      if (!kore.state.running) return { connections: [] };
      const c = await clashGet('/connections');
      const rows = (c.connections || []).slice(0, 200).map((x) => {
        const m = x.metadata || {};
        const lanSrc = /lan-in/.test(m.type || '') || ((m.type || '').startsWith('mixed') && m.sourceIP && !/^(127\.|::1)/.test(m.sourceIP));
        return { fromLan: !!lanSrc, blocked: false, out: (x.chains || []).includes('direct') ? 'direct' : 'proxy', src: m.sourceIP || '', dst: (m.host || m.destinationIP || '') + (m.destinationPort ? ':' + m.destinationPort : ''), route: (x.chains || []).slice().reverse().join(' → '), up: x.upload || 0, down: x.download || 0 };
      });
      return { connections: rows };
    },
    'POST /api/deploy': async (p) => {
      if (job.running) throw new Error('Установка уже идёт');
      const list = Array.isArray(p.servers) ? p.servers : [p];
      if (!list.length || list.length > MAX_BATCH) throw new Error(`За один раз можно установить от 1 до ${MAX_BATCH} серверов`);
      const seen = new Set();
      const tasks = list.map((x, n) => {
        const host = String(x.host || '').trim(), port = Number(x.port || 22), username = String(x.username || 'root').trim();
        const label = `Сервер ${n + 1}: `;
        if (!HOST_OK.test(host)) throw new Error(label + 'неверный адрес');
        if (seen.has(host)) throw new Error(label + 'адрес ' + host + ' указан дважды');
        seen.add(host);
        if (!(port > 0 && port < 65536)) throw new Error(label + 'неверный порт SSH');
        if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(username)) throw new Error(label + 'неверное имя пользователя');
        if (!x.password && !x.privateKey) throw new Error(label + 'нужен пароль или ключ');
        const name = String(x.name || '').trim().slice(0, 40) || undefined;
        let ports;
        try { ports = portsFor(x.portMode || 'default', x.basePort); } catch (e) { throw new Error(label + e.message); }
        if (Object.values(ports).includes(port)) throw new Error(label + `порт SSH ${port} попадает в порты протоколов, выбери другой начальный порт`);
        const realitySni = String(x.realitySni || '').trim().toLowerCase();
        if (realitySni && !REAL.HOST_RE.test(realitySni)) throw new Error(label + 'неверный сайт для маскировки');
        return { params: { host, port, username, password: x.password || undefined, privateKey: x.privateKey || undefined, name, domain: x.domain || undefined, email: x.email || undefined, ports, realitySni: realitySni || undefined, remember: !!x.remember, useWarp: !!x.useWarp },
          rec: { host, name: name || host, status: 'wait', logs: [], error: '', added: 0, link: '' } };
      });
      const hostsAfter = new Set([...store.hosts(), ...tasks.map((t) => t.params.host)]);
      if (hostsAfter.size > 20) throw new Error('Всего серверов в списке не больше 20. Удали ненужные');
      job = { running: true, servers: tasks.map((t) => t.rec), link: '' };
      const mine = job, okItems = [];
      // WARP: если IP сервера закрыт с этого компьютера, на время установки включаем WARP и заходим по SSH через него
      let warpPrev;   // undefined — WARP не включали; null — до этого ничего не было подключено; id — прежний профиль
      const warpReady = async (rec) => {
        if (warpPrev !== undefined) return;
        const w = store.data.servers.find((x) => x.proto === 'warp');
        if (!w) throw new Error('WARP не настроен: открой «Инструменты» → Cloudflare WARP, скачай ядро и зарегистрируй WARP');
        const prev = kore.state.running ? kore.state.itemId : null;
        rec.logs.push('Включаю WARP, чтобы дойти до сервера');
        await startCore(w.id); warpPrev = prev;
        if (!(await works())) throw new Error('WARP включился, но интернет через него не открывается');
      };
      const runOne = async ({ params, rec }) => {
        rec.status = 'run';
        try {
          let hostKey = '';
          if (params.useWarp) { await warpReady(rec); params.sock = await (deps.warpSock || viaProxySock)(params.host, params.port); rec.logs.push('Захожу на сервер по SSH через WARP'); }
          const r = await (deps.deployServer || M.deployServer)(params, { onLog: (l) => rec.logs.push(l), onHostKey: (h) => { hostKey = h; rec.logs.push('Отпечаток ключа сервера (SHA-256): ' + h); } });
          const imp = M.importText(r.link);
          // Переустановка: профили этого сервера заменяются новыми целиком, старые (другие порты и ключи) уже не работают и только мешали бы в списке
          const oldItems = store.data.servers.filter((x) => x.host === params.host), newIds = new Set(imp.items.map((x) => Store.idOf(x)));
          if (kore.state.running && oldItems.some((x) => x.id === kore.state.itemId && !newIds.has(x.id))) { await stopAll(); rec.logs.push('Подключение к старому профилю этого сервера остановлено'); }
          store.replaceHost(params.host, imp.items, imp.name);
          rec.added = imp.items.filter((x) => !oldItems.some((o) => o.id === Store.idOf(x))).length;
          const gone = oldItems.filter((x) => !newIds.has(x.id)); for (const x of gone) pings.delete(x.id);
          if (gone.length) rec.logs.push(`Старых профилей этого сервера убрано из списка: ${gone.length}`);
          store.data.own = [...new Set([...(store.data.own || []), params.host])]; store.save();   // «Мои серверы»: поставлены самим Квазаром
          if (params.remember && params.password) {
            try {
              store.data.access[params.host] = { port: params.port, username: params.username, secret: await secret.protect(params.password), fingerprint: hostKey || undefined, at: Date.now() };
              store.save(); rec.logs.push('Доступ для «Тревоги» сохранён в зашифрованном виде');
            } catch (e) { rec.logs.push('Доступ сохранить не вышло: ' + e.message); }
          }
          rec.link = r.link; rec.status = 'ok'; okItems.push(...imp.items);
          rec.logs.push('Готово: протоколов в списке — ' + imp.items.length);
        } catch (e) { rec.status = 'error'; rec.error = e.message; }
        finally {
          params.password = undefined; params.privateKey = undefined; params.sock = undefined;
          // Журнал установки сохраняем в файл: в окне он пропадает вместе со строкой сервера, а по нему видно, почему протокол не встал
          try {
            const head = `===== ${new Date().toLocaleString('ru-RU')}  ${params.host}  ${rec.status === 'ok' ? 'готово' : 'ошибка: ' + rec.error}`;
            const f = path.join(dataDir, 'install-' + params.host.replace(/[^A-Za-z0-9.-]/g, '_') + '.log');
            fs.appendFileSync(f, [head, ...rec.logs, ''].join('\n'), 'utf8');
            rec.logs.push('Журнал установки сохранён: ' + f);
          } catch { /* журнал не записался — установке это не мешает */ }
        }
      };
      (async () => {
        // Маскировка VLESS: сначала проверяем с этого компьютера, какие сайты провайдер пропускает напрямую
        const own = tasks.map((t) => t.params.realitySni).filter(Boolean);
        let pr = { ok: [], blocked: [] };
        try { pr = await REAL.probeFromClient([...own, ...REAL.REALITY_CANDIDATES], { probe: deps.realityProbe || ((o) => NET.siteLatencyDirect(o)) }); } catch { /* сеть недоступна — решит сервер */ }
        for (const t of tasks) {
          const mineOk = t.params.realitySni && pr.ok.includes(t.params.realitySni);
          if (t.params.realitySni && !mineOk) t.rec.logs.push(`Сайт ${t.params.realitySni} не открывается напрямую у тебя, подберу другой`);
          t.params.realityCandidates = pr.ok.length ? pr.ok : REAL.REALITY_CANDIDATES;
          t.params.realityTimings = Object.fromEntries((pr.timings || []).filter((r) => r.ms !== null).map((r) => [r.host, r.ms]));
          if (pr.ok.length) t.rec.logs.push('Быстрее всего от тебя: ' + (pr.timings || []).filter((r) => r.ms !== null).sort((a, b) => a.ms - b.ms).slice(0, 3).map((r) => `${r.host} ${Math.round(r.ms)} мс`).join(', ') + '; выберу с лучшим общим пингом');
          if (!mineOk) t.params.realitySni = undefined; else t.params.realityForce = true;
          t.rec.logs.push(pr.ok.length ? `Маскировка: у тебя напрямую открываются ${pr.ok.length} сайтов из ${pr.ok.length + pr.blocked.length}` + (pr.blocked.length ? ` (не открылись: ${pr.blocked.join(', ')})` : '') : 'Маскировка: не удалось проверить сайты с компьютера, проверит сервер');
        }
        const queue = tasks.slice();
        await Promise.all(Array.from({ length: Math.min(POOL, queue.length) }, async () => { while (queue.length) await runOne(queue.shift()); }));
        if (warpPrev !== undefined) { try { if (warpPrev) await startCore(warpPrev); else await stopAll(); } catch { /* вернуть прежнее подключение не вышло — не страшно */ } }
        if (okItems.length) mine.link = M.packBundle({ name: 'Мои серверы', host: '', items: okItems });
        mine.running = false;
        // сразу замеряем пинг всех поставленных протоколов, чтобы рядом с каждым уже были цифры
        for (const it of okItems) { const sv = store.server(Store.idOf(it)); const port = sv && pingPort(sv); if (port) NET.pingMedian(sv.host, port, 3, 2500).then((ms) => pings.set(sv.id, { ms, at: Date.now(), via: port !== sv.port ? 'tcp:' + port : null }), () => {}); }
      })();
      return stateView();
    },
    'POST /api/export': async ({ host }) => {
      const items = store.data.servers.filter((x) => !host || x.host === host);
      if (!items.length) throw new Error('Нет серверов для ссылки');
      const link = M.packBundle({ name: host ? (items[0].group || host) : 'Мои серверы', host: host || '', items });
      return { link, count: items.length, hosts: new Set(items.map((x) => x.host)).size };
    },
    // Снять с сервера то, что поставил Квазар (службы quasar-*, папки /opt/quasar*, /etc/quasar, /var/lib/quasar). Чужие панели и программы не трогаем.
    'POST /api/uninstall': async ({ host, password, useWarp }) => {
      host = String(host || '');
      if (maint.running || job.running) throw new Error('Сейчас идёт установка или другая операция: дождись конца');
      if (!(store.data.own || []).includes(host)) throw new Error('Этот сервер ставил не Квазар: снимать с него нечего. Профили можно просто удалить из списка');
      const items = store.data.servers.filter((x) => x.host === host);
      startMaint('uninstall', host, async (log) => {
        let session;
        try {
          const acc = store.data.access[host];
          if (deps.sshSession) session = await deps.sshSession(host);
          else {
            if (!acc && !password) throw new Error('Нужен пароль от сервера (доступ не сохранён)');
            const port = acc ? acc.port : 22;
            let sock = null;
            if (useWarp) { const w = store.data.servers.find((x) => x.proto === 'warp'); if (!w) throw new Error('WARP не настроен: «Инструменты» → Cloudflare WARP'); log('Включаю WARP'); await startCore(w.id); sock = await viaProxySock(host, port); }
            else if ((await (deps.tcpPing || NET.tcpPing)(host, port, 3000)) === null) throw new Error('До сервера по SSH не достучаться напрямую: включи «Через WARP» и повтори');
            const pw = password || await secret.unprotect(acc.secret);
            const t = M.sshTransport({ host, port, username: (acc && acc.username) || 'root', password: pw, expectedFingerprint: acc && acc.fingerprint, sock: sock || undefined });
            session = { async run(script) { const lines = []; await t.run(script, (l) => lines.push(l)); return lines; }, close() { t.close(); } };
          }
          log('Снимаю с сервера протоколы Квазара');
          const ports = [...new Set(items.map((x) => `${x.port}/${['hysteria2', 'tuic', 'shadowquic', 'juicity'].includes(x.proto) ? 'udp' : 'tcp'}`))];
          const out = await session.run(UNINST.uninstallScript(ports));
          let ok = false, err = '';
          for (const l of out) { const m = /^QUASAR_(LOG|ERROR|DONE)=(.*)$/.exec(l); if (!m) continue; if (m[1] === 'LOG') log('  ' + m[2]); else if (m[1] === 'ERROR') err = m[2]; else ok = true; }
          if (err || !ok) throw new Error(err || 'Сервер не подтвердил удаление');
          if (kore.state.running && items.some((x) => x.id === kore.state.itemId)) await stopAll();
          for (const x of items) pings.delete(x.id);
          store.removeHost(host); delete store.data.access[host]; store.data.own = (store.data.own || []).filter((h) => h !== host); store.save();
          log('Готово: на сервере остались только твои программы, а профили этого сервера убраны из списка');
          return { ok: true };
        } finally { if (session && session.close) session.close(); }
      });
      return stateView();
    },
    'POST /api/servers/delete-host': async ({ host }) => {
      const cur = store.server(kore.state.itemId);
      if (cur && cur.host === host) await stopAll();
      for (const x of store.data.servers.filter((y) => y.host === host)) pings.delete(x.id);
      store.removeHost(String(host || ''));
      return stateView();
    },
    'POST /api/best': async () => {
      const hosts = store.hosts();
      if (!hosts.length) throw new Error('Нет серверов');
      const res = await Promise.all(hosts.map(async (h) => {
        const its = store.data.servers.filter((x) => x.host === h);
        const tcp = its.find((x) => TCP_PROTOS.has(x.proto));
        const ms = tcp ? await NET.pingMedian(h, tcp.port, 3, 2500) : null;
        for (const x of its) pings.set(x.id, { ms, at: Date.now(), via: tcp && tcp.id !== x.id ? 'tcp:' + tcp.port : null });
        return { host: h, ms };
      }));
      const alive = res.filter((r) => r.ms !== null).sort((a, b) => a.ms - b.ms);
      if (!alive.length) throw new Error('Ни один сервер не отвечает');
      const its = store.data.servers.filter((x) => x.host === alive[0].host);
      const pick = PREF.map((p) => its.find((x) => x.proto === p)).find(Boolean);
      await startCore(pick.id);
      return { ...stateView(), chosen: { host: alive[0].host, id: pick.id, ms: alive[0].ms } };
    },
  };

  // Проверка после подключения: ядро запущено ещё не значит, что через сервер что-то открывается (UDP-протоколы часто режет провайдер)
  let connCheck = null, fbTried = [], fbNotes = [];
  const fbOn = () => !!autoFallback && store.data.settings.autoFallback !== false;
  const FB_ORDER = ['vless', 'trojan', 'anytls', 'hysteria2', 'shadowsocks', 'shadowtls', 'tuic', 'http', 'naive', 'sudoku', 'shadowquic', 'photon', 'antohin', 'mieru', 'brook', 'juicity', 'restls', 'snell', 'tlsmirror', 'socks', 'warp'];
  const UDP_PROTOS = new Set(['hysteria2', 'tuic', 'shadowquic', 'juicity', 'warp']);
  async function verifyConn(id) {
    const mine = connCheck = { id, status: 'run', ms: null, error: '', hint: '', logs: [], notes: fbNotes.slice() };
    if (!fbTried.includes(id)) fbTried.push(id);
    const item = store.server(id);
    try {
      let last = null;
      // в режиме TUN ядро поднимается дольше (Windows создаёт адаптер), поэтому попыток больше
      const tries = store.data.settings.tun ? 5 : 2;
      for (let i = 0; i < tries && connCheck === mine && kore.state.running && kore.state.itemId === id; i++) {
        await new Promise((r) => setTimeout(r, i ? 1500 : 700));
        // ядро перезапускается из-за занятого TUN-адаптера: это не поломка протокола, ждём (до 20 с)
        for (let w = 0; w < 40 && kore.respawning && connCheck === mine; w++) await new Promise((r) => setTimeout(r, 500));
        if (connCheck !== mine || !kore.state.running) break;
        try { mine.ms = await measureVia(kore.state.mixedPort, { tries: 1, timeout: 6000 }); mine.status = 'ok'; return; } catch (e) { last = e; }
      }
      if (connCheck !== mine) return;
      mine.status = 'fail'; mine.error = last ? last.message : 'ядро остановилось';
      mine.logs = kore.logs.slice(-6);
      mine.hint = item && UDP_PROTOS.has(item.proto)
        ? 'Этот протокол идёт по UDP: провайдер или файрвол сервера мог его закрыть. Проверь, что на сервере открыт UDP-порт ' + item.port + ', или выбери протокол по TCP (VLESS Reality, Trojan, AnyTLS).'
        : 'Проверь адрес, порт и ключи профиля; если всё верно, попробуй другой протокол этого сервера.';
      if (item && TCP_PROTOS.has(item.proto) && item.proto !== 'warp') {
        const ms = await (deps.tcpPing || NET.tcpPing)(item.host, item.port, 2500).catch(() => null);
        if (ms === null) mine.hint = `Порт ${item.port}/tcp этого сервера снаружи не отвечает. Если другие порты сервера открыты, этот режет файрвол хостера или провайдер: открой порт в панели хостинга либо переустанови сервер с режимом портов «Ходовые» (вкладка «Мои серверы» → «Проверить порты» покажет все порты сразу).`;
      }
      // автопереключение: пробуем другие протоколы того же сервера, пока один не заработает (UDP-протоколы провайдеры режут чаще TCP)
      if (fbOn() && item && fbTried.length < 5) {
        // протоколы, не прошедшие последнюю проверку (URL-тест или скачивание), пропускаем: их провайдер режет
        const failed = (x) => { const p = pings.get(x.id); return !!(p && p.ms === null && (p.mode === 'url' || p.mode === 'deep')); };
        const rest = store.data.servers.filter((x) => x.host === item.host && !fbTried.includes(x.id) && !failed(x)).sort((a, b) => FB_ORDER.indexOf(a.proto) - FB_ORDER.indexOf(b.proto));
        const next = rest[0];
        if (next) {
          fbNotes.push(`${item.name}: не ответил (${mine.error}) — пробую ${next.name}`);
          mine.notes = fbNotes.slice();
          try { await startCore(next.id); } catch (e) { fbNotes.push(`${next.name}: не запустился (${e.message})`); }
          return;
        }
        if (fbTried.length > 1) mine.notes = [...fbNotes, 'Перебрал все протоколы этого сервера, ни один не открывает сайты: похоже, сервер недоступен или закрыт целиком'];
      }
    } catch (e) { if (connCheck === mine) { mine.status = 'fail'; mine.error = e.message; } }
  }
  const URL_HOST = 'www.gstatic.com';
  async function freePort() { return new Promise((res, rej) => { const sv = require('net').createServer(); sv.once('error', rej); sv.listen(0, '127.0.0.1', () => { const p = sv.address().port; sv.close(() => res(p)); }); }); }
  // Сайт для «Пинга до сайта»: host или host:port (схему и путь отбрасываем). Только имя/адрес — без пробелов и служебных символов.
  function parseSite(raw) {
    let t = String(raw || '').trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[\/?#].*$/, '');
    const m = /^([a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?)(?::(\d{1,5}))?$/.exec(t);
    if (!m) return null;
    const port = m[3] ? Number(m[3]) : 443;
    if (port < 1 || port > 65535) return null;
    return { host: m[1], port };
  }
  async function measureVia(port, { tries = 2, timeout = 8000, site = null } = {}) {   // первый замер прогревает соединение, берём лучший из двух
    let best = null, lastErr = null;
    const host = site ? site.host : URL_HOST, sport = site ? site.port : 443;
    for (let i = 0; i < tries; i++) { try { const ms = await NET.siteLatency({ proxyPort: port, host, port: sport, timeout, tlsHandshake: sport === 443 }); best = best === null ? ms : Math.min(best, ms); } catch (e) { lastErr = e; } }
    if (best === null) throw new Error('через сервер не ответил' + (lastErr ? ': ' + lastErr.message : ''));
    return best;
  }
  // deep: кроме рукопожатия скачиваем 256 КБ — так видно, не «замораживает» ли провайдер поток после первых килобайт
  // «Пинг до игры»: задержка до адреса, к которому игра подключена сейчас, сквозь протокол.
  // 1) пробуем сам адрес игры (TCP открылся или отказал — это ответ). 2) Игры на UDP на TCP молчат: тогда меряем путь
  // до самого сервера сквозь протокол — именно он у протоколов разный, а участок «сервер → игра» у всех одинаковый.
  async function gameVia(port, item, g) {
    const probe = deps.probeVia || NET.probeVia;
    const tries = [...new Set([g.net === 'tcp' ? g.port : 0, 443, 80].filter(Boolean))];
    for (const tp of tries) {
      const a = await probe(port, g.ip || g.host, tp, { timeout: 2500 }), b = a && await probe(port, g.ip || g.host, tp, { timeout: 2500 });
      if (a) return { ms: Math.min(a.ms, b ? b.ms : a.ms), how: 'game' };
    }
    for (const tp of [443, 22, 80]) {
      const a = await probe(port, item.host, tp, { timeout: 3000 }), b = a && await probe(port, item.host, tp, { timeout: 3000 });
      if (a) return { ms: Math.min(a.ms, b ? b.ms : a.ms), how: 'tunnel' };
    }
    throw new Error('через этот протокол ничего не ответило');
  }
  async function viaCheck(port, deep, site, game, item) {
    if (game) return gameVia(port, item, game);
    const ms = await measureVia(port, { site });
    if (!deep) return ms;
    const d = await (deps.downloadVia || NET.downloadVia)({ proxyPort: port });
    return { ms, kbps: d.kbps };
  }
  async function urlTest(item, { deep = false, site = null, game = null } = {}) {
    if (deps.urlTest) return deps.urlTest(item, { deep, site, game });
    if (kore.state.running && kore.state.itemId === item.id) return viaCheck(kore.state.mixedPort, deep, site, game, item);
    // Протоколы внешних ядер (Фотон, Mieru, Brook, Juicity, Naive, Snell…): запускаем своё временное ядро на свободном порту,
    // рядом — временный sing-box без TUN. Текущее подключение не трогается.
    const ad = COREREG.adapterFor(item);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quasar-urltest-'));
    const tmp = new Core({ dataDir: dir, appDir });
    const extLog = [];
    const tmpExt = ad ? new COREREG.ExtCore({ dataDir: dir, appDir, log: (l) => { extLog.push(l); if (extLog.length > 20) extLog.shift(); } }) : null;
    try {
      const external = tmpExt ? await tmpExt.start(item, (deps.adapter || ((a) => a))(ad)) : null;
      const mixedPort = await freePort(), apiPort = await freePort(), secret = crypto.randomBytes(8).toString('hex');
      await tmp.start(item.id, buildClientConfig(item, { mixedPort, apiPort, secret, adblock: false, tun: false, external }), { mixedPort, apiPort, secret });
      return await viaCheck(mixedPort, deep, site, game, item);
    } catch (e) {
      // последние строки журнала внешнего ядра — по ним видно, почему протокол не работает
      const tail = extLog.filter((l) => /error|fail|warn|fatal|refused|timeout|EOF|denied|invalid|mismatch|not match|ошиб/i.test(l)).slice(-3).map((l) => l.slice(0, 220));
      throw new Error(e.message + (tail.length ? ' | журнал ядра: ' + tail.join(' | ') : ''));
    } finally {
      await tmp.stop().catch(() => {});
      if (tmpExt) await tmpExt.stop().catch(() => {});
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* временная папка */ }
    }
  }
  async function startCore(id) {
    const item = store.server(id);
    if (!item) throw new Error('Сервер не найден');
    const set = store.data.settings;
    if (set.tun && !(await sysp.isAdmin())) throw new Error('Режим TUN требует прав администратора: закрой Квазар и нажми «Перезапустить от администратора» вверху окна');
    const ad = COREREG.adapterFor(item);
    const common = { mixedPort: set.mixedPort, apiPort: set.apiPort, lan: set.lan, lanPort: set.lanPort, lanAuth: set.lanAuth !== false, lanDevice: set.lanDevice || '', lanPass: set.lanPass, adblock: set.adblock, tun: ANDROID ? false : set.tun, bigAds: set.bigAds, rules: set.rules || [], share: !!(set.share && set.share.on) };
    let reused = false;
    if (set.tun) {
      // Постоянный туннель. Раньше при каждой смене протокола sing-box с TUN перезапускался, Windows не успевал убрать
      // прежний адаптер, и сеть пропадала на 15–40 секунд. Теперь TUN-ядро остаётся, а меняется только ядро протокола
      // за ним — на одном и том же локальном порту (для протоколов sing-box это второй sing-box без TUN).
      await ext.stop(); await inner.stop();
      const startInner = async () => {
        if (!innerPort) innerPort = await freePort();
        if (ad) await ext.start(item, (deps.adapter || ((a) => a))(ad), { port: innerPort });
        else { const ip = await freePort(); await inner.start(id, buildClientConfig(item, { mixedPort: innerPort, apiPort: ip, secret: '', adblock: false, tun: false }), { mixedPort: innerPort, apiPort: ip, secret: '' }); }
      };
      try { await startInner(); }
      catch (e) { if (!/EADDRINUSE|address already in use|Only one usage|bind:/i.test(e.message)) throw e; innerPort = await freePort(); await startInner(); }   // порт занял кто-то чужой — берём другой   // порт занял кто-то чужой — берём другой
      const ownIps = [...new Set(store.data.servers.map((x) => String(x.host || '')).filter((h) => /^[\d.]+$/.test(h) || h.includes(':')))].sort();
      const mk = (tunName) => buildClientConfig(item, { ...common, secret: tunSecret, external: { port: innerPort }, directProcs: INNER_PROCS, directIps: ownIps, tunName });
      const same = mk(tunName);
      if (kore.state.running && kore.configJson === JSON.stringify(same)) { kore.setItem(id); reused = true; kore.log('Переключил протокол без перезапуска туннеля: ' + item.name); }
      else {
        // туннель всё-таки перезапускается (поменялись настройки): берём другое имя адаптера — прежний Windows ещё убирает
        // (и после «Отключить» тоже: адаптер снятого ядра Windows убирает ещё 15–30 секунд)
        tunName = SHARE.TUN_NAMES.find((n) => n !== tunName);
        try { await kore.start(id, mk(tunName), { mixedPort: set.mixedPort, apiPort: set.apiPort, secret: tunSecret }); }
        catch (e) { await ext.stop(); await inner.stop(); throw e; }
      }
    } else {
      await inner.stop();
      const secret = crypto.randomBytes(16).toString('hex');
      let external = null;
      if (ad) external = await ext.start(item, (deps.adapter || ((a) => a))(ad));
      else await ext.stop();
      const cfg = buildClientConfig(item, { ...common, secret, external });
      try { await kore.start(id, cfg, { mixedPort: set.mixedPort, apiPort: set.apiPort, secret }); }
      catch (e) { await ext.stop(); throw e; }
    }
    if (!reused && set.tun && set.share && set.share.on) await shareOp(applyShare).catch((e) => { shareInfo.error = e.message; });
    if (set.sysproxy) {
      try { await sysp.enable(set.mixedPort); }
      catch (e) { await kore.stop(); throw new Error('Не удалось включить системный прокси: ' + e.message); }
    } else if (sysp.active) await sysp.restore().catch(() => {});
    ipCache = { at: 0, v: null };
    verifyConn(id).catch(() => {});
  }
  const proxyAuth = () => undefined;   // вход 127.0.0.1 без пароля; пароль только у входа для приставки
  function viaProxySock(host, port) { return NET.connectViaProxy(kore.state.mixedPort, host, port, { timeout: 10000, auth: proxyAuth() }); }
  async function works() {
    if (deps.works) return deps.works();
    if (!kore.state.running) return false;
    try { await NET.siteLatency({ proxyPort: kore.state.mixedPort, host: 'www.google.com', timeout: 7000, auth: proxyAuth() }); return true; } catch { return false; }
  }
  // Переустановка сервера с сохранённым доступом: новые ключи, при необходимости новые порты и маскировка
  async function redeploy(host, ov, route, log) {
    const acc = store.data.access[host];
    if (!acc) throw new Error('Доступ к серверу не сохранён');
    const items = store.data.servers.filter((x) => x.host === host);
    const group = (items[0] && items[0].group) || host;
    const params = { host, port: acc.port, username: acc.username, password: await secret.unprotect(acc.secret), name: group,
      ports: ov.ports || portsFor(ov.portMode || 'default'), realitySni: ov.realitySni, realityForce: ov.realityForce,
      realityCandidates: ov.realityCandidates, shadowtlsSni: ov.shadowtlsSni, shadowquicSni: ov.shadowquicSni, expectedFingerprint: acc.fingerprint };
    try {
      if (route && route.sock) params.sock = await route.sock();
      const r = await (deps.deployServer || M.deployServer)(params, { onLog: (l) => log('  ' + l) });
      const imp = M.importText(r.link);
      store.replaceHost(host, imp.items, group);
      for (const x of items) pings.delete(x.id);
      return store.data.servers.filter((x) => x.host === host);
    } finally { params.password = undefined; }
  }
  // Сессия SSH с сохранённым доступом: один вход на весь перебор. Идём напрямую; если SSH закрыт — через текущее подключение (если оно не к этому же профилю)
  async function openSession(host, skipProxyFor) {
    if (deps.sshSession) return deps.sshSession(host);
    const acc = store.data.access[host]; if (!acc) throw new Error('Доступ к серверу не сохранён');
    let sock = null;
    if ((await (deps.tcpPing || NET.tcpPing)(host, acc.port, 3000)) === null) {
      if (!kore.state.running || (skipProxyFor && kore.state.itemId === skipProxyFor)) throw new Error('До сервера по SSH не достучаться напрямую. Подключись к другому профилю или к WARP и повтори');
      sock = await viaProxySock(host, acc.port);
    }
    let password = await secret.unprotect(acc.secret);
    const t = M.sshTransport({ host, port: acc.port, username: acc.username, password, expectedFingerprint: acc.fingerprint, sock: sock || undefined });
    password = undefined;
    return { async run(script) { const lines = []; await t.run(script, (l) => lines.push(l)); return lines; }, close() { t.close(); } };
  }
  const runTune = async (session, script) => { const r = TUNE.parseOutput(await session.run(script)); if (!r.ok) throw new Error(r.error || 'сервер не подтвердил изменение'); return r; };
  // Рабочий ли протокол с такими параметрами: порт отвечает (для TCP) и через него реально открывается сайт (временное ядро)
  async function probeItem(item) {
    if (TCP_PROTOS.has(item.proto) && (await (deps.tcpPing || NET.tcpPing)(item.host, item.port, 2500)) === null) return false;
    try { await urlTest({ ...item, id: item.id + ':probe' }); return true; } catch { return false; }
  }
  // Смена порта: перебор candidates (один порт — ручная смена). Рабочий порт остаётся; если ничего не вышло или нажали «Стоп» — возвращаем прежний.
  async function tunePorts(it0, cands, log, auto) {
    const it = { ...it0 };   // копия: настоящий профиль меняется только в самом конце
    const wasOn = kore.state.running && kore.state.itemId === it.id;
    const session = await openSession(it.host, it.id);
    let cur = it.port, found = null;
    try {
      for (const p of cands) {
        if (maintStop) { log('Остановлено'); break; }
        log(`Пробую порт ${p}${auto ? '' : ''}`);
        try { await runTune(session, TUNE.portScript(it.proto, cur, p)); cur = p; } catch (e) { log('  сервер не смог: ' + e.message); continue; }
        if (await probeItem({ ...it, port: p })) { found = p; log(`  порт ${p} работает`); break; }
        log('  снаружи не открывается');
      }
      if (found === null && cur !== it.port) {
        log(`Возвращаю прежний порт ${it.port}`);
        try { await runTune(session, TUNE.portScript(it.proto, cur, it.port)); } catch (e) { log('  не получилось вернуть порт: ' + e.message + '. Проверь сервер вручную'); }
      }
    } finally { session.close(); }
    if (found === null) { log(auto ? 'Рабочий порт не найден, всё осталось как было' : 'Порт не открывается снаружи, оставил прежний'); return { ok: false }; }
    if (wasOn) await stopAll();
    const upd = store.changePort(it.id, found);
    pings.delete(it.id);
    log(`Готово: порт ${it.port} → ${found}`);
    if (wasOn) { await startCore(upd.id); log('Переподключился'); }
    return { ok: true };
  }
  // Автоподбор маскировки VLESS Reality: сначала сайты, которые открываются у тебя напрямую, потом по очереди на сервере
  async function tuneMasks(it0, log) {
    const it = { ...it0 };
    const hostItems = store.data.servers.filter((x) => x.host === it.host && x.proto === 'vless');
    const own = store.data.maskSites.slice();
    let cands = [...new Set([...own, ...REAL.REALITY_CANDIDATES])].filter((x) => x !== it.sni);
    try { const pr = await REAL.probeFromClient(cands, { probe: deps.realityProbe || ((o) => NET.siteLatencyDirect(o)) }); if (pr.ok.length) { log(`У тебя напрямую открываются ${pr.ok.length} из ${cands.length} сайтов, пробую их`); cands = pr.ok; } } catch { /* сеть недоступна — пробуем все */ }
    const wasOn = kore.state.running && hostItems.some((x) => x.id === kore.state.itemId);
    const session = await openSession(it.host, wasOn ? kore.state.itemId : null);
    let cur = it.sni, found = null;
    try {
      for (const c of cands) {
        if (maintStop) { log('Остановлено'); break; }
        log(`Пробую маскировку ${c}`);
        try { await runTune(session, TUNE.maskScript(cur, c)); cur = c; } catch (e) { log('  сервер не смог: ' + e.message); continue; }
        if (await probeItem({ ...it, sni: c })) { found = c; log(`  ${c} работает`); break; }
        log('  не пробивается');
      }
      if (found === null && cur !== it.sni) {
        log(`Возвращаю прежнюю маскировку ${it.sni}`);
        try { await runTune(session, TUNE.maskScript(cur, it.sni)); } catch (e) { log('  не получилось вернуть: ' + e.message + '. Проверь сервер вручную'); }
      }
    } finally { session.close(); }
    if (found === null) { log('Рабочая маскировка не найдена, всё осталось как было'); return { ok: false }; }
    for (const x of hostItems) store.updateServer(x.id, { sni: found });
    log(`Готово: маскировка ${it.sni} → ${found}`);
    if (wasOn) { await startCore(kore.state.itemId); log('Переподключился'); }
    return { ok: true };
  }
  let maintStop = false;
  function startMaint(kind, host, fn) {
    maint = { running: true, kind, host, logs: [], ok: null, error: '' }; maintStop = false;
    const m = maint, log = (l) => { m.logs.push(`${new Date().toLocaleTimeString('ru-RU')}  ${l}`); if (m.logs.length > 400) m.logs.splice(0, 100); };
    (async () => {
      try { const r = await fn(log); m.ok = !!(r && r.ok); if (r && r.item) log('Подключено: ' + (r.item.name || r.item.proto)); }
      catch (e) { m.ok = false; m.error = e.message; log('Ошибка: ' + e.message); }
      finally { m.running = false; ipCache = { at: 0, v: null }; }
    })();
  }
  function alarmCtx(log) {
    return {
      log, servers: () => store.data.servers.slice(), group: (h) => { const x = store.data.servers.find((y) => y.host === h); return (x && x.group) || h; },
      access: (h) => store.data.access[h] || null, connect: (id) => startCore(id), disconnect: () => stopAll(), works,
      tcpPing: (h, p, ms) => (deps.tcpPing || NET.tcpPing)(h, p, ms), viaProxySock,
      redeploy: (h, ov, route) => redeploy(h, ov, route, log), maskSites: () => store.data.maskSites.slice(),
    };
  }
  async function applyShare() {
    const sh = store.data.settings.share;
    const log = (l) => { shareInfo.log.push(`${new Date().toLocaleTimeString('ru-RU')}  ${l}`); if (shareInfo.log.length > 50) shareInfo.log.shift(); };
    let target = sh.adapter;
    if (sh.via === 'cable') {
      const list = await share.adapters();
      let a = list.find((x) => x.name === sh.adapter) || (sh.adapterDesc && list.find((x) => x.desc === sh.adapterDesc));
      if (!a) { shareInfo.waiting = true; log(`Жду сетевую карту «${sh.adapter}»: подключи её — раздача включится сама`); return; }
      if (a.internet) throw new Error(`«${a.name}» — адаптер, через который сам ПК выходит в интернет. Раздавать на него нельзя: выбери карту, к которой подключена приставка`);
      if (a.name !== sh.adapter) { log(`Карта теперь называется «${a.name}»`); sh.adapter = a.name; store.save(); }
      target = a.name;
    }
    shareInfo.waiting = false;
    if (sh.via === 'wifi') {
      log('Включаю точку доступа Windows');
      const r = await share.startWifi();
      shareInfo.ssid = r.ssid; shareInfo.pass = r.pass; target = r.adapter;
      log(`Точка доступа: ${r.ssid}`);
    }
    log(`Включаю общий доступ: ${tunName} → ${target}`);
    await share.icsOn(target, tunName);
    shareInfo.up = true; shareInfo.error = '';
    log('Раздача идёт через VPN');
  }
  async function restartIfRunning() { if (kore.state.running) await startCore(kore.state.itemId); }
  async function stopAll() { connCheck = null; fbTried = []; fbNotes = []; await kore.stop(); await ext.stop(); await inner.stop(); await shareDown(); await sysp.restore().catch(() => {}); ipCache = { at: 0, v: null }; }

  // ---------- HTTP ----------
  let port = 0, byeTimer = null, lastSeen = 0;
  // Окно могло исчезнуть без прощания (Edge упал, сняли задачу) — через несколько минут тишины тоже выключаемся.
  // Свёрнутое окно опрашивает редко (Chromium тормозит таймеры до раза в минуту), поэтому порог с запасом.
  const idleTimer = setInterval(() => { if (onQuit && lastSeen && Date.now() - lastSeen > idleQuitMs && !(store && store.data.settings.trayKeep)) onQuit(); }, Math.min(30000, idleQuitMs)); idleTimer.unref();
  const hostOk = (h) => h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  const server = http.createServer(async (req, res) => {
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'" });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    try {
      if (!hostOk(req.headers.host || '')) return send(403, { error: 'Чужой адрес' });
      const origin = req.headers.origin;
      if (origin && !hostOk(origin.replace(/^https?:\/\//, ''))) return send(403, { error: 'Чужой источник запроса' });
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/api/bye' && req.method === 'POST') {
        // окно закрыли крестиком: если за несколько секунд оно не вернулось (обновление страницы) — выключаемся полностью
        let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1024) break; }
        let t = ''; try { t = String(JSON.parse(raw).t || ''); } catch { /* пусто */ }
        const a = Buffer.from(t), b = Buffer.from(tok);
        if (a.length === b.length && crypto.timingSafeEqual(a, b) && onQuit && !(store && store.data.settings.trayKeep)) { clearTimeout(byeTimer); byeTimer = setTimeout(onQuit, quitGraceMs); }
        return send(204, '');
      }
      if (url.pathname.startsWith('/api/')) {
        lastSeen = Date.now(); clearTimeout(byeTimer);
        const given = Buffer.from(String(req.headers['x-quasar-token'] || ''));
        const want = Buffer.from(tok);
        if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return send(401, { error: 'Нужен токен приложения' });
        const h = routes[`${req.method} ${url.pathname}`];
        if (!h) return send(404, { error: 'Нет такого метода' });
        let body = {};
        if (req.method === 'POST') {
          const chunks = []; let n = 0;
          for await (const c of req) { n += c.length; if (n > 64 * 1024) return send(413, { error: 'Слишком большой запрос' }); chunks.push(c); }
          if (n) { try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, { error: 'Запрос не разобрался' }); } }
        }
        try { return send(200, await h(body || {})); } catch (e) { return send(400, { error: e.message }); }
      }
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!/^(index\.html|app\.js|app\.css|icon\.png)$/.test(file)) return send(404, { error: 'Нет такой страницы' });
      return send(200, fs.readFileSync(path.join(UI_DIR, file)), TYPES[path.extname(file)]);
    } catch (e) { return send(500, { error: 'Внутренняя ошибка: ' + e.message }); }
  });

  // Первый запуск: ядро sing-box и ssh2 ставятся сами, в фоне; ход виден в приложении
  function firstRun() {
    if (ANDROID) return;   // ядра и ssh2 уже лежат внутри APK
    if (!require('./lib/core').findSingbox(appDir) && !coreJobs.singbox) {
      coreJobs.singbox = { status: 'run', msg: 'первый запуск: скачиваю ядро sing-box…' };
      console.log('Первый запуск: скачиваю ядро sing-box');
      (deps.installCore || installCore)('singbox', { appDir }).then((r) => { coreJobs.singbox = { status: 'ok', msg: r.version || 'готово' }; console.log('sing-box ' + (r.version || '') + ' установлен'); })
        .catch((e) => { coreJobs.singbox = { status: 'error', msg: e.message }; console.error('sing-box не скачался: ' + e.message); });
    }
    let has = true; try { require.resolve('ssh2', { paths: [appDir] }); } catch { has = false; }
    if (!has && !setupInfo.ssh2) {
      setupInfo.ssh2 = { status: 'run', msg: 'ставлю ssh2 для установки на свои серверы…' };
      console.log('Первый запуск: ставлю ssh2');
      const { spawn } = require('child_process');
      const p = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: appDir, windowsHide: true, shell: process.platform === 'win32' });
      p.stdout && p.stdout.on('data', (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => console.log('npm: ' + l)));
      p.stderr && p.stderr.on('data', (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => console.log('npm: ' + l)));
      p.on('error', (e) => { setupInfo.ssh2 = { status: 'error', msg: e.message }; });
      p.on('exit', (c) => { setupInfo.ssh2 = c === 0 ? { status: 'ok', msg: 'готово' } : { status: 'error', msg: 'npm завершился с кодом ' + c }; console.log('ssh2: ' + setupInfo.ssh2.msg); });
    }
  }

  return {
    store, core: kore, token: tok, deps, pollOnce, firstRun,
    listen: (p = 0) => new Promise((resolve) => server.listen(p, '127.0.0.1', () => { port = server.address().port; resolve(port); })),
    url: () => `http://127.0.0.1:${port}/?t=${tok}`,
    async close() { clearInterval(timer); clearInterval(shareWatch); clearInterval(idleTimer); clearTimeout(byeTimer); await stopAll(); store.save(); await new Promise((r) => server.close(r)); },
  };
}

if (require.main === module || process.env.QUASAR_ANDROID) {
  const dataDir = process.env.QUASAR_DATA || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'Quasar');
  fs.mkdirSync(dataDir, { recursive: true });
  // Чёрного окна нет: всё, что раньше писалось в консоль, идёт в окошко «Консоль» в настройках и в quasar.log
  const LOG = [], logFile = path.join(dataDir, 'quasar.log');
  try { if (fs.statSync(logFile).size > 2e6) fs.renameSync(logFile, logFile + '.old'); } catch { /* файла ещё нет */ }
  const push = (lvl) => (...a) => {
    const line = `${new Date().toLocaleString('ru-RU')}  ${lvl ? lvl + ' ' : ''}${a.map((x) => (x instanceof Error ? x.message : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
    LOG.push(line); if (LOG.length > 500) LOG.splice(0, 100);
    try { fs.appendFileSync(logFile, line + '\n'); } catch { /* диск занят — не страшно */ }
  };
  console.log = push(''); console.error = push('ОШИБКА'); console.warn = push('внимание');
  process.on('uncaughtException', (e) => console.error('Сбой: ' + (e && e.stack || e)));
  process.on('unhandledRejection', (e) => console.error('Сбой: ' + (e && e.stack || e)));

  const instFile = path.join(dataDir, 'instance.json');
  let quitting = false;
  const quit = async () => {
    if (quitting) return; quitting = true;
    console.log('Выключаюсь: отключаю VPN и раздачу');
    try { await app.close(); } catch (e) { console.error(e); }
    try { fs.rmSync(instFile, { force: true }); } catch { /* уже нет */ }
    process.exit(0);
  };
  // «Перезапустить от администратора»: выключаемся, а отдельный скрытый процесс через пару секунд запускает Квазар заново — Windows спросит права (UAC)
  const onElevate = process.platform === 'win32' ? () => {
    const exe = path.join(__dirname, 'Квазар.exe'), target = fs.existsSync(exe) ? exe : path.join(__dirname, 'start.bat');
    const q = (x) => x.replace(/'/g, "''");
    require('child_process').spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `Start-Sleep 3; Start-Process -FilePath '${q(target)}' -WorkingDirectory '${q(__dirname)}'`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    console.log('Перезапуск от администратора');
    quit();
  } : undefined;
  const app = createApp({ dataDir, onQuit: quit, onElevate, autoFallback: true, appLog: () => LOG, ...(ANDROID ? { idleQuitMs: 1e12, quitGraceMs: 2e9 } : {}) });
  app.listen(Number(process.env.QUASAR_PORT) || 0).then(() => {
    const u = app.url();
    fs.writeFileSync(instFile, JSON.stringify({ url: u, pid: process.pid }), { mode: 0o600 });   // по нему Квазар.exe находит уже запущенный Квазар
    console.log('Квазар запущен');
    app.firstRun();
    if (process.platform === 'win32') makeShortcut();
    if (!process.argv.includes('--no-open') && process.platform === 'win32') {
      require('child_process').spawn('cmd', ['/c', 'start', '', 'msedge', `--app=${u}`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
  });
  process.on('SIGINT', quit); process.on('SIGTERM', quit);

  // Ярлык «Квазар» со значком на рабочем столе — один раз
  function makeShortcut() {
    const exe = path.join(__dirname, 'Квазар.exe');
    if (!fs.existsSync(exe)) return;
    const ps = `$d=[Environment]::GetFolderPath('Desktop'); $l=Join-Path $d 'Квазар.lnk'; if (-not (Test-Path $l)) { $s=(New-Object -ComObject WScript.Shell).CreateShortcut($l); $s.TargetPath='${exe.replace(/'/g, "''")}'; $s.WorkingDirectory='${__dirname.replace(/'/g, "''")}'; $s.IconLocation='${exe.replace(/'/g, "''")},0'; $s.Description='Квазар'; $s.Save(); 'создан' }`;
    require('child_process').execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' + ps], { windowsHide: true }, (e, out) => {
      if (e) console.error('Ярлык на рабочем столе не создан: ' + e.message); else if (String(out).includes('создан')) console.log('На рабочем столе создан ярлык «Квазар»');
    });
  }
}

module.exports = { createApp };
