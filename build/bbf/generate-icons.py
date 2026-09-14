#!/usr/bin/env python3
"""Generate BBF Code application icons from the Blackbox Factories brand mark.

The brand mark is the two-chevron device taken verbatim from bbf-logo.svg
(olive #B5BC38 solid chevron + luminous orange #DC6621 outline chevron). The
chevrons are vector polygons in the source logo, so they are re-rendered here
at each target resolution rather than upscaled from the raster wordmark.

Brand rule: the mark always sits on a white/light surface, never on a dark one.

Usage:  python build/bbf/generate-icons.py
Outputs are written in place under resources/.
"""

import os
import struct
from io import BytesIO

from PIL import Image, ImageDraw

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Chevron polygons, copied from the <polygon> elements of bbf-logo.svg.
OLIVE_PTS = [(1632.50, 85.12), (1714.46, 167.07), (1784.55, 167.07),
             (1702.60, 85.12), (1784.55, 3.20), (1714.46, 3.20)]
ORANGE_PTS = [(1774.10, 85.12), (1856.06, 167.07), (1866.86, 167.07),
              (1784.90, 85.12), (1866.86, 3.20), (1856.06, 3.20)]

OLIVE = (181, 188, 56, 255)      # #B5BC38
ORANGE = (220, 102, 33, 255)     # #DC6621
WHITE = (255, 255, 255, 255)
BORDER = (224, 224, 224, 255)

MARK_X0 = min(p[0] for p in OLIVE_PTS + ORANGE_PTS)
MARK_X1 = max(p[0] for p in OLIVE_PTS + ORANGE_PTS)
MARK_Y0 = min(p[1] for p in OLIVE_PTS + ORANGE_PTS)
MARK_Y1 = max(p[1] for p in OLIVE_PTS + ORANGE_PTS)
MARK_W = MARK_X1 - MARK_X0
MARK_H = MARK_Y1 - MARK_Y0

SS = 4           # supersampling factor for antialiasing


def _metrics(size: int):
	"""Small icons need a bigger mark and squarer tile to stay legible.

	At 16-24px a 0.62 mark inside a heavily rounded tile collapses into a few
	ambiguous pixels, so the mark grows and the corner radius tightens as the
	target size drops.
	"""
	if size <= 24:
		return 0.86, 0.12, False   # mark fraction, radius fraction, draw border
	if size <= 48:
		return 0.74, 0.16, True
	return 0.62, 0.18, True


def render(size: int) -> Image.Image:
	"""Render one square icon at the given pixel size."""
	mark_frac, radius_frac, draw_border = _metrics(size)
	s = size * SS
	img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
	d = ImageDraw.Draw(img)

	# White rounded tile keeps the mark on a light surface at any OS theme.
	radius = int(s * radius_frac)
	d.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=WHITE,
	                    outline=BORDER if draw_border else None,
	                    width=max(1, int(s * 0.008)))

	# Scale the chevrons into the tile, centred.
	target_w = s * mark_frac
	scale = target_w / MARK_W
	ox = (s - MARK_W * scale) / 2.0
	oy = (s - MARK_H * scale) / 2.0

	def place(pts):
		return [((x - MARK_X0) * scale + ox, (y - MARK_Y0) * scale + oy) for x, y in pts]

	d.polygon(place(OLIVE_PTS), fill=OLIVE)
	d.polygon(place(ORANGE_PTS), fill=ORANGE)

	return img.resize((size, size), Image.LANCZOS)


def write_png(path: str, size: int):
	render(size).save(path, 'PNG')
	print(f'  {os.path.relpath(path, REPO)}  ({size}x{size})')


def write_ico(path: str, sizes):
	# Render every entry at its own size: letting Pillow downscale one large
	# image would discard the per-size metrics from _metrics().
	images = [render(n) for n in sorted(sizes)]
	base = images[-1]
	base.save(path, 'ICO', sizes=[(n, n) for n in sorted(sizes)],
	          append_images=images[:-1])
	print(f'  {os.path.relpath(path, REPO)}  ({",".join(str(n) for n in sorted(sizes))})')


def write_icns(path: str):
	"""Write an .icns directly (PNG-backed chunks) so this works off macOS."""
	types = [(b'ic07', 128), (b'ic08', 256), (b'ic09', 512), (b'ic10', 1024),
	         (b'ic11', 32), (b'ic12', 64), (b'ic13', 256), (b'ic14', 512)]
	chunks = b''
	for tag, n in types:
		buf = BytesIO()
		render(n).save(buf, 'PNG')
		data = buf.getvalue()
		chunks += tag + struct.pack('>I', len(data) + 8) + data
	with open(path, 'wb') as f:
		f.write(b'icns' + struct.pack('>I', len(chunks) + 8) + chunks)
	print(f'  {os.path.relpath(path, REPO)}  ({len(types)} variants)')


def main():
	r = lambda *p: os.path.join(REPO, *p)

	print('Windows:')
	write_ico(r('resources', 'win32', 'code.ico'), [16, 24, 32, 48, 64, 128, 256])
	write_png(r('resources', 'win32', 'code_70x70.png'), 70)
	write_png(r('resources', 'win32', 'code_150x150.png'), 150)

	print('macOS:')
	write_icns(r('resources', 'darwin', 'code.icns'))

	print('Linux:')
	write_png(r('resources', 'linux', 'code.png'), 512)

	print('Server/web:')
	write_png(r('resources', 'server', 'code-192.png'), 192)
	write_png(r('resources', 'server', 'code-512.png'), 512)
	write_ico(r('resources', 'server', 'favicon.ico'), [16, 32, 48])

	print('\nDone.')


if __name__ == '__main__':
	main()
