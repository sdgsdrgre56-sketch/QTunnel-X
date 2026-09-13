# QTunnel X v0.4.1

Проверенный пакет для GitHub Actions.

После загрузки файлов в ветку `main` GitHub запускает две проверки:

1. Android: Java 17 + Android SDK 35 + Gradle 8.9 -> `assembleDebug`.
2. Server: `go test ./...` + сборка Linux x86-64 и ARM64.

Готовый APK:
`Actions -> Build QTunnel X -> Artifacts -> QTunnel-X-APK`

Серверные бинарники:
`Actions -> Build QTunnel X -> Artifacts -> QTunnel-X-Server`

В папке `server/` также уже лежат предварительно собранные x86-64 и ARM64 бинарники, поэтому `server/deploy/install.sh` не остаётся без требуемого файла.

## Проверено локально

- `go test ./...` — OK
- `go build ./cmd/qtunnelx-server` — OK
- `bash -n` для deploy-скриптов — OK
- Android/Go формат шифрованного кадра сверён: `QTX1`, version 1, username, 12-byte nonce, AES-256-GCM.
- PBKDF2-HMAC-SHA256: 100000 итераций, 256-bit key на обеих сторонах.

Финальную Android-компиляцию выполняет GitHub Actions, потому что локальная среда этой сессии не содержит Android SDK.
