#!/usr/bin/env python3
"""生成 Game On 图标：SVG 源 + PNG 各尺寸 + maskable 自适应 + apple-touch-icon。

设计：深绿圆角方块 + 白��「GAME ON」双行字，中间一条横线（赛道感）。
"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'icons')
os.makedirs(OUT, exist_ok=True)

BG = (60, 138, 90)        # --lamp #3C8A5A
FG = (255, 253, 248)      # --surface #FFFDF8
SIZE = 512


def font(size, bold=True):
    """找一个能用的西文字体，找不到退回默认。"""
    candidates = [
        '/System/Library/Fonts/Supplemental/Arial Bold.ttf' if bold else
        '/System/Library/Fonts/Supplemental/Arial.ttf',
        '/System/Library/Fonts/Helvetica.ttc',
        '/Library/Fonts/Arial.ttf',
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def draw_mark(d, cx, cy, scale):
    """画 GAME / ON 两行字 + 中间横线。scale 为整体缩放比例。"""
    f1 = font(int(96 * scale), True)
    f2 = font(int(104 * scale), True)

    def centered(text, fnt, y):
        bbox = d.textbbox((0, 0), text, font=fnt)
        w = bbox[2] - bbox[0]
        d.text((cx - w / 2 - bbox[0], y), text, font=fnt, fill=FG)

    centered('GAME', f1, cy - 108 * scale)
    # 中间的赛道横线
    lw = 150 * scale
    ly = cy - 6 * scale
    d.rounded_rectangle([cx - lw / 2, ly, cx + lw / 2, ly + 10 * scale],
                        radius=int(5 * scale), fill=FG)
    centered('ON', f2, cy + 20 * scale)


def make_png(size, filename, maskable=False):
    img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        d.rectangle([0, 0, SIZE, SIZE], fill=BG)
        draw_mark(d, SIZE / 2, SIZE / 2, 0.72)
    else:
        d.rounded_rectangle([0, 0, SIZE, SIZE], radius=112, fill=BG)
        draw_mark(d, SIZE / 2, SIZE / 2, 0.92)
    if size != SIZE:
        img = img.resize((size, size), Image.LANCZOS)
    img.save(os.path.join(OUT, filename), 'PNG')
    print('written', filename, img.size)


make_png(192, 'icon-192.png')
make_png(512, 'icon-512.png')
make_png(512, 'icon-maskable-512.png', maskable=True)
make_png(180, 'icon-180.png')

# SVG 版本（矢量、可任意缩放）
svg = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" rx="112" fill="#3C8A5A"/>
  <text x="256" y="176" font-family="Arial Black, Arial, sans-serif" font-size="96" font-weight="900"
        fill="#FFFDF8" text-anchor="middle" letter-spacing="2">GAME</text>
  <rect x="181" y="250" width="150" height="10" rx="5" fill="#FFFDF8"/>
  <text x="256" y="374" font-family="Arial Black, Arial, sans-serif" font-size="104" font-weight="900"
        fill="#FFFDF8" text-anchor="middle" letter-spacing="2">ON</text>
</svg>
'''
with open(os.path.join(OUT, 'icon.svg'), 'w', encoding='utf-8') as f:
    f.write(svg)
print('written icon.svg')
