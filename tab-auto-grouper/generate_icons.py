#!/usr/bin/env python3
"""Generate extension icons using only Python stdlib (struct + zlib). No PIL needed."""
import struct, zlib
from pathlib import Path

OUT = Path(__file__).parent / 'extension' / 'icons'
OUT.mkdir(parents=True, exist_ok=True)

# Design: blue background, two white "tab" rectangles (grouped-tabs metaphor)
BG   = (26, 115, 232, 255)   # Google blue
FG   = (255, 255, 255, 255)  # white
EDGE = (10,  80,  180, 255)  # darker border


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i]-a[i])*t) for i in range(4))


def png(size, pixels):
    """Build a minimal RGBA PNG from a flat list of (R,G,B,A) tuples."""
    def chunk(name, data):
        c = name + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xFFFFFFFF)

    raw = b''
    for y in range(size):
        raw += b'\x00'
        for x in range(size):
            raw += bytes(pixels[y * size + x])

    header = b'\x89PNG\r\n\x1a\n'
    ihdr   = chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    idat   = chunk(b'IDAT', zlib.compress(raw, 9))
    iend   = chunk(b'IEND', b'')
    return header + ihdr + idat + iend


def make_icon(size):
    pixels = [BG] * (size * size)
    s = size

    def fill(x0, y0, x1, y1, color):
        for y in range(max(0,y0), min(s,y1)):
            for x in range(max(0,x0), min(s,x1)):
                pixels[y * s + x] = color

    m = max(1, size // 16)   # margin unit

    # Tab strip bar (top third)
    bar_h = s // 3
    fill(0, 0, s, bar_h, EDGE)

    # Two "tab" labels in the bar
    tab_w  = s // 3
    tab_h  = bar_h - m
    fill(m,          m, m + tab_w,     tab_h, FG)
    fill(m*2+tab_w,  m, m*2+tab_w*2,  tab_h, lerp(FG, BG, 0.5))

    # Two content rectangles below the bar
    row1_y = bar_h + m
    row1_e = bar_h + (s - bar_h) // 2 - m
    row2_y = bar_h + (s - bar_h) // 2 + m
    row2_e = s - m

    fill(m, row1_y, s - m, row1_e, FG)
    fill(m, row2_y, s - m, row2_e, lerp(FG, BG, 0.3))

    return png(size, pixels)


for sz in (16, 48, 128):
    data = make_icon(sz)
    path = OUT / f'icon{sz}.png'
    path.write_bytes(data)
    print(f'  wrote {path}  ({len(data)} bytes)')

print('Icons generated.')
