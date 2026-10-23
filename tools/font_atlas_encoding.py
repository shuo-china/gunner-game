"""Bounded colour precision for generated modal font atlases, before import.

Coverage/alpha and geometry are unchanged. RGB rounds by at most 4/255;
transparent pixels are canonicalized. This avoids Lanczos colour noise taking
more download bytes than the original larger atlas. HUD uses its exact encoder.
"""
import io
from PIL import Image


def encode_font_atlas(image):
    rgba = image.convert('RGBA')
    r, g, b, alpha = rgba.split()
    table = [min(255, round(value / 8) * 8) for value in range(256)]
    compact = Image.merge('RGBA', (r.point(table), g.point(table), b.point(table), alpha))
    compact.paste((0, 0, 0, 0), mask=alpha.point([255] + [0] * 255))
    output = io.BytesIO()
    compact.save(output, format='PNG', optimize=True, compress_level=9)
    return output.getvalue()
