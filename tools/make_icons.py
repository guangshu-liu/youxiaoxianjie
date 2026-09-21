#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make_icons.py — 生成 PWA / 主屏幕图标，纯标准库。

为什么手写 PNG 而不是用 Pillow：这个项目的硬规则是零第三方依赖
（半年后回来 `pip install` 失败就构建不出来）。PNG 的格式足够简单 ——
签名 + IHDR + zlib 压的扫描线 + IEND，40 行就够，没必要为此引入 Pillow。

图标设计：满幅暖橙渐变底 + 居中的奶油色五角星。
- **满幅不留透明圆角**：iOS 的 apple-touch-icon 会自己套圆角蒙版，
  如果你预先切了圆角，套上去会出现两层圆角之间的白边。
- **星星只占中间约 55%**：Android 的 maskable 图标会按自己的形状裁切，
  内容必须落在中间安全区内，否则会被切掉一角。

用法：
    python3 tools/make_icons.py            # 生成到 src/icons/
    python3 tools/make_icons.py --out DIR
"""

import argparse
import math
import os
import struct
import sys
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 与 src/css/base.css 的 --c-primary / --c-primary-d / --c-bg 保持一致
COLOR_TOP = (0xFF, 0x8A, 0x65)
COLOR_BOTTOM = (0xF4, 0x70, 0x3F)
COLOR_STAR = (0xFF, 0xF8, 0xE7)

MASTER = 512
SIZES = {
    'icon-180.png': 180,   # iOS apple-touch-icon
    'icon-192.png': 192,   # Android manifest
    'icon-512.png': 512,   # manifest / 启动画面
    'favicon-32.png': 32,  # 浏览器标签页
}

SS = 3          # 超采样倍数，抗锯齿用。3 已经看不出锯齿，再高只是变慢。
STAR_SCALE = 0.55   # 星星外径 / 画布边长 —— 留够 maskable 的安全区


# ---------------------------------------------------------------- PNG

def _chunk(typ, data):
    return (struct.pack('>I', len(data)) + typ + data
            + struct.pack('>I', zlib.crc32(typ + data) & 0xffffffff))


def write_png(path, width, height, pixels):
    """pixels: 扁平的 RGBA bytes，长度 width*height*4。"""
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)                                  # 每行的 filter byte
        raw += pixels[y * stride:(y + 1) * stride]
    png = (b'\x89PNG\r\n\x1a\n'
           + _chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
           + _chunk(b'IDAT', zlib.compress(bytes(raw), 9))
           + _chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)
    return len(png)


# ---------------------------------------------------------------- 几何

def star_polygon(cx, cy, outer, points=5, inner_ratio=0.382, rot=-math.pi / 2):
    """五角星的顶点列表。inner_ratio 取 0.382 是经典五角星的黄金比例。"""
    inner = outer * inner_ratio
    pts = []
    for i in range(points * 2):
        r = outer if i % 2 == 0 else inner
        a = rot + i * math.pi / points
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def point_in_poly(x, y, poly):
    """射线法。星星是简单多边形，这个够用。"""
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y):
            if x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                inside = not inside
        j = i
    return inside


def lerp(a, b, t):
    return a + (b - a) * t


# ---------------------------------------------------------------- 绘制

def render_master():
    """渲染 512×512 主图，返回扁平 RGBA bytes。超采样后平均得到抗锯齿。"""
    n = MASTER
    star = star_polygon(n / 2, n / 2, n * STAR_SCALE / 2)
    out = bytearray(n * n * 4)
    inv = 1.0 / (SS * SS)

    for py in range(n):
        for px in range(n):
            r = g = b = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    x = px + (sx + 0.5) / SS
                    y = py + (sy + 0.5) / SS
                    if point_in_poly(x, y, star):
                        cr, cg, cb = COLOR_STAR
                    else:
                        t = y / n
                        cr = lerp(COLOR_TOP[0], COLOR_BOTTOM[0], t)
                        cg = lerp(COLOR_TOP[1], COLOR_BOTTOM[1], t)
                        cb = lerp(COLOR_TOP[2], COLOR_BOTTOM[2], t)
                    r += cr
                    g += cg
                    b += cb
            i = (py * n + px) * 4
            out[i] = int(r * inv + 0.5)
            out[i + 1] = int(g * inv + 0.5)
            out[i + 2] = int(b * inv + 0.5)
            out[i + 3] = 255
    return out


def downsample(src, src_size, dst_size):
    """盒式滤波缩小。从 512 主图生成小尺寸比重新渲染快得多，
    而且 512→180 这种非整数倍缩放，盒式滤波的效果已经足够好。"""
    if dst_size == src_size:
        return bytes(src)
    out = bytearray(dst_size * dst_size * 4)
    ratio = src_size / dst_size
    for dy in range(dst_size):
        y0 = int(dy * ratio)
        y1 = max(int((dy + 1) * ratio), y0 + 1)
        for dx in range(dst_size):
            x0 = int(dx * ratio)
            x1 = max(int((dx + 1) * ratio), x0 + 1)
            r = g = b = a = 0
            cnt = 0
            for sy in range(y0, y1):
                base = sy * src_size * 4
                for sx in range(x0, x1):
                    i = base + sx * 4
                    r += src[i]
                    g += src[i + 1]
                    b += src[i + 2]
                    a += src[i + 3]
                    cnt += 1
            o = (dy * dst_size + dx) * 4
            out[o] = r // cnt
            out[o + 1] = g // cnt
            out[o + 2] = b // cnt
            out[o + 3] = a // cnt
    return out


def ensure_icons(outdir, quiet=False):
    """生成全部尺寸。已存在则跳过 —— 构建时调用，不必每次重画。"""
    os.makedirs(outdir, exist_ok=True)
    todo = [(name, size) for name, size in sorted(SIZES.items())
            if not os.path.exists(os.path.join(outdir, name))]
    if not todo:
        if not quiet:
            print('  图标已存在，跳过（共 %d 个）' % len(SIZES))
        return []

    master = render_master()
    made = []
    for name, size in todo:
        pixels = downsample(master, MASTER, size)
        path = os.path.join(outdir, name)
        n = write_png(path, size, size, pixels)
        made.append((name, size, n))
        if not quiet:
            print('  %s  %d×%d  %.1f KB' % (name, size, size, n / 1024))
    return made


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description='生成 PWA 图标（纯标准库）')
    ap.add_argument('--out', default=os.path.join(ROOT, 'src', 'icons'))
    ap.add_argument('--force', action='store_true', help='重新生成（覆盖已有）')
    args = ap.parse_args()

    if args.force:
        for name in SIZES:
            p = os.path.join(args.out, name)
            if os.path.exists(p):
                os.remove(p)

    print('生成图标 → %s' % os.path.relpath(args.out, ROOT))
    made = ensure_icons(args.out)
    if not made:
        print('  全部已存在。要重新生成加 --force。')
        return 0

    total = sum(m[2] for m in made)
    print('  共 %d 个文件，%.1f KB' % (len(made), total / 1024))
    return 0


if __name__ == '__main__':
    sys.exit(main())
