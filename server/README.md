# QTunnel X Server v0.4

Commands:

```sh
qtunnelx-server user-add -username phone1 -password PASS -ip 10.44.0.2 -upload-mbps 10 -download-mbps 50
qtunnelx-server user-list
qtunnelx-server user-speed -username phone1 -upload-mbps 5 -download-mbps 20
qtunnelx-server user-del -username phone1
qtunnelx-server serve -config /etc/qtunnelx/users.json -listen :46000 -tun qtx0
```

Speed value `0` means unlimited. Limits are enforced on the server per user in both directions.
