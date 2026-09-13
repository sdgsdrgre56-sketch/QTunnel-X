#!/bin/sh
set -eu
if [ "$(id -u)" -ne 0 ]; then echo "Run as root: sudo ./install.sh"; exit 1; fi
BASE="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
command -v ip >/dev/null || { echo "iproute2 is required"; exit 1; }
command -v iptables >/dev/null || { echo "iptables is required"; exit 1; }
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) BIN="$BASE/qtunnelx-server-amd64" ;;
  aarch64|arm64) BIN="$BASE/qtunnelx-server-arm64" ;;
  *) echo "Unsupported CPU architecture: $ARCH"; exit 1 ;;
esac
install -m 0755 "$BIN" /usr/local/bin/qtunnelx-server
install -d -m 0700 /etc/qtunnelx /usr/local/lib/qtunnelx
install -m 0755 "$BASE/deploy/net-up.sh" /usr/local/lib/qtunnelx/net-up.sh
install -m 0755 "$BASE/deploy/net-down.sh" /usr/local/lib/qtunnelx/net-down.sh
install -m 0644 "$BASE/deploy/qtunnelx.service" /etc/systemd/system/qtunnelx.service

if [ ! -s /etc/qtunnelx/users.json ]; then
  PASS="$(od -An -N18 -tx1 /dev/urandom | tr -d ' \n')"
  /usr/local/bin/qtunnelx-server user-add -config /etc/qtunnelx/users.json -username client1 -password "$PASS" -ip 10.44.0.2
  umask 077
  cat > /root/qtunnelx-first-client.txt <<CREDS
QTunnel X first client
Username: client1
Password: $PASS
Client IP: 10.44.0.2
UDP port: 46000
DNS: 1.1.1.1
CREDS
fi

# Open UDP port when UFW is installed and active.
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  ufw allow 46000/udp >/dev/null
fi

systemctl daemon-reload
systemctl enable --now qtunnelx.service

echo
echo "QTunnel X installed."
echo "First-client credentials (if newly created): /root/qtunnelx-first-client.txt"
echo "Add user: qtunnelx-server user-add -username NAME -password PASS -upload-mbps 10 -download-mbps 50"
echo "Set speed: qtunnelx-server user-speed -username NAME -upload-mbps 10 -download-mbps 50"
echo "List users: qtunnelx-server user-list"
echo "Server status: systemctl status qtunnelx"
