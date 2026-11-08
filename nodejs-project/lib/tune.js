'use strict';
// Быстрая смена порта или маскировки на уже установленном сервере: правим /etc/quasar/config.json по SSH,
// проверяем sing-box, открываем порт в файрволе и перезапускаем службу. Не переустанавливает сервер и не меняет ключи.
const { HOST_RE } = require('./reality');

// Тег входа в конфиге sing-box (lib/serverconf.js) и по каким сетям он слушает
const INBOUND = {
  vless: { tag: 'vless-reality', nets: ['tcp'] },
  hysteria2: { tag: 'hysteria2', nets: ['udp'] },
  tuic: { tag: 'tuic', nets: ['udp'] },
  anytls: { tag: 'anytls', nets: ['tcp'] },
  trojan: { tag: 'trojan', nets: ['tcp'] },
  http: { tag: 'http-tls', nets: ['tcp'] },
  shadowsocks: { tag: 'ss2022', nets: ['tcp', 'udp'] },
  shadowtls: { tag: 'shadowtls', nets: ['tcp'] },
};
// Для остальных (Фотон, XHTTP, Naive, Sudoku, ShadowQUIC) порт меняется только переустановкой
const portTunable = (item) => !!INBOUND[item.proto] && item.transport !== 'xhttp';

// Порты по порядку «чаще всего открыты»
const PORT_POOL = [443, 8443, 2053, 2083, 2087, 2096, 8080, 8880, 2052, 2082, 2086, 2095, 8444, 8445, 8446, 8447, 8448, 8081, 8888, 9443, 10443, 4443, 5443, 7443];

/** Какие порты пробовать для протокола item: из пула, кроме текущего и занятых другими протоколами этого же сервера в той же сети */
function candidatePorts(item, siblings, pool = PORT_POOL) {
  const nets = (INBOUND[item.proto] || { nets: ['tcp'] }).nets;
  const taken = new Set();
  for (const s of siblings) {
    if (s.id === item.id) continue;
    const sn = (INBOUND[s.proto] || { nets: ['tcp'] }).nets;
    if (sn.some((n) => nets.includes(n))) taken.add(s.port);
    else if (!INBOUND[s.proto]) taken.add(s.port);   // Фотон, Naive и др. — на всякий случай не трогаем их порты
  }
  return pool.filter((p) => p !== item.port && !taken.has(p));
}

const intPort = (p) => { const n = Number(p); if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('Порт: число от 1 до 65535'); return n; };
const q = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '');

/** Bash-скрипт: поменять порт входа proto на newPort. Печатает QUASAR_LOG/QUASAR_ERROR/QUASAR_DONE */
function portScript(proto, oldPort, newPort) {
  const inb = INBOUND[proto]; if (!inb) throw new Error('Порт этого протокола меняется только переустановкой сервера');
  const o = intPort(oldPort), n = intPort(newPort);
  const fw = inb.nets.map((t) => `${n}/${t}`);
  return [
    'set -u',
    'say(){ echo "QUASAR_LOG=$*"; }',
    'fail(){ cp /etc/quasar/config.json.bak /etc/quasar/config.json 2>/dev/null; systemctl restart quasar-singbox >/dev/null 2>&1; echo "QUASAR_ERROR=$*"; exit 1; }',
    'CFG=/etc/quasar/config.json',
    '[ -f "$CFG" ] || { echo "QUASAR_ERROR=Не нашёл /etc/quasar/config.json: сервер ставился не Квазаром?"; exit 1; }',
    'command -v perl >/dev/null 2>&1 || { echo "QUASAR_ERROR=На сервере нет perl, поменять порт на лету не выйдет"; exit 1; }',
    'cp "$CFG" "$CFG.bak"',
    `perl -0pi -e 's/("tag":\\s*"${inb.tag}",\\s*"listen":\\s*"[^"]*",\\s*"listen_port":\\s*)${o}\\b/\${1}${n}/' "$CFG"`,
    `perl -0ne 'exit(/"tag":\\s*"${inb.tag}",\\s*"listen":\\s*"[^"]*",\\s*"listen_port":\\s*${n}\\b/ ? 0 : 1)' "$CFG" || fail "Порт ${o} в настройках не найден, менять нечего"`,
    '/opt/quasar/bin/sing-box check -c "$CFG" >/tmp/quasar-tune.log 2>&1 || fail "sing-box не принял настройки: $(tail -2 /tmp/quasar-tune.log | tr \'\\n\' \' \')"',
    ...fw.map((f) => `N=${f.split('/')[0]}; T=${f.split('/')[1]}; if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then ufw allow "$N/$T" >/dev/null 2>&1; fi; if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then firewall-cmd --add-port="$N/$T" >/dev/null 2>&1; firewall-cmd --permanent --add-port="$N/$T" >/dev/null 2>&1; fi`),
    'systemctl restart quasar-singbox >/dev/null 2>&1; sleep 2',
    `systemctl is-active --quiet quasar-singbox || fail "sing-box не запустился на порту ${n}: $(journalctl -u quasar-singbox -n 3 --no-pager 2>/dev/null | tail -2 | tr '\\n' ' ')"`,
    `say "Порт ${proto}: ${o} → ${n}"`,
    'echo "QUASAR_DONE=1"',
  ].join('\n') + '\n';
}

/** Bash-скрипт: сменить сайт маскировки VLESS Reality (и XHTTP, если стоит) с oldSni на newSni */
function maskScript(oldSni, newSni) {
  const o = q(oldSni), n = q(newSni);
  if (!HOST_RE.test(o) || !HOST_RE.test(n)) throw new Error('Маскировка: нужен адрес сайта, например www.apple.com');
  const po = o.replace(/\./g, '\\.'), po2 = n.replace(/\./g, '\\.');
  return [
    'set -u',
    'say(){ echo "QUASAR_LOG=$*"; }',
    'fail(){ cp /etc/quasar/config.json.bak /etc/quasar/config.json 2>/dev/null; [ -f /etc/quasar/xray.json.bak ] && cp /etc/quasar/xray.json.bak /etc/quasar/xray.json; systemctl restart quasar-singbox >/dev/null 2>&1; systemctl restart quasar-xray >/dev/null 2>&1; echo "QUASAR_ERROR=$*"; exit 1; }',
    'CFG=/etc/quasar/config.json',
    '[ -f "$CFG" ] || { echo "QUASAR_ERROR=Не нашёл /etc/quasar/config.json: сервер ставился не Квазаром?"; exit 1; }',
    'command -v perl >/dev/null 2>&1 || { echo "QUASAR_ERROR=На сервере нет perl, поменять маскировку на лету не выйдет"; exit 1; }',
    'cp "$CFG" "$CFG.bak"; [ -f /etc/quasar/xray.json ] && cp /etc/quasar/xray.json /etc/quasar/xray.json.bak',
    // только внутри входа vless-reality, чтобы не задеть другие протоколы с тем же сайтом
    `perl -0pi -e 's/("tag":\\s*"vless-reality".*?)(?="tag":\\s*"hysteria2")/my $b=$1; $b =~ s#${po}#${n}#g; $b/se' "$CFG"`,
    `perl -0ne 'exit(/"tag":\\s*"vless-reality".*?${po2}.*?"tag":\\s*"hysteria2"/s ? 0 : 1)' "$CFG" || fail "Старая маскировка ${o} в настройках не найдена"`,
    '[ -f /etc/quasar/xray.json ] && perl -pi -e ' + `'s#${po}#${n}#g' /etc/quasar/xray.json`,
    '/opt/quasar/bin/sing-box check -c "$CFG" >/tmp/quasar-tune.log 2>&1 || fail "sing-box не принял настройки: $(tail -2 /tmp/quasar-tune.log | tr \'\\n\' \' \')"',
    'systemctl restart quasar-singbox >/dev/null 2>&1; sleep 2',
    'systemctl is-active --quiet quasar-singbox || fail "sing-box не запустился с новой маскировкой"',
    '[ -f /etc/quasar/xray.json ] && systemctl restart quasar-xray >/dev/null 2>&1',
    `say "Маскировка: ${o} → ${n}"`,
    'echo "QUASAR_DONE=1"',
  ].join('\n') + '\n';
}

/** Разбор вывода скрипта: { ok, logs, error } */
function parseOutput(lines) {
  const out = { ok: false, logs: [], error: '' };
  for (const l of lines) {
    const m = /^QUASAR_(LOG|ERROR|DONE)=(.*)$/.exec(l); if (!m) continue;
    if (m[1] === 'LOG') out.logs.push(m[2]); else if (m[1] === 'ERROR') out.error = m[2]; else out.ok = true;
  }
  return out;
}

module.exports = { INBOUND, PORT_POOL, portTunable, candidatePorts, portScript, maskScript, parseOutput };
