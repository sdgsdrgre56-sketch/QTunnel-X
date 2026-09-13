#!/bin/sh
set -eu
for i in $(seq 1 30); do ip link show qtx0 >/dev/null 2>&1 && break; sleep 0.1; done
ip addr replace 10.44.0.1/24 dev qtx0
ip link set dev qtx0 mtu 1280 up
sysctl -w net.ipv4.ip_forward=1 >/dev/null
WAN="$(ip route show default | awk '/default/ {print $5; exit}')"
[ -n "$WAN" ]
iptables -t nat -C POSTROUTING -s 10.44.0.0/24 -o "$WAN" -m comment --comment QTunnelX -j MASQUERADE 2>/dev/null || \
  iptables -t nat -A POSTROUTING -s 10.44.0.0/24 -o "$WAN" -m comment --comment QTunnelX -j MASQUERADE
iptables -C FORWARD -i qtx0 -o "$WAN" -m comment --comment QTunnelX -j ACCEPT 2>/dev/null || \
  iptables -A FORWARD -i qtx0 -o "$WAN" -m comment --comment QTunnelX -j ACCEPT
iptables -C FORWARD -i "$WAN" -o qtx0 -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment QTunnelX -j ACCEPT 2>/dev/null || \
  iptables -A FORWARD -i "$WAN" -o qtx0 -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment QTunnelX -j ACCEPT
