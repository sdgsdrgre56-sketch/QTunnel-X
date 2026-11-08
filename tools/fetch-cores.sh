#!/usr/bin/env bash
# Кладёт ядра как libXXX.so в app/src/main/jniLibs/arm64-v8a (Квазар ищет их там). Ядро, которое не нашлось, пропускается.
OUT=app/src/main/jniLibs/arm64-v8a
mkdir -p "$OUT"
fetch() {  # репозиторий  регулярка-имени-файла  имя-программы-внутри  имя-в-APK
  local repo=$1 re=$2 bin=$3 out=$4
  local name; name=$(gh release view --repo "$repo" --json assets --jq '.assets[].name' 2>/dev/null | grep -E "$re" | head -1)
  if [ -z "$name" ]; then echo "ПРОПУЩЕНО $out: в $repo нет файла по $re"; gh release view --repo "$repo" --json assets --jq '.assets[].name' 2>/dev/null | head -40; return 0; fi
  local tmp; tmp=$(mktemp -d); mkdir "$tmp/x"
  gh release download --repo "$repo" --pattern "$name" --dir "$tmp" || { echo "ПРОПУЩЕНО $out: не скачался $name"; return 0; }
  case "$name" in
    *.zip) unzip -q "$tmp/$name" -d "$tmp/x" ;;
    *.tar.gz|*.tgz) tar -xzf "$tmp/$name" -C "$tmp/x" ;;
    *.tar.xz) tar -xJf "$tmp/$name" -C "$tmp/x" ;;
    *.gz) gunzip -c "$tmp/$name" > "$tmp/x/$bin" ;;
    *) cp "$tmp/$name" "$tmp/x/$bin" ;;
  esac
  local f; f=$(find "$tmp/x" -type f -name "$bin" | head -1); [ -n "$f" ] || f=$(find "$tmp/x" -type f -name "$bin*" | head -1)
  [ -n "$f" ] || f=$(find "$tmp/x" -type f | head -1)
  cp "$f" "$OUT/lib$out.so" && chmod +x "$OUT/lib$out.so" && echo "OK lib$out.so <- $name"
}
fetch SagerNet/sing-box          'android-arm64\.tar\.gz$'                              sing-box        singbox
fetch MetaCubeX/mihomo           '^mihomo-android-arm64(-v8)?-v[0-9.]+\.gz$'            mihomo          mihomo
fetch XTLS/Xray-core             '^Xray-android-arm64-v8a\.zip$'                        xray            xray
fetch klzgrad/naiveproxy         'android.*arm64.*\.tar\.xz$'                           naive           naive
fetch txthinking/brook           '^brook_linux_arm64$'                                  brook           brook
fetch Diniboy1123/usque          'android.*arm64.*\.zip$'                               usque           usque
fetch spongebob888/shadowquic    'aarch64.*(android|linux)|android.*(aarch64|arm64)'    shadowquic      shadowquic
fetch juicity/juicity            'android.*arm64.*\.zip$|linux-arm64.*\.zip$'           juicity-client  juicityclient
ls -la "$OUT"
