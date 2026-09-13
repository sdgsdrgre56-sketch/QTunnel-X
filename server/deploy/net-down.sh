#!/bin/sh
WAN="$(ip route show default | awk '/default/ {print $5; exit}')"
[ -z "$WAN" ] && exit 0
iptables -t nat -D POSTROUTING -s 10.44.0.0/24 -o "$WAN" -m comment --comment QTunnelX -j MASQUERADE 2>/dev/null || true
iptables -D FORWARD -i qtx0 -o "$WAN" -m comment --comment QTunnelX -j ACCEPT 2>/dev/null || true
iptables -D FORWARD -i "$WAN" -o qtx0 -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment QTunnelX -j ACCEPT 2>/dev/null || true
