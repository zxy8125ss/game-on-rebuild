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

FONT_DIR_ABS="file://$ROOT/fonts/"
SVG_RAW="$(sed -e "s|\.\./fonts/|${FONT_DIR_ABS}|g" "$SRC")"

if [ -z "$SVG_RAW" ]; then
  echo "✗ SVG 读取失败"
  exit 1
fi

render() {
  local filename="$1" size="$2" variant="$3"
  # 图形占比（整数百分比，写成 1 会被当成 1% 导致 SVG 缩成几像素 —— 空图）：
  # normal 满幅；flat 稍收；maskable 必须缩进 Android 安全区
  local art_scale=100 radius=0
  case "$variant" in
    normal)   radius=$(( size * 219 / 1000 )); art_scale=100 ;;
    flat)     art_scale=94 ;;
    maskable) art_scale=66 ;;
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
  # 每个尺寸用独立 profile，避免复用时的状态/缓存干扰
  # --virtual-time-budget 要给足：@font-face 加载完成前 SVG 可能还没画完，
  # 时间不够就会截到空白图
  "$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars \
    --no-first-run --no-default-browser-check \
    --user-data-dir="$TMP/profile-$filename" \
    --force-device-scale-factor=1 --default-background-color=00000000 \
    --allow-file-access-from-files \
    --virtual-time-budget=6000 \
    --window-size="${size},${size}" \
    --screenshot="$TMP/$filename.png" \
    "file://$TMP/$filename.html" >/dev/null 2>&1

  if [ -f "$TMP/$filename.png" ]; then
    cp "$TMP/$filename.png" "$OUT/$filename"
    # 校验：票根是白色 #FFFDF8，背景是绿色 #3C8A5A。
    # 绿色占比接近 100% 说明图形没渲染出来（空图），必须拦下。
    if ! python3 - "$OUT/$filename" <<'PY'
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
w, h = im.size
px = im.load()
green = 0
white = 0
for y in range(0, h, 2):
    for x in range(0, w, 2):
        r, g, b = px[x, y]
        if abs(r - 60) < 12 and abs(g - 138) < 12 and abs(b - 90) < 12:
            green += 1
        elif r > 235 and g > 235 and b > 225:
            white += 1
total = (h // 2 + 1) * (w // 2 + 1)
gp = green / total
wp = white / total
ok = 0.08 < wp < 0.85 and gp < 0.92
print('    检查: 绿 %.0f%%  白 %.0f%% %s' % (gp * 100, wp * 100, 'OK' if ok else '❌ 空图'))
sys.exit(0 if ok else 1)
PY
    then
      echo "  ✗ $filename 是空图，已中止"
      exit 1
    fi
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
