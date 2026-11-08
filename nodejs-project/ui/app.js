'use strict';
// Интерфейс «Квазар». Весь текст с сервера (названия серверов из чужих ссылок) вставляется только через textContent.
(function () {
  const SKINS = [['blue', 'Синий'], ['night', 'Ночь'], ['graphite', 'Графит'], ['emerald', 'Изумруд'], ['sunset', 'Закат'], ['sakura', 'Сакура'], ['lavender', 'Лаванда'], ['ocean', 'Океан'], ['gold', 'Золото'], ['light', 'Светлая']];
  const PROTO = { vless: 'VLESS Reality', hysteria2: 'Hysteria2', tuic: 'TUIC v5', anytls: 'AnyTLS', trojan: 'Trojan', shadowsocks: 'Shadowsocks 2022', shadowtls: 'ShadowTLS v3', http: 'HTTP-прокси', socks: 'SOCKS5', warp: 'WARP (MASQUE)', naive: 'NaiveProxy', shadowquic: 'ShadowQUIC', sudoku: 'Sudoku', dnstt: 'DNS-туннель', photon: 'Фотон', antohin: 'Antohin', mieru: 'Mieru', juicity: 'Juicity', brook: 'Brook', restls: 'Restls', snell: 'Snell', tlsmirror: 'TLSMirror' };

  const url = new URL(location.href);
  let token = url.searchParams.get('t');
  try { if (token) sessionStorage.setItem('qt', token); else token = sessionStorage.getItem('qt'); } catch { /* хранилище может быть недоступно */ }
  if (url.searchParams.has('t')) history.replaceState(null, '', location.pathname);

  const PREF = ['vless', 'hysteria2', 'tuic', 'anytls', 'trojan', 'shadowtls', 'shadowsocks', 'http', 'socks', 'naive', 'warp', 'shadowquic', 'sudoku', 'dnstt', 'photon', 'antohin', 'mieru', 'brook', 'juicity', 'restls', 'snell', 'tlsmirror'];
  const newRow = () => ({ name: '', host: '', port: '22', username: 'root', password: '', domain: '', portMode: 'default', basePort: '', realitySni: '', remember: true, warp: false, sent: false });
  const S = { portIn: {}, portRes: {}, depOpen: {}, logPos: { conn: { top: 0, bottom: false } }, sort: { key: '', dir: 1 }, games: null, pingMode: (() => { try { return localStorage.getItem('pm') === 'url' ? 'url' : 'tcp'; } catch { return 'tcp'; } })(), sel: '', manual: null, view: 'list', st: null, tab: 'servers', ip: null, traffic: [], siteRes: null, busy: {}, rows: [newRow()], mineOpen: {}, multi: new Set(), anchor: '', cols: (() => { try { return JSON.parse(localStorage.getItem('cols') || '{}'); } catch { return {}; } })(), un: null, pingUntil: 0, conn: [], connClear: 0, connPause: false, connFilter: '', connOnly: 'all', importText: '', siteInput: '', open: {}, confirm: '', exportLink: '', exportNote: '', filter: 'all', coreForm: null, mask: {}, maintHide: '', rule: { kind: 'suffix', value: '', action: 'direct' } };
  const plural = (n, f) => n + ' ' + f[n % 10 === 1 && n % 100 !== 11 ? 0 : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 1 : 2];

  async function api(method, path, body) {
    if (path === '/api/ping') {
      const total = ((body && body.ids && body.ids.length) || (S.st ? S.st.servers.length : 0)) * (body && (body.mode === 'url' || body.mode === 'deep') ? 1 : 3);
      if (S.st) { S.st.pingProg = { running: true, total, done: 0 }; render(); }   // шкала появляется сразу, не дожидаясь первого опроса
      const iv = setInterval(() => { refresh().catch(() => {}); }, 350);
      try { return await api0(method, path, body); } finally { clearInterval(iv); S.pingUntil = Date.now() + 1800; setTimeout(render, 1900); }
    }
    return api0(method, path, body);
  }
  async function api0(method, path, body) {
    const r = await fetch(path, { method, headers: { 'X-Quasar-Token': token || '', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Ошибка ' + r.status);
    return j;
  }
  function toast(msg, err) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
    clearTimeout(toast.t); toast.t = setTimeout(() => { t.className = 'toast'; }, 4000);
  }
  async function act(key, fn) {
    if (S.busy[key]) return;
    S.busy[key] = true; render.lock = false; render();
    try { await fn(); } catch (e) { toast(e.message, true); } finally { S.busy[key] = false; render.lock = false; render(); }
  }

  function el(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'text') e.textContent = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
    return e;
  }
  const btn = (text, onclick, cls, extra) => el('button', { class: 'btn ' + (cls || ''), type: 'button', onclick, ...extra }, text);

  function fmtBytes(n) {
    n = Number(n) || 0;
    const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']; let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? String(Math.round(n)) : n.toFixed(n >= 100 ? 0 : 1).replace('.', ',')) + ' ' + u[i];
  }
  const pingCls = (ms) => (ms === null || ms === undefined ? 'bad' : ms < 80 ? 'ok' : ms < 160 ? 'mid' : 'bad');
  const pingTxt = (p) => (!p ? '—' : p.ms === null ? 'нет' : (p.tun || p.how === 'tunnel' ? '≈' : '') + p.ms + ' мс' + (p.mode === 'deep' && p.kbps ? ' · ' + (p.kbps >= 1024 ? (p.kbps / 1024).toFixed(1) + ' МБ/с' : p.kbps + ' КБ/с') : ''));
  const pingTip = (p) => (!p ? 'Не замерено' : (p.mode === 'deep' ? 'Проверка скачиванием: рукопожатие и 256 КБ через сервер. Если здесь «нет», а URL-тест зелёный — провайдер замораживает поток этого протокола после первых килобайт' : p.mode === 'game' ? (p.how === 'tunnel' ? 'Пинг до игры (' + (p.site || '') + '): игра работает по UDP и не отвечает на проверку, поэтому показан путь до сервера сквозь этот протокол, «≈». Участок «сервер → игра» у всех протоколов одного сервера одинаковый, так что сравнивать протоколы можно' : 'Пинг до игры (' + (p.site || '') + ') сквозь этот протокол') : p.mode === 'site' ? 'Пинг до сайта ' + (p.site || '') + ' сквозь этот протокол: реальная задержка, которую получишь в игре или на сайте. Это TCP/TLS, а не UDP игры, но разница между протоколами та же' : p.mode === 'url' ? 'URL-тест: запрос до сайта через сервер' : p.tun ? 'TCP-пинг при включённом TUN идёт через сам туннель, поэтому цифра ненастоящая и «зелёная» даже у неработающего сервера. Проверяй «URL тестом» или выключи TUN' : 'TCP-пинг: время соединения с сервером') + (p.err ? ' — ' + p.err : ''));

  // ---------- блоки ----------
  function renderStatus() {
    const st = S.st, run = st.core.running;
    const cur = st.servers.find((s) => s.id === st.core.itemId);
    const box = document.getElementById('status'); box.replaceChildren(...[
      el('span', { class: run ? 'on' : 'muted' }, el('span', { class: 'dot' }), run ? 'Подключено' : 'Не подключено'),
      run && cur ? el('span', { class: 'muted' }, 'Сервер: ', el('b', { text: cur.name })) : null,
      S.ip ? el('span', { class: 'muted' }, 'Твой IP: ', el('b', { class: 'num', text: (run ? S.ip.via : S.ip.direct) || 'не удалось узнать' })) : null,
      run && S.ip && S.ip.direct ? el('span', { class: 'muted' }, 'Без VPN: ', el('span', { class: 'num', text: S.ip.direct })) : null,
      st.settings.limitGb && (st.usage.month.down + st.usage.month.up) >= st.settings.limitGb * 1024 ** 3 ? el('span', { class: 'bad', role: 'alert', text: 'Лимит трафика исчерпан — переключись на другой сервер' }) : null,
      run && st.check && st.check.status !== 'fail' && st.check.notes && st.check.notes.length ? el('span', { class: 'mid', title: st.check.notes.join('\n'), text: 'Переключился автоматически: ' + st.check.notes[st.check.notes.length - 1] }) : null,
      run && st.check && st.check.id === st.core.itemId ? (st.check.status === 'run' ? el('span', { class: 'mid', text: 'Проверяю, что через сервер открывается…' }) : st.check.status === 'ok' ? el('span', { class: 'ok', text: 'Работает · ' + st.check.ms + ' мс до сайта' }) : el('span', { class: 'bad', role: 'alert', text: 'Через сервер ничего не открывается', title: st.check.error }) ) : null,
      run && st.mode ? el('span', { class: 'muted' }, 'Режим: ', el('b', { text: st.mode })) : null,
      run ? el('span', { class: 'muted num' }, `↓ ${fmtBytes(st.speed.down)}/с  ↑ ${fmtBytes(st.speed.up)}/с`) : null,
      el('span', { class: 'muted num' }, `Сессия: ↓ ${fmtBytes(st.usage.session.down)}  ↑ ${fmtBytes(st.usage.session.up)}`),
    ].filter(Boolean));
  }

  function renderNav() {
    const tabs = [['servers', 'Серверы'], ['mine', 'Мои серверы'], ['tools', 'Инструменты'], ['traffic', 'Трафик'], ['cores', 'Ядра'], ['routes', 'Маршруты'], ['share', 'Раздача'], ['log', 'Журнал'], ['prefs', 'Настройки']];
    document.getElementById('nav').replaceChildren(...tabs.map(([k, t]) => el('button', { type: 'button', class: S.tab === k ? 'active' : '', onclick: () => { S.tab = k; if (k === 'traffic') loadTraffic(); render(); } }, t)));
  }

  function groupsOf(st) {
    const m = new Map();
    for (const x of st.servers) { if (!m.has(x.host)) m.set(x.host, []); m.get(x.host).push(x); }
    return [...m.entries()].map(([host, list]) => ({ host, list, name: list[0].group || host }));
  }
  const bestOf = (g) => PREF.map((p) => g.list.find((x) => x.proto === p)).find(Boolean) || g.list[0];
  const groupPing = (g) => { const v = g.list.map((x) => x.ping).filter((p) => p && p.ms !== null).map((p) => p.ms); const known = g.list.some((x) => x.ping); return !known ? null : { ms: v.length ? Math.min(...v) : null }; };

  const MASKS = ['www.apple.com', 'www.icloud.com', 'www.amazon.com', 'aws.amazon.com', 'www.oracle.com', 'www.nvidia.com', 'www.amd.com', 'www.intel.com', 'www.tesla.com', 'www.sony.com', 'dl.google.com', 'cloudflare.com'];
  function maintCard(st) {
    const m = st.maint;
    if (!m.logs.length || (S.maintHide === m.logs[0] && !m.running)) return null;
    const title = { alarm: 'Тревога: блокировка', 'port-auto': 'Автоподбор порта', uninstall: 'Снятие с сервера', port: 'Смена порта', 'mask-auto': 'Автоподбор маскировки' }[m.kind] || 'Смена маскировки';
    return el('div', { class: 'card' + (m.running ? '' : m.ok ? ' good' : ' alert') },
      el('div', { class: 'row' }, el('h2', { text: title }), el('span', { class: m.running ? 'mid' : m.ok ? 'ok' : 'bad', text: m.running ? 'идёт…' : m.ok ? 'получилось' : 'не получилось' }),
        el('span', { class: 'grow' }), m.running && ['port-auto', 'mask-auto', 'port', 'mask'].includes(m.kind) ? btn(m.stopping ? 'Останавливаю…' : 'Стоп', () => act('mstop', async () => { S.st = await api('POST', '/api/maint/stop'); }), 'danger', { disabled: m.stopping ? true : null, title: 'Остановить после текущего шага; прежние настройки вернутся' }) : null, m.running ? null : btn('Скрыть', () => { S.maintHide = m.logs[0]; render(); }, 'ghost')),
      el('div', { class: 'log', 'data-log': 'maint', role: 'log', text: m.logs.join('\n') }));
  }
  const SS_METHODS = ['2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305', 'aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305'];
  const MANUAL = {
    vless: ['VLESS Reality', [['host', 'Адрес'], ['port', 'Порт', '443'], ['uuid', 'UUID'], ['sni', 'SNI (сайт маскировки)'], ['publicKey', 'Публичный ключ (pbk)'], ['shortId', 'Short ID'], ['flow', 'Flow', 'xtls-rprx-vision']]],
    hysteria2: ['Hysteria2', [['host', 'Адрес'], ['port', 'Порт', '443'], ['password', 'Пароль'], ['sni', 'SNI'], ['obfsPassword', 'Пароль obfs (если есть)'], ['insecure', 'Не проверять сертификат', 'check']]],
    tuic: ['TUIC v5', [['host', 'Адрес'], ['port', 'Порт', '443'], ['uuid', 'UUID'], ['password', 'Пароль'], ['sni', 'SNI'], ['insecure', 'Не проверять сертификат', 'check']]],
    trojan: ['Trojan', [['host', 'Адрес'], ['port', 'Порт', '443'], ['password', 'Пароль'], ['sni', 'SNI'], ['insecure', 'Не проверять сертификат', 'check']]],
    anytls: ['AnyTLS', [['host', 'Адрес'], ['port', 'Порт', '443'], ['password', 'Пароль'], ['sni', 'SNI'], ['insecure', 'Не проверять сертификат', 'check']]],
    shadowsocks: ['Shadowsocks', [['host', 'Адрес'], ['port', 'Порт', '8388'], ['method', 'Шифрование', 'select'], ['password', 'Пароль']]],
    http: ['HTTP / HTTPS-прокси', [['host', 'Адрес'], ['port', 'Порт', '8080'], ['username', 'Логин (если есть)'], ['password', 'Пароль (если есть)'], ['tls', 'HTTPS (с TLS)', 'check']]],
    socks: ['SOCKS5', [['host', 'Адрес'], ['port', 'Порт', '1080'], ['username', 'Логин (если есть)'], ['password', 'Пароль (если есть)']]],
  };
  function checkCard(st) {
    const c = st.check; if (!st.core.running || !c || c.status !== 'fail' || c.id !== st.core.itemId) return null;
    return el('div', { class: 'card alert', role: 'alert' }, el('b', { text: 'Подключились, но через этот профиль ничего не открывается' }),
      ...(c.notes || []).map((n) => el('div', { class: 'note', text: '• ' + n })),
      el('div', { class: 'note', text: c.hint }), c.error ? el('div', { class: 'note', text: 'Ошибка: ' + c.error }) : null,
      c.logs && c.logs.length ? el('div', { class: 'log', text: c.logs.join('\n') }) : null,
      el('div', { class: 'row' }, btn('Отключить', () => act('dc', disconnect), ''), btn('Тревога: подобрать рабочий путь', () => act('alarm', async () => { S.st = await api('POST', '/api/alarm'); S.maintHide = ''; }), 'alarm')));
  }
  function manualCard() {
    const m = S.manual; if (!m) return null;
    const [title, fields] = MANUAL[m.proto];
    const inp = ([k, label, kind]) => kind === 'check'
      ? el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: m.f[k] ? true : null, onchange: (e) => { m.f[k] = e.target.checked; } }), ' ' + label)
      : kind === 'select'
        ? el('div', {}, el('label', { text: label }), el('select', { onchange: (e) => { m.f[k] = e.target.value; } }, SS_METHODS.map((x) => el('option', { value: x, selected: (m.f[k] || SS_METHODS[0]) === x ? true : null, text: x }))))
        : el('div', {}, el('label', { for: 'mf-' + k, text: label }), el('input', { id: 'mf-' + k, type: 'text', value: m.f[k] || '', placeholder: kind || '', autocomplete: 'off', oninput: (e) => { m.f[k] = e.target.value; } }));
    return el('div', { class: 'card' },
      el('div', { class: 'row' }, el('h2', { text: 'Новый сервер вручную' }), el('span', { class: 'grow' }), btn('Закрыть', () => { S.manual = null; render(); }, 'ghost')),
      el('div', { class: 'row' }, el('label', { text: 'Тип' }),
        el('select', { 'aria-label': 'Тип протокола', onchange: (e) => { S.manual = { proto: e.target.value, f: { name: m.f.name || '' } }; render(); } },
          Object.entries(MANUAL).map(([k, [t]]) => el('option', { value: k, selected: m.proto === k ? true : null, text: t })))),
      el('div', { class: 'grid2' }, inp(['name', 'Название']), ...fields.map(inp)),
      el('div', { class: 'note', text: 'NaiveProxy, ShadowQUIC, Sudoku, WARP и DNS-туннель добавляются на вкладке «Ядра».' }),
      btn('Добавить', () => act('man', async () => {
        const f = { ...m.f }; for (const [k, , d] of fields) if (f[k] === undefined && d && d !== 'check' && d !== 'select') f[k] = d;
        if (m.proto === 'shadowsocks' && !f.method) f.method = SS_METHODS[0];
        const r = await api('POST', '/api/add-manual', { proto: m.proto, f }); S.st = r.state; S.manual = null; toast(r.added ? 'Сервер добавлен' : 'Такой сервер уже был — обновил');
      }), 'primary'));
  }
  async function pasteImport() {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch { toast('Браузер не дал прочитать буфер: вставь ссылку в поле внизу', true); return; }
    act('clip', async () => { const r = await api('POST', '/api/import', { text }); S.st = r.state; toast(`Из буфера: новых ${r.added}, обновлено ${r.total - r.added}` + (r.skipped.length ? `, пропущено ${r.skipped.length}` : '')); });
  }
  function maskCellOf(st, s) {
    const m = s.mask;
    if (!m) return el('span', { class: 'muted', text: '—', title: 'У этого протокола нет маскировки под сайт' });
    if (m.where === 'fixed') return el('span', { class: 'muted cut', text: m.value, title: m.why });
    const onServer = m.where === 'server', can = !onServer || st.access.includes(s.host);
    const val = S.mask[s.id] !== undefined ? S.mask[s.id] : m.value;
    const apply = () => act('mk' + s.id, async () => { S.st = await api('POST', '/api/mask', { id: s.id, value: S.mask[s.id] !== undefined ? S.mask[s.id] : m.value }); delete S.mask[s.id]; toast(onServer ? 'Меняю маскировку на сервере, ход виден сверху' : 'Маскировка сменена'); });
    const autoBtn = s.proto === 'vless' && can ? btn(busyAuto(st, s, 'mask-auto') ? 'Стоп' : 'Авто', () => (busyAuto(st, s, 'mask-auto') ? act('mstop', async () => { S.st = await api('POST', '/api/maint/stop'); }) : act('ma' + s.id, async () => { S.st = await api('POST', '/api/mask-auto', { id: s.id }); toast('Подбираю маскировку: ход виден сверху'); })), 'ghost', { title: 'Перебрать сайты маскировки, пока один не заработает (на сервере меняется по SSH, без переустановки)', disabled: st.maint.running && !busyAuto(st, s, 'mask-auto') ? true : null }) : null;
    return el('span', { class: 'mask' },
      el('input', { type: 'text', value: val, list: 'mask-list', placeholder: 'сайт', 'aria-label': 'Маскировка ' + s.proto, disabled: can ? null : true,
        title: can ? (onServer ? 'Прописана и на сервере: приложение само зайдёт туда и поменяет' : 'Меняется только в приложении') : 'Чтобы менять с сервера, переустанови его с галочкой «Запомнить доступ для Тревоги»',
        oninput: (e) => { S.mask[s.id] = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter') apply(); } }),
      btn('✓', apply, 'ghost', { 'aria-label': 'Применить маскировку', disabled: can && !st.maint.running ? null : true }), autoBtn,
      onServer ? el('span', { class: 'badge muted', text: 'сервер', title: 'Смена займёт пару минут: сервер переустановится с той же маскировкой остальных протоколов и теми же портами' }) : null);
  }
  const protoName = (s) => (s.transport === 'xhttp' ? 'VLESS XHTTP' : s.proto === 'http' && s.tls ? 'HTTPS-прокси' : PROTO[s.proto] || s.proto);
  // Быстрая строка прямо над таблицей: тип, адрес (можно user:pass@ip:порт), логин и пароль, если есть
  const QUICK = { vless: ['VLESS Reality', 443, false], http: ['HTTP', 8080, true], socks: ['SOCKS5', 1080, true], shadowsocks: ['Shadowsocks', 8388, false], trojan: ['Trojan', 443, false], hysteria2: ['Hysteria2', 443, false], tuic: ['TUIC v5', 443, false], anytls: ['AnyTLS', 443, false] };
  const QX = { vless: [['uuid', 'UUID'], ['publicKey', 'публичный ключ (pbk)'], ['sni', 'сайт маскировки (sni)'], ['shortId', 'short id']], tuic: [['uuid', 'UUID']] };
  function parseAddr(text, defPort) {
    let t = String(text || '').trim().replace(/^[a-z0-9+.-]+:\/\//i, ''), user = '', pass = '';
    const at = t.lastIndexOf('@');
    if (at >= 0) { const cred = t.slice(0, at); t = t.slice(at + 1); const c = cred.indexOf(':'); user = decodeURIComponent(c >= 0 ? cred.slice(0, c) : cred); pass = c >= 0 ? decodeURIComponent(cred.slice(c + 1)) : ''; }
    const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(t.replace(/\/.*$/, ''));
    if (!m) return null;
    return { host: m[1].replace(/^\[|\]$/g, ''), port: m[2] ? Number(m[2]) : defPort, user, pass };
  }
  function quickAdd() {
    const q = S.quick || (S.quick = { proto: 'http', name: '', addr: '', user: '', pass: '', x: {} }), [, defPort, hasUser] = QUICK[q.proto];
    const go = () => act('quick', async () => {
      if (/^[a-z0-9+.-]+:\/\//i.test(q.addr.trim())) {   // вставили готовую ссылку — берём её целиком, имя применяем своё
        const r = await api('POST', '/api/import', { text: q.addr.trim() }); S.st = r.state;
        if (q.name.trim() && r.state.servers.length) { const last = r.state.servers[r.state.servers.length - 1]; S.st = await api('POST', '/api/rename', { id: last.id, name: q.name }); }
        q.name = ''; q.addr = ''; toast(r.added ? 'Профиль добавлен' : 'Такой уже был — обновил'); return;
      }
      const a = parseAddr(q.addr, defPort); if (!a || !a.host) throw new Error('Впиши адрес: ip или ip:порт (можно логин:пароль@ip:порт)');
      const f = { name: q.name, host: a.host, port: a.port, username: q.user || a.user, password: q.pass || a.pass };
      if (q.proto === 'shadowsocks') f.method = 'chacha20-ietf-poly1305';
      Object.assign(f, q.x || {}); if (q.proto === 'vless') f.flow = 'xtls-rprx-vision';
      const r = await api('POST', '/api/add-manual', { proto: q.proto, f }); S.st = r.state; q.name = ''; q.addr = ''; q.user = ''; q.pass = ''; q.x = {};
      toast(r.added ? 'Профиль добавлен' : 'Такой уже был — обновил');
    });
    const key = (e) => { if (e.key === 'Enter') go(); };
    return el('div', { class: 'quick', role: 'group', 'aria-label': 'Быстро добавить профиль' },
      el('select', { 'aria-label': 'Тип', onchange: (e) => { q.proto = e.target.value; render.lock = false; render(); } }, Object.entries(QUICK).map(([k, [t]]) => el('option', { value: k, selected: q.proto === k ? true : null, text: t }))),
      el('input', { type: 'text', value: q.name, placeholder: 'имя (своё, необязательно)', 'aria-label': 'Имя профиля', autocomplete: 'off', maxlength: 60, oninput: (e) => { q.name = e.target.value; }, onkeydown: key }),
      el('input', { type: 'text', value: q.addr, placeholder: `ip:${defPort}  или готовая ссылка` + (hasUser ? '  или  логин:пароль@ip' : ''), 'aria-label': 'Адрес', autocomplete: 'off', oninput: (e) => { q.addr = e.target.value; }, onkeydown: key }),
      ...(QX[q.proto] || []).map(([k, ph]) => el('input', { type: 'text', value: (q.x || {})[k] || '', placeholder: ph, 'aria-label': ph, autocomplete: 'off', oninput: (e) => { (q.x || (q.x = {}))[k] = e.target.value; }, onkeydown: key })),
      hasUser ? el('input', { type: 'text', value: q.user, placeholder: 'логин (если есть)', 'aria-label': 'Логин', autocomplete: 'off', oninput: (e) => { q.user = e.target.value; }, onkeydown: key }) : null,
      QX[q.proto] && q.proto === 'vless' ? null : el('input', { type: 'password', value: q.pass, placeholder: hasUser ? 'пароль (если есть)' : 'пароль', 'aria-label': 'Пароль', autocomplete: 'new-password', oninput: (e) => { q.pass = e.target.value; }, onkeydown: key }),
      btn('+ Добавить', go, 'primary'));
  }
  // Выделение: щелчок — один, Ctrl — добавить/убрать, Shift — диапазон. Правый клик — меню (пинг, удалить…).
  const chosenIds = () => (S.multi.size ? [...S.multi] : (S.sel ? [S.sel] : []));
  function pickRow(e, s, order) {
    if (e.ctrlKey || e.metaKey) { if (!S.multi.size && S.sel) S.multi.add(S.sel); if (S.multi.has(s.id)) S.multi.delete(s.id); else S.multi.add(s.id); S.sel = s.id; S.anchor = s.id; }
    else if (e.shiftKey && S.anchor) {
      const ids = order.map((x) => x.id), a = ids.indexOf(S.anchor), b = ids.indexOf(s.id);
      if (a >= 0 && b >= 0) { S.multi = new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1)); S.sel = s.id; }
    } else { S.multi = new Set(); S.sel = s.id; S.anchor = s.id; }
    render();
  }
  function closeCtx() { const m = document.getElementById('ctx'); if (m) m.remove(); }
  function ctxMenu(e, s, order) {
    e.preventDefault();
    if (!S.multi.has(s.id) && S.sel !== s.id) { S.multi = new Set(); S.sel = s.id; S.anchor = s.id; render(); }
    const ids = chosenIds(), n = ids.length, st = S.st; closeCtx();
    const menu = el('div', { id: 'ctx', class: 'ctx', role: 'menu' });
    const item = (text, fn, cls) => menu.append(el('button', { type: 'button', role: 'menuitem', class: 'ctx-i ' + (cls || ''), onclick: (ev) => { ev.stopPropagation(); fn(ev.currentTarget); } }, text));
    if (n === 1) { const x = st.servers.find((y) => y.id === ids[0]); if (x) item(st.core.running && st.core.itemId === x.id ? 'Отключить' : 'Подключить', () => { closeCtx(); act('c' + x.id, () => (st.core.running && st.core.itemId === x.id ? disconnect() : connect(x.id, st))); }); }
    item(n > 1 ? `Пинг (${n})` : 'Пинг', () => { closeCtx(); act('pm', async () => { S.st = await api('POST', '/api/ping', { ids, mode: S.pingMode }); }); });
    item(n > 1 ? `Пинг по URL (${n})` : 'Пинг по URL', () => { closeCtx(); act('pmu', async () => { S.st = await api('POST', '/api/ping', { ids, mode: 'url' }); }); });
    if (n === 1) item('Переименовать', () => { closeCtx(); S.renaming = 'sid' + ids[0]; S.renameVal = (st.servers.find((y) => y.id === ids[0]) || {}).name || ''; S.tab = 'servers'; render(); });
    item(n > 1 ? `Выбрать все (${order.length})` : 'Выбрать все', () => { closeCtx(); S.multi = new Set(order.map((x) => x.id)); render(); });
    item(n > 1 ? `Удалить из списка (${n})` : 'Удалить из списка', (b) => {
      if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Точно удалить' + (n > 1 ? ` ${n}` : '') + '?'; return; }
      closeCtx(); S.multi = new Set(); act('dm', async () => { S.sel = ''; S.st = await api('POST', '/api/servers/delete', { ids }); toast(n > 1 ? `Удалено из списка: ${n}` : 'Удалено из списка'); });
    }, 'danger');
    menu.append(el('div', { class: 'ctx-note', text: 'С самого сервера это ничего не снимает' }));
    document.body.append(menu);
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.max(4, Math.min(e.clientX, innerWidth - w - 4)) + 'px'; menu.style.top = Math.max(4, Math.min(e.clientY, innerHeight - h - 4)) + 'px';
  }
  document.addEventListener('click', (e) => { if (!e.target.closest || !e.target.closest('#ctx')) closeCtx(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtx(); });
  window.addEventListener('blur', closeCtx);
  // Ширина столбцов: потяни за край заголовка; двойной щелчок по краю вернёт как было. Запоминается.
  function resizable(table, key) {
    const head = table.querySelector('.t-head'); if (!head) return table;
    const cells = [...head.children], rows = [...table.querySelectorAll('.t-row')], GAP = 6, MINW = 50, LASTMIN = 140;
    const avail = () => (table.clientWidth || (document.getElementById('main').clientWidth - 26)) - 16;
    // Ширины всех столбцов, кроме последнего, плюс последний (кнопки «Пинг/Пуск») не меньше LASTMIN: вместе всегда в ширину окна
    const fit = (w) => {
      const fixed = w.slice(0, -1), room = avail() - (w.length - 1) * GAP - LASTMIN, sum = fixed.reduce((a, x) => a + x, 0);
      return sum > room ? fixed.map((x) => Math.max(MINW, Math.floor(x * Math.max(0.1, room / sum)))) : fixed;
    };
    const apply = (w) => {
      const f = fit(w), tpl = [...f.map((x) => x + 'px'), `minmax(${LASTMIN}px, 1fr)`].join(' '), min = f.length * MINW + (w.length - 1) * GAP + LASTMIN + 16;
      for (const r of [head, ...rows]) { r.style.gridTemplateColumns = tpl; r.style.minWidth = min + 'px'; }
      return f;
    };
    if (Array.isArray(S.cols[key]) && S.cols[key].length === cells.length - 1) apply([...S.cols[key], LASTMIN]);
    cells.slice(0, -1).forEach((c, i) => {
      const grip = el('i', { class: 'grip', role: 'separator', 'aria-label': 'Изменить ширину столбца', title: 'Потяни, чтобы изменить ширину; двойной щелчок — сбросить все столбцы' });
      grip.addEventListener('click', (e) => e.stopPropagation());
      grip.addEventListener('dblclick', (e) => { e.stopPropagation(); delete S.cols[key]; try { localStorage.setItem('cols', JSON.stringify(S.cols)); } catch { /* без хранилища */ } render(); });
      grip.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        const base = cells.map((x) => Math.round(x.getBoundingClientRect().width)), x0 = e.clientX; render.lock = true;
        const others = base.slice(0, -1).reduce((a, x, k) => a + (k === i ? 0 : x), 0), cap = Math.max(MINW, avail() - (base.length - 1) * GAP - LASTMIN - others);   // дальше тянуть нельзя: последний столбец уехал бы
        const move = (ev) => { const w = base.slice(); w[i] = Math.min(cap, Math.max(MINW, base[i] + ev.clientX - x0)); S.cols[key] = apply(w); };
        const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); render.lock = false; try { localStorage.setItem('cols', JSON.stringify(S.cols)); } catch { /* без хранилища */ } };
        document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
      });
      c.append(grip);
    });
    return table;
  }
  let resizeT = 0; window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { render.lock = false; render(); }, 150); });
  // Журнал соединений в реальном времени: что открылось, куда, через что и по какому правилу
  const hhmmss = (t) => new Date(t).toLocaleTimeString('ru-RU');
  function connLogCard(st) {
    const run = st.core.running;
    const q = S.connFilter.trim().toLowerCase();
    const list = S.conn.filter((e) => e.seq > S.connClear && (S.connOnly === 'all' || e.out === S.connOnly) && (!q || (e.host + ' ' + e.ip + ' ' + e.src + ' ' + e.why + ' ' + e.route).toLowerCase().includes(q)));
    const shown = list.slice(-200).reverse(), openN = S.conn.filter((e) => e.open).length;
    const head = el('div', { class: 't-head cols-conn' }, el('span', { text: 'Время' }), el('span', { text: 'Куда' }), el('span', { text: 'Кто' }), el('span', { text: 'Маршрут' }), el('span', { text: 'Почему' }), el('span', { text: '↓ · ↑' }));
    const rows = shown.map((e) => el('div', { class: 't-row cols-conn' + (e.open ? '' : ' closed') },
      el('span', { class: 'muted num', text: hhmmss(e.at), title: e.open ? 'открыто' : 'закрыто в ' + hhmmss(e.closedAt) }),
      el('span', { class: 'cut', title: `${e.host}${e.ip && e.ip !== e.host ? ' (' + e.ip + ')' : ''}:${e.port} ${e.net.toUpperCase()}` }, el('span', { class: e.open ? 'ok' : 'muted', text: e.open ? '● ' : '○ ' }), el('b', { text: e.host || e.ip }), el('span', { class: 'muted', text: ':' + e.port + (e.net === 'udp' ? ' UDP' : '') })),
      el('span', { class: 'cut muted', title: e.inb, text: e.src ? e.src : e.inb }),
      el('span', { class: 'cut ' + (e.out === 'direct' ? 'mid' : 'ok'), title: e.route, text: e.out === 'direct' ? 'напрямую' : 'через сервер' }),
      el('span', { class: 'cut muted', title: e.why, text: e.why }),
      el('span', { class: 'num muted cut', text: `${fmtBytes(e.down)} · ${fmtBytes(e.up)}` })));
    return el('div', { class: 'card' },
      el('div', { class: 'row' }, el('h2', { text: 'Журнал соединений' }),
        el('span', { class: 'note', text: run ? `в реальном времени · открыто сейчас: ${openN} · записей: ${list.length}` : 'подключись к серверу — здесь пойдут соединения' }), el('span', { class: 'grow' }),
        el('input', { type: 'text', class: 'conn-q', value: S.connFilter, placeholder: 'фильтр: сайт, программа…', 'aria-label': 'Фильтр журнала', autocomplete: 'off', oninput: (e) => { S.connFilter = e.target.value; render.lock = false; render(); const i = document.querySelector('.conn-q'); if (i) { i.focus(); i.setSelectionRange(S.connFilter.length, S.connFilter.length); } } }),
        el('select', { 'aria-label': 'Какие показывать', onchange: (e) => { S.connOnly = e.target.value; render(); } }, [['all', 'Все'], ['proxy', 'Через сервер'], ['direct', 'Напрямую']].map(([k, t]) => el('option', { value: k, selected: S.connOnly === k ? true : null, text: t }))),
        btn(S.connPause ? 'Продолжить' : 'Пауза', () => { S.connPause = !S.connPause; render(); }, S.connPause ? 'primary' : 'ghost'),
        btn('Очистить', () => { S.connClear = S.conn.length ? S.conn[S.conn.length - 1].seq : S.connClear; render(); }, 'ghost')),
      run && !rows.length ? el('div', { class: 'note', text: 'Пока тихо: открой сайт или программу — соединение появится здесь. Заблокированная реклама не показывается: отклонённые запросы ядро не считает соединениями.' }) : null,
      rows.length ? el('div', { class: 'table conn-table', 'data-log': 'conn' }, head, ...rows) : null);
  }
  async function loadConn() {
    if (S.connPause || !S.st || S.tab !== 'servers') return;
    try { const r = await api('GET', '/api/connlog'); if (!S.connPause) { S.conn = r.items; render(); } } catch { /* ядро остановлено */ }
  }
  setInterval(loadConn, 1000);
  function selectedOf(st) { return st.servers.find((x) => x.id === S.sel) || st.servers.find((x) => st.core.running && x.id === st.core.itemId) || st.servers[0] || null; }
  const sortVal = { type: (x) => protoName(x).toLowerCase(), name: (x) => x.name.toLowerCase(), ping: (x) => (x.ping && x.ping.ms !== null ? x.ping.ms : Infinity), traffic: (x) => (x.traffic ? x.traffic.down + x.traffic.up : -1) };
  function sorted(list) {
    const k = S.sort.key; if (!k) return list;
    return list.map((x, i) => [x, i]).sort((a, b) => { const va = sortVal[k](a[0]), vb = sortVal[k](b[0]); if (va === vb) return a[1] - b[1]; if (va === Infinity) return 1; if (vb === Infinity) return -1; return (va < vb ? -1 : 1) * S.sort.dir; }).map((p) => p[0]);
  }
  function sortBy(k) { S.sort = S.sort.key === k ? { key: k, dir: -S.sort.dir } : { key: k, dir: k === 'traffic' ? -1 : 1 }; render(); }
  function flatList(st) {
    const sel = selectedOf(st);
    const th = (k, t) => el('button', { class: 'th', type: 'button', title: 'Сортировать', 'aria-label': 'Сортировать по: ' + t, onclick: () => sortBy(k) }, t + (S.sort.key === k ? (S.sort.dir > 0 ? ' ▲' : ' ▼') : ''));
    const head = el('div', { class: 't-head cols-flat' }, th('type', 'Тип'), th('name', 'Название'), el('span', { text: 'Адрес' }), th('ping', 'Пинг'), th('traffic', 'Трафик ↓ ↑'), el('span'));
    const order = sorted(st.servers);
    const rows = order.map((s) => {
      const isCur = st.core.running && st.core.itemId === s.id;
      const go = () => act('c' + s.id, () => connect(s.id, st));
      const chosen = S.multi.has(s.id) || (!S.multi.size && sel && sel.id === s.id);
      return el('div', { class: 't-row cols-flat pick' + (chosen ? ' sel' : '') + (isCur ? ' cur' : ''), tabindex: '0', role: 'row', 'aria-selected': chosen ? 'true' : 'false',
        title: 'Двойной щелчок — подключиться; Ctrl или Shift — выделить несколько; правый клик — меню',
        onclick: (e) => pickRow(e, s, order),
        oncontextmenu: (e) => ctxMenu(e, s, order),
        ondblclick: go,
        onkeydown: (e) => { if (e.key === 'Enter') go(); else if (e.key === ' ') { e.preventDefault(); S.sel = s.id; render(); } } },
        el('span', { class: 'cut' }, isCur ? el('span', { class: 'ok', text: '● ' }) : null, el('b', { text: protoName(s) })),
        el('span', { class: 'cut', text: s.name }),
        el('span', { class: 'cut muted', text: `${s.host}:${s.port}` }),
        el('span', { class: 'num ' + pingCls(s.ping && s.ping.ms), text: pingTxt(s.ping), title: pingTip(s.ping) }),
        el('span', { class: 'num muted cut', title: 'Скачано и отправлено через этот профиль', text: s.traffic ? `${fmtBytes(s.traffic.down)} · ${fmtBytes(s.traffic.up)}` : '—' }),
        el('span', { class: 'acts', onclick: (e) => e.stopPropagation(), ondblclick: (e) => e.stopPropagation() },
          btn('Пинг', () => act('p1' + s.id, async () => { S.st = await api('POST', '/api/ping', { ids: [s.id], mode: S.pingMode }); }), 'ghost'),
          isCur ? btn('Стоп', () => act('dc', disconnect), 'ghost danger') : btn(st.core.running ? 'Перейти' : 'Пуск', go, 'ghost')));
    });
    return resizable(el('div', { class: 'table' }, head, ...rows), 'flat');
  }
  const busyAuto = (st, s, kind) => st.maint.running && st.maint.kind === kind && st.maint.host === s.host;
  // Порт: свой (✓) или «Авто» — Квазар сам перебирает порты на сервере, пока не найдёт рабочий; «Стоп» возвращает прежний
  function portEditor(st, s) {
    if (!s.tunable) return el('span', { class: 'muted', text: ':' + s.port, title: 'Порт этого протокола меняется только переустановкой сервера' });
    const own = st.own && st.own.includes(s.host), can = st.access.includes(s.host);
    const val = S.portIn[s.id] !== undefined ? S.portIn[s.id] : String(s.port);
    const auto = busyAuto(st, s, 'port-auto'), anyBusy = st.maint.running;
    const apply = () => act('pt' + s.id, async () => { S.st = await api('POST', '/api/port', { id: s.id, port: Number(S.portIn[s.id] !== undefined ? S.portIn[s.id] : s.port) }); delete S.portIn[s.id]; toast('Меняю порт на сервере: ход виден сверху'); });
    return el('span', { class: 'mask portbox' },
      el('input', { type: 'text', inputmode: 'numeric', value: val, 'aria-label': 'Порт ' + s.proto, disabled: can ? null : true, class: 'port-in',
        title: can ? 'Свой порт: впиши и нажми ✓ — Квазар поменяет его на сервере по SSH' : 'Чтобы менять порт из приложения, нужен сохранённый доступ к серверу (галочка «Запомнить доступ» при установке)',
        oninput: (e) => { S.portIn[s.id] = e.target.value.replace(/\D/g, '').slice(0, 5); }, onkeydown: (e) => { if (e.key === 'Enter') apply(); } }),
      btn('✓', apply, 'ghost', { 'aria-label': 'Применить порт', disabled: can && !anyBusy ? null : true }),
      btn(auto ? 'Стоп' : 'Авто', () => (auto ? act('mstop', async () => { S.st = await api('POST', '/api/maint/stop'); }) : act('pa' + s.id, async () => { S.st = await api('POST', '/api/port-auto', { id: s.id }); toast('Подбираю порт: ход виден сверху'); })), 'ghost',
        { title: 'Перебрать порты на сервере, пока не найдётся рабочий', disabled: can && (!anyBusy || auto) ? null : true }));
  }
  // Имя профиля: щёлкни по карандашу, впиши своё и нажми Enter. Повторный импорт того же сервера имя не затирает.
  function renameBox(key, name, kind, isHost) {
    if (S.renaming !== kind + key) return el('span', { class: 'rn' }, el('b', { text: name }), el('button', { class: 'btn ghost', type: 'button', title: 'Переименовать', 'aria-label': 'Переименовать ' + name, onclick: () => { S.renaming = kind + key; S.renameVal = name; render.lock = false; render(); setTimeout(() => { const i = document.getElementById('rn-in'); if (i) { i.focus(); i.select(); } }, 0); } }, '✎'));
    const save = () => act('rn', async () => { S.st = await api('POST', '/api/rename', isHost ? { host: key, name: S.renameVal } : { id: key, name: S.renameVal }); S.renaming = ''; });
    return el('span', { class: 'rn' }, el('input', { id: 'rn-in', type: 'text', value: S.renameVal, maxlength: 60, 'aria-label': 'Новое имя', oninput: (e) => { S.renameVal = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') { S.renaming = ''; render.lock = false; render(); } } }),
      btn('Сохранить', save, 'primary'), btn('Отмена', () => { S.renaming = ''; render.lock = false; render(); }, 'ghost'));
  }
  function selectedBar(st) {
    if (S.multi.size > 1) {
      const ids = [...S.multi].filter((i) => st.servers.some((x) => x.id === i));
      return el('div', { class: 'card sel-bar' }, el('div', { class: 'row' }, el('b', { text: `Выбрано: ${ids.length}` }), el('span', { class: 'muted', text: 'Ctrl — добавить или убрать, Shift — диапазон' }), el('span', { class: 'grow' }),
        btn(`Пинг (${ids.length})`, () => act('pm', async () => { S.st = await api('POST', '/api/ping', { ids, mode: S.pingMode }); })),
        btn(`Пинг по URL (${ids.length})`, () => act('pmu', async () => { S.st = await api('POST', '/api/ping', { ids, mode: 'url' }); })),
        btn('Снять выделение', () => { S.multi = new Set(); render(); }, 'ghost'),
        S.confirm === 'multi' ? btn(`Точно удалить ${ids.length}?`, () => act('dm', async () => { S.confirm = ''; S.multi = new Set(); S.sel = ''; S.st = await api('POST', '/api/servers/delete', { ids }); }), 'danger')
          : btn(`Удалить (${ids.length})`, () => { S.confirm = 'multi'; render(); setTimeout(() => { if (S.confirm === 'multi') { S.confirm = ''; render(); } }, 4000); }, 'danger')));
    }
    const s = selectedOf(st); if (!s) return null;
    const isCur = st.core.running && st.core.itemId === s.id;
    return el('div', { class: 'card sel-bar' },
      el('div', { class: 'row' }, renameBox(s.id, s.name, 'sid', false), el('span', { class: 'muted num', text: `${protoName(s)} · ${s.host}:${s.port}` }), el('span', { class: 'grow' }),
        btn('Пинг', () => act('p1' + s.id, async () => { S.st = await api('POST', '/api/ping', { ids: [s.id], mode: S.pingMode }); }), ''),
        btn('Пинг по URL', () => act('pu' + s.id, async () => { S.st = await api('POST', '/api/ping', { ids: [s.id], mode: 'url' }); }), '', { title: 'Настоящая задержка до сайта через этот протокол' }),
        isCur ? btn('Отключить', () => act('dc', disconnect), '') : btn(st.core.running ? 'Переключить' : 'Подключить', () => act('c' + s.id, () => connect(s.id, st)), 'primary'),
        S.confirm === s.id ? btn('Точно удалить?', () => act('d1' + s.id, async () => { S.confirm = ''; S.sel = ''; S.st = await api('POST', '/api/servers/delete', { id: s.id }); }), 'danger')
          : btn('Удалить', () => { S.confirm = s.id; render(); setTimeout(() => { if (S.confirm === s.id) { S.confirm = ''; render(); } }, 4000); }, 'danger')),
      el('div', { class: 'row' }, el('span', { class: 'muted', text: 'Порт' }), portEditor(st, s)),
      s.mask ? el('div', { class: 'row' }, el('span', { class: 'muted', text: 'Маскировка' }), el('div', { class: 'grow' }, maskCellOf(st, s))) : null);
  }
  function serversTab() {
    const st = S.st, groups = groupsOf(st);
    const head = el('div', { class: 't-head cols-servers' }, el('span', { text: 'Сервер' }), el('span', { text: 'Протокол' }), el('span', { text: 'Пинг' }), el('span'));
    const maskCell = (s) => maskCellOf(st, s);
    const protoRow = (s) => {
      const isCur = st.core.running && st.core.itemId === s.id;
      const order = st.servers, chosen = S.multi.has(s.id);
      return el('div', { class: 't-row cols-proto sub' + (isCur || chosen ? ' sel' : ''), onclick: (e) => { if (e.target.closest('button,input,select')) return; pickRow(e, s, order); }, oncontextmenu: (e) => ctxMenu(e, s, order) },
        el('span', { class: 'cut indent', title: s.host + ':' + s.port, text: s.transport === 'xhttp' ? 'VLESS XHTTP' : s.proto === 'http' && s.tls ? 'HTTPS-прокси' : PROTO[s.proto] || s.proto }),
        el('span', { class: 'muted', text: ':' + s.port }),
        maskCell(s),
        el('span', { class: 'num ' + pingCls(s.ping && s.ping.ms), text: pingTxt(s.ping) }),
        el('span', { class: 'acts' },
          isCur ? btn('Отключить', () => act('dc', disconnect), 'ghost') : btn('Подключить', () => act('c' + s.id, () => connect(s.id)), 'ghost')));
    };
    const rows = [];
    for (const g of groups) {
      const isOpen = S.open[g.host] !== undefined ? S.open[g.host] : groups.length === 1;
      const cur = st.core.running && g.list.some((x) => x.id === st.core.itemId);
      const gp = groupPing(g);
      rows.push(el('div', { class: 't-row cols-servers group' + (cur ? ' sel' : '') },
        el('span', { class: 'cut' }, el('button', { class: 'twist', type: 'button', 'aria-expanded': isOpen ? 'true' : 'false', 'aria-label': (isOpen ? 'Свернуть ' : 'Развернуть ') + g.name, onclick: () => { S.open[g.host] = !isOpen; render(); } }, isOpen ? '▾' : '▸'),
          el('b', { text: g.name }), g.name !== g.host ? el('span', { class: 'muted', text: '  ' + g.host }) : null),
        el('span', { class: 'muted', text: plural(g.list.length, ['протокол', 'протокола', 'протоколов']) }),
        el('span', { class: 'num ' + pingCls(gp && gp.ms), text: pingTxt(gp) }),
        el('span', { class: 'acts' },
          btn('Пинг', () => act('pg' + g.host, async () => { S.st = await api('POST', '/api/ping', { ids: g.list.map((x) => x.id), mode: S.pingMode }); }), 'ghost'),
          btn('URL', () => act('pgu' + g.host, async () => { S.st = await api('POST', '/api/ping', { ids: g.list.map((x) => x.id), mode: 'url' }); }), 'ghost', { title: 'Пинг по URL: настоящая задержка до сайта сквозь каждый протокол этого сервера' }),
          cur ? btn('Отключить', () => act('dc', disconnect), 'ghost') : btn('Подключить', () => act('cg' + g.host, () => connect(bestOf(g).id)), 'ghost'),
          btn('Ссылка', () => act('ex' + g.host, async () => { const r = await api('POST', '/api/export', { host: g.host }); S.exportLink = r.link; S.exportNote = `Сервер «${g.name}»: ${plural(r.count, ['протокол', 'протокола', 'протоколов'])}`; }), 'ghost'),
          S.confirm === g.host
            ? btn('Точно удалить?', () => act('dh' + g.host, async () => { S.confirm = ''; S.st = await api('POST', '/api/servers/delete-host', { host: g.host }); }), 'ghost danger')
            : btn('✕', () => { S.confirm = g.host; render(); setTimeout(() => { if (S.confirm === g.host) { S.confirm = ''; render(); } }, 4000); }, 'ghost danger', { 'aria-label': 'Удалить сервер ' + g.name + ' из списка', title: 'Убрать из списка (на самом сервере ничего не меняется)' }))));
      if (isOpen) for (const x of g.list) rows.push(protoRow(x));
    }
    const exportBox = S.exportLink ? el('div', { class: 'card' },
      el('div', { class: 'row' }, el('h2', { text: 'Единая ссылка' }), el('span', { class: 'note', text: S.exportNote }), el('span', { class: 'grow' }), btn('Закрыть', () => { S.exportLink = ''; render(); }, 'ghost')),
      el('textarea', { readonly: true, 'aria-label': 'Единая ссылка' }, S.exportLink),
      el('div', { class: 'row' }, btn('Скопировать', async () => { try { await navigator.clipboard.writeText(S.exportLink); toast('Ссылка скопирована'); } catch { toast('Не получилось скопировать', true); } }, 'primary'),
        el('span', { class: 'note', text: 'В ссылке лежат ключи доступа: передавай её только тем, кому доверяешь.' }))) : null;
    const sites = el('div', { class: 'card' },
      el('div', { class: 'row' }, el('h2', { text: 'Пинг до сайтов' }), el('span', { class: 'note', text: S.siteRes ? (S.siteRes.viaProxy ? 'через выбранный сервер и напрямую' : 'без VPN (подключись, чтобы увидеть путь через сервер)') : 'нажми «Замерить»' }),
        el('span', { class: 'grow' }), btn('Замерить', () => act('sites', async () => { S.siteRes = await api('POST', '/api/sites/ping'); }), 'primary')),
      el('div', { class: 'row' },
        el('div', { class: 'grow' }, el('input', { type: 'text', id: 'site-in', placeholder: 'example.com', value: S.siteInput, 'aria-label': 'Сайт', oninput: (e) => { S.siteInput = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter') addSite(); } })),
        btn('Добавить сайт', addSite)),
      el('div', { class: 'grid2' }, st.sites.map((h) => {
        const r = S.siteRes && S.siteRes.results.find((x) => x.host === h);
        return el('div', { class: 'site' }, el('span', { class: 'cut', text: h }),
          el('span', { class: 'row' },
            r ? el('b', { class: 'num ' + pingCls(r.via !== null && r.via !== undefined ? r.via : r.direct), text: [r.via !== null && r.via !== undefined ? r.via + ' мс' : null, r.direct !== null ? (S.siteRes.viaProxy ? 'без VPN ' : '') + r.direct + ' мс' : 'нет'].filter(Boolean).join(' · ') }) : null,
            el('button', { class: 'btn ghost danger', type: 'button', 'aria-label': 'Убрать ' + h, onclick: () => act('rs' + h, async () => { S.st = await api('POST', '/api/sites/delete', { host: h }); }) }, '✕')));
      })));
    const imp = el('div', { class: 'card' }, el('h2', { text: 'Добавить серверы' }),
      el('textarea', { placeholder: 'Вставь ссылку quasar://…, подписку или ссылки vless:// hysteria2:// tuic:// …', 'aria-label': 'Ссылка', oninput: (e) => { S.importText = e.target.value; } }, S.importText),
      el('div', { class: 'row' },
        btn('Добавить', () => act('imp', async () => {
          const r = await api('POST', '/api/import', { text: S.importText });
          S.st = r.state; S.importText = '';
          toast(`Новых: ${r.added}, обновлено: ${r.total - r.added}` + (r.skipped.length ? `, пропущено: ${r.skipped.length}` : ''));
        }), 'primary'),
        btn('Вставить из буфера', async () => { try { S.importText = await navigator.clipboard.readText(); render(); } catch { toast('Браузер не дал прочитать буфер: вставь ссылку вручную', true); } })));
    const view = S.view || 'list';
    S.toolsParts = { sites, imp };
    return [el('div', { class: 'row' }, el('span', { class: 'note', text: st.servers.length ? `${plural(st.servers.length, ['протокол', 'протокола', 'протоколов'])}, ${plural(groups.length, ['сервер', 'сервера', 'серверов'])}` : '' })),
      el('div', { class: 'row toolbar' },
        btn('+ Из буфера', pasteImport, 'primary', { title: 'Вставить ссылки vless:// trojan:// hysteria2:// ss:// … или подписку из буфера обмена' }),
        btn('+ Вручную', () => { S.manual = S.manual ? null : { proto: 'vless', f: {} }; render(); }),
        btn('Пинг всех', () => act('pingall', async () => { S.st = await api('POST', '/api/ping', { mode: S.pingMode }); S.sort = { key: 'ping', dir: 1 }; }), '', { title: 'Замерить все и отсортировать: быстрые сверху' }),
        btn('Пинг по URL', () => act('pingallurl', async () => { S.st = await api('POST', '/api/ping', { mode: 'url' }); S.sort = { key: 'ping', dir: 1 }; }), '', { title: 'Настоящая задержка до сайта сквозь каждый протокол: показывает, что протокол реально работает. Дольше, чем TCP' }),
        btn('Найти игру', () => act('findgame', async () => { S.games = await api('GET', '/api/games'); }), '', { title: 'Запусти игру, подключись к матчу и нажми: Квазар найдёт, к какому адресу она сейчас подключена, и замерит задержку до него через каждый протокол. Нужно, чтобы Квазар был подключён' }),
        btn('Проверка скачиванием', () => act('pingalldeep', async () => { S.st = await api('POST', '/api/ping', { mode: 'deep' }); S.sort = { key: 'ping', dir: 1 }; }), '', { title: 'Через каждый протокол скачивается 256 КБ: видно, какие протоколы провайдер пропускает по-настоящему, а какие замораживает после первых килобайт' }),
        el('span', { class: 'seg', role: 'group', 'aria-label': 'Вид пинга', title: 'TCP — быстрый замер соединения с сервером. URL — настоящая задержка до сайта сквозь протокол (дольше, зато показывает, что протокол реально работает)' },
          ['tcp', 'url'].map((m) => el('button', { type: 'button', class: S.pingMode === m ? 'on' : '', 'aria-pressed': S.pingMode === m ? 'true' : 'false', onclick: () => { S.pingMode = m; try { localStorage.setItem('pm', m); } catch { /* не страшно */ } render(); } }, m === 'tcp' ? 'TCP пинг' : 'URL тест'))),
        el('span', { class: 'grow' }),
        el('span', { class: 'seg' },
          el('button', { type: 'button', class: view === 'list' ? 'on' : '', 'aria-pressed': view === 'list' ? 'true' : 'false', onclick: () => { S.view = 'list'; render(); } }, 'Списком'),
          el('button', { type: 'button', class: view === 'groups' ? 'on' : '', 'aria-pressed': view === 'groups' ? 'true' : 'false', onclick: () => { S.view = 'groups'; render(); } }, 'По серверам'))),
      gamesCard(st), manualCard(), checkCard(st),
      el('div', { class: 'row' },
        groups.length ? btn('Все серверы — одна ссылка', () => act('exall', async () => { const r = await api('POST', '/api/export', {}); S.exportLink = r.link; S.exportNote = `${plural(r.hosts, ['сервер', 'сервера', 'серверов'])}, ${plural(r.count, ['протокол', 'протокола', 'протоколов'])}`; })) : null,
        null),
      maintCard(st),
      el('datalist', { id: 'mask-list' }, [...st.maskSites, ...(st.maskList || MASKS)].map((v) => el('option', { value: v }))),
      quickAdd(),
      st.servers.length ? (view === 'list' ? [flatList(st), selectedBar(st), connLogCard(st)] : [el('div', { class: 'table' }, head, ...rows), connLogCard(st)]) : el('div', { class: 'card muted', text: 'Серверов пока нет. Нажми «+ Из буфера» (ссылки vless://, trojan://, hysteria2://, ss:// или подписка), «+ Вручную» или установи свои серверы на вкладке «Мои серверы».' }),
      exportBox].flat();
  }
  function toolsTab() {
    if (!S.toolsParts) serversTab();   // карточки собираются там же
    const st = S.st, warp = st.servers.filter((x) => x.proto === 'warp'), core = st.cores.find((c) => c.id === 'usque');
    const warpCard = el('div', { class: 'card' }, el('h2', { text: 'Cloudflare WARP' }),
      el('div', { class: 'note', text: 'Бесплатный выход через сеть Cloudflare: запасной вариант, когда блокируют твой сервер. Профиль появится в списке серверов.' }),
      warp.length ? el('div', { class: 'note ok', text: 'Профиль WARP уже в списке: ' + warp.map((x) => x.name).join(', ') }) : null,
      el('div', { class: 'row' },
        core && core.installed ? btn(warp.length ? 'Зарегистрировать заново' : 'Зарегистрировать WARP', () => act('warp', async () => { S.st = await api('POST', '/api/warp/register'); toast('WARP добавлен в список серверов'); }), 'primary')
          : btn('Скачать ядро WARP', () => act('ciusque', async () => { S.st = await api('POST', '/api/cores/install', { id: 'usque' }); }), 'primary'),
        core && !core.installed ? el('span', { class: 'note', text: 'Сначала нужно скачать ядро, потом зарегистрировать.' }) : null));
    const preset = el('div', { class: 'card' }, el('h2', { text: 'Сайты для быстрой проверки пинга' }),
      el('div', { class: 'note', text: 'Добавлю около 70 сайтов: те же крупные, под которые Квазар маскирует VLESS, и популярные (Google, YouTube, Telegram, Discord…). Твои сайты остаются. Лишние можно убрать в списке.' }),
      el('div', { class: 'row' }, btn('Добавить сайты', () => act('preset', async () => { const r = await api('POST', '/api/sites/preset'); S.st = r; toast(r.added ? `Добавлено сайтов: ${r.added}` : 'Все они уже в списке'); }), 'primary')));
    return [el('h1', { text: 'Инструменты' }), preset, S.toolsParts.sites, S.toolsParts.imp, warpCard];
  }
  function addSite() { act('addsite', async () => { S.st = await api('POST', '/api/sites', { host: S.siteInput }); S.siteInput = ''; }); }

  const FILTERS = [['all', 'Все'], ['vpn', 'Через VPN'], ['direct', 'Напрямую'], ['lan', 'С приставки']];
  function trafficTab() {
    const f = S.filter;
    const list = S.traffic.filter((c) => f === 'all' || (f === 'vpn' && c.out === 'proxy') || (f === 'direct' && c.out === 'direct') || (f === 'lan' && c.fromLan));
    const rows = list.map((c) => el('div', { class: 't-row cols-traffic' }, el('span', { class: 'muted cut', text: c.src + (c.fromLan ? ' (приставка)' : '') }), el('span', { class: 'cut', text: c.dst }),
      el('span', { class: c.out === 'direct' ? 'ok' : '', text: c.out === 'direct' ? 'Напрямую' : 'Через сервер' }), el('span', { class: 'num muted', text: fmtBytes(c.down + c.up) })));
    return [usageCard(S.st), el('div', { class: 'row' }, el('h1', { text: 'Трафик: откуда и куда' }), el('span', { class: 'note', text: S.st.core.running ? `Активных соединений: ${S.traffic.length}` : '' }), el('span', { class: 'grow' }), btn('Обновить', loadTraffic)),
      el('div', { class: 'row' }, FILTERS.map(([k, t]) => el('button', { type: 'button', class: 'btn ' + (f === k ? 'primary' : 'ghost'), 'aria-pressed': f === k ? 'true' : 'false', onclick: () => { S.filter = k; render(); } }, t))),
      S.st.core.running ? (rows.length ? el('div', { class: 'table' }, el('div', { class: 't-head cols-traffic' }, el('span', { text: 'Откуда' }), el('span', { text: 'Куда' }), el('span', { text: 'Маршрут' }), el('span', { text: 'Трафик' })), ...rows) : el('div', { class: 'card muted', text: 'Подходящих соединений нет.' }))
        : el('div', { class: 'card muted', text: 'Подключись к серверу, чтобы увидеть, куда идёт трафик.' }),
      el('div', { class: 'note', text: 'Заблокированная реклама в таблице не показывается: отклонённые запросы ядро не считает соединениями.' })];
  }

  function coreState(c) {
    if (c.planned) return ['в планах', 'muted'];
    if (c.job && c.job.status === 'run') return ['скачивается…', 'mid'];
    if (c.installed) return ['установлено', 'ok'];
    return [c.manual ? 'нужен файл' : 'не установлено', 'muted'];
  }
  function coresTab() {
    const cores = S.st.cores, f = S.coreForm;
    const card = (c) => {
      const [stTxt, stCls] = coreState(c);
      const addOpen = f && f.id === c.id;
      return el('div', { class: 'card' },
        el('div', { class: 'row' }, el('b', { text: c.title }), el('span', { class: 'grow' }), c.experimental ? el('span', { class: 'badge muted', text: 'экспериментально' }) : null, el('span', { class: 'badge ' + stCls, text: stTxt })),
        el('div', { class: 'note', text: c.about }), el('div', { class: 'note', text: c.protocols }),
        c.planned ? el('div', { class: 'note', text: c.planned }) : null,
        c.manual && !c.installed ? el('div', { class: 'note', text: c.manual }) : null,
        !c.planned && !c.verified ? el('div', { class: 'note', text: 'Настройки этого ядра написаны по документации и ещё не проверены на настоящем бинарнике.' }) : null,
        c.job && c.job.status !== 'run' ? el('div', { class: 'note ' + (c.job.status === 'error' ? 'bad' : 'ok'), text: c.job.status === 'error' ? 'Ошибка: ' + c.job.msg : 'Версия: ' + c.job.msg }) : null,
        c.used ? el('div', { class: 'note', text: 'Серверов с этим ядром: ' + c.used }) : null,
        el('div', { class: 'row' },
          c.canInstall && !(c.job && c.job.status === 'run') ? btn(c.installed ? 'Обновить' : 'Скачать', () => act('ci' + c.id, async () => { S.st = await api('POST', '/api/cores/install', { id: c.id }); }), c.installed ? 'ghost' : 'primary') : null,
          c.register && c.installed ? btn('Зарегистрировать WARP', () => act('warp', async () => { S.st = await api('POST', '/api/warp/register'); toast('WARP добавлен в список серверов'); }), 'primary') : null,
          c.addable && c.fields ? btn(addOpen ? 'Скрыть форму' : 'Добавить сервер', () => { S.coreForm = addOpen ? null : { id: c.id, values: {} }; render(); }, 'ghost') : null),
        addOpen ? el('div', { class: 'grid2' }, [{ key: 'name', label: 'Название (необязательно)' }, ...c.fields].map((fl) => el('div', {}, el('label', { for: 'cf-' + fl.key, text: fl.label }),
          el('input', { id: 'cf-' + fl.key, type: /pass|key|Пароль|Ключ/i.test(fl.key + fl.label) ? 'password' : 'text', value: f.values[fl.key] || '', autocomplete: 'off', oninput: (e) => { f.values[fl.key] = e.target.value; } })))) : null,
        addOpen ? btn('Добавить в список', () => act('ca' + c.id, async () => { S.st = await api('POST', '/api/cores/add', { core: c.id, values: f.values }); S.coreForm = null; toast('Сервер добавлен'); }), 'primary') : null);
    };
    return [el('h1', { text: 'Ядра и протоколы' }),
      el('div', { class: 'note', text: 'Каждое ядро запускается отдельным процессом и отдаёт Квазару локальный прокси. Дальше всё одинаково для любого ядра: TUN, маршруты, блок рекламы, трафик и пинг. Нужное ядро выбирается само по типу сервера.' }),
      el('div', { class: 'grid2' }, cores.map(card)),
      el('div', { class: 'card' }, el('b', { text: 'Не ставим: ' }), 'старые v2ray-core и Hysteria 1 (заброшены), ShadowsocksR и Brook (устарели, легко детектируются), любые ядра без открытого кода и без обновлений.')];
  }

  const ACT = { proxy: 'Через сервер', direct: 'Напрямую', block: 'Блок' }, KIND = { suffix: 'Домен и поддомены', domain: 'Только этот домен', keyword: 'Содержит слово' };
  function routesTab() {
    const rules = S.st.settings.rules, r = S.rule;
    const sel = (key, opts, label) => el('select', { 'aria-label': label, onchange: (e) => { r[key] = e.target.value; } }, Object.entries(opts).map(([k, t]) => el('option', { value: k, selected: r[key] === k ? true : null, text: t })));
    return [el('h1', { text: 'Маршруты' }),
      el('div', { class: 'note', text: 'Свои правила перебивают всё остальное: например, банк — напрямую, а какой-нибудь рекламный домен — в блок. Остальной трафик идёт через сервер.' }),
      el('div', { class: 'card' }, el('div', { class: 'grid2' }, sel('kind', KIND, 'Тип'), sel('action', ACT, 'Действие')),
        el('div', { class: 'row' }, el('div', { class: 'grow' }, el('input', { type: 'text', placeholder: 'example.com', value: r.value, 'aria-label': 'Домен', oninput: (e) => { r.value = e.target.value; } })),
          btn('Добавить правило', () => act('rule', async () => { S.st = await api('POST', '/api/rules', r); r.value = ''; }), 'primary'))),
      rules.length ? el('div', { class: 'table' }, rules.map((x) => el('div', { class: 't-row cols-rules' }, el('span', { class: 'cut', text: x.value }), el('span', { class: 'muted', text: KIND[x.kind] }),
        el('span', { class: x.action === 'block' ? 'bad' : x.action === 'direct' ? 'ok' : '', text: ACT[x.action] }),
        el('button', { class: 'btn ghost danger', type: 'button', 'aria-label': 'Удалить правило ' + x.value, onclick: () => act('rd' + x.value, async () => { S.st = await api('POST', '/api/rules/delete', { kind: x.kind, value: x.value }); }) }, '✕'))))
        : el('div', { class: 'card muted', text: 'Своих правил пока нет.' })];
  }

  function shareTab() {
    const st = S.st, on = st.settings.lan, sh = st.share || {}, f = S.shareForm || (S.shareForm = { via: sh.via || 'wifi', adapter: sh.adapter || '' });
    const run = st.core.running;
    const steps = el('ol', { class: 'steps' },
      el('li', {}, 'Подключись к серверу (пинг, выбрал протокол, «Подключить»).', run ? el('span', { class: 'ok', text: '  ✓ подключено' }) : el('span', { class: 'bad', text: '  пока не подключено' })),
      el('li', {}, 'Выбери, как приставка подключена к ПК, и нажми «Раздать». Квазар сам включит режим TUN (весь ПК через VPN), при Wi-Fi — точку доступа Windows, и раздаст через неё уже проксированный интернет.'),
      el('li', {}, 'На PS4: Настройки → Сеть → Установить соединение с Интернетом → Wi-Fi (или кабель) → «Простой». Прокси, DNS и пароли на приставке не нужны.'));
    const adapters = S.adapters || [];
    const main = el('div', { class: 'card' + (sh.on ? ' good' : '') },
      el('div', { class: 'row' }, el('h2', { text: 'Весь интернет на приставку через VPN (как в NekoBox)' }), el('span', { class: 'grow' }), sh.on ? el('span', { class: 'badge ' + (sh.waiting ? 'muted' : 'ok'), text: sh.waiting ? 'ждёт карту' : 'раздаётся' }) : null),
      !sh.supported ? el('div', { class: 'note bad', text: 'Работает только в Windows.' }) : null,
      steps,
      el('div', { class: 'row' },
        el('label', { class: 'check' }, el('input', { type: 'radio', name: 'via', checked: f.via === 'wifi' ? true : null, onchange: () => { f.via = 'wifi'; render(); } }), ' Wi-Fi от ПК (точка доступа)'),
        el('label', { class: 'check' }, el('input', { type: 'radio', name: 'via', checked: f.via === 'cable' ? true : null, onchange: () => { f.via = 'cable'; if (!S.adapters) loadAdapters(); render(); } }), ' Кабель от ПК к приставке (USB- или вторая сетевая карта)')),
      f.via === 'cable' ? el('div', { class: 'row' },
        el('select', { 'aria-label': 'Адаптер, к которому подключена приставка', onchange: (e) => { f.adapter = e.target.value; } },
          el('option', { value: '', text: adapters.length ? 'Выбери сетевой адаптер с кабелем к PS4…' : 'Список адаптеров загружается…' }),
          adapters.map((x) => el('option', { value: x.name, disabled: x.internet ? true : null, selected: f.adapter === x.name ? true : null, text: `${x.name} — ${x.desc}${x.internet ? ' (через неё ПК выходит в интернет — не подойдёт)' : x.up ? '' : ' (кабель не подключён)'}` }))),
        btn('Обновить', loadAdapters, 'ghost')) : null,
      el('div', { class: 'row' },
        sh.on ? btn('Остановить раздачу', () => act('shoff', async () => { S.st = await api('POST', '/api/share/stop'); toast('Раздача остановлена'); }), '')
          : btn(sh.busy ? 'Включаю…' : 'Раздать', () => act('shon', async () => { S.st = await api('POST', '/api/share/start', { via: f.via, adapter: f.adapter }); toast('Раздача включена'); loadIp(true); }), 'primary', { disabled: sh.busy || !sh.supported ? true : null })),
      sh.on && sh.waiting ? el('div', { class: 'note mid', text: `Жду сетевую карту «${sh.adapter}». Вставь её (и включи приставку) — раздача включится сама.` }) : null,
      f.via === 'cable' ? el('div', { class: 'note', text: 'Если USB-карты сейчас нет в списке, подключи её и нажми «Обновить». Выбранную карту Квазар запомнит и сам включит раздачу, когда она появится, даже если Windows назовёт её по-другому.' }) : null,
      sh.on && sh.ssid ? el('div', { class: 'row' }, el('span', { class: 'muted', text: 'Сеть Wi-Fi' }), el('b', { text: sh.ssid }), el('span', { class: 'muted', text: 'пароль' }), el('b', { class: 'num', text: sh.pass })) : null,
      sh.error ? el('div', { class: 'note bad', text: sh.error }) : null,
      sh.log && sh.log.length ? el('div', { class: 'log', text: sh.log.join('\n') }) : null,
      el('div', { class: 'note', text: 'Нужен запуск Квазара от имени администратора. Если VPN отключится, приставка останется без интернета, а не пойдёт мимо VPN. Игры с голосовым чатом и UDP тоже идут через сервер, если протокол умеет UDP (VLESS, Hysteria2, TUIC, Trojan, Shadowsocks — умеют).' }));
    const lan = st.lan;
    const proxy = el('div', { class: 'card' },
      el('h2', { text: 'Запасной способ: прокси для приставки' }),
      el('div', { class: 'note', text: 'Если раздача через Windows не заработает: на PS4 в настройках сети выбери «Специальный» → прокси-сервер «Использовать» и впиши адрес и порт ниже. Пароль PS4 не поддерживает, поэтому вход без пароля открыт только для домашней сети (или только для IP приставки).' }),
      el('div', { class: 'row' }, btn(on ? 'Выключить прокси' : 'Включить прокси', () => act('lan', async () => { const r = await api('POST', '/api/settings', { lan: !on, lanAuth: on ? undefined : false }); S.st = r.state; }), on ? '' : 'primary')),
      on && lan ? el('div', {},
        ...[['Адрес', lan.addresses.join(' или ') || 'адрес не найден'], ['Порт', String(lan.port)], ['Тип', 'HTTP (на PS4) или SOCKS5'], ['Пароль', lan.auth ? `логин ${lan.user}, пароль ${lan.pass}` : 'без пароля']]
          .map(([k, v]) => el('div', { class: 'row' }, el('span', { class: 'muted', text: k }), el('b', { class: 'num', text: v }))),
        el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: lan.auth ? true : null, onchange: (e) => act('la', async () => { const r = await api('POST', '/api/settings', { lanAuth: e.target.checked }); S.st = r.state; }) }), ' Требовать логин и пароль (для телефонов и ПК; PS4 так не умеет)'),
        el('div', { class: 'row' }, el('div', { class: 'grow' }, el('input', { type: 'text', id: 'lan-dev', value: lan.device, placeholder: 'IP приставки, например 192.168.1.50 (пусто — вся домашняя сеть)', 'aria-label': 'IP приставки' })),
          btn('Сохранить', () => act('ld', async () => { const r = await api('POST', '/api/settings', { lanDevice: document.getElementById('lan-dev').value }); S.st = r.state; toast('Сохранено'); }), 'ghost'))) : null);
    return [el('h1', { text: 'Раздача на приставку' }), main, proxy];
  }
  async function loadAdapters() { try { S.adapters = (await api('GET', '/api/share/adapters')).adapters; } catch (e) { S.adapters = []; toast(e.message, true); } render(); }

  function usageCard(st) {
    const u = st.usage, pct = Math.min(100, Math.round((u.month.down + u.month.up) / ((st.settings.limitGb || 200) * 1024 ** 3) * 100));
    return el('div', { class: 'card' }, el('h2', { text: 'Израсходовано' }),
      ...[['Эта сессия', u.session], ['Сегодня', u.today], ['За месяц', u.month]].map(([t, v]) => el('div', { class: 'row' }, el('span', { class: 'muted', text: t }), el('b', { class: 'num', text: fmtBytes(v.down + v.up) }))),
      el('div', { class: 'bar' }, (() => { const d = el('div'); d.style.width = pct + '%'; return d; })()),
      el('div', { class: 'note', text: `Месяц: ↓ ${fmtBytes(u.month.down)} · ↑ ${fmtBytes(u.month.up)}` }));
  }
  function skinCard(st) {
    return el('div', { class: 'card' }, el('div', { class: 'row' }, el('h2', { text: 'Скин' }), el('span', { class: 'note', text: (SKINS.find((k) => k[0] === st.settings.skin) || [])[1] })),
      el('div', { class: 'chips' }, SKINS.map(([k, name]) => el('button', { class: 'chip' + (st.settings.skin === k ? ' active' : ''), 'data-skin': k, type: 'button', 'aria-label': name, 'aria-pressed': st.settings.skin === k ? 'true' : 'false', onclick: () => setSkin(k) }))));
  }
  function prefsTab() {
    const st = S.st, set = st.settings;
    const month = (st.usage.month.down + st.usage.month.up) / 1024 ** 3;
    const sw = (label, sub, on, fn) => el('div', { class: 'switch-row' }, el('div', {}, el('div', { text: label }), el('div', { class: 'note', text: sub })),
      el('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': label, onclick: fn }));
    return [skinCard(st), usageCard(st),
      el('div', { class: 'card' }, el('h2', { text: 'Лимит трафика' }),
        el('div', { class: 'note', text: set.limitGb ? `За этот месяц израсходовано ${month.toFixed(1)} из ${set.limitGb} ГБ.` : 'Лимит не задан. Укажи, сколько гигабайт в месяц даёт твой тариф, и Квазар предупредит, когда он закончится.' }),
        el('div', { class: 'row' }, el('div', { class: 'grow' }, el('input', { type: 'number', min: 0, step: 1, placeholder: 'ГБ в месяц, 0 — без лимита', value: set.limitGb || '', 'aria-label': 'Лимит, ГБ', id: 'limit-in' })),
          btn('Сохранить', () => act('limit', async () => { const r = await api('POST', '/api/settings', { limitGb: Number(document.getElementById('limit-in').value || 0) }); S.st = r.state; toast('Лимит сохранён'); }), 'primary'))),
      el('details', { class: 'card', open: S.consoleOpen ? true : null, ontoggle: (e) => { S.consoleOpen = e.target.open; } },
        el('summary', {}, el('b', { text: 'Консоль Квазара' }), el('span', { class: 'note', text: '  всё, что раньше писалось в чёрное окно' })),
        el('div', { class: 'log console', role: 'log', text: (st.appLog || []).join('\n') || 'Пусто' }),
        el('div', { class: 'row' }, btn('Скопировать', async () => { try { await navigator.clipboard.writeText((st.appLog || []).join('\n')); toast('Скопировано'); } catch { toast('Не получилось скопировать', true); } }, 'ghost'),
          el('span', { class: 'note', text: 'Полный журнал: файл quasar.log в папке %APPDATA%\\Quasar' }))),
      el('div', { class: 'card' }, el('div', { class: 'row' }, el('div', { class: 'grow' }, el('b', { text: 'Выключить Квазар' }), el('div', { class: 'note', text: 'То же, что закрыть окно крестиком: отключит VPN и раздачу.' })),
        btn('Выйти', () => act('quit', async () => { await api('POST', '/api/quit'); document.body.textContent = 'Квазар выключен. Запустить снова — значком «Квазар» на рабочем столе.'; }), 'ghost danger'))),
      el('div', { class: 'card' }, el('h2', { text: 'Мои сайты для маскировки' }),
        el('div', { class: 'note', text: 'Эти сайты идут первыми в подсказках у протоколов и при подборе маскировки во время «Тревоги».' }),
        el('div', { class: 'row' }, el('div', { class: 'grow' }, el('input', { type: 'text', id: 'mask-in', placeholder: 'www.example.com', 'aria-label': 'Сайт для маскировки' })),
          btn('Добавить', () => act('ms', async () => { S.st = await api('POST', '/api/mask-sites', { add: document.getElementById('mask-in').value }); }), 'primary')),
        el('div', { class: 'chips' }, st.maskSites.map((h) => el('span', { class: 'chip-txt' }, h, el('button', { class: 'btn ghost danger', type: 'button', 'aria-label': 'Убрать ' + h, onclick: () => act('msr' + h, async () => { S.st = await api('POST', '/api/mask-sites', { remove: h }); }) }, '✕'))))),
      el('div', { class: 'card' }, el('h2', { text: 'Сохранённый доступ к серверам' }),
        st.access.length ? el('div', {}, st.access.map((h) => el('div', { class: 'row' }, el('span', { class: 'num', text: h }), el('span', { class: 'grow' }),
          btn('Забыть', () => act('af' + h, async () => { S.st = await api('POST', '/api/access/forget', { host: h }); }), 'ghost danger'))))
          : el('div', { class: 'note', text: 'Пока нет. Доступ сохраняется при установке сервера, если стоит галочка «Запомнить доступ».' })),
      el('div', { class: 'card' }, el('h2', { text: 'Подключение' }),
        sw('Крестик сворачивает в трей', 'окно закрывается, а Квазар и VPN продолжают работать; открыть снова или выключить совсем — значок возле часов (нужен запуск через Квазар.exe)', !!set.trayKeep, () => act('tk', async () => { const r = await api('POST', '/api/settings', { trayKeep: !set.trayKeep }); S.st = r.state; })),
        sw('Автопереключение протокола', 'если через выбранный протокол ничего не открывается, Квазар сам попробует другие протоколы этого сервера (сначала TCP)', set.autoFallback !== false, () => act('af2', async () => { const r = await api('POST', '/api/settings', { autoFallback: !(set.autoFallback !== false) }); S.st = r.state; }))),
      el('div', { class: 'card' }, el('h2', { text: 'Блок рекламы' }),
        sw('Блок рекламы', 'базовый список из 24 доменов', set.adblock, () => act('ad', async () => { const r = await api('POST', '/api/settings', { adblock: !set.adblock }); S.st = r.state; })),
        sw('Большой список (около 100 тысяч доменов)', 'ядро скачивает его само через сервер и обновляет раз в неделю', set.bigAds, () => act('bigads', async () => { const r = await api('POST', '/api/settings', { bigAds: !set.bigAds }); S.st = r.state; })))];
  }

  function mineTab() {
    const st = S.st, own = groupsOf(st).filter((g) => st.own.includes(g.host));
    const cards = own.map((g) => {
      const cur = st.core.running && g.list.some((x) => x.id === st.core.itemId), gp = groupPing(g), saved = st.access.includes(g.host);
      const isOpen = S.mineOpen[g.host] !== undefined ? S.mineOpen[g.host] : !!(S.un && S.un.host === g.host);
      return el('div', { class: 'card' + (cur ? ' good' : '') },
        el('div', { class: 'row' },
          el('button', { class: 'twist', type: 'button', 'aria-expanded': isOpen ? 'true' : 'false', 'aria-label': (isOpen ? 'Свернуть ' : 'Развернуть ') + g.name, onclick: () => { S.mineOpen[g.host] = !isOpen; render(); } }, isOpen ? '▾' : '▸'),
          isOpen ? renameBox(g.host, g.name, 'hid', true) : el('b', { class: 'cut', text: g.name }), el('span', { class: 'muted num', text: g.host }), el('span', { class: 'muted', text: plural(g.list.length, ['протокол', 'протокола', 'протоколов']) }),
          el('span', { class: 'num ' + pingCls(gp && gp.ms), text: pingTxt(gp) }), el('span', { class: 'grow' }),
          cur ? btn('Выключить', () => act('dc', disconnect), '', { title: 'Отключиться от этого сервера' }) : btn('Включить', () => act('cg' + g.host, () => connect(bestOf(g).id)), 'primary', { title: 'Работает один сервер за раз: включение этого отключит текущий' })),
        isOpen ? el('div', { class: 'row' }, saved ? el('span', { class: 'badge muted', text: 'доступ сохранён', title: 'Для «Тревоги» и смены маскировки на сервере' }) : null, el('span', { class: 'grow' }),
          btn('Пинг', () => act('pg' + g.host, async () => { S.st = await api('POST', '/api/ping', { ids: g.list.map((x) => x.id), mode: S.pingMode }); })),
          btn('Пинг по URL', () => act('pgu' + g.host, async () => { S.st = await api('POST', '/api/ping', { ids: g.list.map((x) => x.id), mode: 'url' }); }), '', { title: 'Настоящая задержка до сайта сквозь каждый протокол этого сервера' }),
          btn('Ссылка', () => act('ex' + g.host, async () => { const r = await api('POST', '/api/export', { host: g.host }); S.exportLink = r.link; S.exportNote = `Сервер «${g.name}»`; })),
          btn('Проверить порты', () => act('pc' + g.host, async () => { S.portRes[g.host] = await api('POST', '/api/ports-check', { host: g.host }); }), '', { title: 'Какие порты сервера открыты снаружи' }),
          btn('Удалить с сервера', () => { S.un = S.un && S.un.host === g.host ? null : { host: g.host, pw: '', warp: false }; render.lock = false; render(); }, 'ghost danger', { title: 'Снять с сервера то, что поставил Квазар; твои панели и программы не трогаются' }),
          btn('Переустановить', () => { const r = S.rows[0] && !S.rows[0].host ? S.rows[0] : (S.rows.push(newRow()), S.rows[S.rows.length - 1]); Object.assign(r, { name: g.name, host: g.host, remember: true, portMode: 'common' }); render(); window.scrollTo(0, document.body.scrollHeight); document.getElementById('main').scrollTo(0, 1e6); toast('Данные сервера подставлены ниже: впиши пароль и нажми «Установить»'); }, 'ghost')) : null,
        isOpen && S.un && S.un.host === g.host ? el('div', { class: 'card inner alert' },
          el('b', { text: 'Снять с сервера ' + g.name + '?' }),
          el('div', { class: 'note', text: 'Будут остановлены и удалены только службы Квазара (quasar-*) и папки /opt/quasar*, /etc/quasar, /var/lib/quasar; закрыты открытые для них порты, если их больше никто не слушает. Твои панели (3x-ui и др.), сайты, Node.js, nginx и остальные программы не трогаются. Профили этого сервера уберутся из списка.' }),
          st.access.includes(g.host) ? el('div', { class: 'note ok', text: 'Доступ сохранён: пароль вводить не нужно.' })
            : el('div', {}, el('label', { for: 'un-pw', text: 'Пароль root от сервера' }), el('input', { id: 'un-pw', type: 'password', value: S.un.pw, autocomplete: 'off', oninput: (e) => { S.un.pw = e.target.value; } })),
          el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: S.un.warp ? true : null, onchange: (e) => { S.un.warp = e.target.checked; } }), ' Заходить через WARP (если сервер напрямую недоступен)'),
          el('div', { class: 'row' }, btn('Да, снять с сервера', () => act('un' + g.host, async () => { const u = S.un; S.st = await api('POST', '/api/uninstall', { host: g.host, password: u.pw || undefined, useWarp: !!u.warp }); S.un = null; S.maintHide = ''; }), 'danger', { disabled: st.maint.running ? true : null }), btn('Отмена', () => { S.un = null; render(); }, 'ghost'))) : null,
        isOpen && S.portRes[g.host] ? el('div', { class: 'card inner' }, el('div', { class: 'note', text: S.portRes[g.host].verdict }),
          el('div', { class: 'row' }, S.portRes[g.host].rows.map((r) => el('span', { class: 'badge ' + (r.ok === true ? 'ok' : r.ok === false ? 'bad' : 'muted'), title: r.name, text: `${r.port}/${r.kind} ${r.ok === true ? 'открыт' : r.ok === false ? 'закрыт' : 'UDP: не проверить'}` })))) : null,
        isOpen ? el('div', { class: 'table' }, g.list.map((x) => el('div', { class: 't-row cols-proto' + (st.core.running && st.core.itemId === x.id ? ' sel' : '') },
          el('span', { class: 'cut', text: protoName(x) }), portEditor(st, x), maskCellOf(st, x), el('span', { class: 'num ' + pingCls(x.ping && x.ping.ms), text: pingTxt(x.ping), title: pingTip(x.ping) }),
          el('span', { class: 'acts' }, btn('Пинг', () => act('p1' + x.id, async () => { S.st = await api('POST', '/api/ping', { ids: [x.id], mode: S.pingMode }); }), 'ghost'), btn('URL', () => act('pu' + x.id, async () => { S.st = await api('POST', '/api/ping', { ids: [x.id], mode: 'url' }); }), 'ghost', { title: 'Пинг по URL через этот протокол' }), st.core.running && st.core.itemId === x.id ? btn('Стоп', () => act('dc', disconnect), 'ghost danger') : btn('Пуск', () => act('c' + x.id, () => connect(x.id)), 'ghost'))))) : null);
    });
    const exportBox = S.exportLink ? el('div', { class: 'card' }, el('div', { class: 'row' }, el('h2', { text: 'Единая ссылка' }), el('span', { class: 'note', text: S.exportNote }), el('span', { class: 'grow' }), btn('Закрыть', () => { S.exportLink = ''; render(); }, 'ghost')),
      el('textarea', { readonly: true, 'aria-label': 'Единая ссылка' }, S.exportLink), el('div', { class: 'note', text: 'В ссылке лежат ключи доступа: передавай её только тем, кому доверяешь.' })) : null;
    return [el('div', { class: 'row' }, el('h1', { text: 'Мои серверы' }), el('span', { class: 'note', text: own.length ? `поставлено Квазаром: ${own.length}` : '' })),
      el('datalist', { id: 'mask-list' }, [...st.maskSites, ...MASKS].map((v) => el('option', { value: v }))),
      maintCard(st), exportBox, ...(cards.length ? cards : [el('div', { class: 'card muted', text: 'Серверов, поставленных Квазаром, пока нет. Заполни форму ниже: Квазар зайдёт по SSH и поставит все протоколы. Готовые ссылки добавляются на вкладке «Серверы».' })]),
      el('h2', { text: 'Установить на новый сервер' }), ...installTab().slice(1)];
  }

  const STATUS = { wait: ['ожидает', 'muted'], run: ['устанавливается…', 'mid'], ok: ['готово', 'ok'], error: ['ошибка', 'bad'] };
  function installTab() {
    const d = S.st.deploy, rows = S.rows, free = 20 - groupsOf(S.st).length;
    const field = (r, i, key, label, type, ph) => el('div', {}, el('label', { for: `r${i}-${key}`, text: label }),
      el('input', { id: `r${i}-${key}`, type, placeholder: ph || '', value: r[key], autocomplete: key === 'password' ? 'off' : 'on', 'aria-label': `${label}, сервер ${i + 1}`, oninput: (e) => { r[key] = e.target.value; } }));
    const payload = (r) => ({ name: r.name, host: r.host, port: Number(r.port), username: r.username, password: r.password, domain: r.domain, portMode: r.portMode, basePort: r.portMode === 'base' ? Number(r.basePort) : undefined, realitySni: r.realitySni.trim() || undefined, remember: !!r.remember, useWarp: !!r.warp });
    const launch = (idx) => act('deploy', async () => {
      const pick = idx.map((i) => rows[i]); pick.forEach((r) => { r.sent = true; });
      try { S.st = await api('POST', '/api/deploy', { servers: pick.map(payload) }); } catch (e) { pick.forEach((r) => { r.sent = false; }); throw e; }
    });
    const forms = rows.map((r, i) => el('div', { class: 'card inner' },
      el('div', { class: 'row' }, el('b', { text: 'Сервер ' + (i + 1) + (r.host ? ' · ' + (r.name || r.host) : '') }), el('span', { class: 'grow' }),
        btn(d.running ? 'Идёт установка…' : 'Установить только этот', () => launch([i]), 'primary', { disabled: d.running || !r.host.trim() ? true : null, title: 'Остальные серверы из списка ниже не затрагиваются' }),
        rows.length > 1 ? btn('Убрать', () => { rows.splice(i, 1); render(); }, 'ghost danger', { 'aria-label': 'Убрать сервер ' + (i + 1) }) : null),
      el('div', { class: 'grid2' }, field(r, i, 'name', 'Название', 'text', 'Нидерланды'), field(r, i, 'host', 'IP или адрес', 'text', '203.0.113.5'), field(r, i, 'port', 'Порт SSH', 'number', '22'),
        field(r, i, 'username', 'Пользователь', 'text', 'root'), field(r, i, 'password', 'Пароль', 'password'), field(r, i, 'domain', 'Домен (необязательно)', 'text', 'vpn.example.com'),
        el('div', {}, el('label', { for: `r${i}-pm`, text: 'Порты протоколов' }),
          el('select', { id: `r${i}-pm`, onchange: (e) => { r.portMode = e.target.value; render(); } },
            [['default', 'Стандартные (443, 8443, 8444…)'], ['common', 'Ходовые (443, 8443, 2053… — если часть портов закрыта)'], ['base', 'Подряд с моего порта'], ['random', 'Случайные высокие']].map(([k, t]) => el('option', { value: k, selected: r.portMode === k ? true : null, text: t })))),
        r.portMode === 'base' ? field(r, i, 'basePort', 'Начальный порт (займёт 20 подряд)', 'number', '54121') : null,
        field(r, i, 'realitySni', 'Сайт маскировки VLESS', 'text', 'авто: проверю и выберу сам')),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: r.warp ? true : null, onchange: (e) => { r.warp = e.target.checked; render.lock = false; render(); } }),
        ' Заходить на сервер через WARP (включи, если IP сервера заблокирован у тебя и напрямую по SSH не пускает; WARP должен быть настроен в «Инструментах»)'),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: r.remember ? true : null, onchange: (e) => { r.remember = e.target.checked; } }),
        ' Запомнить доступ для «Тревоги» и смены маскировки (пароль хранится зашифрованным средствами Windows, расшифровать может только твоя учётная запись)'),
      r.portMode === 'base' && Number(r.basePort) >= 1024 ? el('div', { class: 'note', text: `Порты: ${Number(r.basePort)}–${Number(r.basePort) + 16}. Порт 80 всё равно нужен Let's Encrypt для NaiveProxy.` }) : null,
      r.portMode === 'common' ? el('div', { class: 'note', text: 'TCP: VLESS 443, AnyTLS 2053, Trojan 2083, HTTPS-прокси 8080, Shadowsocks 8880. UDP: Hysteria2 8443, TUIC 443. Такие порты хостеры и провайдеры закрывают реже всего.' }) : null,
      r.portMode === 'random' ? el('div', { class: 'note', text: 'Каждому протоколу свой случайный порт от 20000 до 60999; какие именно, будет видно в списке серверов.' }) : null));
    const canAdd = rows.length < Math.min(10, free);
    const status = d.servers.length ? el('div', { class: 'card' }, el('h2', { text: d.running ? 'Идёт установка' : 'Результат установки' }),
      d.servers.map((x) => el('details', { class: 'dep', open: (S.depOpen[x.host] !== undefined ? S.depOpen[x.host] : x.status === 'error' || x.status === 'run') ? true : null, ontoggle: (e) => { S.depOpen[x.host] = e.target.open; } },
        el('summary', {}, el('b', { text: x.name }), el('span', { class: 'muted', text: '  ' + x.host + '  ' }), el('span', { class: STATUS[x.status][1], text: STATUS[x.status][0] }), x.error ? el('span', { class: 'bad', text: ' — ' + x.error }) : null),
        el('div', { class: 'log', 'data-log': 'dep-' + x.host, role: 'log', text: x.logs.join('\n') || 'Пока тихо…' }),
        x.status === 'error' && rows.some((r) => r.host.trim() === x.host && !r.warp) ? el('div', { class: 'row' }, btn('Повторить через WARP', () => { const i = rows.findIndex((r) => r.host.trim() === x.host); if (i >= 0) { rows[i].warp = true; launch([i]); } }, '', { disabled: d.running ? true : null, title: 'Включит WARP и зайдёт на сервер по SSH через него' }), el('span', { class: 'note', text: 'Если провайдер закрыл доступ к IP сервера, через WARP он часто открывается.' })) : null,
        x.link ? el('div', { class: 'row' }, btn('Скопировать ссылку сервера', async () => { try { await navigator.clipboard.writeText(x.link); toast('Ссылка скопирована'); } catch { toast('Не получилось скопировать', true); } }, 'ghost')) : null)),
      d.link ? el('div', {}, el('label', { text: 'Одна ссылка на все установленные серверы (они уже в списке)' }), el('textarea', { readonly: true, 'aria-label': 'Единая ссылка' }, d.link),
        btn('Скопировать', async () => { try { await navigator.clipboard.writeText(d.link); toast('Ссылка скопирована'); } catch { toast('Не получилось скопировать', true); } })) : null) : null;
    return [el('div', { class: 'row' }, el('h1', { text: 'Свои серверы' }), el('span', { class: 'note', text: `можно добавить ещё ${Math.max(0, free)} (всего до 20)` })),
      el('div', { class: 'card' },
        el('div', { class: 'note', text: 'Квазар зайдёт на каждый сервер по SSH, поставит разом все протоколы: VLESS Reality, Hysteria2, TUIC, AnyTLS, Trojan, HTTPS-прокси, Shadowsocks 2022, ShadowTLS, VLESS XHTTP, Sudoku, ShadowQUIC, NaiveProxy (домен и сертификат найдёт сам), Фотон и Antohin, и выдаст одну ссылку на всё. За один раз можно до 10 серверов, ставятся по три одновременно. Пароли нигде не сохраняются. Подходит чистый Linux-сервер (Debian, Ubuntu и т. п.) с systemd.' }),
        ...forms,
        el('div', { class: 'row' },
          btn('+ Ещё сервер', () => { rows.push(newRow()); render(); }, '', { disabled: !canAdd }),
          rows.length > 1 ? btn(d.running ? 'Идёт установка…' : 'Установить все ' + rows.length, () => launch(rows.map((_, i) => i)), '', { disabled: d.running || rows.some((r) => !r.host.trim()) ? true : null, title: 'Все серверы из списка сразу. Чтобы поставить один, нажми «Установить только этот» в его карточке' }) : null,
          el('span', { class: 'note', text: 'Каждый сервер ставится сам по себе: уже установленные не трогаются. Пароль хранится только в окне и стирается, когда установка прошла.' }))),
      status];
  }

  function logTab() {
    return [el('div', { class: 'row' }, el('h1', { text: 'Журнал ядра' })), el('div', { class: 'log', text: S.st.core.logs.join('\n') || 'Пусто' })];
  }

  // «Пинг до игры»: найденные программы с активным трафиком через туннель; кнопка замеряет задержку до их адреса сквозь каждый протокол
  function gamesCard(st) {
    const g = S.games;
    if (!g) return null;
    const fmt = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' МБ' : Math.max(1, Math.round(b / 1024)) + ' КБ');
    if (!g.running) return el('div', { class: 'card muted' }, 'Квазар не подключён: подключись к любому протоколу, запусти игру и нажми «Найти игру» ещё раз.', btn('Закрыть', () => { S.games = null; render(); }, 'ghost'));
    if (!g.apps.length) return el('div', { class: 'card muted' }, 'Пока ничего не идёт через туннель. Запусти игру, зайди в матч или лобби и нажми «Найти игру» ещё раз.', btn('Закрыть', () => { S.games = null; render(); }, 'ghost'));
    return el('div', { class: 'card' },
      el('div', { class: 'row' }, el('b', { text: 'Что сейчас идёт через туннель' }), el('span', { class: 'grow' }), btn('Закрыть', () => { S.games = null; render(); }, 'ghost')),
      el('div', { class: 'muted', text: 'Выбери игру: Квазар замерит задержку до адреса, к которому она подключена, через каждый протокол. Результат появится в колонке пинга.' }),
      g.apps.map((a) => el('div', { class: 'row' },
        el('span', { class: 'cut', text: (a.game ? '🎮 ' : '') + a.app }),
        el('span', { class: 'muted num', text: `${a.target.ip}:${a.target.port} · ${a.target.net.toUpperCase()} · ${fmt(a.bytes)}` }),
        el('span', { class: 'grow' }),
        btn('Пинг до неё', () => act('pg' + a.app, async () => { S.st = await api('POST', '/api/ping', { mode: 'game', game: { ...a.target, app: a.app } }); S.sort = { key: 'ping', dir: 1 }; }), 'primary', { title: 'Замерить задержку до этого адреса через каждый протокол' }))));
  }
  // Шкала «пинг идёт»: 0–100%, чтобы было видно, что проверка не зависла
  function pingBar(st) {
    const p = st.pingProg || {};
    if (!p.running && Date.now() > S.pingUntil) return null;
    const pct = p.total ? Math.round(100 * Math.min(p.done, p.total) / p.total) : 100;
    const fill = el('span', { class: 'fill' }); fill.style.width = pct + '%';
    return el('span', { class: 'pbar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), title: `Проверено ${Math.min(p.done, p.total)} из ${p.total}` }, fill, el('span', { class: 'txt', text: (p.running ? 'Пинг ' : 'Готово ') + pct + '%' }));
  }
  function renderRight() {
    const st = S.st, run = st.core.running, gs = groupsOf(st);
    const sel = selectedOf(st);
    const tick = (label, on, fn, title) => el('label', { class: 'tick', title }, el('input', { type: 'checkbox', checked: on ? true : null, onchange: fn }), el('span', { text: label }));
    const items = [
      run && sel && sel.id !== st.core.itemId ? btn('Переключить на «' + (sel.name.length > 22 ? sel.name.slice(0, 21) + '…' : sel.name) + '»', () => act('c' + sel.id, () => connect(sel.id, st)), 'primary', { title: 'Прежнее подключение отключится само' }) : null,
      run ? btn('Отключить', () => act('dc', disconnect), sel && sel.id !== st.core.itemId ? '' : 'primary')
        : gs.length > 1 && !sel ? btn('Подключить лучший', () => act('best', async () => { const r = await api('POST', '/api/best'); S.st = r; toast(`Подключено к самому быстрому: ${r.chosen.ms} мс`); loadIp(true); }), 'primary')
          : btn(sel ? 'Подключить' : 'Нет серверов', () => sel && act('c', () => connect(sel.id)), 'primary', { disabled: !sel }),
      gs.length > 1 ? btn('Лучший', () => act('best', async () => { const r = await api('POST', '/api/best'); S.st = r; toast(`Подключено к самому быстрому: ${r.chosen.ms} мс`); loadIp(true); }), '', { title: 'Замерить все серверы и подключиться к самому быстрому' }) : null,
      st.servers.length ? btn(st.maint.running && st.maint.kind === 'alarm' ? 'Тревога: перебираю…' : 'Тревога', () => act('alarm', async () => { S.st = await api('POST', '/api/alarm'); S.tab = 'servers'; S.maintHide = ''; }), 'alarm', { disabled: st.maint.running ? true : null, title: 'Блокировка: перебрать все протоколы и серверы, при необходимости сменить на сервере маскировку и порты, а в крайнем случае включить WARP' }) : null,
      pingBar(st),
      el('span', { class: 'grow' }),
      st.admin === false ? el('span', { class: 'adm' }, el('span', { class: 'mid', text: 'Нет прав администратора' }),
        st.canElevate ? btn('Перезапустить от администратора', () => act('elev', async () => { await api('POST', '/api/elevate'); document.body.textContent = 'Перезапускаю Квазар… Нажми «Да» в окне Windows. Если окно не появилось за несколько секунд — запусти Квазар.exe правой кнопкой → «Запуск от имени администратора».'; }), '', { title: 'Нужны для режима TUN и раздачи на приставку' }) : null) : null,
      tick('Системный прокси', st.settings.sysproxy, () => act('sp', async () => { const r = await api('POST', '/api/settings', { sysproxy: !st.settings.sysproxy }); S.st = r.state; }), 'Windows сам направит программы в Квазар'),
      tick('Режим TUN', st.settings.tun, () => act('tun', async () => {
        if (!st.settings.tun && st.admin === false) { toast('Для режима TUN нужны права администратора: нажми «Перезапустить от администратора» вверху', true); return; }
        const r = await api('POST', '/api/settings', { tun: !st.settings.tun }); S.st = r.state; if (r.state.core.running) loadIp(true);
      }), 'Весь компьютер через VPN (нужны права администратора)'),
    ];
    document.getElementById('bar').replaceChildren(...items.filter(Boolean));
  }

  async function connect(id, st0) { const was = (st0 || S.st).core.running; S.st = await api('POST', '/api/connect', { id }); toast(was ? 'Переключено на выбранный профиль' : 'Подключено'); loadIp(true); }
  async function disconnect() { S.st = await api('POST', '/api/disconnect'); S.ip = null; loadIp(true); toast('Отключено'); }
  async function setSkin(k) { document.documentElement.dataset.skin = k; try { const r = await api('POST', '/api/settings', { skin: k }); S.st = r.state; render(); } catch (e) { toast(e.message, true); } }
  async function loadTraffic() { try { S.traffic = (await api('GET', '/api/traffic')).connections; } catch { S.traffic = []; } render(); }
  async function loadIp(force) { try { S.ip = await api('GET', '/api/ip'); render(); } catch { /* сеть недоступна */ } if (force) return; }

  function render() {
    if (!S.st) return;
    // Не перерисовываем, пока человек печатает в поле — иначе пропадёт фокус.
    const a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && a.dataset.keep !== 'no' && render.lock) return;
    document.documentElement.dataset.skin = S.st.settings.skin;
    renderStatus(); renderNav(); renderRight();
    const main = document.getElementById('main');
    const tab = { servers: serversTab, traffic: trafficTab, cores: coresTab, routes: routesTab, share: shareTab, mine: mineTab, tools: toolsTab, log: logTab, prefs: prefsTab }[S.tab];
    const su = S.st.setup || {}, run = [su.singbox, su.ssh2].filter((x) => x && x.status !== 'ok');
    const banner = run.length ? el('div', { class: 'card ' + (run.some((x) => x.status === 'error') ? 'alert' : '') }, el('b', { text: 'Первый запуск' }),
      ...run.map((x) => el('div', { class: 'note ' + (x.status === 'error' ? 'bad' : 'mid'), text: (x.status === 'error' ? 'Ошибка: ' : '') + x.msg }))) : null;
    // журналы: записи идут сверху вниз и не стираются; прокрутку не сбрасываем, а если человек был внизу — идём за новыми строками
    document.querySelectorAll('[data-log]').forEach((l) => { S.logPos[l.dataset.log] = { top: l.scrollTop, bottom: l.scrollHeight - l.clientHeight - l.scrollTop < 8 }; });
    const keep = S.lastTab === S.tab ? main.scrollTop : 0; S.lastTab = S.tab;
    main.replaceChildren(...[banner, ...tab()].filter(Boolean));
    document.querySelectorAll('[data-log]').forEach((l) => { const p = S.logPos[l.dataset.log]; l.scrollTop = !p || p.bottom ? l.scrollHeight : p.top; });
    main.scrollTop = keep;   // список не прыгает наверх при каждой перерисовке
  }

  function cleanRows() {
    const d = S.st && S.st.deploy; if (!d || d.running) return;
    for (let i = S.rows.length - 1; i >= 0; i--) {
      const r = S.rows[i]; if (!r.sent) continue;
      const x = d.servers.find((y) => y.host === r.host.trim()); if (!x) continue;
      if (x.status === 'ok') { if (S.rows.length > 1) S.rows.splice(i, 1); else S.rows[i] = newRow(); }
      else if (x.status === 'error') r.sent = false;   // строка остаётся: можно поправить и повторить (в том числе через WARP)
    }
  }
  async function refresh() {
    try { S.st = await api('GET', '/api/state'); cleanRows(); render(); } catch (e) { if (!/токен/i.test(e.message)) console.error('refresh: ' + (e && e.stack || e)); if (/токен/i.test(e.message)) document.getElementById('main').textContent = 'Открой Квазар через start.bat: ссылка с токеном нужна для защиты.'; }
  }
  // Автообновление: журнал, установка и счётчики; печать в полях не прерываем.
  document.addEventListener('focusin', (e) => { render.lock = /^(INPUT|TEXTAREA)$/.test(e.target.tagName); });
  document.addEventListener('focusout', () => { render.lock = false; });
  setInterval(refresh, 3000);
  setInterval(() => { if (S.tab === 'traffic' && S.st && S.st.core.running) loadTraffic(); }, 4000);
  // Закрыли окно крестиком — Квазар выключается целиком (обновление страницы этим не считается: окно вернётся за секунду)
  window.addEventListener('pagehide', () => { try { navigator.sendBeacon('/api/bye', new Blob([JSON.stringify({ t: token || "" })], { type: 'text/plain' })); } catch { /* окно уже закрыто */ } });
  refresh().then(() => loadIp());
})();
