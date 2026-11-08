'use strict';
// Клиентский конфиг sing-box для выбранного сервера: исходящий протокол + локальный вход (mixed: HTTP и SOCKS5 на одном порту).

// Базовый список рекламных и трекерных доменов. Большие списки (EasyList и т.п.) подключим отдельно.
const AD_DOMAINS = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.com', 'ads.youtube.com',
  'adnxs.com', 'adsrvr.org', 'taboola.com', 'outbrain.com', 'criteo.com', 'criteo.net', 'scorecardresearch.com',
  'pubmatic.com', 'rubiconproject.com', 'openx.net', 'amazon-adsystem.com', 'moatads.com', 'adform.net',
  'an.yandex.ru', 'yandexadexchange.net', 'ads.mail.ru', 'ad.mail.ru', 'ads.vk.com', 'mc.yandex.ru',
];

const ADS_URL = 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-category-ads-all.srs';

const LAN_CIDRS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', 'fc00::/7', 'fe80::/10'];

// Reality: отпечаток Chrome, TLS 1.3 (с X25519 + ML-KEM-768), сертификат — настоящего сайта-маски
function realityOf(item) {
  return { enabled: true, server_name: item.sni, utls: { enabled: true, fingerprint: 'chrome' }, reality: { enabled: true, public_key: item.publicKey, short_id: item.shortId || '' } };
}

function tlsOf(item, extra = {}) {
  return { enabled: true, server_name: item.sni || item.host, insecure: !!item.insecure, ...extra };
}

function outboundFor(item, tag = 'proxy') {
  const base = { tag, server: item.host, server_port: item.port };
  switch (item.proto) {
    case 'vless':
      return { type: 'vless', ...base, uuid: item.uuid, ...(item.flow ? { flow: item.flow } : {}), packet_encoding: 'xudp',
        tls: { enabled: true, server_name: item.sni || item.host, utls: { enabled: true, fingerprint: 'chrome' }, reality: { enabled: true, public_key: item.publicKey, short_id: item.shortId } } };
    case 'hysteria2': {
      const o = { type: 'hysteria2', ...base, password: item.password, tls: tlsOf(item, { alpn: ['h3'] }) };
      if (item.params && item.params.obfs === 'salamander') o.obfs = { type: 'salamander', password: item.params['obfs-password'] || '' };
      return o;
    }
    case 'tuic':
      return { type: 'tuic', ...base, uuid: item.uuid, password: item.password, congestion_control: 'bbr', udp_relay_mode: 'native', tls: tlsOf(item, { alpn: ['h3'] }) };
    case 'anytls':
      return { type: 'anytls', ...base, password: item.password, tls: item.publicKey ? realityOf(item) : tlsOf(item, { utls: { enabled: true, fingerprint: 'chrome' } }) };
    case 'trojan':
      return { type: 'trojan', ...base, password: item.password, tls: item.publicKey ? realityOf(item) : tlsOf(item, { utls: { enabled: true, fingerprint: 'chrome' } }) };
    case 'http':
      return { type: 'http', ...base, ...(item.username ? { username: item.username, password: item.password || '' } : {}), ...(item.tls ? { tls: tlsOf(item) } : {}) };
    case 'socks':
      return { type: 'socks', ...base, version: '5', ...(item.username ? { username: item.username, password: item.password || '' } : {}) };
    case 'shadowsocks':
      return { type: 'shadowsocks', ...base, method: item.method, password: item.password };
    case 'shadowtls':
      return [
        { type: 'shadowtls', tag: tag + '-tls', server: item.host, server_port: item.port, version: 3, password: item.password,
          tls: { enabled: true, server_name: item.sni, utls: { enabled: true, fingerprint: 'chrome' } } },
        { type: 'shadowsocks', tag, method: item.ss.method, password: item.ss.password, detour: tag + '-tls' },
      ];
    default:
      throw new Error('Протокол «' + item.proto + '» пока нельзя запустить');
  }
}

/**
 * opts: { mixedPort, apiPort, secret, lan, lanPort, lanAuth, lanUser, lanPass, lanDevice, adblock, ... }
 * Локальный вход 127.0.0.1:mixedPort — только для этого компьютера. lan: отдельный вход для приставки на lanPort.
 * Без пароля (PS4 не умеет логин прокси) его пускают только адреса домашней сети или один IP приставки — остальных ядро отклоняет.
 */
function buildClientConfig(item, opts = {}) {
  const { mixedPort = 10808, apiPort = 10809, secret = '', lan = false, lanPort = 10810, lanAuth = true, lanDevice = '', lanUser = 'quasar', lanPass = '', adblock = true, tun = false, bigAds = false, rules: userRules = [], external = null, share = false, directProcs = [], directIps = [], tunName = 'quasar-tun' } = opts;
  if (lan && lanAuth && !lanPass) throw new Error('Для раздачи с паролем нужен пароль');
  if (lan && lanPort === mixedPort) throw new Error('Порт раздачи должен отличаться от локального порта');
  // Внешнее ядро уже подняло локальный SOCKS5: sing-box ходит к нему как к обычному серверу
  const ob = external ? { type: 'socks', tag: 'proxy', server: '127.0.0.1', server_port: external.port, version: '5' } : outboundFor(item, 'proxy');
  const outbounds = [...(Array.isArray(ob) ? ob : [ob]), { type: 'direct', tag: 'direct' }];
  const rules = [{ ip_is_private: true, outbound: 'direct' }];
  if (adblock) rules.unshift({ domain_suffix: AD_DOMAINS, action: 'reject' });
  const ruleSets = [];
  if (adblock && bigAds) {
    // Большой список рекламных доменов (~100 тысяч): ядро скачивает его само через сервер и обновляет раз в неделю.
    ruleSets.push({ type: 'remote', tag: 'ads-big', format: 'binary', url: ADS_URL, download_detour: 'proxy', update_interval: '7d' });
    rules.unshift({ rule_set: 'ads-big', action: 'reject' });
  }
  // Свои правила идут первыми и перебивают всё остальное
  const own = [];
  for (const r of userRules) {
    const key = r.kind === 'suffix' ? 'domain_suffix' : r.kind === 'keyword' ? 'domain_keyword' : 'domain';
    own.push(r.action === 'block' ? { [key]: [r.value], action: 'reject' } : { [key]: [r.value], outbound: r.action === 'direct' ? 'direct' : 'proxy' });
  }
  rules.unshift(...own);
  const inbounds = [{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: mixedPort }];
  if (lan) {
    inbounds.push({ type: 'mixed', tag: 'lan-in', listen: '0.0.0.0', listen_port: lanPort, ...(lanAuth ? { users: [{ username: lanUser, password: lanPass }] } : {}) });
    const allow = lanDevice ? [lanDevice + (lanDevice.includes(':') ? '/128' : '/32')] : LAN_CIDRS;
    // вход для приставки: всех, кто не из домашней сети (или не та приставка), отклоняем первым же правилом
    rules.unshift({ type: 'logical', mode: 'and', rules: [{ inbound: ['lan-in'] }, { source_ip_cidr: allow, invert: true }], action: 'reject' });
  }
  const cfg = {
    log: { level: 'warn', timestamp: true },
    inbounds,
    outbounds,
    route: { rules, final: 'proxy', auto_detect_interface: true, ...(ruleSets.length ? { rule_set: ruleSets } : {}) },
    experimental: { clash_api: { external_controller: `127.0.0.1:${apiPort}`, secret } },
  };
  if (tun) {
    // Режим TUN: весь трафик компьютера идёт через виртуальный адаптер. Нужен запуск от администратора.
    // имя адаптера постоянное: на него Windows вешает общий доступ для приставки; при раздаче strict_route выключен, чтобы не мешать пересылке
    inbounds.push({ type: 'tun', tag: 'tun-in', interface_name: tunName, address: ['172.19.0.1/30'], auto_route: true, strict_route: !share, stack: 'mixed' });
    if (external && external.procName) rules.unshift({ process_name: [external.procName], outbound: 'direct' });   // трафик самого ядра не должен возвращаться в TUN
    // Постоянный туннель: ядра протоколов (любое из них может стоять за ним) и все свои серверы — мимо TUN.
    // Так туннель не нужно пересоздавать при смене протокола или сервера.
    if (directProcs.length) rules.unshift({ process_name: directProcs, outbound: 'direct' });
    if (directIps.length) rules.unshift({ ip_cidr: directIps.map((ip) => ip + (ip.includes(':') ? '/128' : '/32')), outbound: 'direct' });
    rules.unshift({ action: 'sniff' }, { protocol: 'dns', action: 'hijack-dns' });   // sniff первым, чтобы правила по доменам работали
    const isIp = /^[\d.]+$/.test(item.host) || item.host.includes(':');
    cfg.dns = {
      servers: [{ type: 'https', tag: 'dns-remote', server: '1.1.1.1', detour: 'proxy' }, { type: 'local', tag: 'dns-local' }],
      rules: isIp ? [] : [{ domain: [item.host], server: 'dns-local' }],
      final: 'dns-remote', strategy: 'ipv4_only',
    };
    cfg.route.default_domain_resolver = 'dns-local';
  }
  return cfg;
}

module.exports = { LAN_CIDRS, ADS_URL, AD_DOMAINS, outboundFor, buildClientConfig };
