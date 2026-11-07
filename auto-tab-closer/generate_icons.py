#!/usr/bin/env python3
"""Generate extension icons using only Python stdlib (struct + zlib). No PIL needed."""
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).parent / 'extension' / 'icons'
OUT.mkdir(parents=True, exist_ok=True)

# Design: orange background, white X (auto-close / logout metaphor)
BG   = (234, 88,  12,  255)  # orange-600
FG   = (255, 255, 255, 255)  # white
DARK = (154, 52,  18,  255)  # orange-800 for depth


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(4))


def png(size, pixels):
    def chunk(name, data):
        c = name + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xFFFFFFFF)

    raw = b''
    for y in range(size):
        raw += b'\x00'
        for x in range(size):
            raw += bytes(pixels[y * size + x])

    header = b'\x89PNG\r\n\x1a\n'
    ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    idat = chunk(b'IDAT', zlib.compress(raw, 9))
    iend = chunk(b'IEND', b'')
    return header + ihdr + idat + iend


def make_icon(size):
    pixels = [BG] * (size * size)
    s = size

    def fill(x0, y0, x1, y1, color):
        for y in range(max(0, y0), min(s, y1)):
            for x in range(max(0, x0), min(s, x1)):
                pixels[y * s + x] = color

    def set_pixel(x, y, color):
        if 0 <= x < s and 0 <= y < s:
            pixels[y * s + x] = color

    # Rounded square background — darken edges slightly
    margin = max(1, s // 8)
    for y in range(s):
        for x in range(s):
            dx = min(x, s - 1 - x)
            dy = min(y, s - 1 - y)
            d = min(dx, dy)
            if d < margin:
                pixels[y * s + x] = lerp(DARK, BG, d / margin)

    # Draw a thick X centered in the icon
    thick = max(2, s // 5)
    pad   = max(2, s // 6)

    for i in range(s):
        t_norm = i / (s - 1)
        # diagonal TL→BR
        cx = int(pad + t_norm * (s - 1 - 2 * pad))
        cy = int(pad + t_norm * (s - 1 - 2 * pad))
        for dx in range(-thick // 2, thick // 2 + 1):
            for dy in range(-thick // 2, thick // 2 + 1):
                if dx * dx + dy * dy <= (thick // 2) ** 2:
                    set_pixel(cx + dx, cy + dy, FG)
        # diagonal TR→BL
        cx2 = int((s - 1 - pad) - t_norm * (s - 1 - 2 * pad))
        for dx in range(-thick // 2, thick // 2 + 1):
            for dy in range(-thick // 2, thick // 2 + 1):
                if dx * dx + dy * dy <= (thick // 2) ** 2:
                    set_pixel(cx2 + dx, cy + dy, FG)

    return png(size, pixels)


for sz in (16, 48, 128):
    data = make_icon(sz)
    path = OUT / f'icon{sz}.png'
    path.write_bytes(data)
    print(f'  wrote {path}  ({len(data)} bytes)')

print('Icons generated.')
