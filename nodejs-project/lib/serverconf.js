'use strict';
// План сервера: секреты, конфиг sing-box со всеми протоколами и готовые ссылки для клиента.
const crypto = require('crypto');
const { b64u } = require('./links');

const DEFAULT_PORTS = { vless: 443, hysteria2: 8443, tuic: 8444, anytls: 8445, trojan: 8446, shadowsocks: 8388, shadowtls: 8447, http: 8448, photon: 8449, xhttp: 8450, naive: 8451, sudoku: 8452, shadowquic: 8453, antohin: 8454, mieru: 8455, juicity: 8456, brook: 8457, restls: 8458, snell: 8459, tlsmirror: 8460 };

// «Ходовые» порты: их чаще всего оставляют открытыми хостеры и провайдеры (443, 8443, порты Cloudflare, 8080).
// Hysteria2 и TUIC — UDP, VLESS — TCP: один и тот же номер у TCP и UDP не мешает друг другу.
const COMMON_PORTS = { vless: 443, hysteria2: 8443, tuic: 443, anytls: 2053, trojan: 2083, shadowtls: 2096, http: 8080, shadowsocks: 8880, photon: 2052, xhttp: 2087, naive: 2095, sudoku: 2082, shadowquic: 2086, antohin: 2054, mieru: 2081, juicity: 2089, brook: 8843, restls: 2091, snell: 2092, tlsmirror: 2097 };

// Порядок, в котором протоколы занимают порты подряд от начального
const PORT_ORDER = ['vless', 'hysteria2', 'tuic', 'anytls', 'trojan', 'shadowtls', 'http', 'shadowsocks', 'photon', 'xhttp', 'naive', 'sudoku', 'shadowquic', 'antohin', 'mieru', 'juicity', 'brook', 'restls', 'snell', 'tlsmirror'];

/** mode: 'default' — стандартные; 'base' — подряд с base (например 54121, 54122, …); 'random' — случайные высокие, все разные */
function portsFor(mode, base, rand = (n) => crypto.randomBytes(n)) {
  if (!mode || mode === 'default') return { ...DEFAULT_PORTS };
  if (mode === 'common') return { ...COMMON_PORTS };
  if (mode === 'base') {
    const b = Number(base);
    if (!Number.isInteger(b) || b < 1024 || b + PORT_ORDER.length - 1 > 65535) throw new Error(`Начальный порт: число от 1024 до ${65535 - PORT_ORDER.length + 1}`);
    return Object.fromEntries(PORT_ORDER.map((k, i) => [k, b + i]));
  }
  if (mode === 'random') {
    const used = new Set(), out = {};
    for (const k of PORT_ORDER) { let p; do { p = 20000 + (rand(2).readUInt16BE(0) % 41000); } while (used.has(p)); used.add(p); out[k] = p; }
    return out;
  }
  throw new Error('Неизвестный режим портов');
}

function genReality() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return { privateKey: b64u(priv), publicKey: b64u(pub) };
}

function uuidFrom(bytes) {
  const b = Buffer.from(bytes);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const NETS = { hysteria2: ['udp'], tuic: ['udp'], shadowquic: ['udp'], juicity: ['udp'], shadowsocks: ['tcp', 'udp'], naive: ['tcp', 'udp'] };
function checkPorts(ports) {
  const seen = new Map();
  for (const [k, v] of Object.entries(ports)) {
    if (!Number.isInteger(v) || v < 1 || v > 65535) throw new Error(`Неверный порт для ${k}: ${v}`);
    // один и тот же номер могут занимать только TCP- и UDP-протокол (например VLESS по TCP и TUIC по UDP)
    for (const n of NETS[k] || ['tcp']) {
      const key = n + '/' + v;
      if (seen.has(key)) throw new Error(`Порт ${v} (${n.toUpperCase()}) указан дважды (${seen.get(key)} и ${k})`);
      seen.set(key, k);
    }
  }
}

/**
 * opts: { host, name?, domain?, email?, ports?, realitySni?, realityCandidates?, shadowtlsSni?, certSni?, hy2Obfs?, rand? }
 * Без domain используется самоподписанный сертификат: клиентам нужно доверять отпечатку (см. pin).
 */
function buildServerPlan(opts) {
  if (!opts || !opts.host) throw new Error('Не указан адрес сервера');
  const rand = opts.rand || ((n) => crypto.randomBytes(n));
  const ports = { ...DEFAULT_PORTS, ...(opts.ports || {}) };
  checkPorts(ports);
  const name = opts.name || 'Квазар';
  const domain = opts.domain || '';
  // Сайт маскировки выбирает сам сервер при установке (см. script.js); в конфиг идёт заглушка
  const R = require('./reality');
  const realityCandidates = opts.realityForce && opts.realitySni ? R.cleanList([opts.realitySni]) : R.cleanList([opts.realitySni, ...(opts.realityCandidates || R.REALITY_CANDIDATES)]);
  if (!realityCandidates.length) throw new Error('Нет ни одного сайта для маскировки VLESS');
  const realitySni = realityCandidates[0];
  const realityTimings = {};   // пинг от компьютера пользователя до каждого сайта: при выборе учитывается вместе с пингом от сервера
  for (const [h, ms] of Object.entries(opts.realityTimings || {})) if (realityCandidates.includes(h) && Number.isFinite(ms)) realityTimings[h] = Math.max(0, Math.min(5000, Math.round(ms)));
  const RS = '__QUASAR_REALITY__';
  const stSni = opts.shadowtlsSni || 'www.apple.com';
  const certSni = domain || opts.certSni || 'www.bing.com';
  const insecure = !domain;

  const reality = genReality();
  const s = {
    uuid: uuidFrom(rand(16)),
    tuicUuid: uuidFrom(rand(16)),
    shortId: rand(8).toString('hex'),
    shortIdTr: rand(8).toString('hex'),
    shortIdAt: rand(8).toString('hex'),
    hy2: b64u(rand(18)),
    hy2Obfs: opts.hy2Obfs ? b64u(rand(18)) : '',
    tuic: b64u(rand(18)),
    anytls: b64u(rand(18)),
    trojan: b64u(rand(18)),
    ssKey: rand(16).toString('base64'),        // 2022-blake3-aes-128-gcm: ключ ровно 16 байт
    httpPass: b64u(rand(18)),
    stPass: b64u(rand(18)),
    stSsKey: rand(16).toString('base64'),
    reality,
  };

  const tls = (alpn) => {
    const t = domain
      ? { enabled: true, server_name: domain, acme: { domain: [domain], email: opts.email || undefined, data_directory: '/var/lib/quasar/acme' } }
      : { enabled: true, server_name: certSni, certificate_path: '/etc/quasar/cert.pem', key_path: '/etc/quasar/key.pem' };
    if (alpn) t.alpn = alpn;
    return t;
  };

  // Trojan и AnyTLS прячутся за Reality, как VLESS: тому, кто сам постучится на порт (активная проверка DPI),
  // отвечает настоящий сайт с настоящим сертификатом, а не самодельный сертификат «www.bing.com», который выдаёт подмену.
  // Снаружи — Chrome, TLS 1.3, обмен ключами X25519 + ML-KEM-768 (постквантовый).
  const realityTls = (sid) => ({ enabled: true, server_name: RS, reality: { enabled: true, handshake: { server: RS, server_port: 443 }, private_key: reality.privateKey, short_id: [sid] } });
  const inbounds = [
    { type: 'vless', tag: 'vless-reality', listen: '::', listen_port: ports.vless,
      users: [{ name: 'quasar', uuid: s.uuid, flow: 'xtls-rprx-vision' }],
      tls: { enabled: true, server_name: RS, reality: { enabled: true, handshake: { server: RS, server_port: 443 }, private_key: reality.privateKey, short_id: [s.shortId] } } },
    { type: 'hysteria2', tag: 'hysteria2', listen: '::', listen_port: ports.hysteria2,
      users: [{ name: 'quasar', password: s.hy2 }],
      ...(s.hy2Obfs ? { obfs: { type: 'salamander', password: s.hy2Obfs } } : {}),
      tls: tls(['h3']) },
    { type: 'tuic', tag: 'tuic', listen: '::', listen_port: ports.tuic,
      users: [{ name: 'quasar', uuid: s.tuicUuid, password: s.tuic }], congestion_control: 'bbr', tls: tls(['h3']) },
    { type: 'anytls', tag: 'anytls', listen: '::', listen_port: ports.anytls,
      users: [{ name: 'quasar', password: s.anytls }], tls: realityTls(s.shortIdAt) },
    { type: 'trojan', tag: 'trojan', listen: '::', listen_port: ports.trojan,
      users: [{ name: 'quasar', password: s.trojan }], tls: realityTls(s.shortIdTr) },
    // HTTPS-прокси: обычный HTTP-прокси внутри TLS, с логином и паролем (открытый HTTP по сети с паролем был бы виден всем)
    { type: 'http', tag: 'http-tls', listen: '::', listen_port: ports.http,
      users: [{ username: 'quasar', password: s.httpPass }], tls: tls() },
    { type: 'shadowsocks', tag: 'ss2022', listen: '::', listen_port: ports.shadowsocks,
      method: '2022-blake3-aes-128-gcm', password: s.ssKey },
    { type: 'shadowtls', tag: 'shadowtls', listen: '::', listen_port: ports.shadowtls, version: 3,
      users: [{ name: 'quasar', password: s.stPass }], handshake: { server: stSni, server_port: 443 }, strict_mode: true, detour: 'ss-behind-shadowtls' },
    { type: 'shadowsocks', tag: 'ss-behind-shadowtls', listen: '127.0.0.1', network: 'tcp',
      method: '2022-blake3-aes-128-gcm', password: s.stSsKey },
  ];

  // Фотон: свой протокол (отдельный процесс Node на сервере, свой самоподписанный сертификат, клиент сверяет отпечаток)
  const ph = require('../photon/proto'), phKeys = ph.genKeyPair();
  const photon = { port: ports.photon, pub: ph.b64u(phKeys.pub), token: ph.b64u(rand(16)),
    cfg: { listen: '0.0.0.0', port: ports.photon, cert: '/etc/quasar/photon-cert.pem', key: '/etc/quasar/photon-key.pem', priv: ph.b64u(phKeys.priv) } };
  photon.cfg.tokens = [photon.token];
  photon.cfg.pq = 'off';   // Фотон и Antohin — два разных протокола: Фотон не принимает постквантовое приветствие
  // Antohin: отдельный сервис, порт, ключи, токен и сертификат; только постквантовый режим
  const aKeys = ph.genKeyPair();
  const antohin = { port: ports.antohin, pub: ph.b64u(aKeys.pub), token: ph.b64u(rand(16)),
    cfg: { listen: '0.0.0.0', port: ports.antohin, cert: '/etc/quasar/antohin-cert.pem', key: '/etc/quasar/antohin-key.pem', priv: ph.b64u(aKeys.priv), pq: 'only' } };
  antohin.cfg.tokens = [antohin.token];

  // Xray: VLESS + XHTTP + Reality (ядро sing-box так не умеет). Ключи Reality общие с основным VLESS.
  const xray = { port: ports.xhttp, path: '/' + b64u(rand(6)) };
  xray.cfg = {
    log: { loglevel: 'warning' },
    inbounds: [{ listen: '0.0.0.0', port: ports.xhttp, protocol: 'vless', settings: { clients: [{ id: s.uuid, flow: '' }], decryption: 'none' },
      streamSettings: { network: 'xhttp', security: 'reality',
        realitySettings: { show: false, dest: RS + ':443', serverNames: [RS], privateKey: reality.privateKey, shortIds: [s.shortId] },
        xhttpSettings: { path: xray.path, mode: 'auto' } } }],
    outbounds: [{ protocol: 'freedom', tag: 'direct' }],
  };

  // NaiveProxy: нужен настоящий сертификат. Домен сервер выбирает сам при установке: указанный домен, имя сервера,
  // иначе бесплатный <ip>.nip.io / <ip>.sslip.io (они сами указывают на IP). Сертификат — Let's Encrypt через sing-box.
  const naive = { port: ports.naive, user: 'quasar', pass: b64u(rand(18)) };
  naive.cfg = { log: { level: 'warn', timestamp: true }, inbounds: [{ type: 'naive', tag: 'naive-in', listen: '::', listen_port: ports.naive,
    users: [{ username: naive.user, password: naive.pass }],
    tls: { enabled: true, server_name: '__QUASAR_DOMAIN__', acme: { domain: ['__QUASAR_DOMAIN__'], email: opts.email || undefined, data_directory: '/var/lib/quasar/acme', disable_tls_alpn_challenge: true } } }],
    outbounds: [{ type: 'direct', tag: 'direct' }] };

  // Sudoku (экспериментально): сервер — mihomo с listener типа sudoku. Ключ — общий UUID для клиента и сервера.
  const sudoku = { port: ports.sudoku, key: uuidFrom(rand(16)), aead: 'chacha20-poly1305', table: 'prefer_ascii', pmin: 2, pmax: 7 };
  sudoku.yaml = ['log-level: warning', 'mode: direct', 'geo-auto-update: false', 'listeners:',
    '  - name: sudoku-in', '    type: sudoku', '    listen: 0.0.0.0', `    port: ${ports.sudoku}`, `    key: "${sudoku.key}"`,
    `    aead-method: ${sudoku.aead}`, `    padding-min: ${sudoku.pmin}`, `    padding-max: ${sudoku.pmax}`, `    table-type: ${sudoku.table}`,
    '    enable-pure-downlink: false', '    httpmask:', '      disable: false', '      mode: legacy', 'rules:', '  - MATCH,DIRECT', ''].join('\n');

  // ShadowQUIC: QUIC без ожидания рукопожатия, маскировка под чужой домен через JLS (сертификат не нужен)
  const sqSni = opts.shadowquicSni || 'cloudflare.com';
  const shadowquic = { port: ports.shadowquic, user: 'quasar', pass: b64u(rand(18)), sni: sqSni };
  shadowquic.yaml = ['inbound:', '  type: shadowquic', `  bind-addr: "0.0.0.0:${ports.shadowquic}"`, '  users:', `    - username: "${shadowquic.user}"`, `      password: "${shadowquic.pass}"`,
    '  jls-upstream:', `    addr: "${sqSni}:443"`, '    alpn: ["h3"]', '  congestion-control: bbr', '  zero-rtt: true',
    'outbound:', '  type: direct', '  dns-strategy: prefer-ipv4', 'log-level: "warn"', ''].join('\n');

  // Mieru: сервер — тот же mihomo (listener типа mieru), транспорт TCP. Рисунок трафика (traffic pattern) свой у сервера и у клиента:
  // печатное начало пакета, низкая энтропия, паддинг. Подробно — lib/mieru.js.
  const MI = require('./mieru');
  const mieru = { port: ports.mieru, user: 'q' + b64u(rand(6)).replace(/[^A-Za-z0-9]/g, 'x'), pass: b64u(rand(18)),
    tpServer: MI.encodeTrafficPattern(MI.quasarPattern(rand)), tpClient: MI.encodeTrafficPattern(MI.quasarPattern(rand)) };
  mieru.yaml = ['log-level: warning', 'mode: direct', 'geo-auto-update: false', 'listeners:',
    '  - name: mieru-in', '    type: mieru', '    listen: 0.0.0.0', `    port: ${ports.mieru}`, '    transport: TCP',
    '    users:', `      ${mieru.user}: "${mieru.pass}"`, `    traffic-pattern: "${mieru.tpServer}"`, 'rules:', '  - MATCH,DIRECT', ''].join('\n');

  // Juicity: QUIC + TLS 1.3, свой самоподписанный сертификат; клиент сверяет хэш цепочки (для одного сертификата это его SHA-256)
  const juicity = { port: ports.juicity, uuid: uuidFrom(rand(16)), pass: b64u(rand(18)), sni: certSni };
  juicity.cfg = { listen: ':' + ports.juicity, users: { [juicity.uuid]: juicity.pass }, certificate: '/etc/quasar/juicity-cert.pem',
    private_key: '/etc/quasar/juicity-key.pem', congestion_control: 'bbr', log_level: 'warn' };

  // Brook: режим wssserver — настоящий HTTPS с WebSocket на секретном пути (на другие пути — 404, как у обычного сайта).
  // Клиент: отпечаток TLS как у Chrome, ClientHello режется на куски (против разбора SNI), сертификат проверяется по нашему CA.
  const brook = { port: ports.brook, pass: b64u(rand(18)), path: '/' + b64u(rand(9)).replace(/[^A-Za-z0-9]/g, 'x'), sni: certSni };

  // Restls: внешне обычный Shadowsocks 2022, но поверх — res-tls (порт mihomo для Restls), который выдаёт себя за
  // настоящий сайт (certSni) до тех пор, пока клиент не докажет пароль Restls внутри самого TLS-рукопожатия —
  // активное зондирование (попытка DPI подключиться самостоятельно) видит перед собой этот сайт и ничего больше.
  // ключ 2022-blake3-aes-128-gcm — ровно 16 байт в обычном base64 (раньше было 18 байт url-base64, и клиент mihomo падал: illegal base64 data)
  const restls = { port: ports.restls, ssPass: rand(16).toString('base64'), rtPass: b64u(rand(18)), site: certSni, jlsUser: 'quasar' };
  restls.yaml = ['log-level: warning', 'mode: direct', 'geo-auto-update: false', 'listeners:',
    '  - name: restls-in', '    type: shadowsocks', '    listen: 0.0.0.0', `    port: ${ports.restls}`,
    `    password: "${restls.ssPass}"`, '    cipher: 2022-blake3-aes-128-gcm',
    // JLS вместо res-tls: с res-tls провайдер его распознавал. JLS устроен как Reality — чужому подключению отвечает
    // настоящий сайт, своего клиента сервер узнаёт по секрету внутри ClientHello; TLS 1.3, отпечаток Chrome
    '    jls-config:', '      enable: true', '      users:', `        - username: "${restls.jlsUser}"`, `          password: "${restls.rtPass}"`,
    `      sni: "${RS}"`, `      dest: "${RS}:443"`,
    'rules:', '  - MATCH,DIRECT', ''].join('\n');

  // Snell (протокол Surge) с тем же res-tls-слоем сверху — самая новая доступная в mihomo маскировка для Snell.
  const snell = { port: ports.snell, psk: b64u(rand(18)), rtPass: b64u(rand(18)), site: certSni };
  snell.yaml = ['log-level: warning', 'mode: direct', 'geo-auto-update: false', 'listeners:',
    '  - name: snell-in', '    type: snell', '    listen: 0.0.0.0', `    port: ${ports.snell}`,
    `    psk: "${snell.psk}"`, '    version: 4',
    // ShadowTLS v3 вместо Restls: с Restls провайдер распознавал Snell после первых соединений, ShadowTLS у него проходит
    // ShadowTLS v3 в mihomo требует список пользователей (иначе вход не поднимается: «at least one user is required»)
    '    shadow-tls:', '      enable: true', '      version: 3', '      users:', '        - name: quasar', `          password: "${snell.rtPass}"`, '      strict-mode: true',
    '      handshake:', `        dest: "${RS}:443"`,
    'rules:', '  - MATCH,DIRECT', ''].join('\n');

  // TLSMirror — самая новая защита в mihomo: VMess с tlsmirror-config вместо обычного TLS. До проверки пароля
  // соединение ведёт себя как настоящий TLS-клиент к сайту dest (пассивный и активный зонд видят настоящий сайт).
  // primary-key — 32 случайных байта (общий секрет сервера и клиента); остальные опции — то, что сейчас
  // поддерживает mihomo без экспериментальной многосерверной части (connection-enrolment) и без генератора трафика.
  const tlsmirror = { port: ports.tlsmirror, uuid: uuidFrom(rand(16)), primaryKey: rand(32).toString('base64'), site: certSni };
  tlsmirror.yaml = ['log-level: warning', 'mode: direct', 'geo-auto-update: false', 'listeners:',
    '  - name: tlsmirror-in', '    type: vmess', '    listen: 0.0.0.0', `    port: ${ports.tlsmirror}`,
    '    users:', `      - username: quasar`, `        uuid: "${tlsmirror.uuid}"`, '        alterId: 0',
    '    tlsmirror-config:', `      primary-key: "${tlsmirror.primaryKey}"`, `      dest: "${RS}:443"`, '      proxy: ""',
    // Только базовый режим. Паддинг и водяные знаки mihomo проверяет лишь на порциях по 128 байт — на больших объёмах
    // соединение обрывалось (у пользователя — на 247 КБ из 256); explicit nonce нужен только для TLS 1.2, а маска работает на TLS 1.3
    'rules:', '  - MATCH,DIRECT', ''].join('\n');

  const config = { log: { level: 'warn', timestamp: true }, inbounds, outbounds: [{ type: 'direct', tag: 'direct' }] };

  // Порты для брандмауэра
  const firewall = [
    { port: ports.vless, proto: 'tcp' }, { port: ports.hysteria2, proto: 'udp' }, { port: ports.tuic, proto: 'udp' },
    { port: ports.anytls, proto: 'tcp' }, { port: ports.trojan, proto: 'tcp' }, { port: ports.http, proto: 'tcp' },
    { port: ports.shadowsocks, proto: 'tcp' }, { port: ports.shadowsocks, proto: 'udp' }, { port: ports.shadowtls, proto: 'tcp' },
  ];
  firewall.push({ port: ports.photon, proto: 'tcp' }, { port: ports.antohin, proto: 'tcp' }, { port: ports.xhttp, proto: 'tcp' }, { port: ports.sudoku, proto: 'tcp' }, { port: ports.shadowquic, proto: 'udp' });
  firewall.push({ port: ports.mieru, proto: 'tcp' }, { port: ports.juicity, proto: 'udp' }, { port: ports.brook, proto: 'tcp' });
  firewall.push({ port: ports.restls, proto: 'tcp' }, { port: ports.snell, proto: 'tcp' }, { port: ports.tlsmirror, proto: 'tcp' });
  firewall.push({ port: ports.naive, proto: 'tcp' }, { port: ports.naive, proto: 'udp' });
  if (domain) firewall.push({ port: 80, proto: 'tcp' });   // проверка владения доменом для сертификата

  return { name, host: opts.host, domain, insecure, certSni, ports, secrets: s, config, firewall, realitySni, realityCandidates, realityTimings, stSni, photon, antohin, xray, naive, sudoku, shadowquic, mieru, juicity, brook, restls, snell, tlsmirror };
}

// Ссылки клиента. pin — отпечаток сертификата сервера (появляется после установки), только для самоподписанного режима.
function buildItems(plan, pin, photonPin, extras = {}) {
  const { host, name, ports, secrets: s, insecure, certSni } = plan;
  const sni = plan.domain || certSni;
  const items = [
    { proto: 'vless', name: `${name} · VLESS Reality`, host, port: ports.vless, uuid: s.uuid, sni: extras.realitySni || plan.realitySni, publicKey: s.reality.publicKey, shortId: s.shortId },
    { proto: 'hysteria2', name: `${name} · Hysteria2`, host, port: ports.hysteria2, password: s.hy2, sni, insecure, pin: insecure ? pin : undefined, obfsPassword: s.hy2Obfs },
    { proto: 'tuic', name: `${name} · TUIC v5`, host, port: ports.tuic, uuid: s.tuicUuid, password: s.tuic, sni, insecure },
    { proto: 'anytls', name: `${name} · AnyTLS`, host, port: ports.anytls, password: s.anytls, sni: extras.realitySni || plan.realitySni, publicKey: s.reality.publicKey, shortId: s.shortIdAt },
    { proto: 'http', name: `${name} · HTTPS-прокси`, host, port: ports.http, username: 'quasar', password: s.httpPass, tls: true, sni, insecure },
    { proto: 'trojan', name: `${name} · Trojan`, host, port: ports.trojan, password: s.trojan, sni: extras.realitySni || plan.realitySni, publicKey: s.reality.publicKey, shortId: s.shortIdTr },
    { proto: 'shadowsocks', name: `${name} · Shadowsocks 2022`, host, port: ports.shadowsocks, method: '2022-blake3-aes-128-gcm', password: s.ssKey },
  ];
  const links = require('./links');
  const out = items.map((i) => ({ ...i, uri: links.buildLink(i) }));
  out.push({ proto: 'shadowtls', name: `${name} · ShadowTLS v3`, host, port: ports.shadowtls, version: 3, password: s.stPass, sni: plan.stSni, ss: { method: '2022-blake3-aes-128-gcm', password: s.stSsKey } });
  if (photonPin) out.push({ proto: 'photon', name: `${name} · Фотон`, host, port: plan.photon.port, x: { pub: plan.photon.pub, token: plan.photon.token, pin: photonPin, sni: certSni } });
  if (extras.antohinPin) out.push({ proto: 'antohin', name: `${name} · Antohin`, host, port: plan.antohin.port, x: { pub: plan.antohin.pub, token: plan.antohin.token, pin: extras.antohinPin, sni: certSni, pq: true } });
  if (extras.xray) out.push({ proto: 'vless', name: `${name} · VLESS XHTTP`, host, port: plan.xray.port, uuid: s.uuid, flow: '', sni: extras.realitySni || plan.realitySni, publicKey: s.reality.publicKey, shortId: s.shortId, transport: 'xhttp', path: plan.xray.path, mode: 'auto', xhost: '' });
  if (extras.naive && extras.naiveDomain) out.push({ proto: 'naive', name: `${name} · NaiveProxy`, host, port: plan.naive.port, x: { username: plan.naive.user, password: plan.naive.pass, domain: extras.naiveDomain } });   // адрес — IP сервера, домен нужен только для сертификата
  if (extras.sudoku) out.push({ proto: 'sudoku', name: `${name} · Sudoku`, host, port: plan.sudoku.port, x: { key: plan.sudoku.key, aead: plan.sudoku.aead, table: plan.sudoku.table, pmin: plan.sudoku.pmin, pmax: plan.sudoku.pmax } });
  if (extras.shadowquic) out.push({ proto: 'shadowquic', name: `${name} · ShadowQUIC`, host, port: plan.shadowquic.port, x: { username: plan.shadowquic.user, password: plan.shadowquic.pass, sni: plan.shadowquic.sni } });
  if (extras.mieru) out.push({ proto: 'mieru', name: `${name} · Mieru`, host, port: plan.mieru.port, x: { username: plan.mieru.user, password: plan.mieru.pass, transport: 'TCP', tp: plan.mieru.tpClient } });
  if (extras.juicityPin) out.push({ proto: 'juicity', name: `${name} · Juicity`, host, port: plan.juicity.port, x: { uuid: plan.juicity.uuid, password: plan.juicity.pass, sni: plan.juicity.sni, pin: extras.juicityPin } });
  if (extras.brookCa) out.push({ proto: 'brook', name: `${name} · Brook`, host, port: plan.brook.port, x: { password: plan.brook.pass, path: plan.brook.path, sni: plan.brook.sni, ca: extras.brookCa } });
  if (extras.restls) out.push({ proto: 'restls', name: `${name} · Restls (JLS)`, host, port: plan.restls.port, x: { ssPass: plan.restls.ssPass, rtPass: plan.restls.rtPass, site: extras.realitySni || plan.realitySni, obfs: 'jls', user: plan.restls.jlsUser } });
  if (extras.snell) out.push({ proto: 'snell', name: `${name} · Snell`, host, port: plan.snell.port, x: { psk: plan.snell.psk, rtPass: plan.snell.rtPass, site: extras.realitySni || plan.realitySni, obfs: 'shadow-tls' } });
  if (extras.tlsmirror) out.push({ proto: 'tlsmirror', name: `${name} · TLSMirror`, host, port: plan.tlsmirror.port, x: { uuid: plan.tlsmirror.uuid, primaryKey: plan.tlsmirror.primaryKey, site: extras.realitySni || plan.realitySni } });
  return out;
}

module.exports = { PORT_ORDER, portsFor, DEFAULT_PORTS, COMMON_PORTS, buildServerPlan, buildItems, genReality };
