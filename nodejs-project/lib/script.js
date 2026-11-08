'use strict';
// Скрипт установки, который уходит на сервер через stdin команды `bash -s` (в аргументах процесса секретов нет).
// Конфиг приходит в base64, чтобы не зависеть от кавычек. Скрипт сам ничего не придумывает: порты и ключи уже выбрал клиент.

const fs = require('fs');
const path = require('path');
const b64f = (f) => fs.readFileSync(path.join(__dirname, '..', 'photon', f)).toString('base64');

function installScript(plan) {
  const cfgB64 = Buffer.from(JSON.stringify(plan.config, null, 2), 'utf8').toString('base64');
  const checks = [...new Set(plan.firewall.filter((f) => ![plan.photon.port, plan.antohin.port, plan.mieru.port, plan.juicity.port, plan.brook.port, plan.restls.port, plan.snell.port, plan.tlsmirror.port].includes(f.port)).map((f) => `${f.port}/${f.proto}`))];
  const phCfg = Buffer.from(JSON.stringify(plan.photon.cfg, null, 2), 'utf8').toString('base64');
  const phPort = plan.photon.port;
  const xrCfg = Buffer.from(JSON.stringify(plan.xray.cfg, null, 2), 'utf8').toString('base64');
  const xrPort = plan.xray.port;
  const sdCfg = Buffer.from(plan.sudoku.yaml, 'utf8').toString('base64');
  const sdPort = plan.sudoku.port;
  const sqCfg = Buffer.from(plan.shadowquic.yaml, 'utf8').toString('base64');
  const sqPort = plan.shadowquic.port;
  const miCfg = Buffer.from(plan.mieru.yaml, 'utf8').toString('base64');
  const miPort = plan.mieru.port;
  const jcCfg = Buffer.from(JSON.stringify(plan.juicity.cfg, null, 2), 'utf8').toString('base64');
  const jcPort = plan.juicity.port;
  const bkPort = plan.brook.port;
  const bkSni = String(plan.brook.sni).replace(/[^A-Za-z0-9.-]/g, '');
  const bkPath = String(plan.brook.path).replace(/[^A-Za-z0-9/_-]/g, '');
  const bkPass = String(plan.brook.pass).replace(/[^A-Za-z0-9_-]/g, '');
  const rtCfg = Buffer.from(plan.restls.yaml, 'utf8').toString('base64');
  const rtPort = plan.restls.port;
  const snCfg = Buffer.from(plan.snell.yaml, 'utf8').toString('base64');
  const snPort = plan.snell.port;
  const tmCfg = Buffer.from(plan.tlsmirror.yaml, 'utf8').toString('base64');
  const tmPort = plan.tlsmirror.port;
  const nvCfg = Buffer.from(JSON.stringify(plan.naive.cfg, null, 2), 'utf8').toString('base64');
  const nvPort = plan.naive.port;
  const hostIn = String(plan.host).replace(/[^A-Za-z0-9.:-]/g, '');
  const domIn = String(plan.domain || '').replace(/[^A-Za-z0-9.-]/g, '');
  const selfSigned = !plan.domain;
  const helperBlock = String.raw`

# Распаковка zip. unzip бывает не поставить (apt занят автообновлением) — тогда python3, busybox или bsdtar.
# unz АРХИВ ПАПКА [ФАЙЛ_ИЗ_АРХИВА]
unz(){
  local Z="$1" O="$2" M=""; [ $# -ge 3 ] && M="$3"
  if command -v unzip >/dev/null 2>&1; then unzip -o -q "$Z" $M -d "$O" >/dev/null 2>&1 && return 0; fi
  for PY in python3 python; do
    command -v $PY >/dev/null 2>&1 && $PY -c 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); z.extractall(sys.argv[2], sys.argv[3:] or None)' "$Z" "$O" $M >/dev/null 2>&1 && return 0
  done
  command -v busybox >/dev/null 2>&1 && busybox unzip -o -q "$Z" -d "$O" >/dev/null 2>&1 && return 0
  command -v bsdtar >/dev/null 2>&1 && bsdtar -xf "$Z" -C "$O" >/dev/null 2>&1 && return 0
  return 1
}
have_unz(){ command -v unzip >/dev/null 2>&1 || command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1 || command -v busybox >/dev/null 2>&1 || command -v bsdtar >/dev/null 2>&1; }

# Последний релиз с GitHub. API отдаёт не больше 60 ответов в час на один IP: после нескольких переустановок подряд
# он отвечает ошибкой, и протоколы молча пропускались. Тогда берём версию из редиректа /releases/latest,
# а ссылки на файлы — со страницы expanded_assets (у них такого лимита нет). Формат вывода тот же, что у API.
gh_rel(){
  local R T
  R=$(curl -fsSL --max-time 20 "https://api.github.com/repos/$1/releases/latest" 2>/dev/null)
  if echo "$R" | grep -q '"tag_name"'; then echo "$R"; return 0; fi
  T=$(curl -fsSL --max-time 20 -o /dev/null -w '%{url_effective}' "https://github.com/$1/releases/latest" 2>/dev/null | sed -nE 's#.*/releases/tag/([^/?]+).*#\1#p')
  [ -n "$T" ] || return 1
  echo "\"tag_name\": \"$T\""
  curl -fsSL --max-time 30 "https://github.com/$1/releases/expanded_assets/$T" 2>/dev/null | grep -oE 'href="/[^"]+/releases/download/[^"]+"' | sed -E 's#^href="#"browser_download_url": "https://github.com#'
}
# Время сервера: Shadowsocks 2022, ShadowTLS, Фотон и Antohin отклоняют соединение, если часы сервера и клиента
# расходятся больше чем на 30 секунд. Включаем NTP и, если часы всё равно сбиты, ставим время по заголовку Date.
fix_time(){
  local D W N DIFF
  command -v timedatectl >/dev/null 2>&1 && timedatectl set-ntp true >/dev/null 2>&1
  D=$(curl -fsSI --max-time 10 https://www.google.com 2>/dev/null | tr -d '\r' | sed -nE 's/^[Dd]ate: (.*)$/\1/p' | head -1)
  [ -n "$D" ] || D=$(curl -fsSI --max-time 10 https://www.cloudflare.com 2>/dev/null | tr -d '\r' | sed -nE 's/^[Dd]ate: (.*)$/\1/p' | head -1)
  [ -n "$D" ] || { say "Не смог сверить время сервера (нет ответа от google.com и cloudflare.com)"; return 0; }
  W=$(date -d "$D" +%s 2>/dev/null) || return 0
  N=$(date +%s); DIFF=$((N - W)); [ "$DIFF" -lt 0 ] && DIFF=$((0 - DIFF))
  if [ "$DIFF" -gt 5 ]; then
    if date -s "@$W" >/dev/null 2>&1; then say "Часы сервера расходились на $DIFF с — поправил (без этого не работают Shadowsocks 2022, ShadowTLS, Фотон, Antohin)"
    else say "Часы сервера расходятся на $DIFF с, поправить не вышло: Shadowsocks 2022, ShadowTLS, Фотон и Antohin могут не работать"; fi
  else say "Часы сервера в порядке (разница $DIFF с)"; fi
}
# Разбор причины, если служба не запустилась: ищем сами и пишем по-человечески
why(){
  U="$1"; P="$2"; T="$3"; [ -n "$T" ] || T=tcp
  J=$(journalctl -u "$U" -n 40 --no-pager 2>/dev/null)
  LAST=$(echo "$J" | tail -3 | tr '\n' ' ' | cut -c1-300)
  say "  Ищу причину, почему не запустился $U:"
  if echo "$J" | grep -qiE "address already in use|bind: .*in use|EADDRINUSE"; then
    if [ "$T" = udp ]; then WHO=$(ss -lunp 2>/dev/null | grep -E "[:.]$P " | head -1); else WHO=$(ss -ltnp 2>/dev/null | grep -E "[:.]$P " | head -1); fi
    WHO=$(echo "$WHO" | sed -nE 's/.*users:\(\("([^"]+)".*/\1/p')
    [ -n "$WHO" ] || WHO=неизвестной
    say "  → порт $P ($T) уже занят программой «$WHO». Освободи его или выбери другие порты при установке"
  elif echo "$J" | grep -qiE "permission denied|operation not permitted"; then
    say "  → не хватает прав (SELinux, AppArmor или защита systemd): $(echo "$J" | grep -iE 'permission denied|not permitted' | tail -1 | cut -c1-180)"
  elif echo "$J" | grep -qiE "exec format error|cannot execute binary"; then
    say "  → программа не подходит под процессор этого сервера ($(uname -m))"
  elif echo "$J" | grep -qiE "no such file|not found|cannot open"; then
    say "  → не найден нужный файл: $(echo "$J" | grep -iE 'no such file|not found|cannot open' | tail -1 | cut -c1-180)"
  elif echo "$J" | grep -qiE "unknown field|unmarshal|parse|decode config|invalid config|yaml:|json:"; then
    say "  → программа не приняла настройки: $(echo "$J" | grep -iE 'unknown field|unmarshal|parse|decode|invalid|yaml:|json:' | tail -1 | cut -c1-180)"
  elif echo "$J" | grep -qiE "acme|certificate|x509|tls:"; then
    say "  → проблема с сертификатом: $(echo "$J" | grep -iE 'acme|certificate|x509|tls:' | tail -1 | cut -c1-180)"
  elif echo "$J" | grep -qiE "out of memory|oom|killed"; then
    say "  → не хватило памяти (на $(free -m 2>/dev/null | awk '/Mem:/{print $2}') МБ). Возьми сервер побольше или сними лишние протоколы"
  elif echo "$J" | grep -qiE "network is unreachable|cannot assign requested address|ipv6"; then
    say "  → на сервере не работает нужный сетевой адрес (часто выключен IPv6): $(echo "$J" | tail -1 | cut -c1-180)"
  else
    [ -n "$LAST" ] || LAST=пусто
    say "  → причина не опознана. Последние строки журнала службы: $LAST"
  fi
}
# Поднять службу: если не встала — один перезапуск; не вышло — разбор причины. Код 0 = работает.
heal(){
  U="$1"; P="$2"; T="$3"
  systemctl is-active --quiet "$U" && return 0
  say "  $U не запустился, пробую перезапустить"
  systemctl reset-failed "$U" >/dev/null 2>&1; systemctl restart "$U" >/dev/null 2>&1; sleep 3
  if systemctl is-active --quiet "$U"; then say "  после перезапуска $U заработал"; return 0; fi
  why "$U" "$P" "$T"; return 1
}
`;
  const tcpBlock = (o) => String.raw`
# ---------- ${o.label} (необязательная часть: если не получится, остальные протоколы всё равно работают) ----------
${o.var}=0
say "Ставлю ${o.label} (свой протокол)"
nodever(){ [ -x "$1" ] && "$1" -p "process.versions.node.split('.')[0]" 2>/dev/null; }
# Нужен Node.js 18+. Чужой системный Node не трогаем: если его нет или он старый, кладём свой в /opt/quasar/node (удаляется вместе с Квазаром)
NODE_BIN=$(command -v node 2>/dev/null)
if [ -z "$NODE_BIN" ] || [ "$(nodever "$NODE_BIN" || echo 0)" -lt 18 ] 2>/dev/null; then
  NODE_BIN=/opt/quasar/node/bin/node
  if [ "$(nodever "$NODE_BIN" || echo 0)" -lt 18 ] 2>/dev/null; then
    say "На сервере нет Node.js 18+, ставлю свой в /opt/quasar/node (системный не трогаю)"
    NA=""; case "$A" in amd64) NA=x64;; arm64) NA=arm64;; esac
    NSUM=$(curl -fsSL --max-time 30 https://nodejs.org/dist/latest-v20.x/SHASUMS256.txt 2>/dev/null | grep "linux-$NA.tar.gz" | head -1)
    NFILE=$(echo "$NSUM" | awk '{print $2}'); NHASH=$(echo "$NSUM" | awk '{print $1}')
    if [ -n "$NA" ] && [ -n "$NFILE" ] && curl -fsSL --max-time 240 -o /tmp/quasar-node.tgz "https://nodejs.org/dist/latest-v20.x/$NFILE" 2>/dev/null && [ "$(sha256sum /tmp/quasar-node.tgz | cut -d' ' -f1)" = "$NHASH" ]; then
      rm -rf /opt/quasar/node && mkdir -p /opt/quasar/node && tar -xzf /tmp/quasar-node.tgz -C /opt/quasar/node --strip-components=1 && rm -f /tmp/quasar-node.tgz
    else say "  не удалось скачать Node.js (нет доступа к nodejs.org или не сошлась проверка)"; rm -f /tmp/quasar-node.tgz; fi
  fi
fi
if [ "$(nodever "$NODE_BIN" || echo 0)" -lt 18 ] 2>/dev/null; then say "${o.label} пропущен: нет Node.js 18 или новее и свой поставить не вышло"
elif ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${o.port}$" && ! systemctl is-active --quiet quasar-${o.id}; then say "${o.label} пропущен: порт ${o.port} занят"
else
  systemctl stop quasar-${o.id} >/dev/null 2>&1
  mkdir -p /opt/quasar-${o.id}
  echo '${b64f('proto.js')}' | base64 -d > /opt/quasar-${o.id}/proto.js
  echo '${b64f('mlkem.js')}' | base64 -d > /opt/quasar-${o.id}/mlkem.js
  echo '${b64f('transport.js')}' | base64 -d > /opt/quasar-${o.id}/transport.js
  echo '${b64f('server.js')}' | base64 -d > /opt/quasar-${o.id}/server.js
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout /etc/quasar/${o.id}-key.pem -out /etc/quasar/${o.id}-cert.pem -days 3650 -subj "/CN=${plan.certSni}" >/dev/null 2>&1
  chmod 600 /etc/quasar/${o.id}-key.pem
  echo '${o.cfg}' | base64 -d > /etc/quasar/${o.id}.json && chmod 600 /etc/quasar/${o.id}.json
  cat > /etc/systemd/system/quasar-${o.id}.service <<UNIT
[Unit]
Description=Quasar ${o.label}
After=network-online.target
[Service]
ExecStart=$NODE_BIN /opt/quasar-${o.id}/server.js /etc/quasar/${o.id}.json
Restart=on-failure
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT
  N=${o.port}
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then ufw allow "$N/tcp" >/dev/null 2>&1; fi
  if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then firewall-cmd --permanent --add-port="$N/tcp" >/dev/null 2>&1; firewall-cmd --reload >/dev/null 2>&1; fi
  systemctl daemon-reload; systemctl enable quasar-${o.id} >/dev/null 2>&1; systemctl restart quasar-${o.id}; sleep 2
  if heal quasar-${o.id} ${o.port} tcp; then
    ${o.var}=1
    echo "QUASAR_${o.marker}_CERT_SHA256=$(openssl x509 -in /etc/quasar/${o.id}-cert.pem -noout -fingerprint -sha256 | cut -d= -f2 | tr -d ':')"
    say "${o.label} запущен"
  else say "${o.label} не поставился (остальные протоколы работают)"; fi
fi
`;
  const photonBlock = tcpBlock({ id: 'photon', label: 'Фотон', var: 'PHOTON', marker: 'PHOTON', port: phPort, cfg: phCfg });
  const antohinBlock = tcpBlock({ id: 'antohin', label: 'Antohin', var: 'ANTOHIN', marker: 'ANTOHIN', port: plan.antohin.port, cfg: Buffer.from(JSON.stringify(plan.antohin.cfg, null, 2), 'utf8').toString('base64') });
  const xrayBlock = String.raw`
# ---------- Xray: VLESS XHTTP (необязательно, сбой не мешает остальному) ----------
say "Ставлю Xray (VLESS XHTTP)"
XRAY=0
XAS=""; case "$A" in amd64) XAS=64;; arm64) XAS=arm64-v8a;; esac
if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${xrPort}$" && ! systemctl is-active --quiet quasar-xray; then say "Xray пропущен: порт ${xrPort} занят"
else
  command -v unzip >/dev/null 2>&1 || { command -v apt-get >/dev/null 2>&1 && apt-get -o DPkg::Lock::Timeout=180 install -y unzip >/dev/null 2>&1; command -v dnf >/dev/null 2>&1 && dnf install -y unzip >/dev/null 2>&1; command -v yum >/dev/null 2>&1 && yum install -y unzip >/dev/null 2>&1; }
  XV=$(gh_rel XTLS/Xray-core | grep -m1 '"tag_name"' | sed -E 's/.*"v([^"]+)".*/\1/')
  if [ -z "$XAS" ]; then say "Xray пропущен: нет сборки под процессор $(uname -m)"
  elif [ -z "$XV" ]; then say "Xray пропущен: не удалось узнать последнюю версию на GitHub"
  elif ! have_unz; then say "Xray пропущен: на сервере нечем распаковать zip (нет unzip и python3)"
  else
    rm -rf /tmp/quasar-xr && mkdir -p /tmp/quasar-xr
    if curl -fsSL --max-time 180 -o /tmp/quasar-xr/x.zip "https://github.com/XTLS/Xray-core/releases/download/v$XV/Xray-linux-$XAS.zip" && unz /tmp/quasar-xr/x.zip /tmp/quasar-xr xray && install -m 755 /tmp/quasar-xr/xray /opt/quasar/bin/xray; then
      echo '${xrCfg}' | base64 -d | sed "s/__QUASAR_REALITY__/$RS/g" > /etc/quasar/xray.json && chmod 600 /etc/quasar/xray.json
      if /opt/quasar/bin/xray run -test -c /etc/quasar/xray.json >/tmp/quasar-xray-check.log 2>&1; then
        cat > /etc/systemd/system/quasar-xray.service <<'UNIT'
[Unit]
Description=Quasar Xray
After=network-online.target
[Service]
ExecStart=/opt/quasar/bin/xray run -c /etc/quasar/xray.json
Restart=on-failure
RestartSec=3
LimitNOFILE=1048576
[Install]
WantedBy=multi-user.target
UNIT
        N=${xrPort}
        if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then ufw allow "$N/tcp" >/dev/null 2>&1; fi
        if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then firewall-cmd --permanent --add-port="$N/tcp" >/dev/null 2>&1; firewall-cmd --reload >/dev/null 2>&1; fi
        systemctl daemon-reload; systemctl enable quasar-xray >/dev/null 2>&1; systemctl restart quasar-xray; sleep 2
        if heal quasar-xray ${xrPort} tcp; then XRAY=1; say "Xray $XV запущен"; else say "Xray не поставился (остальные протоколы работают)"; fi
      else say "Xray пропущен: он не принял настройки: $(tail -2 /tmp/quasar-xray-check.log | tr '\n' ' ')"; fi
    else say "Xray пропущен: не скачался или не поставился"; fi
    rm -rf /tmp/quasar-xr
  fi
fi
echo "QUASAR_XRAY=$XRAY"
`;
  const sudokuBlock = String.raw`
# ---------- Sudoku (экспериментально): сервер mihomo ----------
say "Ставлю Sudoku (mihomo)"
SUDOKU=0
if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${sdPort}$" && ! systemctl is-active --quiet quasar-sudoku; then say "Sudoku пропущен: порт ${sdPort} занят"
else
  REL=$(gh_rel MetaCubeX/mihomo)
  MURL=$(echo "$REL" | grep -oE "https://[^\"]*/mihomo-linux-$A-compatible-v[0-9.]+\.gz" | head -1)
  [ -n "$MURL" ] || MURL=$(echo "$REL" | grep -oE "https://[^\"]*/mihomo-linux-$A-v[0-9.]+\.gz" | head -1)
  if [ -z "$MURL" ]; then say "Sudoku пропущен: не нашёл mihomo для linux-$A"
  elif curl -fsSL --max-time 180 -o /tmp/quasar-mihomo.gz "$MURL" && gunzip -c /tmp/quasar-mihomo.gz > /tmp/quasar-mihomo && install -m 755 /tmp/quasar-mihomo /opt/quasar/bin/mihomo; then
    rm -f /tmp/quasar-mihomo /tmp/quasar-mihomo.gz
    mkdir -p /etc/quasar/mihomo
    echo '${sdCfg}' | base64 -d > /etc/quasar/sudoku.yaml && chmod 600 /etc/quasar/sudoku.yaml
    if /opt/quasar/bin/mihomo -t -d /etc/quasar/mihomo -f /etc/quasar/sudoku.yaml >/tmp/quasar-sudoku-check.log 2>&1; then
      cat > /etc/systemd/system/quasar-sudoku.service <<'UNIT'
[Unit]
Description=Quasar Sudoku (mihomo)
After=network-online.target
[Service]
ExecStart=/opt/quasar/bin/mihomo -d /etc/quasar/mihomo -f /etc/quasar/sudoku.yaml
Restart=on-failure
RestartSec=3
LimitNOFILE=1048576
[Install]
WantedBy=multi-user.target
UNIT
      N=${sdPort}
      if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then ufw allow "$N/tcp" >/dev/null 2>&1; fi
      if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then firewall-cmd --permanent --add-port="$N/tcp" >/dev/null 2>&1; firewall-cmd --reload >/dev/null 2>&1; fi
      systemctl daemon-reload; systemctl enable quasar-sudoku >/dev/null 2>&1; systemctl restart quasar-sudoku; sleep 2
      if heal quasar-sudoku ${sdPort} tcp; then SUDOKU=1; say "Sudoku запущен ($(basename "$MURL" .gz))"; else say "Sudoku не поставился (остальные протоколы работают)"; fi
    else say "Sudoku пропущен: mihomo не принял настройки: $(tail -2 /tmp/quasar-sudoku-check.log | tr '\n' ' ')"; fi
  else say "Sudoku пропущен: mihomo не скачался"; fi
fi
echo "QUASAR_SUDOKU=$SUDOKU"
`;
  const sqBlock = String.raw`
# ---------- ShadowQUIC (QUIC, маскировка через JLS) ----------
say "Ставлю ShadowQUIC"
SQ=0
case "$A" in amd64) QA=x86_64;; arm64) QA=aarch64;; *) QA="";; esac
if ss -lun 2>/dev/null | awk '{print $5}' | grep -qE "[:.]${sqPort}$" && ! systemctl is-active --quiet quasar-shadowquic; then say "ShadowQUIC пропущен: порт ${sqPort}/udp занят"
else
  REL=$(gh_rel spongebob888/shadowquic)
  SURL=$(echo "$REL" | grep -oE "https://[^\"]*/shadowquic-$QA-linux-musl\"" | tr -d '"' | head -1)
  [ -n "$SURL" ] || SURL=$(echo "$REL" | grep -oE "https://[^\"]*/shadowquic-$QA-linux\"" | tr -d '"' | head -1)
  if [ -z "$QA" ] || [ -z "$SURL" ]; then say "ShadowQUIC пропущен: нет сборки для linux-$A"
  elif curl -fsSL --max-time 180 -o /tmp/quasar-sq "$SURL" && install -m 755 /tmp/quasar-sq /opt/quasar/bin/shadowquic; then
    rm -f /tmp/quasar-sq
    echo '${sqCfg}' | base64 -d > /etc/quasar/shadowquic.yaml && chmod 600 /etc/quasar/shadowquic.yaml
    cat > /etc/systemd/system/quasar-shadowquic.service <<'UNIT'
[Unit]
Description=Quasar ShadowQUIC
After=network-online.target
[Service]
ExecStart=/opt/quasar/bin/shadowquic -c /etc/quasar/shadowquic.yaml
Restart=on-failure
RestartSec=3
LimitNOFILE=1048576
[Install]
WantedBy=multi-user.target
UNIT
    N=${sqPort}
    if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then ufw allow "$N/udp" >/dev/null 2>&1; fi
    if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then firewall-cmd --permanent --add-port="$N/udp" >/dev/null 2>&1; firewall-cmd --reload >/dev/null 2>&1; fi
    systemctl daemon-reload; systemctl enable quasar-shadowquic >/dev/null 2>&1; systemctl restart quasar-shadowquic; sleep 3
    if heal quasar-shadowquic ${sqPort} udp && ss -lun 2>/dev/null | awk '{print $5}' | grep -qE "[:.]$N$"; then SQ=1; say "ShadowQUIC запущен ($(basename "$SURL"))"
    else say "ShadowQUIC не поставился (остальные протоколы работают)"; say "  журнал ShadowQUIC: $(journalctl -u quasar-shadowquic -n 6 --no-pager 2>/dev/null | tail -3 | tr '\n' ' ' | cut -c1-400)"; systemctl disable --now quasar-shadowquic >/dev/null 2>&1; fi
  else say "ShadowQUIC пропущен: не скачался"; fi
fi
echo "QUASAR_SHADOWQUIC=$SQ"
`;
  // Общие куски для трёх необязательных протоколов ниже
  const fwOpen = (port, proto) => String.raw`
      if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then ufw allow "${port}/${proto}" >/dev/null 2>&1; fi
      if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then firewall-cmd --permanent --add-port="${port}/${proto}" >/dev/null 2>&1; firewall-cmd --reload >/dev/null 2>&1; fi`;
  const unit = (name, desc, exec) => String.raw`
      cat > /etc/systemd/system/${name}.service <<'UNIT'
[Unit]
Description=${desc}
After=network-online.target
[Service]
ExecStart=${exec}
Restart=on-failure
RestartSec=3
LimitNOFILE=1048576
[Install]
WantedBy=multi-user.target
UNIT`;
  // самоподписанный сертификат с SAN (Go без SAN имя не принимает); старый openssl без -addext — без SAN
  const mkcert = (id) => String.raw`
      if [ ! -s /etc/quasar/${id}-cert.pem ] || [ ! -s /etc/quasar/${id}-key.pem ]; then
        openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout /etc/quasar/${id}-key.pem -out /etc/quasar/${id}-cert.pem -days 3650 -subj "/CN=${plan.certSni}" -addext "subjectAltName=DNS:${plan.certSni}" >/dev/null 2>&1           || openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout /etc/quasar/${id}-key.pem -out /etc/quasar/${id}-cert.pem -days 3650 -subj "/CN=${plan.certSni}" >/dev/null 2>&1
        chmod 600 /etc/quasar/${id}-key.pem
      fi`;

  const mieruBlock = String.raw`
# ---------- Mieru (mihomo, TCP): поток без узнаваемого рукопожатия, печатное начало, низкая энтропия ----------
say "Ставлю Mieru (mihomo)"
MIERU=0
if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${miPort}$" && ! systemctl is-active --quiet quasar-mieru; then say "Mieru пропущен: порт ${miPort} занят"
else
  if [ ! -x /opt/quasar/bin/mihomo ]; then
    REL=$(gh_rel MetaCubeX/mihomo)
    MURL=$(echo "$REL" | grep -oE "https://[^\"]*/mihomo-linux-$A-compatible-v[0-9.]+\.gz" | head -1)
    [ -n "$MURL" ] || MURL=$(echo "$REL" | grep -oE "https://[^\"]*/mihomo-linux-$A-v[0-9.]+\.gz" | head -1)
    [ -n "$MURL" ] && curl -fsSL --max-time 180 -o /tmp/quasar-mihomo.gz "$MURL" && gunzip -c /tmp/quasar-mihomo.gz > /tmp/quasar-mihomo && install -m 755 /tmp/quasar-mihomo /opt/quasar/bin/mihomo
    rm -f /tmp/quasar-mihomo /tmp/quasar-mihomo.gz
  fi
  if [ ! -x /opt/quasar/bin/mihomo ]; then say "Mieru пропущен: mihomo не скачался"
  else
    mkdir -p /etc/quasar/mihomo-mieru
    echo '${miCfg}' | base64 -d > /etc/quasar/mieru.yaml && chmod 600 /etc/quasar/mieru.yaml
    if /opt/quasar/bin/mihomo -t -d /etc/quasar/mihomo-mieru -f /etc/quasar/mieru.yaml >/tmp/quasar-mieru-check.log 2>&1; then
${unit('quasar-mieru', 'Quasar Mieru (mihomo)', '/opt/quasar/bin/mihomo -d /etc/quasar/mihomo-mieru -f /etc/quasar/mieru.yaml')}
${fwOpen(miPort, 'tcp')}
      systemctl daemon-reload; systemctl enable quasar-mieru >/dev/null 2>&1; systemctl restart quasar-mieru; sleep 2
      if heal quasar-mieru ${miPort} tcp; then MIERU=1; say "Mieru запущен"; else say "Mieru не поставился (остальные протоколы работают)"; systemctl disable --now quasar-mieru >/dev/null 2>&1; fi
    else say "Mieru пропущен: mihomo не принял настройки (нужна свежая версия): $(tail -2 /tmp/quasar-mieru-check.log | tr '\n' ' ')"; fi
  fi
fi
echo "QUASAR_MIERU=$MIERU"
`;

  const juicityBlock = String.raw`
# ---------- Juicity (QUIC + TLS 1.3, UDP) ----------
say "Ставлю Juicity"
JUICITY=0
case "$A" in amd64) JA=x86_64;; arm64) JA=arm64;; *) JA="";; esac
if ss -lun 2>/dev/null | awk '{print $5}' | grep -qE "[:.]${jcPort}$" && ! systemctl is-active --quiet quasar-juicity; then say "Juicity пропущен: порт ${jcPort} (UDP) занят"
elif [ -z "$JA" ]; then say "Juicity пропущен: нет сборки под процессор $(uname -m)"
elif ! have_unz; then say "Juicity пропущен: на сервере нечем распаковать zip (нет unzip и python3)"
else
  REL=$(gh_rel juicity/juicity)
  JURL=$(echo "$REL" | grep -oE "https://[^\"]*/juicity-linux-$JA\.zip" | head -1)
  rm -rf /tmp/quasar-jc && mkdir -p /tmp/quasar-jc
  if [ -z "$JURL" ]; then say "Juicity пропущен: не нашёл сборку juicity-linux-$JA"
  elif curl -fsSL --max-time 180 -o /tmp/quasar-jc/j.zip "$JURL" && unz /tmp/quasar-jc/j.zip /tmp/quasar-jc && install -m 755 "$(find /tmp/quasar-jc -type f -name juicity-server | head -1)" /opt/quasar/bin/juicity-server; then
${mkcert('juicity')}
    echo '${jcCfg}' | base64 -d > /etc/quasar/juicity.json && chmod 600 /etc/quasar/juicity.json
${unit('quasar-juicity', 'Quasar Juicity', '/opt/quasar/bin/juicity-server run -c /etc/quasar/juicity.json --disable-timestamp')}
${fwOpen(jcPort, 'udp')}
    systemctl daemon-reload; systemctl enable quasar-juicity >/dev/null 2>&1; systemctl restart quasar-juicity; sleep 2
    if heal quasar-juicity ${jcPort} udp; then
      JUICITY=1; say "Juicity запущен ($(basename "$JURL"))"
      echo "QUASAR_JUICITY_CERT_SHA256=$(openssl x509 -in /etc/quasar/juicity-cert.pem -noout -fingerprint -sha256 | cut -d= -f2 | tr -d ':')"
    else say "Juicity не поставился (остальные протоколы работают)"; systemctl disable --now quasar-juicity >/dev/null 2>&1; fi
  else say "Juicity пропущен: не скачался"; fi
  rm -rf /tmp/quasar-jc
fi
echo "QUASAR_JUICITY=$JUICITY"
`;

  const brookBlock = String.raw`
# ---------- Brook (wssserver: HTTPS + WebSocket на секретном пути) ----------
say "Ставлю Brook"
BROOK=0
if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${bkPort}$" && ! systemctl is-active --quiet quasar-brook; then say "Brook пропущен: порт ${bkPort} занят"
else
  REL=$(gh_rel txthinking/brook)
  BURL=$(echo "$REL" | grep -oE "https://[^\"]*/brook_linux_$A\"" | tr -d '"' | head -1)
  if [ -z "$BURL" ]; then say "Brook пропущен: не нашёл сборку brook_linux_$A"
  elif curl -fsSL --max-time 180 -o /tmp/quasar-brook "$BURL" && install -m 755 /tmp/quasar-brook /opt/quasar/bin/brook; then
    rm -f /tmp/quasar-brook
${mkcert('brook')}
${unit('quasar-brook', 'Quasar Brook', `/opt/quasar/bin/brook wssserver --domainaddress ${bkSni}:${bkPort} --password ${bkPass} --path ${bkPath} --cert /etc/quasar/brook-cert.pem --certkey /etc/quasar/brook-key.pem`)}
${fwOpen(bkPort, 'tcp')}
    systemctl daemon-reload; systemctl enable quasar-brook >/dev/null 2>&1; systemctl restart quasar-brook; sleep 2
    if heal quasar-brook ${bkPort} tcp; then
      BROOK=1; say "Brook запущен"
      echo "QUASAR_BROOK_CA=$(base64 -w0 /etc/quasar/brook-cert.pem 2>/dev/null || base64 /etc/quasar/brook-cert.pem | tr -d '\n')"
    else say "Brook не поставился (остальные протоколы работают)"; systemctl disable --now quasar-brook >/dev/null 2>&1; fi
  else say "Brook пропущен: не скачался"; fi
fi
echo "QUASAR_BROOK=$BROOK"
`;

  // Общий кусок для Restls/Snell/TLSMirror: тот же бинарь mihomo, что и для Sudoku/Mieru, скачиваем один раз
  const ensureMihomo = String.raw`
  if [ ! -x /opt/quasar/bin/mihomo ]; then
    REL=$(gh_rel MetaCubeX/mihomo)
    MURL=$(echo "$REL" | grep -oE "https://[^\"]*/mihomo-linux-$A-compatible-v[0-9.]+\.gz" | head -1)
    [ -n "$MURL" ] || MURL=$(echo "$REL" | grep -oE "https://[^\"]*/mihomo-linux-$A-v[0-9.]+\.gz" | head -1)
    [ -n "$MURL" ] && curl -fsSL --max-time 180 -o /tmp/quasar-mihomo.gz "$MURL" && gunzip -c /tmp/quasar-mihomo.gz > /tmp/quasar-mihomo && install -m 755 /tmp/quasar-mihomo /opt/quasar/bin/mihomo
    rm -f /tmp/quasar-mihomo /tmp/quasar-mihomo.gz
  fi`;

  const restlsBlock = String.raw`
# ---------- Restls (mihomo, Shadowsocks 2022 + res-tls): выдаёт себя за настоящий сайт до проверки пароля ----------
say "Ставлю Restls"
RESTLS=0
if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${rtPort}$" && ! systemctl is-active --quiet quasar-restls; then say "Restls пропущен: порт ${rtPort} занят"
else
${ensureMihomo}
  if [ ! -x /opt/quasar/bin/mihomo ]; then say "Restls пропущен: mihomo не скачался"
  else
    mkdir -p /etc/quasar/mihomo-restls
    echo '${rtCfg}' | base64 -d | sed "s/__QUASAR_REALITY__/$RS/g" > /etc/quasar/restls.yaml && chmod 600 /etc/quasar/restls.yaml
    if /opt/quasar/bin/mihomo -t -d /etc/quasar/mihomo-restls -f /etc/quasar/restls.yaml >/tmp/quasar-restls-check.log 2>&1; then
${unit('quasar-restls', 'Quasar Restls (mihomo)', '/opt/quasar/bin/mihomo -d /etc/quasar/mihomo-restls -f /etc/quasar/restls.yaml')}
${fwOpen(rtPort, 'tcp')}
      systemctl daemon-reload; systemctl enable quasar-restls >/dev/null 2>&1; systemctl restart quasar-restls; sleep 2
      if heal quasar-restls ${rtPort} tcp; then RESTLS=1; say "Restls запущен"; else say "Restls не поставился (остальные протоколы работают)"; systemctl disable --now quasar-restls >/dev/null 2>&1; fi
    else say "Restls пропущен: mihomo не принял настройки (нужна свежая версия с поддержкой res-tls): $(tail -2 /tmp/quasar-restls-check.log | tr '\n' ' ')"; fi
  fi
fi
echo "QUASAR_RESTLS=$RESTLS"
`;

  const snellBlock = String.raw`
# ---------- Snell + res-tls (mihomo): протокол Surge с самой новой доступной маскировкой ----------
say "Ставлю Snell"
SNELL=0
if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${snPort}$" && ! systemctl is-active --quiet quasar-snell; then say "Snell пропущен: порт ${snPort} занят"
else
${ensureMihomo}
  if [ ! -x /opt/quasar/bin/mihomo ]; then say "Snell пропущен: mihomo не скачался"
  else
    mkdir -p /etc/quasar/mihomo-snell
    echo '${snCfg}' | base64 -d | sed "s/__QUASAR_REALITY__/$RS/g" > /etc/quasar/snell.yaml && chmod 600 /etc/quasar/snell.yaml
    if /opt/quasar/bin/mihomo -t -d /etc/quasar/mihomo-snell -f /etc/quasar/snell.yaml >/tmp/quasar-snell-check.log 2>&1; then
${unit('quasar-snell', 'Quasar Snell (mihomo)', '/opt/quasar/bin/mihomo -d /etc/quasar/mihomo-snell -f /etc/quasar/snell.yaml')}
${fwOpen(snPort, 'tcp')}
      systemctl daemon-reload; systemctl enable quasar-snell >/dev/null 2>&1; systemctl restart quasar-snell; sleep 2
      if heal quasar-snell ${snPort} tcp; then SNELL=1; say "Snell запущен"; else say "Snell не поставился (остальные протоколы работают)"; systemctl disable --now quasar-snell >/dev/null 2>&1; fi
    else say "Snell пропущен: mihomo не принял настройки (нужна свежая версия с поддержкой res-tls для Snell): $(tail -2 /tmp/quasar-snell-check.log | tr '\n' ' ')"; fi
  fi
fi
echo "QUASAR_SNELL=$SNELL"
`;

  const tlsmirrorBlock = String.raw`
# ---------- TLSMirror (mihomo, VMess + tlsmirror-config): самая новая защита, экспериментальная в mihomo ----------
say "Ставлю TLSMirror"
TLSMIRROR=0
if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${tmPort}$" && ! systemctl is-active --quiet quasar-tlsmirror; then say "TLSMirror пропущен: порт ${tmPort} занят"
else
${ensureMihomo}
  if [ ! -x /opt/quasar/bin/mihomo ]; then say "TLSMirror пропущен: mihomo не скачался"
  else
    mkdir -p /etc/quasar/mihomo-tlsmirror
    echo '${tmCfg}' | base64 -d | sed "s/__QUASAR_REALITY__/$RS/g" > /etc/quasar/tlsmirror.yaml && chmod 600 /etc/quasar/tlsmirror.yaml
    if /opt/quasar/bin/mihomo -t -d /etc/quasar/mihomo-tlsmirror -f /etc/quasar/tlsmirror.yaml >/tmp/quasar-tlsmirror-check.log 2>&1; then
${unit('quasar-tlsmirror', 'Quasar TLSMirror (mihomo)', '/opt/quasar/bin/mihomo -d /etc/quasar/mihomo-tlsmirror -f /etc/quasar/tlsmirror.yaml')}
${fwOpen(tmPort, 'tcp')}
      systemctl daemon-reload; systemctl enable quasar-tlsmirror >/dev/null 2>&1; systemctl restart quasar-tlsmirror; sleep 2
      if heal quasar-tlsmirror ${tmPort} tcp; then TLSMIRROR=1; say "TLSMirror запущен"; else say "TLSMirror не поставился (остальные протоколы работают)"; systemctl disable --now quasar-tlsmirror >/dev/null 2>&1; fi
    else say "TLSMirror пропущен: mihomo не принял настройки (нужна самая свежая версия с поддержкой tlsmirror): $(tail -2 /tmp/quasar-tlsmirror-check.log | tr '\n' ' ')"; fi
  fi
fi
echo "QUASAR_TLSMIRROR=$TLSMIRROR"
`;

  const naiveBlock = String.raw`
# ---------- NaiveProxy: домен и сертификат Let's Encrypt находятся сами ----------
say "Ставлю NaiveProxy"
NAIVE=0; ND=""
H="${hostIn}"; DOM="${domIn}"
PUB4=$(curl -4 -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)
if [ -n "$DOM" ]; then CANDS="$DOM"
elif echo "$H" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then IP="$H"; CANDS=""
elif echo "$H" | grep -q ':'; then IP=""; CANDS="$(echo "$H" | tr ':' '-').sslip.io"
else CANDS="$H"; IP="$PUB4"; fi
[ -n "$IP" ] || IP="$PUB4"
# имя, которое хостер дал серверу (обратная запись DNS), если оно указывает обратно на этот же IP
if [ -n "$IP" ] && [ -z "$DOM" ]; then
  RN=$(getent hosts "$IP" 2>/dev/null | awk '{print $2}' | head -1)
  if [ -n "$RN" ] && echo "$RN" | grep -q '\.' && getent ahostsv4 "$RN" 2>/dev/null | awk '{print $1}' | grep -qx "$IP"; then CANDS="$CANDS $RN"; fi
  D=$(echo "$IP" | tr '.' '-'); CANDS="$CANDS $D.nip.io $D.sslip.io"
fi
if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]80$" && ! systemctl is-active --quiet quasar-naive && [ -z "$DOM" ]; then
  say "NaiveProxy пропущен: порт 80 занят, а он нужен Let's Encrypt для проверки домена"
else
  for P in "80/tcp" "${nvPort}/tcp" "${nvPort}/udp"; do
    if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then ufw allow "$P" >/dev/null 2>&1; fi
    if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then firewall-cmd --permanent --add-port="$P" >/dev/null 2>&1; fi
  done
  command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld && firewall-cmd --reload >/dev/null 2>&1
  cat > /etc/systemd/system/quasar-naive.service <<'UNIT'
[Unit]
Description=Quasar Naive
After=network-online.target quasar-singbox.service
[Service]
ExecStart=/opt/quasar/bin/sing-box run -c /etc/quasar/naive.json
Restart=on-failure
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  for D in $CANDS; do
    say "NaiveProxy: пробую домен $D"
    echo '${nvCfg}' | base64 -d | sed "s/__QUASAR_DOMAIN__/$D/g" > /etc/quasar/naive.json && chmod 600 /etc/quasar/naive.json
    if ! /opt/quasar/bin/sing-box check -c /etc/quasar/naive.json >/tmp/quasar-naive-check.log 2>&1; then
      say "NaiveProxy пропущен: sing-box не принял настройки: $(tail -2 /tmp/quasar-naive-check.log | tr '\n' ' ')"; break
    fi
    systemctl restart quasar-naive
    for i in $(seq 1 30); do
      sleep 3
      ISS=$(echo | timeout 5 openssl s_client -connect 127.0.0.1:${nvPort} -servername "$D" 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null)
      if echo "$ISS" | grep -qi "let's encrypt"; then NAIVE=1; ND="$D"; break; fi
    done
    [ "$NAIVE" = 1 ] && break
    say "NaiveProxy: сертификат для $D не выдали: $(journalctl -u quasar-naive -n 20 --no-pager 2>/dev/null | grep -iE 'acme|certificate|error' | tail -1 | cut -c1-200)"
    say "  Частые причины: домен указывает не на этот сервер, порт 80 закрыт файрволом хостера, лимит Let's Encrypt на этот домен"
  done
  if [ "$NAIVE" = 1 ]; then systemctl enable quasar-naive >/dev/null 2>&1; say "NaiveProxy запущен: $ND"
  else systemctl disable --now quasar-naive >/dev/null 2>&1; [ -n "$CANDS" ] && say "NaiveProxy не встал: ни для одного домена не получилось получить сертификат"; fi
fi
echo "QUASAR_NAIVE=$NAIVE"
echo "QUASAR_NAIVE_DOMAIN=$ND"
`;
  return String.raw`#!/bin/bash
set -u
say(){ echo "QUASAR_LOG=$*"; }
die(){ echo "QUASAR_ERROR=$*"; exit 1; }
${helperBlock}
[ "$(id -u)" = 0 ] || die "Нужен root (или пользователь с sudo)"
command -v systemctl >/dev/null 2>&1 || die "На сервере нет systemd — такой сервер пока не поддерживается"
case "$(uname -m)" in x86_64|amd64) A=amd64;; aarch64|arm64) A=arm64;; *) die "Архитектура $(uname -m) не поддерживается";; esac

say "Ставлю нужные пакеты"
if command -v apt-get >/dev/null 2>&1; then export DEBIAN_FRONTEND=noninteractive; apt-get -o DPkg::Lock::Timeout=180 update -y >/dev/null 2>&1; apt-get -o DPkg::Lock::Timeout=180 install -y curl tar openssl ca-certificates unzip >/dev/null 2>&1
elif command -v dnf >/dev/null 2>&1; then dnf install -y curl tar openssl ca-certificates unzip >/dev/null 2>&1
elif command -v yum >/dev/null 2>&1; then yum install -y curl tar openssl ca-certificates unzip >/dev/null 2>&1; fi
command -v curl >/dev/null 2>&1 || die "Нет curl и поставить его не вышло"
command -v openssl >/dev/null 2>&1 || die "Нет openssl и поставить его не вышло"
say "Сверяю время сервера"
fix_time

for U in quasar-singbox quasar-photon quasar-antohin quasar-xray quasar-sudoku quasar-shadowquic quasar-naive quasar-mieru quasar-juicity quasar-brook quasar-restls quasar-snell quasar-tlsmirror; do systemctl stop "$U" >/dev/null 2>&1; done   # повторная установка: освобождаем свои же порты

say "Проверяю, что порты свободны"
BUSY=""
for P in ${checks.map((c) => `"${c}"`).join(' ')}; do
  N=$(echo "$P" | cut -d/ -f1); T=$(echo "$P" | cut -d/ -f2)
  if [ "$T" = tcp ]; then ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$N$" && BUSY="$BUSY $P"
  else ss -lun 2>/dev/null | awk '{print $5}' | grep -qE "[:.]$N$" && BUSY="$BUSY $P"; fi
done
[ -z "$BUSY" ] || die "Эти порты на сервере уже заняты:$BUSY. Выбери другие порты или освободи эти"

say "Скачиваю sing-box"
VER=$(gh_rel SagerNet/sing-box | grep -m1 '"tag_name"' | sed -E 's/.*"v([^"]+)".*/\1/')
[ -n "$VER" ] || die "Не удалось узнать последнюю версию sing-box (нет доступа к GitHub?)"
mkdir -p /opt/quasar/bin
rm -rf /tmp/quasar-sb && mkdir -p /tmp/quasar-sb
curl -fsSL --max-time 180 -o /tmp/quasar-sb/sb.tgz "https://github.com/SagerNet/sing-box/releases/download/v$VER/sing-box-$VER-linux-$A.tar.gz" || die "Не скачался sing-box $VER"
tar -xzf /tmp/quasar-sb/sb.tgz -C /tmp/quasar-sb || die "Не распаковался архив sing-box"
install -m 755 "/tmp/quasar-sb/sing-box-$VER-linux-$A/sing-box" /opt/quasar/bin/sing-box || die "Не получилось поставить sing-box"
rm -rf /tmp/quasar-sb
say "sing-box $VER установлен"

mkdir -p /etc/quasar /var/lib/quasar
${selfSigned ? String.raw`say "Создаю сертификат"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout /etc/quasar/key.pem -out /etc/quasar/cert.pem -days 3650 -subj "/CN=${plan.certSni}" >/dev/null 2>&1 || die "Не получилось создать сертификат"
chmod 600 /etc/quasar/key.pem
echo "QUASAR_CERT_SHA256=$(openssl x509 -in /etc/quasar/cert.pem -noout -fingerprint -sha256 | cut -d= -f2 | tr -d ':')"` : 'say "Сертификат выпустит сам sing-box для домена ' + plan.domain + '"'}


say "Подбираю сайт для маскировки VLESS Reality (TLS 1.3, HTTP/2, X25519, скорость от сервера)"
RS=""; BEST=999999
cms(){ case "$1" in ${Object.entries(plan.realityTimings || {}).map(([h, ms]) => `${h}) echo ${ms};;`).join(' ')} *) echo 0;; esac; }
for D in ${plan.realityCandidates.join(' ')}; do
  OUT=$(echo | timeout 8 openssl s_client -connect "$D:443" -servername "$D" -tls1_3 -alpn h2 -curves X25519 2>/dev/null)
  if ! echo "$OUT" | grep -q "TLSv1.3"; then say "  $D: не подходит (нет TLS 1.3, X25519 или HTTP/2, либо не отвечает)"; continue; fi
  if ! echo "$OUT" | grep -q "ALPN protocol: h2"; then say "  $D: не подходит (нет HTTP/2)"; continue; fi
  MS=999999
  for k in 1 2 3; do
    T0=$(date +%s%N); echo | timeout 5 openssl s_client -connect "$D:443" -servername "$D" -tls1_3 >/dev/null 2>&1 && { T=$(( ($(date +%s%N) - T0) / 1000000 )); [ "$T" -lt "$MS" ] && MS=$T; }
  done
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "https://$D/" 2>/dev/null)
  PEN=0; case "$CODE" in 3*) PEN=500;; 000) PEN=1000;; esac
  CM=$(cms "$D")
  say "  $D: подходит, $MS мс от сервера, $CM мс от твоего компьютера, ответ $CODE"
  if [ $((MS + PEN + CM)) -lt "$BEST" ]; then BEST=$((MS + PEN + CM)); RS="$D"; fi
done
if [ -z "$RS" ]; then RS="${plan.realitySni}"; say "Ни один сайт не прошёл проверку, беру $RS"; fi
say "Маскировка VLESS Reality и XHTTP: $RS"
echo "QUASAR_REALITY_SNI=$RS"

say "Записываю настройки"
# прежние настройки — в запас: если новые sing-box не примет, сервер вернётся к рабочему состоянию
[ -s /etc/quasar/config.json ] && cp -f /etc/quasar/config.json /etc/quasar/config.json.prev
echo '${cfgB64}' | base64 -d | sed "s/__QUASAR_REALITY__/$RS/g" > /etc/quasar/config.json || die "Не получилось записать настройки"
chmod 600 /etc/quasar/config.json
if ! /opt/quasar/bin/sing-box check -c /etc/quasar/config.json 2>/tmp/quasar-check.log; then
  WHY=$(tail -3 /tmp/quasar-check.log | tr '\n' ' ')
  if [ -s /etc/quasar/config.json.prev ]; then
    cp -f /etc/quasar/config.json.prev /etc/quasar/config.json
    for U in quasar-singbox quasar-photon quasar-antohin quasar-xray quasar-sudoku quasar-shadowquic quasar-naive quasar-mieru quasar-juicity quasar-brook quasar-restls quasar-snell quasar-tlsmirror; do systemctl is-enabled --quiet "$U" 2>/dev/null && systemctl start "$U" >/dev/null 2>&1; done
    die "sing-box не принял новые настройки: $WHY. Сервер возвращён к прежним настройкам, прежние протоколы работают"
  fi
  die "sing-box не принял настройки: $WHY"
fi

cat > /etc/systemd/system/quasar-singbox.service <<'UNIT'
[Unit]
Description=Quasar sing-box
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=/opt/quasar/bin/sing-box run -c /etc/quasar/config.json
Restart=on-failure
RestartSec=3
LimitNOFILE=1048576
[Install]
WantedBy=multi-user.target
UNIT

say "Открываю порты в брандмауэре и включаю BBR"
for P in ${checks.map((c) => `"${c}"`).join(' ')}; do
  N=$(echo "$P" | cut -d/ -f1); T=$(echo "$P" | cut -d/ -f2)
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then ufw allow "$N/$T" >/dev/null 2>&1; fi
  if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then firewall-cmd --permanent --add-port="$N/$T" >/dev/null 2>&1; fi
done
command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld && firewall-cmd --reload >/dev/null 2>&1
if ! sysctl net.ipv4.tcp_congestion_control 2>/dev/null | grep -q bbr; then
  grep -q "tcp_congestion_control=bbr" /etc/sysctl.conf 2>/dev/null || { echo "net.core.default_qdisc=fq" >> /etc/sysctl.conf; echo "net.ipv4.tcp_congestion_control=bbr" >> /etc/sysctl.conf; }
  sysctl -p >/dev/null 2>&1
fi

say "Запускаю"
systemctl daemon-reload
systemctl enable quasar-singbox >/dev/null 2>&1
systemctl restart quasar-singbox
sleep 3
heal quasar-singbox ${plan.ports.vless} tcp || die "Основной sing-box не запустился, причина выше"
say "Hysteria2 и TUIC работают по UDP (порты ${plan.ports.hysteria2} и ${plan.ports.tuic}): если с твоего компьютера они не подключаются, а VLESS работает, хостер или провайдер режет UDP: открой UDP-порты в панели хостинга или используй протоколы по TCP"
${photonBlock}${antohinBlock}${xrayBlock}${sudokuBlock}${sqBlock}${mieruBlock}${juicityBlock}${brookBlock}${restlsBlock}${snellBlock}${tlsmirrorBlock}${naiveBlock}
echo "QUASAR_DONE=1"
`;
}

module.exports = { installScript };
