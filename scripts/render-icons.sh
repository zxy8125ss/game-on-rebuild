#!/usr/bin/env bash
# 用 Chrome headless 命令行把 SVG 渲染成各尺寸 PNG。
# 比 CDP 简单可靠：直接 --screenshot，不用管 session。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
SRC="$ROOT/scripts/icon-source.svg"
OUT="$ROOT/icons"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FONT_ABS="file://$ROOT/fonts/barlow-condensed-latin-700-normal.woff2"
SVG_RAW="$(cat "$SRC")"
# 字体路径改成绝对 file:// 地址（内联 SVG 后相对路径失效）
SVG_RAW="${SVG_RAW//url(\"..\/fonts\//url(\"$FONT_ABS/}"

render() {
  local filename="$1" size="$2" variant="$3"
  # 图形占比：normal 满幅；flat 稍收；maskable 必须缩进 Android 安全区
  local art_scale=1 radius=0
  case "$variant" in
    normal)   radius=$(( size * 219 / 1000 )); art_scale=1 ;;
    flat)     art_scale=0.94 ;;
    maskable) art_scale=0.66 ;;
  esac

  local inner
  inner="$(printf '%s' "$SVG_RAW" | sed -e 's/<?xml[^>]*?>//' -e 's/width="512" height="512"//')"

  cat > "$TMP/$filename.html" <<HTML
<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0}
html,body{background:transparent}
.w{width:${size}px;height:${size}px;overflow:hidden;position:relative;
  display:flex;align-items:center;justify-content:center}
.bg{position:absolute;inset:0;background:#3C8A5A;border-radius:${radius}px}
.art{position:relative;width:${size}px;height:${size}px;
  display:flex;align-items:center;justify-content:center}
.art>svg{width:${art_scale}%;height:${art_scale}%;display:block}
</style></head><body><div class="w"><div class="bg"></div><div class="art">$inner</div></div></body></html>
HTML

  # --user-data-dir 指向项目内的临时目录：
  # 否则 Chrome headless 会在 ~/Library/Application Support/Google/Chrome-headless/
  # 下建 scoped_dir 并尝试清理，触发系统权限拦截
  "$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars \
    --no-first-run --no-default-browser-check \
    --user-data-dir="$TMP/profile" \
    --force-device-scale-factor=1 --default-background-color=00000000 \
    --allow-file-access-from-files \
    --virtual-time-budget=3000 \
    --window-size="${size},${size}" \
    --screenshot="$TMP/$filename.png" \
    "file://$TMP/$filename.html" >/dev/null 2>&1

  if [ -f "$TMP/$filename.png" ]; then
    cp "$TMP/$filename.png" "$OUT/$filename"
    echo "written $filename (${size}px)"
  else
    echo "✗ 渲染失败: $filename"
    exit 1
  fi
}

mkdir -p "$OUT"
render "icon-512.png"        512 normal
render "icon-192.png"        192 normal
render "icon-180.png"        180 flat
render "icon-maskable-512.png" 512 maskable

# 小尺寸预览：验证缩到手机桌面实际大小（约 60px）时是否还清晰
python3 - "$OUT" <<'PY'
import sys, os
from PIL import Image
out = sys.argv[1]
src = Image.open(os.path.join(out, 'icon-512.png')).convert('RGBA')
sizes = [120, 60, 40]
sheet = Image.new('RGBA', (sum(sizes) + 40 * len(sizes), 140), (245, 246, 248, 255))
x = 20
for s in sizes:
    sheet.paste(src.resize((s, s), Image.LANCZOS), (x, 20), src.resize((s, s), Image.LANCZOS))
    x += s + 40
sheet.save(os.path.join(out, '..', 'scripts', 'shots', 'icon-small.png'))
print('written scripts/shots/icon-small.png')
PY
