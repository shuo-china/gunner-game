"""Build shared, source-faithful Latin atlases for the system-Chinese UI.

Run: python -B tools/build-latin-fonts.py [--source-root E:/gunner]
Offline dependencies: Pillow, numpy, scipy, fontTools, UnityPy; the original
data.unity3d, DummyDll type information and read_original_feedback.py under
SOURCE_ROOT/AI-Workspace/Work/v1/tools. That read-only evidence reader is the
same one used by the original art exporters. It must never be replaced by a
font installed on the build machine. No TTF or historical atlas is deleted.

Existing Latin glyph metrics are retained; modal pixels are resized for their
maximum displayed size with 1.5x density headroom and bounded RGB precision.
The HUD retains its existing exact encoder. Missing glyphs use
the original TMP SDF, or the embedded source face when its dynamic atlas is
empty. ASCII plus multiplication, division and minus receive a complete white
base. Existing and actually authored colour combinations are retained; unused
colour/character combinations are not expanded into large textures.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import io
import json
import math
import re
import sys
import uuid
from functools import lru_cache
from pathlib import Path
from font_atlas_encoding import encode_font_atlas

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / 'assets/resources/art'
CODES = tuple(range(32, 127)) + (215, 247, 8722)
WHITE = '255,255,255,255'
SCALE = 2
PAGE = 2048


def dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def write_json(path, value, pretty=False):
    text = (json.dumps(value, ensure_ascii=False, indent=2) if pretty else dump(value)) + '\n'
    if not path.exists() or path.read_text(encoding='utf8') != text:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf8')


def ptr(value, owner='level0'):
    if not value or not value.get('m_PathID'):
        return None
    fid = value['m_FileID']
    name = owner if fid == 0 else 'sharedassets0.assets' if (owner == 'level0' and fid == 2) else 'resources.assets'
    return f"{name}:{value['m_PathID']}"


def rgba(value):
    return [round(value[c] * 255) for c in 'rgba']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, default=ROOT.parent)
    parser.add_argument('--only-system', help='Incrementally migrate one system to shared Latin pages without rewriting other systems')
    parser.add_argument('--report', type=Path, help='Optional incremental migration audit JSON')
    parser.add_argument('--check', action='store_true', help='Read-only incremental consistency check; requires --only-system')
    args = parser.parse_args()
    if args.only_system:
        from shared_font_incremental import migrate_system
        migrate_system(ROOT, args.only_system, args.report, check=args.check)
        return
    if args.check:
        parser.error('--check requires --only-system')
    source_root = args.source_root.resolve()
    sys.path[:0] = [str(source_root / 'AI-Workspace/Work/v1/tools'),
                   str(source_root / 'AI-Workspace/Work/v1/hud-python-deps')]
    from read_original_feedback import read as original_read, OBJECTS, BASE
    if Path(BASE).resolve() != source_root:
        raise RuntimeError('The evidence reader BASE differs from --source-root')
    import numpy as np
    from PIL import Image, ImageFont, ImageDraw
    from scipy.ndimage import distance_transform_edt, map_coordinates
    from fontTools.ttLib import TTFont
    read = lru_cache(None)(original_read)
    template_path = ART / 'latin-fonts/hud-latin-0.png.meta'
    template_name = template_path.name.removesuffix('.png.meta')
    template = json.loads(template_path.read_text(encoding='utf8'))
    output = ART / 'latin-fonts'
    output.mkdir(parents=True, exist_ok=True)

    def write_atlas_meta(file, name, size):
        meta_file = Path(str(file) + '.meta')
        if meta_file.exists():
            meta = json.loads(meta_file.read_text(encoding='utf8'))
        else:
            uid = str(uuid.uuid5(uuid.NAMESPACE_URL, 'forest-gunner/art/latin-fonts/' + name))
            meta = json.loads(dump(template).replace(template['uuid'], uid).replace(template_name, name))
            meta['imported'] = False
        info = meta['subMetas']['f9941']['userData']
        info.update(trimType='none', trimX=0, trimY=0, offsetX=0, offsetY=0, width=size[0], height=size[1],
                    rawWidth=size[0], rawHeight=size[1], borderLeft=0, borderBottom=0, borderRight=0,
                    borderTop=0, packable=False, pixelsToUnit=100, pivotX=.5, pivotY=.5)
        info.pop('vertices', None)
        write_json(meta_file, meta)

    @lru_cache(None)
    def face_file(key):
        raw = bytes(read(key)['m_FontData'])
        return raw, TTFont(io.BytesIO(raw), recalcTimestamp=False)

    def profile(font_key, material_key):
        data = read(font_key)
        face = data['m_FaceInfo']
        source_file = ptr(data['m_SourceFontFile'], 'sharedassets0.assets')
        _, ttf = face_file(source_file)
        material = read(material_key)['m_SavedProperties']
        floats, colors = dict(material['m_Floats']), dict(material['m_Colors'])
        gradient, ratio = floats.get('_GradientScale', 1), floats.get('_ScaleRatioA', 1)
        underlay = floats.get('_ScaleRatioC', 1)
        cmap, units = ttf.getBestCmap(), ttf['head'].unitsPerEm
        return {'font': 'font' + source_file.split(':')[1], 'pointSize': face['m_PointSize'],
                'scale': face['m_Scale'], 'ascent': face['m_AscentLine'], 'descent': face['m_DescentLine'],
                'advances': {str(code): ttf['hmtx'][cmap[code]][0] / units for code in CODES if code in cmap},
                'faceDilate': floats.get('_FaceDilate', 0) * gradient * ratio / 2,
                'outlineWidth': floats.get('_OutlineWidth', 0) * gradient * ratio / 2,
                'outlineColor': rgba(colors.get('_OutlineColor', dict(r=0, g=0, b=0, a=1))),
                'shadowOffset': [floats.get('_UnderlayOffsetX', 0) * gradient * underlay,
                                 floats.get('_UnderlayOffsetY', 0) * gradient * underlay],
                'shadowColor': rgba(colors.get('_UnderlayColor', dict(r=0, g=0, b=0, a=0))),
                'source': {'font': font_key, 'material': material_key, 'fontFile': source_file}}

    configs = {}
    formatting = {}
    for file in sorted(ART.glob('*/config.json')):
        raw = file.read_text(encoding='utf8')
        config = json.loads(raw)
        if config.get('nodes') or file.parent.name in ('hud', 'ui-alert'):
            configs[file] = config
            formatting[file] = len(raw.splitlines()) > 2

    # Recover profiles for legacy TTF-only UI nodes, including cloned weapon
    # cards whose component IDs still identify their unmodified source text.
    for file, config in configs.items():
        if file.parent.name not in ('weapon-system', 'stage-transition'):
            continue
        profiles = config.setdefault('textProfiles', {})
        for node in config['nodes'].values():
            text = node.get('text')
            if not text or text.get('profile'):
                continue
            source_keys = [':'.join(key.split(':')[-2:]) for key in node.get('components', [])]
            components = [read(key) for key in source_keys if key in OBJECTS]
            data = next((item for item in components if 'm_fontAsset' in item and 'm_text' in item), None)
            if data is None:
                raise RuntimeError('Missing original text source: ' + node['id'])
            localize = next((item for item in components if 'mTermSecondary' in item), {})
            font_key, material_key = ptr(data['m_fontAsset']), ptr(data['m_sharedMaterial'])
            if file.parent.name == 'stage-transition':
                font_key, material_key = 'sharedassets0.assets:1002', 'sharedassets0.assets:3'
            elif localize.get('mTermSecondary') in ('font', 'font (outline)'):
                font_key = 'sharedassets0.assets:' + ('1002' if 'outline' in localize['mTermSecondary'] else '1003')
                material_key = ptr(read(font_key)['m_Material'], 'sharedassets0.assets')
            key = font_key.split(':')[1] + ':' + material_key.split(':')[1]
            profiles.setdefault(key, profile(font_key, material_key))
            text['profile'] = key
            text.update(minSize=data['m_fontSizeMin'], maxSize=data['m_fontSizeMax'],
                        characterSpacing=data.get('m_characterSpacing', 0), wordSpacing=data.get('m_wordSpacing', 0),
                        lineSpacing=data.get('m_lineSpacing', 0), margin=[data['m_margin'][c] for c in 'xyzw'],
                        kerning=0x6b65726e in data.get('m_ActiveFontFeatures', []))
            # The existing exported cash sprite is retained; only its original
            # TMP baseline and advance were missing in the legacy TTF path.
            for index in re.findall(r'<sprite=(\d+)>', text['value']):
                asset_key = ptr(data['m_spriteAsset'])
                asset = read(asset_key)
                character = asset['m_SpriteCharacterTable'][int(index)]
                glyph = next(g for g in asset['m_GlyphTable'] if g['m_Index'] == character['m_GlyphIndex'])
                metrics = glyph['m_Metrics']
                sprite_key = asset_key.split(':')[1]
                text['spriteAsset'] = sprite_key
                config.setdefault('inlineSpriteMetrics', {}).setdefault(sprite_key + '-' + index, {
                    'width': metrics['m_Width'], 'height': metrics['m_Height'],
                    'bearingX': metrics['m_HorizontalBearingX'], 'bearingY': metrics['m_HorizontalBearingY'],
                    'advance': metrics['m_HorizontalAdvance'], 'scale': character['m_Scale'] * glyph['m_Scale'],
                    'pointSize': asset['m_FaceInfo']['m_PointSize'], 'source': asset_key})

    hud = configs[ART / 'hud/config.json']
    alerts = configs[ART / 'ui-alert/config.json']
    extra = [(hud, 'bitmapFont', profile('sharedassets0.assets:1006', 'sharedassets0.assets:75')),
             (alerts, 'bitmapFont', profile(alerts['source']['chineseFont'], alerts['source']['fontMaterial']))]
    groups = {}
    targets = []
    reused = 0

    @lru_cache(8)
    def existing_page(path):
        return Image.open(path).convert('RGBA')

    def signature(p):
        def normalize(value):
            if isinstance(value, (float, int)):
                result = round(value, 7)
                return int(result) if result == int(result) else result
            if isinstance(value, list):
                return [normalize(item) for item in value]
            if isinstance(value, dict):
                return {key: normalize(item) for key, item in value.items()}
            return value
        keys = ('pointSize', 'scale', 'ascent', 'descent', 'faceDilate', 'outlineWidth', 'outlineColor', 'shadowOffset', 'shadowColor')
        value = {key: p[key] for key in keys}
        value['source'] = {key: p['source'][key] for key in ('font', 'material', 'fontFile')}
        return hashlib.sha256(dump(normalize(value)).encode()).hexdigest()[:16]

    def register(p, old, nodes):
        nonlocal reused
        key = signature(p)
        group = groups.setdefault(key, {'profile': p, 'glyphs': {}, 'colors': {}, 'sources': {}, 'sourceScales': {}, 'maxDisplaySize': 60})
        # Source layouts are 1080px wide. Keep 1.5x headroom for high-density
        # phones, instead of giving every small modal an unconditional 180px face.
        for node in nodes:
            text = node['text']
            size = text.get('maxSize', text['size']) if text.get('autosize') else text['size']
            group['maxDisplaySize'] = max(group['maxDisplaySize'], size * p.get('scale', 1))
        colors = {WHITE}
        demand = {str(code): {WHITE} for code in CODES}
        amount_codes = set(map(ord, '0123456789abcdefghijklmnopqrstuvwxyz.%+−-:/×÷'))
        for node in nodes:
            text = node['text']
            color = ','.join(map(str, text['color']))
            colors.add(color)
            value = re.sub(r'<[^>]*>', '', text['value'])
            needed = {ord(char) for char in value if ord(char) in CODES}
            if any(char.isascii() and char.isdigit() for char in value):
                needed.update(amount_codes)
            for code in needed:
                demand[str(code)].add(color)
        # Affordability colours are assigned at runtime rather than appearing
        # in serialized initial labels. Keep their full formatted amount set.
        old_colors = {color for glyph in (old or {}).get('glyphs', {}).values() for color in glyph.get('variants', {})}
        for color in old_colors:
            r, g, b, _ = map(int, color.split(','))
            if r >= 190 and r > g * 1.5 and r > b * 1.5:
                colors.add(color)
                for code in amount_codes:
                    demand[str(code)].add(color)
        for code, glyph in (old or {}).get('glyphs', {}).items():
            if int(code) not in CODES:
                continue
            metric = {k: copy.deepcopy(v) for k, v in glyph.items() if k != 'variants'}
            if code in group['glyphs'] and group['glyphs'][code] != metric:
                # Some source exports carry provenance-only fields. Geometry
                # must agree before sharing the original bitmap pixels.
                channels = ('advance', 'bearingX', 'bearingY', 'width', 'height', 'empty')
                if any(group['glyphs'][code].get(c) != metric.get(c) for c in channels):
                    raise RuntimeError('Incompatible original metrics: ' + key + ':' + code)
            group['glyphs'].setdefault(code, metric)
            for color, variant in glyph.get('variants', {}).items():
                if color not in demand[code]:
                    continue
                pair = (code, color)
                page = ROOT / 'assets/resources' / (old['pages'][variant['page']] + '.png')
                x, y, w, h = variant['rect']
                image = existing_page(page).crop((x, y, x + w, y + h))
                if pair in group['sources']:
                    previous = group['sources'][pair]
                    if previous.size != image.size or previous.tobytes() != image.tobytes():
                        raise RuntimeError('Incompatible original glyph pixels: ' + key + ':' + str(pair))
                else:
                    group['sources'][pair] = image
                    group['sourceScales'][pair] = old.get('rasterScale', SCALE)
                    reused += 1
                group['colors'].setdefault(code, set()).add(color)
        for code, variants in demand.items():
            group['colors'].setdefault(code, set()).update(variants)
        return key, colors

    for file, config in configs.items():
        for key, p in config.get('textProfiles', {}).items():
            old = config.get('bitmapFonts', {}).get(key)
            nodes = [n for n in config.get('nodes', {}).values() if n.get('text', {}).get('profile') == key]
            group_key, colors = register(p, old, nodes)
            targets.append((config.setdefault('bitmapFonts', {}), key, group_key, colors))
    for config, field, p in extra:
        old = config.get(field)
        group_key, colors = register(p, None if old and old.get('losslessGlyphCrop') else old, [])
        targets.append((config, field, group_key, colors))
    # HUD prices retain their authored insufficient-funds red for every amount.
    hud_key = targets[-2][2]
    upgrade = json.loads((ART / 'upgrades/config.json').read_text(encoding='utf8'))
    red = ','.join(map(str, upgrade['palette']['insufficient']))
    targets[-2][3].add(red)
    for char in '0123456789abcdefghijklmnopqrstuvwxyz.%+−-':
        groups[hud_key]['colors'].setdefault(str(ord(char)), set()).add(red)

    def raster(group, code, raster_scale=SCALE):
        p = group['profile']
        data, material = read(p['source']['font']), read(p['source']['material'])
        f = dict(material['m_SavedProperties']['m_Floats'])
        raw, ttf = face_file(p['source']['fontFile'])
        cmap = ttf.getBestCmap()
        if int(code) not in cmap:
            raise RuntimeError('Original font lacks required character: ' + p['source']['fontFile'] + ':' + code)
        point = p['pointSize']
        face = ImageFont.truetype(io.BytesIO(raw), round(point * raster_scale))
        table = {g['m_Index']: g for g in data['m_GlyphTable']}
        static = {str(c['m_Unicode']): table[c['m_GlyphIndex']] for c in data['m_CharacterTable']}
        gradient = f['_GradientScale']
        face_shift = f.get('_FaceDilate', 0) * f.get('_ScaleRatioA', 1) * gradient / 2
        outline = f.get('_OutlineWidth', 0) * f.get('_ScaleRatioA', 1) * gradient / 2
        shadow_x = f.get('_UnderlayOffsetX', 0) * f.get('_ScaleRatioC', 1) * gradient
        shadow_y = f.get('_UnderlayOffsetY', 0) * f.get('_ScaleRatioC', 1) * gradient
        shadow_shift = face_shift + f.get('_UnderlayDilate', 0) * f.get('_ScaleRatioC', 1) * gradient / 2
        pad = math.ceil(max(2 * (face_shift + outline), abs(shadow_x) + 2 * shadow_shift,
                            abs(shadow_y) + 2 * shadow_shift, 0)) + 3
        advance = ttf['hmtx'][cmap[int(code)]][0] / ttf['head'].unitsPerEm * point
        g = static.get(code)
        if g and g['m_GlyphRect']['m_Width']:
            metrics, rect = g['m_Metrics'], g['m_GlyphRect']
            advance = metrics['m_HorizontalAdvance']
            width, height = metrics['m_Width'] + pad * 2, metrics['m_Height'] + pad * 2
            left, top = metrics['m_HorizontalBearingX'] - pad, metrics['m_HorizontalBearingY'] + pad
            atlas_key = ptr(data['m_AtlasTextures'][0], 'sharedassets0.assets')
            sdf = source_atlas(atlas_key)
            region = sdf.crop((rect['m_X'] - pad, sdf.height - rect['m_Y'] - rect['m_Height'] - pad,
                               rect['m_X'] + rect['m_Width'] + pad, sdf.height - rect['m_Y'] + pad))
            sampled = region.resize((math.ceil(width * raster_scale), math.ceil(height * raster_scale)), Image.Resampling.BILINEAR)
            distance = (np.asarray(sampled, dtype=float) / 255 - .5) * gradient
            origin = 'source-sdf'
        else:
            box = face.getbbox(chr(int(code)), anchor='ls')
            if box[2] == box[0] or box[3] == box[1]:
                return {'advance': advance, 'origin': 'source-font', 'empty': True}, {}
            width, height = (box[2] - box[0]) / raster_scale + pad * 2, (box[3] - box[1]) / raster_scale + pad * 2
            left, top = box[0] / raster_scale - pad, -box[1] / raster_scale + pad
            mask = Image.new('L', (math.ceil(width * raster_scale), math.ceil(height * raster_scale)))
            ImageDraw.Draw(mask).text((pad * raster_scale - box[0], pad * raster_scale - box[1]), chr(int(code)), font=face, anchor='ls', fill=255)
            coverage = np.asarray(mask, dtype=float) / 255
            binary = coverage >= .5
            distance = (distance_transform_edt(binary) - distance_transform_edt(~binary) + coverage - .5) / (2 * raster_scale)
            origin = 'source-font'
        metric = {'advance': advance, 'bearingX': left, 'bearingY': top, 'width': width, 'height': height, 'origin': origin}
        face_alpha = np.clip((distance + face_shift - outline) * raster_scale + .5, 0, 1)
        outer_alpha = np.clip((distance + face_shift + outline) * raster_scale + .5, 0, 1)
        border = np.asarray(p['outlineColor'], dtype=float) / 255
        yy, xx = np.mgrid[:distance.shape[0], :distance.shape[1]]
        shifted = map_coordinates(distance, [yy + shadow_y * raster_scale, xx - shadow_x * raster_scale], order=1, mode='constant', cval=-999)
        shadow_alpha = np.clip((shifted + shadow_shift) * raster_scale + .5, 0, 1) if 'UNDERLAY_ON' in material.get('m_ValidKeywords', []) else np.zeros(distance.shape)
        shadow = np.asarray(p['shadowColor'], dtype=float) / 255
        images = {}
        for color in sorted(group['colors'][code]):
            if (code, color) in group['sources']:
                source = group['sources'][(code, color)]
                ratio = raster_scale / group['sourceScales'].get((code, color), SCALE)
                size = (max(1, round(source.width * ratio)), max(1, round(source.height * ratio)))
                images[color] = source if source.size == size else source.resize(size, Image.Resampling.LANCZOS)
                continue
            fc = np.asarray(list(map(int, color.split(','))), dtype=float) / 255
            a = outer_alpha * fc[3]
            rgb = (border[:3][None, None, :] * (1 - face_alpha[:, :, None]) + fc[:3][None, None, :] * face_alpha[:, :, None]) * a[:, :, None]
            sa = shadow_alpha * shadow[3] * fc[3] * (1 - a)
            rgb += shadow[:3][None, None, :] * sa[:, :, None]
            a += sa
            rgb = np.divide(rgb, a[:, :, None], out=np.zeros_like(rgb), where=a[:, :, None] > 0)
            images[color] = Image.fromarray(np.clip(np.dstack((rgb, a)) * 255 + .5, 0, 255).astype('uint8'), 'RGBA')
        return metric, images

    @lru_cache(None)
    def source_atlas(key):
        return OBJECTS[key].read().image.getchannel('A')

    banks = {}
    report = {'version': 1, 'characters': ''.join(map(chr, CODES)), 'fonts': []}
    for key, group in sorted(groups.items()):
        raster_scale = min(SCALE, max(1, math.ceil(group['maxDisplaySize'] * 1.5 / group['profile']['pointSize'] * 4) / 4))
        entries = {}
        images_by_code = {}
        for code in map(str, CODES):
            metric, images = raster(group, code, raster_scale=raster_scale)
            # Preserve authored advance/bearing/size, independent of raster density.
            metric = copy.deepcopy(group['glyphs'].get(code, metric))
            entries[code] = {**metric, 'variants': {}}
            images_by_code[code] = images
        pages = []
        # Keep colours on separate pages. A white HUD must never load the
        # dozens of grade-colour pages used by the weapon/fish collections.
        for color in sorted({c for images in images_by_code.values() for c in images}):
            page = Image.new('RGBA', (PAGE, PAGE))
            x = y = row = 2
            for code, images in images_by_code.items():
                image = images.get(color)
                if image is None:
                    continue
                if x + image.width + 2 > PAGE:
                    x, y, row = 2, y + row + 2, 0
                if y + image.height + 2 > PAGE:
                    pages.append(page)
                    page = Image.new('RGBA', (PAGE, PAGE))
                    x = y = row = 2
                page.paste(image, (x, y))
                entries[code]['variants'][color] = {'page': len(pages), 'rect': [x, y, image.width, image.height]}
                x += image.width + 2
                row = max(row, image.height)
            pages.append(page)
        paths = []
        pixel_bytes = png_bytes = 0
        for i, page in enumerate(pages):
            rects = [v['rect'] for glyph in entries.values() for v in glyph['variants'].values() if v['page'] == i]
            size = (min(PAGE, max(r[0] + r[2] + 2 for r in rects)), min(PAGE, max(r[1] + r[3] + 2 for r in rects)))
            page = page.crop((0, 0, *size))
            name = 'latin-' + key + '-' + str(i)
            file = output / (name + '.png')
            data = encode_font_atlas(page)
            if not file.exists() or file.read_bytes() != data:
                file.write_bytes(data)
            write_atlas_meta(file, name, size)
            paths.append('art/latin-fonts/' + name)
            pixel_bytes += size[0] * size[1] * 4
            png_bytes += len(data)
        p = group['profile']
        source_data = read(p['source']['font'])
        _, ttf = face_file(p['source']['fontFile'])
        cmap = ttf.getBestCmap()
        code_by_glyph = {ttf.getGlyphID(cmap[code]): str(code) for code in CODES}
        kerning = {}
        for pair in source_data['m_FontFeatureTable'].get('m_GlyphPairAdjustmentRecords', []):
            first, second = pair['m_FirstAdjustmentRecord'], pair['m_SecondAdjustmentRecord']
            left, right = code_by_glyph.get(first['m_GlyphIndex']), code_by_glyph.get(second['m_GlyphIndex'])
            if left and right:
                a, b = first['m_GlyphValueRecord'], second['m_GlyphValueRecord']
                kerning[left + ':' + right] = [[a['m_XPlacement'], a['m_YPlacement'], a['m_XAdvance']], [b['m_XPlacement'], b['m_YPlacement'], b['m_XAdvance']]]
        banks[key] = {'pages': paths, 'glyphs': entries, 'kerning': kerning, 'lineHeight': source_data['m_FaceInfo']['m_LineHeight'],
                      **{k: p[k] for k in ('pointSize', 'scale', 'ascent', 'descent', 'source')}, 'rasterScale': raster_scale}
        report['fonts'].append({'id': key, 'source': p['source'], 'pages': paths, 'pngBytes': png_bytes, 'rgbaBytes': pixel_bytes,
                               'maxDisplaySize': group['maxDisplaySize'], 'rasterScale': raster_scale})
        print(f'{key}: {len(pages)} pages, {png_bytes:,} PNG bytes, {pixel_bytes:,} RGBA bytes', flush=True)

    for target, field, key, colors in targets:
        font = copy.deepcopy(banks[key])
        for glyph in font['glyphs'].values():
            glyph['variants'] = {color: variant for color, variant in glyph['variants'].items() if color in colors}
        indices = sorted({v['page'] for glyph in font['glyphs'].values() for v in glyph['variants'].values()})
        font['pages'] = [font['pages'][i] for i in indices]
        for glyph in font['glyphs'].values():
            for variant in glyph['variants'].values():
                variant['page'] = indices.index(variant['page'])
        target[field] = font
    # The startup font gets its own lossless atlas. Transparent glyph padding
    # can be removed if the bearing is shifted by exactly the same amount;
    # advances and every nontransparent RGBA pixel stay unchanged.
    compact = copy.deepcopy(hud['bitmapFont'])
    # At most 60 source-layout pixels are used on the HUD. Rasterize directly
    # from the original SDF at 90 points, instead of carrying the 180px atlas
    # intended for larger modal text into WeChat's size-limited main package.
    hud_group = {'profile': groups[hud_key]['profile'], 'sources': {}, 'colors': {
        code: set(glyph['variants']) for code, glyph in compact['glyphs'].items()}}
    cropped = []
    for code, glyph in compact['glyphs'].items():
        variants = glyph['variants']
        if glyph.get('empty') or not variants:
            continue
        metric, images = raster(hud_group, code, raster_scale=1)
        glyph.update(metric)
        boxes = [image.getbbox() for image in images.values() if image.getbbox()]
        w, h = next(iter(images.values())).size
        left, top = max(0, min(b[0] for b in boxes) - 1), max(0, min(b[1] for b in boxes) - 1)
        right, bottom = min(w, max(b[2] for b in boxes) + 1), min(h, max(b[3] for b in boxes) + 1)
        sx, sy = glyph['width'] / w, glyph['height'] / h
        glyph['bearingX'] += left * sx
        glyph['bearingY'] -= top * sy
        glyph['width'], glyph['height'] = (right - left) * sx, (bottom - top) * sy
        for color, image in images.items():
            cropped.append((code, color, image.crop((left, top, right, bottom))))
        glyph['variants'] = {}
    pages, page = [], Image.new('RGBA', (PAGE, PAGE))
    x = y = row = 2
    for code, color, image in sorted(cropped, key=lambda item: (-item[2].height, -item[2].width, item[0], item[1])):
        if x + image.width + 2 > PAGE:
            x, y, row = 2, y + row + 2, 0
        if y + image.height + 2 > PAGE:
            pages.append(page)
            page = Image.new('RGBA', (PAGE, PAGE))
            x = y = row = 2
        page.paste(image, (x, y))
        compact['glyphs'][code]['variants'][color] = {'page': len(pages), 'rect': [x, y, image.width, image.height]}
        x += image.width + 2
        row = max(row, image.height)
    pages.append(page)
    compact['pages'] = []
    hud_png = hud_rgba = 0
    for i, page in enumerate(pages):
        rects = [v['rect'] for glyph in compact['glyphs'].values() for v in glyph['variants'].values() if v['page'] == i]
        size = (min(PAGE, max(r[0] + r[2] + 2 for r in rects)), min(PAGE, max(r[1] + r[3] + 2 for r in rects)))
        page = page.crop((0, 0, *size))
        name = 'hud-latin-' + str(i)
        file = output / (name + '.png')
        buffer = io.BytesIO()
        page.save(buffer, format='PNG', optimize=True)
        data = buffer.getvalue()
        if not file.exists() or file.read_bytes() != data:
            file.write_bytes(data)
        write_atlas_meta(file, name, size)
        compact['pages'].append('art/latin-fonts/' + name)
        hud_png += len(data)
        hud_rgba += size[0] * size[1] * 4
    compact['losslessGlyphCrop'] = True
    compact['rasterScale'] = 1
    hud['bitmapFont'] = compact
    report['fonts'].append({'id': 'hud', 'source': compact['source'], 'pages': compact['pages'], 'pngBytes': hud_png, 'rgbaBytes': hud_rgba})
    print(f'HUD lossless crop: {len(pages)} pages, {hud_png:,} PNG bytes, {hud_rgba:,} RGBA bytes', flush=True)
    settings = configs[ART / 'settings-system/config.json']
    settings['input']['bitmapFont'] = copy.deepcopy(settings['bitmapFonts'][settings['input']['textProfile']])
    for file, config in configs.items():
        write_json(file, config, formatting[file])
    write_json(Path(str(output) + '.meta'), {'ver': '1.2.0', 'importer': 'directory', 'imported': True,
               'uuid': str(uuid.uuid5(uuid.NAMESPACE_URL, 'forest-gunner/art/latin-fonts')), 'files': [], 'subMetas': {}, 'userData': {}})
    report['pngBytes'] = sum(f['pngBytes'] for f in report['fonts'])
    report['rgbaBytes'] = sum(f['rgbaBytes'] for f in report['fonts'])
    active_files = {Path(page).name + suffix for font in report['fonts'] for page in font['pages'] for suffix in ('.png', '.png.meta')}
    # Remove only this generator's obsolete pages, never historical art or TTFs.
    for file in output.iterdir():
        if re.fullmatch(r'(?:latin-(?:extra-)?[0-9a-f]{16}|hud-latin)-\d+\.png(?:\.meta)?', file.name) and file.name not in active_files:
            if file.resolve().parent != output.resolve():
                raise RuntimeError('Unexpected generated atlas path')
            file.unlink()
    write_json(output / 'manifest.json', report, True)
    if not (output / 'manifest.json.meta').exists():
        write_json(output / 'manifest.json.meta', {'ver': '2.0.1', 'importer': 'json', 'imported': False,
                   'uuid': str(uuid.uuid5(uuid.NAMESPACE_URL, 'forest-gunner/art/latin-fonts/manifest')), 'files': ['.json'], 'subMetas': {}, 'userData': {}})
    print(dump({'reusedGlyphVariants': reused, **{k: report[k] for k in ('pngBytes', 'rgbaBytes')}}), flush=True)


if __name__ == '__main__':
    main()
