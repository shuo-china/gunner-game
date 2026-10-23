"""Losslessly optimize PNGs in an isolated generated WeChat release.

Requires Pillow. Chooses only smaller encodings, retaining exact RGBA pixels
and color-management chunks. It never resizes, quantizes, or changes source art.
Duplicate files are reported, not removed: Cocos UUID references must stay valid.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
from pathlib import Path
import struct
import sys
import zlib

from PIL import Image, ImageChops, PngImagePlugin


SIGNATURE = b'\x89PNG\r\n\x1a\n'
COLOR_CHUNKS = {b'cHRM', b'gAMA', b'iCCP', b'sRGB', b'cICP', b'mDCv', b'cLLi'}


def chunks(data):
    if not data.startswith(SIGNATURE):
        raise ValueError('Not a PNG')
    pos = 8
    while pos < len(data):
        size = struct.unpack('>I', data[pos:pos + 4])[0]
        kind = data[pos + 4:pos + 8]
        payload = data[pos + 8:pos + 8 + size]
        yield kind, payload
        pos += size + 12


def chunk(kind, payload):
    return (struct.pack('>I', len(payload)) + kind + payload
            + struct.pack('>I', zlib.crc32(kind + payload) & 0xffffffff))


def save_png(im, original_chunks, **kwargs):
    output = io.BytesIO()
    im.save(output, format='PNG', optimize=True, compress_level=9, **kwargs)
    encoded = list(chunks(output.getvalue()))
    # Copy the original color profile exactly, including when the image mode
    # changes. Authoring metadata such as C2PA, text, EXIF is not runtime data.
    color = [(k, v) for k, v in original_chunks if k in COLOR_CHUNKS]
    encoded = [(k, v) for k, v in encoded if k not in COLOR_CHUNKS]
    return SIGNATURE + b''.join(chunk(k, v) for k, v in encoded[:1] + color + encoded[1:])


def exact_palette(rgba, colors):
    entries = [color for count, color in colors]
    lookup = {int.from_bytes(bytes(c), sys.byteorder): i for i, c in enumerate(entries)}
    pixels = memoryview(rgba.tobytes()).cast('I')
    indices = bytes(lookup[pixel] for pixel in pixels)
    result = Image.frombytes('P', rgba.size, indices)
    result.putpalette([channel for c in entries for channel in c[:3]])
    result.info['transparency'] = bytes(c[3] for c in entries)
    return result


def optimize(path, root, apply):
    original = path.read_bytes()
    original_chunks = list(chunks(original))
    if any(k == b'acTL' for k, v in original_chunks):
        raise ValueError(f'Animated PNG is not supported: {path}')
    with Image.open(io.BytesIO(original)) as source:
        source.load()
        rgba = source.convert('RGBA')
        pixels = rgba.tobytes()
        best, method = original, 'original'

        def consider(candidate, name):
            nonlocal best, method
            if len(candidate) < len(best):
                best, method = candidate, name

        consider(save_png(source, original_chunks), 'png-optimize')
        r, g, b, a = rgba.split()
        opaque = a.getextrema() == (255, 255)
        grayscale = (ImageChops.difference(r, g).getbbox() is None
                     and ImageChops.difference(r, b).getbbox() is None)
        if grayscale:
            gray = r if opaque else Image.merge('LA', (r, a))
            consider(save_png(gray, original_chunks), 'grayscale-exact')
        elif opaque:
            consider(save_png(rgba.convert('RGB'), original_chunks), 'rgb-exact')
        colors = rgba.getcolors(256)
        if colors:
            palette = exact_palette(rgba, colors)
            bits = next(n for n in (1, 2, 4, 8) if 2 ** n >= len(colors))
            consider(save_png(palette, original_chunks, bits=bits), 'palette-exact')

        # Retain existing scanline filters as another candidate. Pillow may use
        # less efficient filters for some already optimized atlas images.
        raw = zlib.decompress(b''.join(v for k, v in original_chunks if k == b'IDAT'))
        for strategy, label in ((zlib.Z_DEFAULT_STRATEGY, 'deflate'),
                                (zlib.Z_FILTERED, 'deflate-filtered')):
            compressor = zlib.compressobj(9, zlib.DEFLATED, 15, 9, strategy)
            compressed = compressor.compress(raw) + compressor.flush()
            output = bytearray(SIGNATURE)
            inserted = False
            for kind, payload in original_chunks:
                if kind == b'IDAT':
                    if not inserted:
                        output.extend(chunk(kind, compressed))
                        inserted = True
                elif kind != b'caBX':
                    output.extend(chunk(kind, payload))
            consider(bytes(output), label)

        with Image.open(io.BytesIO(best)) as verified:
            if verified.size != source.size or verified.convert('RGBA').tobytes() != pixels:
                raise ValueError(f'Pixel comparison failed: {path}')
        original_color = [(k, v) for k, v in original_chunks if k in COLOR_CHUNKS]
        result_color = [(k, v) for k, v in chunks(best) if k in COLOR_CHUNKS]
        if original_color != result_color:
            raise ValueError(f'Color profile comparison failed: {path}')
        if apply and best != original:
            temporary = path.with_suffix(path.suffix + '.optimizing')
            temporary.write_bytes(best)
            temporary.replace(path)
        return {
            'file': path.relative_to(root).as_posix(),
            'before': len(original), 'after': len(best),
            'saved': len(original) - len(best), 'method': method,
            'rgbaPixelsEqual': True, 'colorProfileEqual': True,
            'sha256Before': hashlib.sha256(original).hexdigest(),
            'sha256After': hashlib.sha256(best).hexdigest(),
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build', required=True)
    parser.add_argument('--report', required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--workers', type=int, default=4)
    args = parser.parse_args()
    root = Path(args.build).resolve()
    report = Path(args.report).resolve()
    if not (root / 'game.js').is_file() or not (root / 'game.json').is_file():
        raise ValueError('Expected a generated WeChat game directory')
    if (root / '.git').exists() or (root / 'assets' / 'scripts').exists():
        raise ValueError('Refusing to modify authoring resources')
    if report == root or root in report.parents:
        raise ValueError('Write reports outside the uploaded package')
    paths = sorted(root.rglob('*.png'))
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        results = list(pool.map(lambda p: optimize(p, root, args.apply), paths))
    groups = {}
    for row in results:
        groups.setdefault(row['sha256After'], []).append(row)
    duplicates = [{'files': [r['file'] for r in group],
                   'bytesPerFile': group[0]['after'],
                   'potentialSaved': (len(group) - 1) * group[0]['after']}
                  for group in groups.values() if len(group) > 1]
    summary = {
        'build': str(root), 'applied': args.apply, 'pngCount': len(results),
        'before': sum(r['before'] for r in results),
        'after': sum(r['after'] for r in results),
        'saved': sum(r['saved'] for r in results),
        'rgbaPixelsEqual': all(r['rgbaPixelsEqual'] for r in results),
        'colorProfileEqual': all(r['colorProfileEqual'] for r in results),
        'duplicateCandidates': duplicates, 'files': results,
    }
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k: v for k, v in summary.items() if k not in ('files', 'duplicateCandidates')}))
    print(f'Duplicate PNGs (not removed): {sum(r["potentialSaved"] for r in duplicates)} bytes')


if __name__ == '__main__':
    main()
