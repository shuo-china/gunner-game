"""Migrate an existing exported UI font to the shared Latin bank.

Only the selected config's bitmapFonts field is changed. Existing metrics,
kerning, source styles and every supported authored colour are retained. Pages
are reused only when style, geometry and re-encoded glyph pixels agree; missing
colour variants are downsampled from their own original exported glyphs. No
system font, original Unity reader, or replacement rasterizer is needed.
"""
from __future__ import annotations

import copy
import hashlib
import io
import json
import math
import re
import uuid
from collections import defaultdict
from pathlib import Path

from PIL import Image
from font_atlas_encoding import encode_font_atlas

CODES = tuple(map(str, (*range(32, 127), 215, 247, 8722)))
WHITE = '255,255,255,255'
GEOMETRY = ('advance', 'bearingX', 'bearingY', 'width', 'height', 'empty')


def dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def signature(profile):
    def normalize(value):
        if isinstance(value, (float, int)):
            result = round(value, 7)
            return int(result) if result == int(result) else result
        if isinstance(value, dict):
            return {key: normalize(item) for key, item in value.items()}
        if isinstance(value, list):
            return [normalize(item) for item in value]
        return value
    keys = ('pointSize', 'scale', 'ascent', 'descent', 'faceDilate', 'outlineWidth',
            'outlineColor', 'shadowOffset', 'shadowColor')
    value = {key: profile[key] for key in keys}
    value['source'] = {key: profile['source'][key] for key in ('font', 'material', 'fontFile')}
    return hashlib.sha256(dump(normalize(value)).encode()).hexdigest()[:16]


def same_geometry(a, b):
    return all(a.get(key) == b.get(key) for key in GEOMETRY)


def migrate_system(root: Path, system: str, report_path: Path | None = None, check=False):
    if not re.fullmatch(r'[a-z][a-z-]*-system', system):
        raise ValueError('Expected an authored system directory, e.g. adventure-system')
    resources = root / 'assets/resources'
    art, output = resources / 'art', resources / 'art/latin-fonts'
    config_path = art / system / 'config.json'
    original_text = config_path.read_text(encoding='utf8')
    original = json.loads(original_text)
    config = copy.deepcopy(original)
    writes = {}
    shared = defaultdict(list)
    for file in sorted(art.glob('*/config.json')):
        if file == config_path:
            continue
        owner = json.loads(file.read_text(encoding='utf8'))
        for key, profile in owner.get('textProfiles', {}).items():
            font = owner.get('bitmapFonts', {}).get(key)
            if font and all(page.startswith('art/latin-fonts/') for page in font['pages']):
                shared[signature(profile)].append(font)
    cache = {}

    def file_bytes(file):
        return writes[file] if file in writes else file.read_bytes()

    def page_image(page):
        if page not in cache:
            cache[page] = Image.open(io.BytesIO(file_bytes(resources / (page + '.png')))).convert('RGBA')
        return cache[page]

    def crop(font, variant):
        x, y, width, height = variant['rect']
        return page_image(font['pages'][variant['page']]).crop((x, y, x + width, y + height))

    def footprint(fonts):
        pages = sorted({p for font in fonts.values() for p in font['pages']})
        return {'pages': len(pages), 'pngBytes': sum(len(file_bytes(resources / (p + '.png'))) for p in pages),
                'rgbaBytes': sum(page_image(p).width * page_image(p).height * 4 for p in pages)}

    before = footprint(original['bitmapFonts'])
    generated, destinations = {}, []
    reused = metrics_checked = retained_variants = 0
    profiles = []
    for key, old in original['bitmapFonts'].items():
        profile = original['textProfiles'][key]
        bank_key = signature(profile)
        candidates = shared[bank_key]
        if not candidates:
            raise ValueError(f'No source-identical shared font for {system}:{key}; run the full generator first')
        nodes = [node['text'] for node in config['nodes'].values() if node.get('text', {}).get('profile') == key]
        max_size = max((text.get('maxSize', text['size']) if text.get('autosize') else text['size']) * profile['scale']
                       for text in nodes) if nodes else 60
        minimum_scale = max(1, math.ceil(max_size * 1.5 / profile['pointSize'] * 4) / 4)
        scales = sorted({font.get('rasterScale', 2) for font in candidates if font.get('rasterScale', 2) >= minimum_scale})
        if not scales:
            raise ValueError(f'Shared font density insufficient for {system}:{key}')
        scale = scales[0]
        candidates = [font for font in candidates if font.get('rasterScale', 2) == scale]
        font = copy.deepcopy(old)
        font['glyphs'], font['pages'], font['rasterScale'] = {}, [], scale
        for code in CODES:
            source_glyph = old['glyphs'].get(code)
            donor = next((f['glyphs'][code] for f in candidates if code in f['glyphs']), None)
            if donor is None:
                raise ValueError(f'Missing shared white coverage for {key}:{code}')
            if source_glyph is not None:
                if not same_geometry(source_glyph, donor):
                    raise ValueError(f'Changed glyph geometry: {key}:{code}')
                metrics_checked += 1
            glyph = {name: copy.deepcopy(value) for name, value in (source_glyph or donor).items() if name != 'variants'}
            glyph['variants'] = {}
            font['glyphs'][code] = glyph
            if glyph.get('empty'):
                continue
            colors = {WHITE, *(source_glyph or {}).get('variants', {})}
            for color in sorted(colors):
                old_variant = (source_glyph or {}).get('variants', {}).get(color)
                resized = None
                if old_variant:
                    image = crop(old, old_variant)
                    ratio = scale / old.get('rasterScale', 2)
                    extent = (max(1, round(image.width * ratio)), max(1, round(image.height * ratio)))
                    if image.size != extent:
                        image = image.resize(extent, Image.Resampling.LANCZOS)
                    resized = Image.open(io.BytesIO(encode_font_atlas(image))).convert('RGBA')
                    retained_variants += 1
                match = None
                for candidate in candidates:
                    other = candidate['glyphs'].get(code)
                    variant = other and other['variants'].get(color)
                    if variant and same_geometry(glyph, other):
                        pixels = crop(candidate, variant)
                        if resized is None or pixels.size == resized.size and pixels.tobytes() == resized.tobytes():
                            match = (candidate['pages'][variant['page']], variant['rect'])
                            break
                if match:
                    page, rect = match
                    if page not in font['pages']:
                        font['pages'].append(page)
                    glyph['variants'][color] = {'page': font['pages'].index(page), 'rect': copy.deepcopy(rect)}
                    reused += 1
                else:
                    if resized is None:
                        raise ValueError(f'No original or shared pixels for {key}:{code}:{color}')
                    item_key = (bank_key, scale, code, color)
                    previous = generated.get(item_key)
                    if previous is not None and (previous.size != resized.size or previous.tobytes() != resized.tobytes()):
                        raise ValueError(f'Conflicting source pixels for {item_key}')
                    generated[item_key] = resized
                    destinations.append((font, glyph, color, item_key))
        config['bitmapFonts'][key] = font
        profiles.append({'key': key, 'sharedStyle': bank_key, 'maxDisplaySize': max_size, 'rasterScale': scale})

    # Small supplementary pages share exactly the same geometry and colour policy
    # as the common bank. Their content-derived names never overwrite another UI.
    batches = defaultdict(list)
    for item_key, image in generated.items():
        batches[item_key[:2]].append((item_key, image))
    additions, positions = [], {}
    template_path = output / 'hud-latin-0.png.meta'
    template_name = template_path.name.removesuffix('.png.meta')
    template = json.loads(template_path.read_text(encoding='utf8'))
    for (bank_key, scale), items in sorted(batches.items()):
        identity = hashlib.sha256()
        for item_key, image in sorted(items):
            identity.update(dump(item_key).encode())
            identity.update(dump(image.size).encode())
            identity.update(image.tobytes())
        prefix = 'latin-extra-' + identity.hexdigest()[:16]
        pages, page, placements = [], Image.new('RGBA', (2048, 2048)), []
        x = y = 2
        row = 0
        for item_key, image in sorted(items, key=lambda item: (-item[1].height, -item[1].width, item[0])):
            if x + image.width + 2 > 2048:
                x, y, row = 2, y + row + 2, 0
            if y + image.height + 2 > 2048:
                pages.append((page, placements))
                page, placements, x, y, row = Image.new('RGBA', (2048, 2048)), [], 2, 2, 0
            page.paste(image, (x, y))
            placements.append((item_key, [x, y, image.width, image.height]))
            x += image.width + 2
            row = max(row, image.height)
        if placements:
            pages.append((page, placements))
        paths, png_bytes, rgba_bytes = [], 0, 0
        for index, (page, placements) in enumerate(pages):
            width = max(rect[0] + rect[2] + 2 for _, rect in placements)
            height = max(rect[1] + rect[3] + 2 for _, rect in placements)
            name = prefix + '-' + str(index)
            page_path = 'art/latin-fonts/' + name
            data = encode_font_atlas(page.crop((0, 0, width, height)))
            file = output / (name + '.png')
            if file.exists() and file.read_bytes() != data:
                raise ValueError('Content-addressed font page collision: ' + name)
            if not file.exists():
                writes[file] = data
            meta_file = Path(str(file) + '.meta')
            if not meta_file.exists():
                uid = str(uuid.uuid5(uuid.NAMESPACE_URL, 'forest-gunner/' + page_path))
                meta = json.loads(dump(template).replace(template['uuid'], uid).replace(template_name, name))
                meta['imported'] = False
                info = meta['subMetas']['f9941']['userData']
                info.update(trimType='none', trimX=0, trimY=0, offsetX=0, offsetY=0, width=width, height=height,
                            rawWidth=width, rawHeight=height, borderLeft=0, borderRight=0, borderTop=0, borderBottom=0,
                            packable=False, pixelsToUnit=100, pivotX=.5, pivotY=.5)
                info.pop('vertices', None)
                writes[meta_file] = (dump(meta) + '\n').encode('utf8')
            for item_key, rect in placements:
                positions[item_key] = (page_path, rect)
            paths.append(page_path)
            png_bytes += len(data)
            rgba_bytes += width * height * 4
        additions.append({'id': prefix, 'source': next(f['source'] for f in shared[bank_key]), 'pages': paths,
                          'pngBytes': png_bytes, 'rgbaBytes': rgba_bytes, 'rasterScale': scale,
                          'maxDisplaySize': max(p['maxDisplaySize'] for p in profiles if p['sharedStyle'] == bank_key),
                          'incrementalSystem': system})
    for font, glyph, color, item_key in destinations:
        page, rect = positions[item_key]
        if page not in font['pages']:
            font['pages'].append(page)
        glyph['variants'][color] = {'page': font['pages'].index(page), 'rect': rect}
    # A rerun must retain the same supplemental pages and manifest. It never
    # deletes an asset; obsolete legacy pages can be archived after reference QA.
    text = (json.dumps(config, ensure_ascii=False, indent=2) if len(original_text.splitlines()) > 2 else dump(config)) + '\n'
    if original_text != text:
        writes[config_path] = text.encode('utf8')
    manifest_file = output / 'manifest.json'
    manifest = json.loads(manifest_file.read_text(encoding='utf8'))
    known = {font['id'] for font in manifest['fonts']}
    manifest['fonts'].extend(font for font in additions if font['id'] not in known)
    for font in manifest['fonts']:
        font['pngBytes'] = sum(len(file_bytes(resources / (page + '.png'))) for page in font['pages'])
        font['rgbaBytes'] = sum(page_image(page).width * page_image(page).height * 4 for page in font['pages'])
    manifest['pngBytes'] = sum(font['pngBytes'] for font in manifest['fonts'])
    manifest['rgbaBytes'] = sum(font['rgbaBytes'] for font in manifest['fonts'])
    manifest_text = json.dumps(manifest, ensure_ascii=False, indent=2) + '\n'
    if manifest_file.read_text(encoding='utf8') != manifest_text:
        writes[manifest_file] = manifest_text.encode('utf8')
    report = {'system': system, 'before': before, 'after': footprint(config['bitmapFonts']),
              'reusedVariantReferences': reused, 'originalLatinMetricsChecked': metrics_checked,
              'retainedOriginalLatinColorVariants': retained_variants, 'newUniqueGlyphVariants': len(generated),
              'newPages': sum(len(font['pages']) for font in additions), 'profiles': profiles,
              'removedNonLatinGlyphs': sum(len(set(font['glyphs']) - set(CODES)) for font in original['bitmapFonts'].values()),
              'legacyFilesDeleted': False, 'otherConfigFieldsUnchanged': True}
    assert {k: v for k, v in config.items() if k != 'bitmapFonts'} == {k: v for k, v in original.items() if k != 'bitmapFonts'}
    changed = [file for file, data in writes.items() if not file.exists() or file.read_bytes() != data]
    report['changedFiles'] = [file.relative_to(root).as_posix() for file in changed]
    report['check'] = check
    if check and changed:
        raise ValueError('Shared font migration is stale: ' + ', '.join(report['changedFiles']))
    if not check:
        for file in changed:
            file.write_bytes(writes[file])
    if report_path and not check:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    print(json.dumps(report, ensure_ascii=False))
