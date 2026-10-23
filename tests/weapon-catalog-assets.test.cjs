const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getWeaponCatalog, WEAPON_CATEGORY_NAMES } = require('./.build/session/core/WeaponCatalog.js');
const root = path.resolve(__dirname, '..'), resource = key => path.join(root, 'assets/resources', key);
const config = require('../assets/resources/art/weapon-system/config.json');
const visuals = require('../assets/resources/art/weapon-system/visuals.json');
const approvedArt = require('./fixtures/weapon-redraw-v2-assets.json').weapons;
const approvedById = new Map(approvedArt.map(weapon => [weapon.id, weapon]));
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-8, `${message}: ${actual} != ${expected}`);
const battleVisibleSize = image => {
  const { bounds } = require('./support/png-alpha.cjs').pngAlpha(fs.readFileSync(resource(image.path + '.png')), 16);
  return [0, 1].map(axis => (bounds[axis + 2] - bounds[axis]) / image.sizePx[axis] *
    image.sizeUnits[axis] * Math.abs(image.localScale[axis]));
};

test('compressed weapon art stays under 2 MB and preserves firing transforms, grade sizes and artwork proportions', () => {
  let bytes = 0;
  const { pngAlpha } = require('./support/png-alpha.cjs');
  for (const expected of approvedArt) {
    const appearance = visuals.weapons[expected.id], image = appearance.image;
    const before = expected.compression.sourceAppearance, old = before.image;
    const buffer = fs.readFileSync(resource(image.path + '.png'));
    const actual = pngAlpha(buffer, 16), bounds = expected.compression.sourceAlphaBounds16;
    bytes += buffer.length;
    assert.ok(buffer.length < expected.compression.sourceBytes, `${expected.id}: every texture is smaller`);
    for (const key of Object.keys(before).filter(key => !['image', 'bowString', 'supportGripPx'].includes(key))) {
      assert.deepEqual(appearance[key], before[key], `${expected.id}: ${key} is unaffected by image compression`);
    }
    for (const key of ['path', 'localScale', 'localPosition', 'localRotationDeg', 'color']) {
      assert.deepEqual(image[key], old[key], `${expected.id}: ${key} is preserved`);
    }
    const oldSize = [0, 1].map(axis => (bounds[axis + 2] - bounds[axis]) / old.sizePx[axis] * old.sizeUnits[axis]);
    const newSize = [0, 1].map(axis => (actual.bounds[axis + 2] - actual.bounds[axis]) / image.sizePx[axis] * image.sizeUnits[axis]);
    const metric = expected.category === 'glove' ? size => Math.sqrt(size[0] * size[1]) :
      ['bow', 'staff', 'fan'].includes(expected.category) ? size => size[1] : size => size[0];
    close(metric(newSize), metric(oldSize), `${expected.id}: visible battle size target is identical`);
    newSize.forEach((value, axis) => assert.ok(Math.abs(value / oldSize[axis] - 1) < .02, `${expected.id}: perpendicular raster rounding stays below 2%`));
    if (appearance.bowString) {
      for (const key of ['drawPx', 'handRetreatPx', 'lineWidthPx']) {
        close(appearance.bowString[key] / image.ppu, before.bowString[key] / old.ppu, `${expected.id}: ${key} in world units is unchanged`);
      }
    }
  }
  assert.ok(bytes <= 2_000_000, `65 runtime PNGs must stay below 2 MB; found ${bytes} bytes`);
});

test('all 65 installed PNGs match their approved sources, exact export geometry and current world scale', () => {
  const { createHash } = require('node:crypto');
  const { pngAlpha } = require('./support/png-alpha.cjs');
  const raid = require('../assets/resources/art/raid-system/config.json');
  assert.deepEqual(approvedArt.map(weapon => weapon.id), getWeaponCatalog().map(weapon => weapon.id));
  for (const expected of approvedArt) {
    const weapon = getWeaponCatalog()[expected.id], appearance = visuals.weapons[expected.id], image = appearance.image;
    const key = config.gunIcons[expected.id], icon = config.images[key];
    const png = fs.readFileSync(resource(image.path + '.png'));
    const full = pngAlpha(png, 1), visible = pngAlpha(png, 16);
    assert.equal(weapon.category, expected.category, `${key}: approved family`);
    assert.equal(image.path, expected.previousRuntimePath, `${key}: stable runtime path`);
    assert.equal(createHash('sha256').update(png).digest('hex'), expected.sha256, `${key}: exact approved source bytes`);
    assert.equal(Math.max(full.width, full.height), 208, `${key}: compressed canvas long edge`);
    assert.deepEqual([full.width, full.height], expected.sizePx, `${key}: reviewed compressed dimensions`);
    assert.deepEqual(full.bounds, expected.alphaBounds1, `${key}: full-alpha export bounds`);
    assert.deepEqual(visible.bounds, expected.alphaBounds16, `${key}: stable alpha16 body`);
    assert.equal(expected.worldSpanAlphaThreshold, 16);
    assert.ok(full.bounds[0] >= 2 && full.bounds[1] >= 2 && full.bounds[2] <= full.width - 2 && full.bounds[3] <= full.height - 2,
      `${key}: transparent filtering margin`);
    assert.deepEqual(image.sizePx, [full.width, full.height]);
    assert.deepEqual(icon.sizePx, image.sizePx); assert.deepEqual(icon.anchor, image.anchor);
    assert.deepEqual(icon.uiVisibleBoundsPx, visible.bounds, `${key}: actual alpha16 UI body`);
    const hull = icon.uiVisibleHullPx;
    assert.ok(hull?.length >= 3 && hull.every(point => point.length === 2 && point.every(Number.isFinite)), `${key}: registered UI hull`);
    if (['cannon', 'handgun', 'fan'].includes(weapon.category)) {
      for (const angle of [0, 24, -24, 90]) {
        const cosine = Math.cos(angle * Math.PI / 180), sine = Math.sin(angle * Math.PI / 180);
        const extent = points => {
          const bounds = [Infinity, Infinity, -Infinity, -Infinity];
          for (const [x, y] of points) {
            const u = cosine * x + sine * y, v = sine * x - cosine * y;
            bounds[0] = Math.min(bounds[0], u); bounds[1] = Math.min(bounds[1], v);
            bounds[2] = Math.max(bounds[2], u); bounds[3] = Math.max(bounds[3], v);
          }
          return bounds;
        };
        function* cells() {
          for (let y = 0; y < visible.height; y++) for (let x = 0; x < visible.width; x++) {
            if (visible.at(x, y) < 16) continue;
            yield [x, y]; yield [x + 1, y]; yield [x, y + 1]; yield [x + 1, y + 1];
          }
        }
        const projected = extent(hull);
        extent(cells()).forEach((value, axis) => close(value, projected[axis], `${key}/${angle}: real alpha projection ${axis}`));
      }
    }
    assert.deepEqual(raid.images[key], icon, `${key}: both UI catalogs share registration`);
    assert.ok(Number.isFinite(image.ppu) && image.ppu > 0);
    image.sizeUnits.forEach((value, axis) => close(value, image.sizePx[axis] / image.ppu, `${key}: canvas units ${axis}`));
    const axis = expected.majorAxis === 'width' ? 0 : 1;
    const worldBounds = visible.bounds;
    close((worldBounds[axis + 2] - worldBounds[axis]) / image.ppu, expected.visibleMajorWorldUnits, `${key}: preserved visible world span`);
    assert.deepEqual(image.localScale, expected.localScale, `${key}: battle scale preserved`);
    if (weapon.id === 23) assert.deepEqual(image.localScale, [.552, -.552], 'SS cannon retains the approved category baseline');
    assert.deepEqual(image.localPosition, expected.localPosition, `${key}: holding transform preserved`);
    assert.equal(image.localRotationDeg || 0, expected.localRotationDeg, `${key}: authored image orientation`);
    const grip = [image.anchor[0] * full.width, (1 - image.anchor[1]) * full.height];
    grip.forEach((value, axis) => close(value, expected.gripPx[axis], `${key}: reviewed grip ${axis}`));
    assert.ok(full.at(...grip) >= 16, `${key}: grip lies on painted art`);
    const launch = [grip[0] + appearance.muzzle.localPosition[0] * image.ppu,
      grip[1] - appearance.muzzle.localPosition[1] * image.ppu];
    launch.forEach((value, axis) => close(value, expected.muzzlePx[axis], `${key}: reviewed launch point ${axis}`));
    if (weapon.id === 63) assert.deepEqual(appearance.supportGripPx, expected.supportGripPx, `${key}: reviewed support point`);
    const meta = JSON.parse(fs.readFileSync(resource(image.path + '.png.meta'), 'utf8'));
    assert.equal(meta.uuid, expected.uuid, `${key}: image UUID preserved`);
    const frame = meta.subMetas.f9941.userData;
    assert.deepEqual([frame.width, frame.height, frame.rawWidth, frame.rawHeight], [full.width, full.height, full.width, full.height]);
    assert.deepEqual([frame.pivotX, frame.pivotY], image.anchor);
    assert.equal(frame.pixelsToUnit, image.ppu); assert.equal(frame.trimType, 'none');
  }
});

test('all 65 authored weapon icons, collection identities and equipped appearances agree', () => {
  const catalog = getWeaponCatalog(), collection = Object.values(config.roles).find(role => role.type === 'Gun_Collection_UI');
  const roles = collection.Gun_Item_list.map(key => config.roles[key]);
  assert.equal(config.gunIcons.length, catalog.length); assert.equal(roles.length, catalog.length);
  assert.deepEqual(roles.map(role => role.GunNum).sort((a, b) => a - b), catalog.map(w => w.id));
  assert.equal(new Set(config.gunIcons).size, catalog.length); assert.equal(visuals.weapons.length, catalog.length);
  catalog.forEach(w => {
    const icon = config.images[config.gunIcons[w.id]], appearance = visuals.weapons[w.id];
    assert.equal(appearance.id, w.id); assert.ok(icon); assert.equal(icon.path, appearance.image.path);
    assert.ok(fs.existsSync(resource(icon.path + '.png')), `missing weapon image ${w.id}`);
    assert.ok(visuals.projectileSkins[appearance.projectileSkin], `missing projectile ${w.id}`);
    assert.ok(visuals.muzzleSkins[appearance.muzzleSkin], `missing muzzle ${w.id}`);
  });
});

test('D/C/B/A bows share complete string registration across battle and both UI catalogs', () => {
  const raid = require('../assets/resources/art/raid-system/config.json');
  const bows = getWeaponCatalog().filter(weapon => weapon.category === 'bow');
  assert.deepEqual(bows.map(weapon => weapon.grade), [0, 1, 2, 3, 0, 0, 1]);
  const keys = bows.map(weapon => config.gunIcons[weapon.id]);
  const centeredKeys = getWeaponCatalog().map(weapon => config.gunIcons[weapon.id]);
  for (const ui of [config, raid]) {
    assert.deepEqual(Object.keys(ui.images).filter(key => ui.images[key].uiBowString).sort(), [...keys].sort(), 'only the seven bows add UI strings');
    assert.deepEqual(Object.keys(ui.images).filter(key => ui.images[key].uiVisibleBoundsPx).sort(), [...centeredKeys].sort(), 'all weapons are centered independently of their battle grips');
  }
  assert.deepEqual(visuals.weapons.filter(weapon => weapon.bowString).map(weapon => weapon.id), bows.map(weapon => weapon.id));
  for (const bow of bows) {
    const key = config.gunIcons[bow.id], appearance = visuals.weapons[bow.id], image = appearance.image;
    const icon = config.images[key], string = appearance.bowString;
    const png = fs.readFileSync(resource(image.path + '.png'));
    assert.deepEqual(image.sizePx, [png.readUInt32BE(16), png.readUInt32BE(20)], `${key}: coordinates use the actual exported PNG`);
    assert.deepEqual(icon.sizePx, image.sizePx); assert.deepEqual(raid.images[key], icon);
    const [width, height] = image.sizePx, bounds = icon.uiVisibleBoundsPx;
    assert.equal(bounds.length, 4); assert.ok(bounds.every(Number.isFinite));
    assert.ok(bounds[0] >= 0 && bounds[1] >= 0 && bounds[2] <= width && bounds[3] <= height);
    assert.ok(bounds[0] < bounds[2] && bounds[1] < bounds[3]);
    assert.ok(Math.abs(bounds[1] - (height - bounds[3])) <= 1, `${key}: bow PNG top/bottom visible margins agree`);
    for (const field of ['upperPx', 'lowerPx', 'bracePx']) {
      assert.equal(string[field].length, 2); assert.ok(string[field].every(Number.isFinite));
      assert.ok(string[field][0] >= 0 && string[field][0] <= width && string[field][1] >= 0 && string[field][1] <= height);
      assert.deepEqual(icon.uiBowString[field], string[field], `${key}: UI and battle ${field}`);
    }
    assert.ok(string.upperPx[1] < string.bracePx[1] && string.bracePx[1] < string.lowerPx[1]);
    assert.ok(Number.isFinite(string.drawPx) && string.drawPx > 0);
    assert.ok(Number.isFinite(string.handRetreatPx) && string.handRetreatPx > 0);
    assert.ok(Number.isFinite(string.bracePx[0] - string.drawPx - string.handRetreatPx), 'dynamic hands may extend beyond tight PNG bounds');
    assert.equal(icon.uiBowString.handRetreatPx, undefined, 'battle hand placement does not alter the collection string');
    assert.ok(Number.isFinite(string.lineWidthPx) && string.lineWidthPx > 0);
    assert.ok(Number.isFinite(icon.uiBowString.widthPx) && icon.uiBowString.widthPx > 0);
    assert.ok(icon.uiBowString.widthPx <= string.lineWidthPx, 'battle string may be heavier for world-scale readability');
    assert.equal(string.color.length, 4); assert.ok(string.color.every(value => Number.isFinite(value) && value >= 0 && value <= 255));
    assert.deepEqual(icon.uiBowString.color, string.color);
    assert.ok(Math.abs((1 - image.anchor[1]) * height - string.bracePx[1]) < .001, `${key}: string brace and arrow grip share a height`);
  }
});

test('seven bow PNGs have exact transparent margins, grade-scaled battle height and source-aligned grips', () => {
  const { pngAlpha } = require('./support/png-alpha.cjs');
  const bows = getWeaponCatalog().filter(w => w.category === 'bow');
  for (const bow of bows) {
    const key=config.gunIcons[bow.id],image=config.images[key],battle=visuals.weapons[bow.id].image;
    const png=fs.readFileSync(resource(image.path+'.png')),alpha=pngAlpha(png,1);
    assert.equal(alpha.height,208); assert.deepEqual(alpha.bounds,approvedById.get(bow.id).alphaBounds1);
    assert.deepEqual(image.uiVisibleBoundsPx,pngAlpha(png,16).bounds);
    for(let y=0;y<alpha.height;y++) for(let x=0;x<alpha.width;x++)
      if(x<2||y<2||x>=alpha.width-2||y>=alpha.height-2) assert.equal(alpha.at(x,y),0,`${key}: transparent padding`);
    close((image.uiVisibleBoundsPx[3]-image.uiVisibleBoundsPx[1])/battle.ppu,137/7.5,`${key}: visible bow height survives resolution change`);
    close(battleVisibleSize(battle)[1],7.672*(1+.03*bow.grade),`${key}: battle height grows by three percent of the D baseline per grade`);
    close(battle.localScale[0],-battle.localScale[1],`${key}: scaling preserves proportions and the vertical flip`);
    assert.equal(image.uiHeightReference,'bow_D_1452001');assert.ok(image.uiVisibleHullPx.length>=3);
    const grip=[battle.anchor[0]*alpha.width,(1-battle.anchor[1])*alpha.height];
    const bowString=visuals.weapons[bow.id].bowString;
    assert.ok(grip[0]>bowString.bracePx[0],`${key}: the string remains behind the holding grip`);
    const [top,bottom,brace]=[bowString.upperPx,bowString.lowerPx,bowString.bracePx];
    const restingX=top[0]+(bottom[0]-top[0])*(brace[1]-top[1])/(bottom[1]-top[1]);
    assert.ok(Math.abs(restingX-brace[0])<.0001,`${key}: asymmetric tips keep the resting string straight`);
    assert.ok(alpha.at(...grip)>=16,`${key}: holding grip lies on the painted grip`);
    for(const point of [visuals.weapons[bow.id].bowString.upperPx,visuals.weapons[bow.id].bowString.lowerPx])
      assert.ok(alpha.at(...point)>=16,`${key}: string ends touch the painted limb`);
    const meta=JSON.parse(fs.readFileSync(resource(image.path+'.png.meta'),'utf8')).subMetas.f9941.userData;
    assert.deepEqual([meta.pivotX,meta.pivotY],battle.anchor);assert.equal(meta.trimType,'none');
  }
  const collection=Object.values(config.roles).find(r=>r.type==='Gun_Collection_UI');
  const order=collection.Gun_Item_list.map(key=>config.roles[key].GunNum);
  assert.deepEqual(order.filter(id=>getWeaponCatalog()[id].category==='bow'),[59,60,0,2,61,5,9]);
  assert.deepEqual(order.slice(0,10),[59,60,0,1,62,2,61,3,63,4]);
});

test('all eight crossbows register authored sprites, original-palm image offsets, launch rails and matching UI bounds', () => {
  const raid = require('../assets/resources/art/raid-system/config.json');
  const attachments = require('../assets/resources/art/characters/cat_basic/rig.json').attachments;
  const imageOffset = attachments.hand.localPosition.map((value, axis) => value - attachments.gun.localPosition[axis]);
  const crossbows = getWeaponCatalog().filter(weapon => weapon.category === 'crossbow');
  assert.deepEqual(crossbows.map(weapon => weapon.grade), [0, 1, 2, 3, 4, 0, 1, 2]);
  const expected = new Map([[1,'D_1462001'],[62,'D_1462210'],[3,'C_1462028'],[63,'C_1462003'],
    [6,'B_1462029'],[64,'B_1462006'],[10,'A_1462011'],[14,'S_1462125']]);
  for (const crossbow of crossbows) {
    const key = config.gunIcons[crossbow.id], appearance = visuals.weapons[crossbow.id], image = appearance.image;
    const icon = config.images[key], bounds = icon.uiVisibleBoundsPx, support = appearance.supportGripPx;
    assert.equal(key, `crossbow_${expected.get(crossbow.id)}`, `${crossbow.id}: approved source and grade`);
    assert.deepEqual(raid.images[key], icon, `${key}: Raid and all standard UI use one registration`);
    assert.equal(icon.uiBowString, undefined, `${key}: crossbow strings belong to the painted silhouette`);
    assert.ok(Number.isFinite(image.ppu) && image.ppu > 0);
    close(battleVisibleSize(image)[0], 6.492255 * (1 + .03 * crossbow.grade), `${key}: battle width follows the D baseline and grade`);
    close(image.localScale[0] / image.localScale[1], -.875, `${key}: scaling retains the authored crossbow aspect correction and flip`);
    assert.deepEqual(image.localPosition, imageOffset, `${key}: image follows the original palm without moving the gun pivot`);
    assert.equal(icon.localScale, undefined, `${key}: battle scale leaves the centered UI scale unchanged`);
    assert.ok(bounds?.length === 4 && bounds.every(Number.isFinite), `${key}: visible artwork bounds are explicit`);
    const [width, height] = image.sizePx, grip = [image.anchor[0] * width, (1 - image.anchor[1]) * height];
    const png = fs.readFileSync(resource(image.path + '.png'));
    assert.deepEqual(image.sizePx, [png.readUInt32BE(16), png.readUInt32BE(20)]);
    assert.ok(bounds[0] > 0 && bounds[1] > 0 && bounds[2] < width && bounds[3] < height, `${key}: no clipped edge`);
    assert.ok(bounds[2] - bounds[0] >= 80 && bounds[3] - bounds[1] >= 40, `${key}: readable authored silhouette`);
    assert.ok(support?.length === 2 && support.every(Number.isFinite), `${key}: retained artwork registration point`);
    for (const point of [grip, support]) {
      assert.ok(bounds[0] <= point[0] && point[0] < bounds[2] && bounds[1] <= point[1] && point[1] < bounds[3]);
    }
    const launch = [grip[0] + appearance.muzzle.localPosition[0] * image.ppu,
      grip[1] - appearance.muzzle.localPosition[1] * image.ppu];
    assert.ok(support[0] > grip[0] && launch[0] > support[0], `${key}: retained grip/support markers and launch point follow the rail`);
    assert.ok(Math.abs(launch[1] - grip[1]) / image.ppu <= 12 / 7.5, `${key}: horizontal projectile rail stays near the holding axis in world units`);
  }
});

test('eight crossbows retain their approved full-alpha edges, stable alpha16 UI hulls and synchronized import pivots', () => {
  const { pngAlpha } = require('./support/png-alpha.cjs');
  const activeFiles=config.gunIcons.filter(key=>key.startsWith('crossbow_')).map(key=>key+'.png').sort();
  assert.deepEqual(fs.readdirSync(resource('art/weapons/redesigned')).filter(name=>name.startsWith('crossbow_')&&name.endsWith('.png')).sort(),activeFiles,
    'superseded crossbow assets are archived outside runtime resources');
  for (const weapon of getWeaponCatalog().filter(w => w.category === 'crossbow')) {
    const key = config.gunIcons[weapon.id], icon = config.images[key], battle = visuals.weapons[weapon.id].image;
    const png = fs.readFileSync(resource(icon.path + '.png'));
    const alpha = pngAlpha(png, 1), visible = pngAlpha(png, 16);
    const expectedBounds = approvedById.get(weapon.id).alphaBounds1;
    assert.deepEqual(alpha.bounds, expectedBounds, `${key}: actual all-alpha bounds match its approved export`);
    assert.equal(icon.uiAlphaThreshold, 16, `${key}: UI ignores faint peripheral source pixels`);
    assert.deepEqual(icon.uiVisibleBoundsPx, visible.bounds, `${key}: UI bounds measure the actual alpha16 body`);
    for (let y=0;y<alpha.height;y++) for (let x=0;x<alpha.width;x++)
      if (x<expectedBounds[0] || y<expectedBounds[1] || x>=expectedBounds[2] || y>=expectedBounds[3]) assert.equal(alpha.at(x,y), 0, `${key}: transparent area outside approved alpha bounds`);
    const hull=icon.uiVisibleHullPx;
    assert.ok(hull?.length>=3 && hull.every(p=>p.length===2 && p.every(Number.isFinite)));
    assert.deepEqual([Math.min(...hull.map(p=>p[0])),Math.min(...hull.map(p=>p[1])),
      Math.max(...hull.map(p=>p[0])),Math.max(...hull.map(p=>p[1]))], visible.bounds, `${key}: hull uses stable body bounds`);
    // Project actual occupied pixel-cell corners independently of the registered
    // hull, including the collection angle, so a noise-shifted hull cannot pass.
    function* corners() {
      for (let y=0;y<visible.height;y++) for (let x=0;x<visible.width;x++) {
        if (visible.at(x,y) < 16) continue;
        yield [x,y]; yield [x+1,y]; yield [x,y+1]; yield [x+1,y+1];
      }
    }
    for (const angle of [0,24,-24,90]) {
      const cosine=Math.cos(angle*Math.PI/180), sine=Math.sin(angle*Math.PI/180);
      const projectBounds = points => {
        const result=[Infinity,Infinity,-Infinity,-Infinity];
        for (const [x,y] of points) {
          const px=cosine*x+sine*y, py=sine*x-cosine*y;
          result[0]=Math.min(result[0],px); result[1]=Math.min(result[1],py);
          result[2]=Math.max(result[2],px); result[3]=Math.max(result[3],py);
        }
        return result;
      };
      const fromPixels=projectBounds(corners()), fromHull=projectBounds(hull);
      fromPixels.forEach((value,axis)=>assert.ok(Math.abs(value-fromHull[axis])<1e-8,
        `${key}/${angle}: UI hull preserves actual alpha16 projection ${axis}`));
    }
    const grip=[battle.anchor[0]*alpha.width,(1-battle.anchor[1])*alpha.height];
    assert.ok(alpha.at(...grip)>0, `${key}: holding anchor touches the authored grip`);
    const meta=JSON.parse(fs.readFileSync(resource(icon.path+'.png.meta'),'utf8')).subMetas.f9941.userData;
    assert.deepEqual([meta.width,meta.height],[alpha.width,alpha.height]);
    assert.deepEqual([meta.pivotX,meta.pivotY],battle.anchor);
    assert.equal(meta.pixelsToUnit,battle.ppu); assert.equal(meta.trimType,'none');
  }
  const collection=Object.values(config.roles).find(r=>r.type==='Gun_Collection_UI');
  const order=collection.Gun_Item_list.map(key=>config.roles[key].GunNum);
  assert.deepEqual(order.filter(id=>getWeaponCatalog()[id].category==='crossbow'),[1,62,3,63,6,64,10,14]);
  for (const grade of [0,1,2]) {
    const members=order.filter(id=>getWeaponCatalog()[id].grade===grade);
    assert.equal(members.length,5);
    const rectangles=members.map(id=>{
      const role=Object.values(config.roles).find(r=>r.type==='Gun_Item_Collection'&&r.GunNum===id);
      return config.nodes[role.node].rect;
    });
    rectangles.forEach((rect,index)=>{
      assert.equal(rect.position[1],-140-grade*240);
      if(index) assert.ok(rect.position[0]-rectangles[index-1].position[0]>=rect.size[0]*rect.scale[0],'collection cards do not overlap');
    });
  }
});

test('green A fan retains its approved baseline while all ten fans grow in visible height with grade', () => {
  const { pngAlpha } = require('./support/png-alpha.cjs');
  const key = 'fan_A_1292001', appearance = visuals.weapons[13], battle = appearance.image;
  const icon = config.images[key], raid = require('../assets/resources/art/raid-system/config.json');
  const actual = pngAlpha(fs.readFileSync(resource(icon.path + '.png')), 1);
  assert.equal(config.gunIcons[13], key); assert.deepEqual(raid.images[key], icon);
  assert.deepEqual(battle.sizePx, [actual.width, actual.height]);
  assert.deepEqual(actual.bounds, approvedById.get(13).alphaBounds1);
  assert.deepEqual(icon.uiVisibleBoundsPx, pngAlpha(fs.readFileSync(resource(icon.path + '.png')), 16).bounds);
  const hull = icon.uiVisibleHullPx;
  assert.deepEqual([Math.min(...hull.map(p => p[0])), Math.min(...hull.map(p => p[1])),
    Math.max(...hull.map(p => p[0])), Math.max(...hull.map(p => p[1]))], icon.uiVisibleBoundsPx);
  const grip = [battle.anchor[0] * actual.width, (1 - battle.anchor[1]) * actual.height];
  const launch = [grip[0] + appearance.muzzle.localPosition[0] * battle.ppu,
    grip[1] - appearance.muzzle.localPosition[1] * battle.ppu];
  assert.ok(actual.at(...grip) >= 128, 'holding anchor lies on the painted hinge');
  assert.ok(launch[0] > grip[0] && Math.abs(launch[0] - actual.bounds[2]) <= 1 && actual.at(Math.min(launch[0] - 1, actual.bounds[2] - 1), launch[1]) > 0,
    'projectile exits within one compressed pixel of the painted fan edge');
  close(launch[1], grip[1], 'fan hinge and launch axis');
  close((icon.uiVisibleBoundsPx[3] - icon.uiVisibleBoundsPx[1]) / battle.ppu, 11.072500395983472, 'preserved fan world height');
  assert.deepEqual(battle.localScale, [.62073, -.62073]); assert.deepEqual(battle.localPosition, [0, 0]);
  const targetHeight = 6.87303317079882;
  const fans = getWeaponCatalog().filter(weapon => weapon.category === 'fan');
  assert.equal(fans.length, 10);
  for (const fan of fans) {
    const image = visuals.weapons[fan.id].image;
    const pixels = pngAlpha(fs.readFileSync(resource(image.path + '.png')), 16);
    const visibleHeight = (pixels.bounds[3] - pixels.bounds[1]) / image.sizePx[1] * image.sizeUnits[1] * Math.abs(image.localScale[1]);
    const expectedHeight = targetHeight * (1 + .03 * (fan.grade - 3));
    close(visibleHeight, expectedHeight, `${config.gunIcons[fan.id]}: battle height grows by three percent of the A baseline per grade`);
    close(image.localScale[0], -image.localScale[1], `${config.gunIcons[fan.id]}: uniform scaling preserves fan proportions and vertical flip`);
  }
  assert.equal(appearance.projectileSkin, '71286-69964'); assert.equal(appearance.muzzleSkin, 'none'); assert.equal(appearance.soundId, 20);
  const meta = JSON.parse(fs.readFileSync(resource(icon.path + '.png.meta'), 'utf8'));
  assert.equal(meta.uuid, '406f2dc9-cee5-5997-b748-78b95bed727c');
  const frame = meta.subMetas.f9941.userData;
  assert.deepEqual([frame.width, frame.height], battle.sizePx);
  assert.deepEqual([frame.pivotX, frame.pivotY], battle.anchor);
  assert.equal(frame.pixelsToUnit, battle.ppu); assert.equal(frame.trimType, 'none');
});

test('all eleven vertical staff finals preserve visible world length and register holding grips and forward casting tips', () => {
  const { pngAlpha } = require('./support/png-alpha.cjs');
  const raid = require('../assets/resources/art/raid-system/config.json');
  const attachments = require('../assets/resources/art/characters/cat_basic/rig.json').attachments;
  const offset = attachments.hand.localPosition.map((value, axis) => value - attachments.gun.localPosition[axis]);
  const staves = getWeaponCatalog().filter(weapon => weapon.category === 'staff');
  assert.deepEqual(staves.map(weapon => weapon.id), [8, 12, 16, 20, 25, 30, 35, 40, 45, 50, 55]);
  for (const staff of staves) {
    const key = config.gunIcons[staff.id], appearance = visuals.weapons[staff.id], image = appearance.image;
    const icon = config.images[key], actual = pngAlpha(fs.readFileSync(resource(image.path + '.png')));
    const [left, top, right, bottom] = actual.bounds;
    assert.equal(image.sizePx[1], 208); assert.deepEqual([actual.width, actual.height], image.sizePx);
    assert.deepEqual(icon.uiVisibleBoundsPx, actual.bounds, `${key}: UI uses measured alpha bounds`);
    assert.deepEqual(raid.images[key], icon, `${key}: Raid uses the same image registration`);
    const hull = icon.uiVisibleHullPx;
    assert.ok(hull?.length >= 3 && hull.length < 100, `${key}: actual alpha hull is registered for rotated UI`);
    assert.equal(icon.uiHeightReference, undefined, `${key}: staff length normalization is authored, not borrowed from another weapon`);
    for (const angle of [0, 15, 22.6, 24, 90, -24]) {
      const cosine = Math.cos(angle * Math.PI / 180), sine = Math.sin(angle * Math.PI / 180);
      const projected = points => {
        const extent = [Infinity, Infinity, -Infinity, -Infinity];
        for (const [x, y] of points) {
          const px = cosine * x + sine * y, py = sine * x - cosine * y;
          extent[0] = Math.min(extent[0], px); extent[1] = Math.min(extent[1], py);
          extent[2] = Math.max(extent[2], px); extent[3] = Math.max(extent[3], py);
        }
        return extent;
      };
      function* visibleCells() {
        for (let y = 0; y < actual.height; y++) for (let x = 0; x < actual.width; x++) {
          if (actual.at(x, y) < 16) continue;
          yield [x, y]; yield [x + 1, y]; yield [x, y + 1]; yield [x + 1, y + 1];
        }
      }
      const fromHull = projected(hull), fromPixels = projected(visibleCells());
      fromPixels.forEach((value, axis) => assert.ok(Math.abs(value - fromHull[axis]) < 1e-8, `${key}/${angle}: hull preserves rotated alpha boundary ${axis}`));
    }
    close((bottom - top) / image.ppu, approvedById.get(staff.id).visibleMajorWorldUnits, `${key}: original visible world length`);
    assert.ok(left > 0 && top > 0 && right < actual.width && bottom < actual.height, `${key}: no edge clips`);
    assert.ok(Math.abs(left - (actual.width - right)) <= 1, `${key}: equal left/right canvas margins`);
    assert.ok(Math.abs(top - (actual.height - bottom)) <= 1, `${key}: equal top/bottom canvas margins`);
    close(battleVisibleSize(image)[1], 8.619350308251988 * (1 + .03 * (staff.grade - 2)), `${key}: source-axis staff length follows the B baseline and grade`);
    close(image.localScale[0], -image.localScale[1], `${key}: scaling preserves proportions and the vertical flip`);
    assert.equal(image.localRotationDeg, 90, `${key}: vertical source becomes horizontal in battle`);
    image.sizeUnits.forEach((value, axis) => close(value, image.sizePx[axis] / image.ppu, `${key}: high-resolution canvas world dimensions`));
    assert.deepEqual(image.localPosition, offset, `${key}: artwork grip follows the original gun-holding palm`);
    assert.deepEqual(icon.anchor, image.anchor); assert.equal(icon.localScale, undefined); assert.equal(icon.uiDisplayScale, undefined);
    const grip = [image.anchor[0] * actual.width, (1 - image.anchor[1]) * actual.height];
    const tip = [grip[0] + appearance.muzzle.localPosition[0] * image.ppu, grip[1] - appearance.muzzle.localPosition[1] * image.ppu];
    for (const [label, point] of [['grip', grip], ['casting tip', tip]]) {
      // World-to-pixel division can return 2.999999999999943 for a reviewed
      // y=3 tip. Snap numerical noise only before sampling discrete pixels.
      const sample = point.map(value => Math.abs(value - Math.round(value)) < 1e-8 ? Math.round(value) : value);
      assert.ok(sample.every(Number.isFinite) && sample[0] >= left && sample[0] < right && sample[1] >= top && sample[1] < bottom, `${key}: ${label} inside visible bounds`);
      assert.ok(actual.at(...sample) >= 16, `${key}: ${label} is registered on the actual artwork`);
    }
    assert.ok(tip[1] < grip[1], `${key}: casting tip is above the holding palm in the vertical PNG`);
    const radians = image.localRotationDeg * Math.PI / 180;
    const local = appearance.muzzle.localPosition;
    const forward = Math.cos(radians) * local[0] * image.localScale[0] - Math.sin(radians) * local[1] * image.localScale[1];
    assert.ok(forward > 0, `${key}: image flip and rotation put the casting tip ahead of the holding palm`);
    close(appearance.muzzle.localRotationDeg, 90, `${key}: cast effect faces forward after image flip and rotation`);
    const meta = JSON.parse(fs.readFileSync(resource(image.path + '.png.meta'), 'utf8')).subMetas.f9941.userData;
    assert.deepEqual([meta.pivotX, meta.pivotY], image.anchor, `${key}: SpriteFrame and battle share the grip`);
    assert.equal(meta.trimType, 'none'); assert.equal(meta.pixelsToUnit, image.ppu);
  }
});

test('all twelve gloves retain UI registration and their visible battle width and height never fall below C grade', () => {
  const { pngAlpha } = require('./support/png-alpha.cjs');
  const cuffs = require('./fixtures/glove-cuff-registration.json').weapons;
  const raid = require('../assets/resources/art/raid-system/config.json');
  const gloves = getWeaponCatalog().filter(weapon => weapon.category === 'glove');
  assert.deepEqual(gloves.map(weapon => weapon.grade), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const reference = config.images.claw_C_1472000;
  assert.deepEqual(reference.uiHeightReferenceFrame.sizePx, [256, 143]);
  const frozenHull = reference.uiHeightReferenceFrame.uiVisibleHullPx;
  assert.deepEqual([Math.min(...frozenHull.map(p => p[0])), Math.min(...frozenHull.map(p => p[1])),
    Math.max(...frozenHull.map(p => p[0])), Math.max(...frozenHull.map(p => p[1]))], [23, 35, 140, 109]);
  assert.equal(reference.uiHeightReference, 'claw_C_1472000');
  const cBattle = visuals.weapons[4].image, cPixels = pngAlpha(fs.readFileSync(resource(cBattle.path + '.png')));
  const cVisibleSize = [0, 1].map(axis => (cPixels.bounds[axis + 2] - cPixels.bounds[axis]) /
    cBattle.sizePx[axis] * cBattle.sizeUnits[axis] * Math.abs(cBattle.localScale[axis]));
  for (const glove of gloves) {
    const key = config.gunIcons[glove.id], icon = config.images[key], battle = visuals.weapons[glove.id].image;
    const actual = pngAlpha(fs.readFileSync(resource(icon.path + '.png'))), hull = icon.uiVisibleHullPx;
    const bounds = icon.uiVisibleBoundsPx;
    assert.deepEqual(raid.images[key], icon, `${key}: standard UI and Raid share registration`);
    assert.equal(bounds.length, 4); assert.ok(bounds.every(Number.isFinite));
    assert.ok(bounds[0] > 0 && bounds[1] > 0 && bounds[2] < icon.sizePx[0] && bounds[3] < icon.sizePx[1]);
    assert.ok(bounds[2] > bounds[0] && bounds[3] > bounds[1]);
    assert.deepEqual(bounds, actual.bounds, `${key}: registered bounds match alpha >= 16`);
    for (const axis of [0, 1]) {
      const visibleSize = (actual.bounds[axis + 2] - actual.bounds[axis]) /
        battle.sizePx[axis] * battle.sizeUnits[axis] * Math.abs(battle.localScale[axis]);
      assert.ok(visibleSize + 1e-8 >= cVisibleSize[axis], `${key}: battle ${axis ? 'height' : 'width'} is at least C grade`);
    }
    const visibleSize = battleVisibleSize(battle);
    close(Math.sqrt(visibleSize[0] * visibleSize[1]), Math.sqrt(cVisibleSize[0] * cVisibleSize[1]) * (1 + .03 * (glove.grade - 1)),
      `${key}: equivalent visible size grows linearly with grade while retaining the C width and height floors`);
    close(battle.localScale[0], -battle.localScale[1], `${key}: proportional scaling preserves the vertical flip`);
    if (glove.id === 4) assert.deepEqual(battle.localScale, [.4, -.4], `${key}: C retains the approved category baseline`);
    assert.equal(icon.uiHeightReference, 'claw_C_1472000');
    assert.equal(icon.uiDisplayScale, undefined, `${key}: old minimum-only multiplier no longer biases height`);
    assert.ok(hull.length >= 3 && hull.length < 100, `${key}: compact precomputed convex hull`);
    assert.ok(hull.every(point => point.length === 2 && point.every(Number.isInteger) && point[0] >= 0 && point[0] <= actual.width && point[1] >= 0 && point[1] <= actual.height));
    for (const angle of [0, 15, 22.6, 24, 90, -24]) {
      const cosine = Math.cos(angle * Math.PI / 180), sine = Math.sin(angle * Math.PI / 180);
      const projected = points => {
        const result = [Infinity, Infinity, -Infinity, -Infinity];
        for (const [x, y] of points) {
          const px = cosine * x + sine * y, py = sine * x - cosine * y;
          result[0] = Math.min(result[0], px); result[1] = Math.min(result[1], py);
          result[2] = Math.max(result[2], px); result[3] = Math.max(result[3], py);
        }
        return result;
      };
      function* visibleCells() {
        for (let y = 0; y < actual.height; y++) for (let x = 0; x < actual.width; x++) {
          if (actual.at(x, y) < 16) continue;
          yield [x, y]; yield [x + 1, y]; yield [x, y + 1]; yield [x + 1, y + 1];
        }
      }
      const fromHull = projected(hull), fromPixels = projected(visibleCells());
      fromPixels.forEach((value, axis) => assert.ok(Math.abs(value - fromHull[axis]) < 1e-8, `${key}/${angle}: hull preserves real rotated alpha boundary ${axis}`));
    }
    assert.deepEqual(icon.anchor, battle.anchor); assert.deepEqual(icon.sizePx, battle.sizePx);
    const cuff = cuffs.find(entry => entry.id === glove.id);
    assert.equal(cuff.key, key);
    const expectedAnchor = [cuff.wristEntryPx[0] / actual.width, 1 - cuff.wristEntryPx[1] / actual.height];
    icon.anchor.forEach((value, axis) => assert.ok(Math.abs(value - expectedAnchor[axis]) < 1e-8, `${key}: current cuff registration is preserved`));
    assert.equal(battle.uiDisplayScale, undefined); assert.equal(battle.uiVisibleBoundsPx, undefined);
    assert.equal(battle.uiVisibleHullPx, undefined); assert.equal(battle.uiHeightReference, undefined);
    assert.equal(icon.localScale, undefined, `${key}: UI scale does not borrow an equipped transform`);
    if (glove.id === 4) {
      const fullAlpha = pngAlpha(fs.readFileSync(resource(icon.path + '.png')), 1);
      assert.deepEqual(fullAlpha.bounds, approvedById.get(glove.id).alphaBounds1);
      close((actual.bounds[2] - actual.bounds[0]) / battle.ppu, approvedById.get(glove.id).visibleMajorWorldUnits, `${key}: preserved visible world width`);
      assert.deepEqual(battle.localScale, [.4, -.4]); assert.deepEqual(battle.localPosition, [0, 0]);
      assert.equal(visuals.weapons[4].projectileSkin, 'shuriken-C');
      assert.equal(visuals.weapons[4].muzzleSkin, 'none'); assert.equal(visuals.weapons[4].soundId, 21);
      assert.ok(actual.at(...cuff.wristEntryPx) >= 128);
      // The reviewed release point may lie on the first transparent pixel just
      // outside the knuckles; it must remain within one pixel of the alpha body.
      assert.ok(cuff.attackPointPx[0] >= cuff.wristEntryPx[0]);
      assert.ok(Math.abs(cuff.attackPointPx[0] - fullAlpha.bounds[2]) <= 1);
      const meta = JSON.parse(fs.readFileSync(resource(icon.path + '.png.meta'), 'utf8'));
      assert.equal(meta.uuid, 'd3ebf56b-c1b9-5233-9e4c-8dd9787f2920');
      const frame = meta.subMetas.f9941.userData;
      assert.deepEqual([frame.width, frame.height], battle.sizePx);
      assert.deepEqual([frame.pivotX, frame.pivotY], battle.anchor);
      assert.equal(frame.pixelsToUnit, battle.ppu); assert.equal(frame.trimType, 'none');
    } else assert.equal(icon.uiHeightReferenceFrame, undefined, `${key}: shared UI scale is frozen only on the C reference`);
  }
  for (const ui of [config, raid]) {
    assert.deepEqual(Object.keys(ui.images).filter(key => ui.images[key].uiHeightReference).sort(),
      getWeaponCatalog().filter(w => ['glove','bow'].includes(w.category)).map(weapon => config.gunIcons[weapon.id]).sort(), 'gloves and bows opt into projected-height fitting');
    assert.deepEqual(Object.keys(ui.images).filter(key => ui.images[key].uiVisibleHullPx).sort(),
      getWeaponCatalog().map(weapon => config.gunIcons[weapon.id]).sort(),
      'all 65 weapons use actual projected alpha silhouettes for centering');
  }
});

// Read cmap directly so a system fallback font cannot conceal missing packaged glyphs.
function glyphPresent(buffer, code) {
  let cmap = 0;
  for (let i = 0; i < buffer.readUInt16BE(4); i++) {
    const entry = 12 + i * 16;
    if (buffer.toString('ascii', entry, entry + 4) === 'cmap') cmap = buffer.readUInt32BE(entry + 8);
  }
  assert.ok(cmap, 'font cmap exists');
  for (let i = 0; i < buffer.readUInt16BE(cmap + 2); i++) {
    const base = cmap + buffer.readUInt32BE(cmap + 8 + i * 8), format = buffer.readUInt16BE(base);
    if (format === 12) {
      for (let j = 0; j < buffer.readUInt32BE(base + 12); j++) {
        const p = base + 16 + j * 12, from = buffer.readUInt32BE(p), to = buffer.readUInt32BE(p + 4);
        if (from <= code && code <= to && buffer.readUInt32BE(p + 8) + code - from) return true;
      }
    } else if (format === 4 && code <= 0xffff) {
      const count = buffer.readUInt16BE(base + 6) / 2, end = base + 14;
      const start = end + 2 * count + 2, delta = start + 2 * count, offset = delta + 2 * count;
      for (let j = 0; j < count; j++) if (buffer.readUInt16BE(start + j * 2) <= code && code <= buffer.readUInt16BE(end + j * 2)) {
        const change = buffer.readInt16BE(delta + j * 2), range = buffer.readUInt16BE(offset + j * 2);
        const glyph = range ? buffer.readUInt16BE(offset + j * 2 + range + (code - buffer.readUInt16BE(start + j * 2)) * 2) : code;
        if (glyph && ((glyph + change) & 0xffff)) return true;
      }
    }
  }
  return false;
}

test('the packaged Chinese font contains all weapon names and the seven family labels', () => {
  const font = fs.readFileSync(resource(config.fonts.chinese + '.ttf'));
  const text = getWeaponCatalog().map(w => w.name).join('') + Object.values(WEAPON_CATEGORY_NAMES).join('');
  for (const char of new Set(text)) assert.ok(glyphPresent(font, char.codePointAt(0)), `missing weapon glyph ${char}`);
});
