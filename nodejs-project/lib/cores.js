'use strict';
// Реестр внешних ядер. Каждое ядро — отдельный процесс с локальным SOCKS5; sing-box остаётся «фасадом»
// (TUN, маршруты, блок рекламы, статистика) и ходит к ядру как к обычному socks-серверу.
// Конфиги ядер написаны по их документации и не проверялись на настоящих бинарниках — это отмечено в поле `verified`.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const { tcpPing } = require('./net');

const WIN = process.platform === 'win32';
const exeName = (n) => (WIN ? n + '.exe' : n);
const enc = encodeURIComponent;
const need = (v, label) => { const s = String(v == null ? '' : v).trim(); if (!s) throw new Error('Заполни поле «' + label + '»'); return s; };
const host_ = (v) => { const s = need(v, 'Адрес'); if (!/^[A-Za-z0-9.:-]{1,253}$/.test(s)) throw new Error('Неверный адрес'); return s; };
const port_ = (v, d) => { const n = Number(v || d); if (!(n > 0 && n < 65536)) throw new Error('Неверный порт'); return n; };
const q = (s) => JSON.stringify(String(s));   // строка для YAML: JSON-кавычки подходят

// Mieru через mihomo. traffic-pattern — base64 protobuf (см. lib/mieru.js); пускаем только похожее на base64.
function mieruMake(it, port) {
  const x = it.x || {};
  const tp = /^[A-Za-z0-9+/=]{0,400}$/.test(x.tp || '') ? x.tp || '' : '';
  const mux = ['MULTIPLEXING_OFF', 'MULTIPLEXING_LOW', 'MULTIPLEXING_MIDDLE', 'MULTIPLEXING_HIGH'].includes(x.mux) ? x.mux : 'MULTIPLEXING_LOW';
  const y = [`socks-port: ${port}`, 'allow-lan: false', "bind-address: '127.0.0.1'", 'mode: global', 'log-level: warning', 'geo-auto-update: false', 'proxies:',
    '  - name: mieru', '    type: mieru', `    server: ${q(it.host)}`, `    port: ${it.port}`, `    transport: ${x.transport === 'UDP' ? 'UDP' : 'TCP'}`, '    udp: true',
    `    username: ${q(x.username)}`, `    password: ${q(x.password)}`, `    multiplexing: ${mux}`, '    handshake-mode: HANDSHAKE_STANDARD',
    ...(tp ? [`    traffic-pattern: ${q(tp)}`] : []),
    'proxy-groups:', '  - name: GLOBAL', '    type: select', '    proxies: [mieru]', 'rules:', '  - MATCH,mieru', ''].join('\n');
  return { args: ['-d', '{dir}', '-f', '{cfg}'], files: [{ name: 'config-mieru.yaml', content: y }] };
}

// Restls: обычный Shadowsocks 2022 с плагином restls (та же res-tls-маскировка, что и на сервере).
function restlsMake(it, port) {
  const x = it.x || {};
  const y = [`socks-port: ${port}`, 'allow-lan: false', "bind-address: '127.0.0.1'", 'mode: global', 'log-level: warning', 'geo-auto-update: false', 'proxies:',
    '  - name: restls', '    type: ss', `    server: ${q(it.host)}`, `    port: ${it.port}`, `    password: ${q(x.ssPass)}`, '    cipher: 2022-blake3-aes-128-gcm',
    '    client-fingerprint: chrome',   // ClientHello как у Chrome (TLS 1.3, X25519 + ML-KEM-768)
    // новые профили — JLS (как Reality), старые (до переустановки) — restls
    ...(x.obfs === 'jls'
      ? ['    plugin: jls', '    plugin-opts:', `      host: ${q(x.site)}`, `      username: ${q(x.user || 'quasar')}`, `      password: ${q(x.rtPass)}`]
      : ['    plugin: restls', '    plugin-opts:', `      host: ${q(x.site)}`, `      password: ${q(x.rtPass)}`, '      version-hint: "tls13"']),
    'proxy-groups:', '  - name: GLOBAL', '    type: select', '    proxies: [restls]', 'rules:', '  - MATCH,restls', ''].join('\n');
  return { args: ['-d', '{dir}', '-f', '{cfg}'], files: [{ name: 'config-restls.yaml', content: y }] };
}

// Snell с тем же restls-слоем сверху (obfs-opts.mode: restls — самая новая маскировка для Snell в mihomo).
function snellMake(it, port) {
  const x = it.x || {};
  const y = [`socks-port: ${port}`, 'allow-lan: false', "bind-address: '127.0.0.1'", 'mode: global', 'log-level: warning', 'geo-auto-update: false', 'proxies:',
    '  - name: snell', '    type: snell', `    server: ${q(it.host)}`, `    port: ${it.port}`, `    psk: ${q(x.psk)}`, '    version: 4', '    client-fingerprint: chrome',
    // старые профили (до переустановки) — Restls, новые — ShadowTLS v3
    ...(x.obfs === 'shadow-tls'
      ? ['    obfs-opts:', '      mode: shadow-tls', `      host: ${q(x.site)}`, `      password: ${q(x.rtPass)}`, '      version: 3']
      : ['    obfs-opts:', '      mode: restls', `      host: ${q(x.site)}`, `      password: ${q(x.rtPass)}`, '      version-hint: "tls13"']),
    'proxy-groups:', '  - name: GLOBAL', '    type: select', '    proxies: [snell]', 'rules:', '  - MATCH,snell', ''].join('\n');
  return { args: ['-d', '{dir}', '-f', '{cfg}'], files: [{ name: 'config-snell.yaml', content: y }] };
}

// TLSMirror: VMess с tlsmirror-opts вместо обычного TLS (primary-key — общий секрет сервера и клиента).
const SITE_RE = /^[A-Za-z0-9.-]{1,253}$/;
function tlsmirrorMake(it, port) {
  const x = it.x || {};
  const y = [`socks-port: ${port}`, 'allow-lan: false', "bind-address: '127.0.0.1'", 'mode: global', 'log-level: warning', 'geo-auto-update: false', 'proxies:',
    '  - name: tlsmirror', '    type: vmess', `    server: ${q(it.host)}`, `    port: ${it.port}`, `    uuid: ${q(x.uuid)}`, '    alterId: 0', '    cipher: auto', '    tls: true', '    client-fingerprint: chrome',
    // имя сайта-маски в TLS: сервер зеркалит рукопожатие к нему, и сертификат приходит от этого сайта.
    // Без servername mihomo сверял сертификат с IP сервера и рвал соединение. Старые профили без site — сайт по умолчанию www.bing.com
    `    servername: ${q(SITE_RE.test(x.site || '') ? x.site : 'www.bing.com')}`,
    // базовый режим TLSMirror: паддинг и водяные знаки обрывали большие загрузки (247 КБ из 256)
    '    tlsmirror-opts:', `      primary-key: ${q(x.primaryKey)}`,
    'proxy-groups:', '  - name: GLOBAL', '    type: select', '    proxies: [tlsmirror]', 'rules:', '  - MATCH,tlsmirror', ''].join('\n');
  return { args: ['-d', '{dir}', '-f', '{cfg}'], files: [{ name: 'config-tlsmirror.yaml', content: y }] };
}

const CORES = {
  singbox: {
    title: 'sing-box', tag: 'основа', facade: true, repo: 'SagerNet/sing-box', asset: /windows-amd64\.zip$/i, notAsset: /legacy/i, exe: 'sing-box', dir: '',
    about: 'Главный движок: TUN-режим, маршрутизация по правилам, DNS, статистика соединений.',
    protocols: 'VLESS · Reality · Trojan · Shadowsocks 2022 · Hysteria2 · TUIC · AnyTLS · ShadowTLS', verified: true,
  },
  xray: {
    title: 'Xray-core', tag: 'VLESS XHTTP', repo: 'XTLS/Xray-core', asset: /^Xray-windows-64\.zip$/i, exe: 'xray',
    about: 'Родное ядро для VLESS: XHTTP и другие новинки появляются здесь первыми. Берёт только серверы VLESS с транспортом xhttp. Сервер Xray ставится вместе с остальными протоколами.',
    protocols: 'VLESS · Reality · XHTTP', verified: false,
    handles: (it) => it.proto === 'vless' && it.transport === 'xhttp',
    make(it, port) {
      const cfg = {
        log: { loglevel: 'warning' },
        inbounds: [{ listen: '127.0.0.1', port, protocol: 'socks', settings: { udp: true } }],
        outbounds: [{ protocol: 'vless', settings: { vnext: [{ address: it.host, port: it.port, users: [{ id: it.uuid, encryption: 'none', flow: it.flow || '' }] }] },
          streamSettings: { network: 'xhttp', security: 'reality', realitySettings: { serverName: it.sni || it.host, fingerprint: 'chrome', publicKey: it.publicKey, shortId: it.shortId },
            xhttpSettings: { path: it.path || '/', host: it.xhost || '', mode: it.mode || 'auto' } } }],
      };
      return { args: ['run', '-c', '{cfg}'], files: [{ name: 'config.json', content: JSON.stringify(cfg, null, 2) }] };
    },
  },
  mihomo: {
    title: 'mihomo (Clash Meta)', tag: 'Sudoku · Mieru · Restls · Snell · TLSMirror', repo: 'MetaCubeX/mihomo', asset: /^mihomo-windows-amd64-v[\d.]+\.zip$/i, exe: 'mihomo',
    about: 'Здесь живёт экспериментальный Sudoku: данные кодируются как судоку 4×4, вывод может выглядеть как обычный текст. Нужна версия 1.19.21 или новее. Сервер Sudoku ставится вместе с остальными протоколами. Авторы пишут «только для исследований».',
    protocols: 'Sudoku (экспериментально) · Mieru · Restls · Snell · TLSMirror (экспериментально)', verified: false, experimental: true,
    fields: [['host', 'Адрес'], ['port', 'Порт'], ['key', 'Ключ (UUID или закрытый ключ)']],
    makeItem: (v) => ({ proto: 'sudoku', host: host_(v.host), port: port_(v.port, 0), x: { key: need(v.key, 'Ключ'), aead: 'chacha20-poly1305', table: 'prefer_ascii', pmin: 2, pmax: 7 } }),
    handles: (it) => it.proto === 'sudoku' || it.proto === 'mieru' || it.proto === 'restls' || it.proto === 'snell' || it.proto === 'tlsmirror',
    make(it, port) {
      if (it.proto === 'mieru') return mieruMake(it, port);
      if (it.proto === 'restls') return restlsMake(it, port);
      if (it.proto === 'snell') return snellMake(it, port);
      if (it.proto === 'tlsmirror') return tlsmirrorMake(it, port);
      const x = it.x, n = (v, d) => (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 100 ? Number(v) : d);
      const pmin = n(x.pmin, 2), pmax = Math.max(pmin, n(x.pmax, 7));
      const aead = ['chacha20-poly1305', 'aes-128-gcm'].includes(x.aead) ? x.aead : 'chacha20-poly1305';
      const table = ['prefer_ascii', 'prefer_entropy', 'up_ascii_down_entropy', 'up_entropy_down_ascii'].includes(x.table) ? x.table : 'prefer_ascii';
      const y = [`socks-port: ${port}`, 'allow-lan: false', "bind-address: '127.0.0.1'", 'mode: global', 'log-level: warning', 'geo-auto-update: false', 'proxies:',
        '  - name: sudoku', '    type: sudoku', `    server: ${q(it.host)}`, `    port: ${it.port}`, `    key: ${q(x.key)}`, `    aead-method: ${aead}`,
        `    padding-min: ${pmin}`, `    padding-max: ${pmax}`, `    table-type: ${table}`, '    enable-pure-downlink: false', '    httpmask:', '      disable: false', '      mode: legacy',
        'proxy-groups:', '  - name: GLOBAL', '    type: select', '    proxies: [sudoku]', 'rules:', '  - MATCH,sudoku', ''].join('\n');
      return { args: ['-d', '{dir}', '-f', '{cfg}'], files: [{ name: 'config.yaml', content: y }] };
    },
  },
  usque: {
    title: 'WARP · MASQUE (usque)', tag: 'Cloudflare', repo: 'Diniboy1123/usque', asset: /windows.*(amd64|x86_64).*\.zip$/i, exe: 'usque',
    about: 'Бесплатный Cloudflare WARP поверх QUIC / HTTP3. Неофициальный клиент, автор называет его хобби-проектом и тестировал только на Linux.',
    protocols: 'MASQUE (HTTP/3)', verified: false, register: true,
    makeItem: () => ({ proto: 'warp', host: 'engage.cloudflareclient.com', port: 443, x: {} }),
    handles: (it) => it.proto === 'warp',
    make(it, port, ctx) {
      const conf = path.join(ctx.dataDir, 'warp', 'config.json');
      if (!fs.existsSync(conf)) throw new Error('WARP ещё не зарегистрирован: нажми «Зарегистрировать WARP» на вкладке «Ядра»');
      return { args: ['-c', conf, 'socks', '-b', '127.0.0.1', '-p', String(port)], files: [] };
    },
  },
  naive: {
    title: 'NaiveProxy', tag: 'маскировка', repo: 'klzgrad/naiveproxy', asset: /^naiveproxy-.*-win-x64\.zip$/i, exe: 'naive',
    about: 'Трафик неотличим от обычного Chrome по TLS-отпечатку. Сервер ставится вместе с остальными протоколами; домен и сертификат Let\'s Encrypt он находит сам (например, <ip>.nip.io).',
    protocols: 'Naive (HTTPS)', verified: false,
    fields: [['host', 'Адрес'], ['port', 'Порт (443)'], ['username', 'Логин'], ['password', 'Пароль']],
    makeItem: (v) => ({ proto: 'naive', host: host_(v.host), port: port_(v.port, 443), x: { username: need(v.username, 'Логин'), password: need(v.password, 'Пароль') } }),
    handles: (it) => it.proto === 'naive',
    make(it, port) {
      const cfg = { listen: `socks://127.0.0.1:${port}`, proxy: `https://${enc(it.x.username)}:${enc(it.x.password)}@${it.x.domain || it.host}:${it.port}` };
      return { args: ['{cfg}'], files: [{ name: 'config.json', content: JSON.stringify(cfg, null, 2) }] };
    },
  },
  shadowquic: {
    title: 'ShadowQUIC', tag: 'QUIC, 0-RTT', repo: 'spongebob888/shadowquic', asset: /^shadowquic-x86_64-windows\.exe$/i, raw: true, exe: 'shadowquic',
    about: 'Прокси на QUIC без ожидания рукопожатия, маскируется под чужой домен без своих сертификатов (JLS). Малоизвестный проект, лицензия MIT. Сервер ставится вместе с остальными протоколами.',
    protocols: 'ShadowQUIC', verified: false,
    fields: [['host', 'Адрес'], ['port', 'Порт'], ['username', 'Пользователь'], ['password', 'Пароль'], ['sni', 'Домен маскировки (как на сервере)']],
    makeItem: (v) => ({ proto: 'shadowquic', host: host_(v.host), port: port_(v.port, 0), x: { username: need(v.username, 'Пользователь'), password: need(v.password, 'Пароль'), sni: need(v.sni, 'Домен маскировки') } }),
    handles: (it) => it.proto === 'shadowquic',
    make(it, port) {
      const h = it.host.includes(':') ? `[${it.host}]` : it.host;
      const y = ['inbound:', '  type: socks', `  bind-addr: "127.0.0.1:${port}"`, 'outbound:', '  type: shadowquic', `  addr: ${q(h + ':' + it.port)}`,
        `  username: ${q(it.x.username)}`, `  password: ${q(it.x.password)}`, `  server-name: ${q(it.x.sni)}`, '  alpn: ["h3"]', '  initial-mtu: 1300',
        '  congestion-control: bbr', '  zero-rtt: true', '  over-stream: false', 'log-level: "warn"', ''].join('\n');
      return { args: ['-c', '{cfg}'], files: [{ name: 'config.yaml', content: y }] };
    },
  },
  juicity: {
    title: 'Juicity', tag: 'QUIC', repo: 'juicity/juicity', asset: /^juicity-windows-x86_64\.zip$/i, exe: 'juicity-client',
    about: 'Прокси на QUIC (UDP) с TLS 1.3, родственник TUIC. Сертификат сервера свой, клиент сверяет его хэш. Если провайдер режет UDP или QUIC, не пойдёт: тогда бери протоколы по TCP. Сервер ставится вместе с остальными протоколами.',
    protocols: 'Juicity (QUIC)', verified: false,
    fields: [['host', 'Адрес'], ['port', 'Порт'], ['uuid', 'UUID'], ['password', 'Пароль'], ['sni', 'SNI'], ['pin', 'Хэш сертификата (pinned_certchain_sha256)']],
    makeItem: (v) => ({ proto: 'juicity', host: host_(v.host), port: port_(v.port, 0), x: { uuid: need(v.uuid, 'UUID'), password: need(v.password, 'Пароль'), sni: String(v.sni || '').trim(), pin: need(v.pin, 'Хэш сертификата') } }),
    handles: (it) => it.proto === 'juicity',
    make(it, port) {
      const x = it.x, h = it.host.includes(':') ? `[${it.host}]` : it.host;
      // Отпечаток приходит в hex (как его печатает openssl), а juicity-client сначала читает его как base64: 64 hex-символа —
      // тоже допустимый base64, получались другие байты, и сертификат «не совпадал» всегда. Отдаём base64 тех же 32 байт.
      const pinRaw = String(x.pin || '').replace(/:/g, '');
      const pin = /^[0-9A-Fa-f]{64}$/.test(pinRaw) ? Buffer.from(pinRaw, 'hex').toString('base64') : x.pin;
      const cfg = { listen: `127.0.0.1:${port}`, server: `${h}:${it.port}`, uuid: x.uuid, password: x.password, sni: x.sni || undefined,
        allow_insecure: false, pinned_certchain_sha256: pin, congestion_control: 'bbr', log_level: 'warn' };
      return { args: ['run', '-c', '{cfg}'], files: [{ name: 'config.json', content: JSON.stringify(cfg, null, 2) }] };
    },
  },
  brook: {
    title: 'Brook', tag: 'WebSocket + TLS', repo: 'txthinking/brook', asset: /^brook_windows_amd64(\.exe)?$/i, raw: true, exe: 'brook',
    about: 'Brook в режиме wssserver: снаружи обычный HTTPS с WebSocket на секретном пути, чужим отвечает 404. Отпечаток TLS как у Chrome, ClientHello режется на куски против разбора SNI, сертификат сервера проверяется по сохранённому. Сервер ставится вместе с остальными протоколами.',
    protocols: 'Brook (wss)', verified: false,
    handles: (it) => it.proto === 'brook',
    make(it, port) {
      const x = it.x || {};
      const h = it.host.includes(':') ? `[${it.host}]` : it.host;
      const v = new URLSearchParams();
      v.set('wssserver', `wss://${x.sni}:${it.port}${x.path || '/ws'}`);
      v.set('password', x.password);
      v.set('address', `${h}:${it.port}`);          // соединяемся с IP, а в TLS называем sni
      if (x.ca) v.set('ca', x.ca); else v.set('insecure', 'true');
      v.set('tlsfingerprint', 'chrome');
      v.set('fragment', '30:80:1000:5000');          // куски ClientHello 30–80 байт, паузы 1–5 мс (единицы brook — микросекунды)
      const link = 'brook://wssserver?' + v.toString();
      return { args: ['connect', '--link', link, '--socks5', `127.0.0.1:${port}`], files: [] };
    },
  },
  dnstt: {
    title: 'DNS-туннель (запасной канал)', tag: 'аварийный', manual: 'Нужен dnstt-client: собери из исходников (Go) и положи dnstt-client.exe в папку bin\\cores\\dnstt',
    exe: 'dnstt-client',
    about: 'Туннель внутри DNS-запросов (DNSTT, как в SlipNet): медленный, но живёт, когда режут всё, кроме DNS. Нужен свой сервер dnstt с SOCKS на выходе. Запускается отдельным процессом (у SlipNet лицензия AGPL).',
    protocols: 'DNSTT', verified: false, experimental: true,
    fields: [['domain', 'Домен туннеля'], ['pubkey', 'Публичный ключ'], ['resolver', 'DoH-адрес (https://…)']],
    makeItem: (v) => ({ proto: 'dnstt', host: host_(v.domain), port: 53, x: { pubkey: need(v.pubkey, 'Публичный ключ'), resolver: need(v.resolver, 'DoH-адрес') } }),
    handles: (it) => it.proto === 'dnstt',
    make(it, port) {
      if (!/^https:\/\//.test(it.x.resolver)) throw new Error('DoH-адрес должен начинаться с https://');
      return { args: ['-doh', it.x.resolver, '-pubkey-file', '{pub}', it.host, `127.0.0.1:${port}`], files: [{ name: 'pub.key', content: it.x.pubkey + '\n', key: 'pub' }] };
    },
  },
  photon: {
    title: 'Фотон', tag: 'своё', selfExe: true, verified: false,
    about: 'Наш собственный протокол: рукопожатие X25519, ChaCha20-Poly1305 и HKDF (стандартные примитивы), защита от повторов, под чужой запрос отвечает как обычный веб-сервер. Работает внутри TLS 1.3. Проверен только против самого себя и без внешнего аудита, поэтому дополнительный. Сервер ставится вместе с остальными протоколами, если на нём есть Node.js 18+.',
    protocols: 'Фотон (TLS/TCP)',
    fields: [['host', 'Адрес'], ['port', 'Порт (8449)'], ['pub', 'Открытый ключ сервера'], ['token', 'Токен'], ['pin', 'Отпечаток сертификата (SHA-256)']],
    makeItem: (v) => ({ proto: 'photon', host: host_(v.host), port: port_(v.port, 8449), x: { pub: need(v.pub, 'Открытый ключ сервера'), token: need(v.token, 'Токен'), pin: need(v.pin, 'Отпечаток'), sni: '' } }),
    handles: (it) => it.proto === 'photon',
    make(it, port, ctx) {
      const cfg = { host: it.host, port: it.port, pub: it.x.pub, token: it.x.token, pin: it.x.pin, sni: it.x.sni || '', listenPort: port };
      return { args: [path.join(ctx.appDir, 'photon', 'client.js'), '{cfg}'], files: [{ name: 'config.json', content: JSON.stringify(cfg, null, 2) }] };
    },
  },
  antohin: {
    title: 'Antohin', tag: 'своё, постквантовый', selfExe: true, verified: false,
    about: 'Отдельный собственный протокол с постквантовым шифрованием: обмен ключами X25519 + ML-KEM-768 (перехваченный сегодня трафик не вскроют и квантовым компьютером). Ключ ML-KEM и ответ сервера зашифрованы, под чужой запрос сервер отвечает как обычный веб-сервер (nginx 404). Работает внутри TLS 1.3 на своём порту и со своими ключами, с Фотоном не связан. Проверен только против самого себя и эталона ML-KEM, без внешнего аудита.',
    protocols: 'Antohin (TLS/TCP, ML-KEM-768)',
    fields: [['host', 'Адрес'], ['port', 'Порт (8454)'], ['pub', 'Открытый ключ сервера'], ['token', 'Токен'], ['pin', 'Отпечаток сертификата (SHA-256)']],
    makeItem: (v) => ({ proto: 'antohin', host: host_(v.host), port: port_(v.port, 8454), x: { pub: need(v.pub, 'Открытый ключ сервера'), token: need(v.token, 'Токен'), pin: need(v.pin, 'Отпечаток'), sni: '' } }),
    handles: (it) => it.proto === 'antohin',
    make(it, port, ctx) {
      const cfg = { host: it.host, port: it.port, pub: it.x.pub, token: it.x.token, pin: it.x.pin, sni: it.x.sni || '', pq: true, listenPort: port };
      return { args: [path.join(ctx.appDir, 'photon', 'client.js'), '{cfg}'], files: [{ name: 'config.json', content: JSON.stringify(cfg, null, 2) }] };
    },
  },
};

const ENV = (id) => 'QUASAR_CORE_' + id.toUpperCase();

function binDir(appDir, id) { return id === 'singbox' ? path.join(appDir, 'bin') : path.join(appDir, 'bin', 'cores', id); }

function findExe(appDir, id) {
  const c = CORES[id]; if (!c) return null;
  if (c.selfExe) return process.execPath;   // Фотон-клиент работает на том же Node, что и Квазар
  if (!c.exe) return null;
  if (process.env.QUASAR_NATIVE_DIR) {   // Android: ядра лежат в APK как lib<имя>.so
    const nf = path.join(process.env.QUASAR_NATIVE_DIR, 'lib' + c.exe.replace(/[^a-z0-9]/gi, '') + '.so');
    if (fs.existsSync(nf)) return nf;
  }
  if (process.env[ENV(id)] && fs.existsSync(process.env[ENV(id)])) return process.env[ENV(id)];
  const f = path.join(binDir(appDir, id), exeName(c.exe));
  return fs.existsSync(f) ? f : null;
}

function adapterFor(item) { for (const [id, c] of Object.entries(CORES)) if (c.handles && c.handles(item)) return { id, ...c }; return null; }

function status(appDir, servers = []) {
  return Object.entries(CORES).map(([id, c]) => ({
    id, title: c.title, tag: c.tag, about: c.about, protocols: c.protocols, verified: !!c.verified, experimental: !!c.experimental,
    installed: !!findExe(appDir, id), canInstall: !!c.repo, manual: c.manual || null, planned: c.planned || null,
    fields: c.fields ? c.fields.map(([key, label]) => ({ key, label })) : null, register: !!c.register, addable: !!c.makeItem,
    used: servers.filter((s) => c.handles && c.handles(s)).length,
  }));
}

function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

// Запущенное внешнее ядро (одно за раз)
class ExtCore {
  constructor({ dataDir, appDir, log = () => {} }) { this.dataDir = dataDir; this.appDir = appDir; this.log = log; this.proc = null; this.port = null; this.name = ''; }
  get running() { return !!this.proc; }

  async start(item, ad, { port: fixedPort } = {}) {
    await this.stop();
    const exe = findExe(this.appDir, ad.id);
    if (!exe) throw new Error(`Ядро «${ad.title}» не установлено. ${ad.manual || 'Нажми «Скачать» на вкладке «Ядра»'}`);
    const port = fixedPort || await freePort();   // постоянный туннель: ядро протокола всегда на одном и том же порту
    const dir = path.join(this.dataDir, 'cores', ad.id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const made = ad.make(item, port, { dataDir: this.dataDir, appDir: this.appDir });
    const paths = { dir };
    for (const f of made.files) { const p = path.join(dir, f.name); fs.writeFileSync(p, f.content, { mode: 0o600 }); paths[f.key || 'cfg'] = p; }
    const args = made.args.map((a) => a.replace(/^\{(\w+)\}$/, (_, k) => paths[k] || a));
    // Android: Фотон и Antohin (на Node) запускаем внутри этого же процесса, отдельного node там нет
    const p = (process.env.QUASAR_ANDROID && ad.selfExe) ? require('./inproc').spawnWorker(args[0], args.slice(1)) : spawn(exe, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.proc = p; this.port = port; this.name = path.basename(exe);
    let exited = null;
    const onData = (d) => String(d).split(/\r?\n/).forEach((l) => l.trim() && this.log(`[${ad.title}] ${l.trim()}`));
    p.stdout.on('data', onData); p.stderr.on('data', onData);
    p.once('error', (e) => { exited = e.message; });
    p.once('exit', (c) => { exited = 'код ' + c; if (this.proc === p) { this.proc = null; this.port = null; } });
    const t0 = Date.now();
    for (;;) {
      if (exited) { this.proc = null; throw new Error(`Ядро «${ad.title}» не запустилось: ${exited}`); }
      if ((await tcpPing('127.0.0.1', port, 400)) !== null) break;
      if (Date.now() - t0 > 15000) { await this.stop(); throw new Error(`Ядро «${ad.title}» запустилось, но не открыло порт`); }
      await new Promise((r) => setTimeout(r, 150));
    }
    return { port, procName: this.name };
  }

  async stop() {
    const p = this.proc; if (!p) return;
    await new Promise((resolve) => {
      const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* уже завершён */ } }, 3000);
      p.once('exit', () => { clearTimeout(t); resolve(); });
      try { p.kill(); } catch { clearTimeout(t); resolve(); }
    });
    this.proc = null; this.port = null;
  }
}

module.exports = { CORES, binDir, findExe, adapterFor, status, freePort, ExtCore, exeName };
