'use strict';
// Снятие с сервера того, что поставил Квазар. Принцип: трогаем только своё (службы quasar-*, папки /opt/quasar*, /etc/quasar,
// /var/lib/quasar) и правила брандмауэра для своих портов, но только если после остановки на порту никто больше не слушает.
// Панели (3x-ui, x-ui и т. п.), Node.js, nginx и прочее остаётся как было.
const UNITS = ['quasar-singbox', 'quasar-xray', 'quasar-sudoku', 'quasar-shadowquic', 'quasar-naive', 'quasar-photon', 'quasar-antohin', 'quasar-mieru', 'quasar-juicity', 'quasar-brook', 'quasar-restls', 'quasar-snell', 'quasar-tlsmirror'];
const DIRS = ['/opt/quasar', '/opt/quasar-photon', '/opt/quasar-antohin', '/etc/quasar', '/var/lib/quasar'];

function uninstallScript(ports = []) {
  const list = [...new Set(ports.map(String).filter((x) => /^\d{1,5}\/(tcp|udp)$/.test(x)))].join(' ');
  return String.raw`#!/bin/bash
say(){ echo "QUASAR_LOG=$*"; }
die(){ echo "QUASAR_ERROR=$*"; exit 1; }
[ "$(id -u)" = 0 ] || die "Нужен root: без него службы не снять"
for U in ${UNITS.join(' ')}; do
  if [ -f "/etc/systemd/system/$U.service" ]; then
    systemctl disable --now "$U" >/dev/null 2>&1; rm -f "/etc/systemd/system/$U.service"; say "Служба $U снята"
  fi
done
systemctl daemon-reload >/dev/null 2>&1; systemctl reset-failed >/dev/null 2>&1
for D in ${DIRS.join(' ')}; do [ -e "$D" ] && { rm -rf -- "$D"; say "Папка $D удалена"; }; done
rm -rf /tmp/quasar-* 2>/dev/null
# Порты: правило убираем, только если порт больше никто не слушает (вдруг там чья-то панель)
for P in ${list}; do
  N=$(echo "$P" | cut -d/ -f1); T=$(echo "$P" | cut -d/ -f2)
  if [ "$T" = udp ]; then BUSY=$(ss -lun 2>/dev/null | awk '{print $5}' | grep -cE "[:.]$N$"); else BUSY=$(ss -ltn 2>/dev/null | awk '{print $4}' | grep -cE "[:.]$N$"); fi
  if [ "$BUSY" != 0 ]; then say "Порт $P оставлен: его слушает другая программа"; continue; fi
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then ufw delete allow "$P" >/dev/null 2>&1; fi
  if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then firewall-cmd --permanent --remove-port="$P" >/dev/null 2>&1; fi
done
command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld && firewall-cmd --reload >/dev/null 2>&1
say "Не тронуто: ваши панели и сайты, Node.js, nginx, пакеты и остальные службы"
echo "QUASAR_DONE=1"
`;
}
module.exports = { uninstallScript, UNITS, DIRS };
