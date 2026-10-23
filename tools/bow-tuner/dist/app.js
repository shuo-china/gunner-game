'use strict';
const $ = selector => document.querySelector(selector);
const STORAGE_KEY = 'forest-gunner:bow-tuner:v1';
const SCHEMA = 'forest-gunner.bow-pose.v1';
const GROUPS = [
  { title: '持弓轨道', description: '圆心相对当前胸口偏移；半径随弓的原始握距计算。', color: '', fields: [
    ['pivotX', '圆心 · 水平偏移', -5, 5, .01, '单位'], ['pivotY', '圆心 · 垂直偏移', -5, 5, .01, '单位'],
    ['holdingRadiusScale', '持弓半径系数', .1, 2, .01, '倍']] },
  { title: '拉弦手起点', description: '相对圆心的位置，瞄准时固定在这里旋转。', color: 'teal', fields: [
    ['drawHandX', '起点 · 水平偏移', -5, 5, .01, '单位'], ['drawHandY', '起点 · 垂直偏移', -5, 5, .01, '单位'],
    ['drawHandAngle', '手腕角度偏移', -180, 180, 1, '°']] },
  { title: '拉弦动作', description: '从起点沿弓的后方平移，再回到同一位置。', color: 'green', fields: [
    ['drawDistanceScale', '拉弦距离系数', 0, 3, .01, '倍'], ['drawDirectionAngle', '后拉方向偏移', -90, 90, 1, '°']] },
];
const FIELDS = GROUPS.flatMap(group => group.fields), FIELD_MAP = new Map(FIELDS.map(field => [field[0], field]));
const state = { pose: {}, view: { weaponId: 0, skinId: 0, facing: -1, aim: 0, duration: 2, zoom: 1, walk: false, guides: true },
  phase: 0, playing: !matchMedia('(prefers-reduced-motion: reduce)').matches, compare: false };
let defaults, bridge, saving, toastTimer, lastFrame, ready = false, pendingSaved;
try { pendingSaved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { pendingSaved = null; }

function toast(message) {
  $('#toast').textContent = message; $('#toast').classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 3200);
}
function config() { return { schema: SCHEMA, bowPose: { ...state.pose }, preview: { ...state.view } }; }
function changed(save = true) {
  if (!ready) return;
  $('#json-output').value = JSON.stringify(config(), null, 2);
  if (!save) return;
  clearTimeout(saving); $('#save-status').textContent = '保存中';
  saving = setTimeout(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config())); $('#save-status').textContent = '已自动保存'; }
    catch { $('#save-status').textContent = '本次会话'; toast('浏览器未允许保存，请复制或下载参数。'); }
  }, 250);
}
function setParameter(key, input, save = true) {
  if (!ready || !FIELD_MAP.has(key) || !Number.isFinite(Number(input))) return;
  const [, , min, max, step] = FIELD_MAP.get(key);
  const digits = step < 1 ? 2 : 0;
  const value = Number(Math.max(min, Math.min(max, Number(input))).toFixed(digits));
  state.pose[key] = value;
  $(`#${key}`).value = value; $(`#${key}-range`).value = value;
  changed(save);
}
function mountControls() {
  $('#parameters').innerHTML = GROUPS.map(group => `<section class="parameter-group"><div class="group-heading"><i class="group-dot ${group.color}"></i><h3>${group.title}</h3></div><p class="group-description">${group.description}</p>${group.fields.map(([key, label, min, max, step, unit]) => `<div class="parameter"><div class="parameter-line"><label for="${key}">${label}</label><div class="parameter-entry"><input id="${key}" data-key="${key}" type="number" min="${min}" max="${max}" step="${step}" aria-label="${label}"><span>${unit}</span></div></div><input id="${key}-range" data-key="${key}" type="range" min="${min}" max="${max}" step="${step}" aria-label="${label}滑块"><div class="parameter-range"><span>${min}</span><span>${max}</span></div></div>`).join('')}</section>`).join('');
  $('#parameters').addEventListener('input', event => {
    if (!event.target.dataset.key || event.target.value === '') return;
    setParameter(event.target.dataset.key, event.target.value);
  });
  $('#parameters').addEventListener('change', event => {
    const key = event.target.dataset.key;
    if (key && event.target.value === '') event.target.value = state.pose[key];
  });
  for (const [key] of FIELDS) setParameter(key, state.pose[key], false);
  $('#skin').innerHTML = Array.from({ length: 25 }, (_, id) => `<option value="${id}">${id === 0 ? '基础狐狸' : `皮肤 ${String(id + 1).padStart(2, '0')}`}</option>`).join('');
}
function syncView() {
  $('#weapon').value = state.view.weaponId; $('#skin').value = state.view.skinId;
  $('#aim').value = state.view.aim; $('#aim-value').value = `${state.view.aim}°`;
  $('#duration').value = state.view.duration; $('#zoom').value = state.view.zoom;
  $('#walk').checked = state.view.walk; $('#show-guides').checked = state.view.guides;
  $('#facing').textContent = state.view.facing < 0 ? '朝向左 ←' : '朝向右 →';
  $('#play').textContent = state.playing ? 'Ⅱ 暂停' : '▶ 播放';
  $('#compare').setAttribute('aria-pressed', String(state.compare));
  $('#compare-badge').hidden = !state.compare;
  $('#guides').style.visibility = state.view.guides ? 'visible' : 'hidden';
}
function validateImport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请输入一个有效的 JSON 对象。');
  if (value.schema && value.schema !== SCHEMA) throw new Error('参数版本不匹配，请导入这个调试页导出的参数。');
  const pose = value.bowPose ?? value;
  if (!pose || typeof pose !== 'object' || Array.isArray(pose)) throw new Error('缺少 bowPose 参数。');
  const keys = Object.keys(pose);
  if (!keys.length || keys.some(key => !FIELD_MAP.has(key))) throw new Error('包含无法识别的动作参数。');
  for (const key of keys) {
    const [, , min, max] = FIELD_MAP.get(key);
    if (typeof pose[key] !== 'number' || !Number.isFinite(pose[key]) || pose[key] < min || pose[key] > max)
      throw new Error(`${key} 必须是 ${min} 到 ${max} 之间的数字。`);
  }
  const view = { ...state.view }, supplied = value.preview;
  if (supplied && typeof supplied === 'object') {
    if ([0, 2, 5, 9].includes(supplied.weaponId)) view.weaponId = supplied.weaponId;
    if (Number.isInteger(supplied.skinId) && supplied.skinId >= 0 && supplied.skinId < 25) view.skinId = supplied.skinId;
    if ([-1, 1].includes(supplied.facing)) view.facing = supplied.facing;
    for (const [key, min, max] of [['aim', -180, 180], ['duration', .4, 6], ['zoom', .45, 1.5]]) {
      if (typeof supplied[key] === 'number' && Number.isFinite(supplied[key])) view[key] = Math.max(min, Math.min(max, supplied[key]));
    }
    for (const key of ['walk', 'guides']) if (typeof supplied[key] === 'boolean') view[key] = supplied[key];
  }
  return { pose: { ...defaults, ...pose }, view };
}
function applyImport(value) {
  const next = validateImport(value); state.pose = next.pose; state.view = next.view; state.compare = false;
  for (const [key] of FIELDS) setParameter(key, state.pose[key], false);
  syncView(); changed();
}

class GameBridge {
  constructor(win, cc, app) {
    this.win = win; this.cc = cc; this.app = app;
    app.enabled = false; app.world.pause(); app.hudRoot.active = false; app.worldScale.active = false;
    const art = app.battlefield.cat.art;
    this.root = new cc.Node('BowTunerPreview'); this.root.layer = app.colors.world.layer;
    this.root.addComponent(cc.UITransform); app.colors.world.addChild(this.root);
    this.cat = new app.battlefield.cat.constructor(art, this.root);
    this.cat.setAimTarget(null); this.cat.shadow.active = false;
    const linearByte = value => Math.round(Math.pow((value / 255 + .055) / 1.055, 2.4) * 255);
    app.colors.camera.clearColor = new cc.Color(linearByte(241), linearByte(240), linearByte(232), 255);
    app.node.getChildByName('Camera').getComponent(cc.Camera).clearColor = new cc.Color(241, 240, 232, 255);
    this.canvas = app.node.getComponent(cc.UITransform);
    this.gameCanvas = win.document.getElementById('GameCanvas');
    this.lastSize = '';
    this.find = (node, name) => node.name === name ? node : node.children.map(child => this.find(child, name)).find(Boolean);
  }
  render(dt) {
    const { cat, app } = this, view = state.view, pose = state.compare ? defaults : state.pose;
    // Cocos updates its design canvas after the iframe's CSS size changes.
    // Track the settled engine dimensions as well, otherwise the render target
    // uses the old camera height and stretches when the editor becomes narrow.
    const size = `${this.gameCanvas.width}:${this.gameCanvas.height}:${this.canvas.width}:${this.canvas.height}`;
    if (size !== this.lastSize) { app.resize(); this.lastSize = size; }
    const scale = Math.min(this.canvas.width, this.canvas.height) * .145 * view.zoom;
    this.root.setScale(scale, scale, 1); this.root.setPosition(0, -1.9 * scale, 0);
    cat.setSkin(view.skinId); cat.setWeapon(view.weaponId); cat.gradeEffects.setActive(false);
    cat.setBowPoseTuning(pose);
    cat.walking = view.walk; cat.updateEffects(state.playing ? dt : 0);
    cat.attackAnimator.reset();
    const t = state.phase, input = { attackInterval: .6, attackProgress: 0, willFire: false, hasTarget: true };
    if (t < .72) {
      input.attackProgress = Math.min(.99999, t / .72); cat.setAttackState(input, 0);
    } else {
      cat.setAttackState({ ...input, attackProgress: 1, willFire: true }, 0);
      if (t > .72) cat.setAttackState(input, (t - .72) * .6);
    }
    cat.aimAngle = 180 - view.aim - cat.poses[0].r;
    cat.updatePose(0, view.walk, view.facing);
    $('#phase-badge').textContent = state.compare ? '默认动作' : t < .27 ? '准备 · 起点' : t < .69 ? '拉弦中' : t < .72 ? '拉满' : t < .77 ? '释放弓弦' : t < .98 ? '手部回位' : '回到起点';
    this.updateGuides();
  }
  rootTransform() { return this.cat.poseFollowers[0][0].getComponent(this.cc.UITransform); }
  toScreen(world) {
    const point = this.canvas.convertToNodeSpaceAR(world), rect = this.gameCanvas.getBoundingClientRect();
    return [rect.left + (point.x / this.canvas.width + .5) * rect.width,
      rect.top + (.5 - point.y / this.canvas.height) * rect.height];
  }
  rootToScreen(point) {
    return this.toScreen(this.rootTransform().convertToWorldSpaceAR(new this.cc.Vec3(point[0], point[1], 0)));
  }
  screenToRoot(clientX, clientY) {
    const frame = $('#runtime').getBoundingClientRect(), rect = this.gameCanvas.getBoundingClientRect();
    const x = ((clientX - frame.left - rect.left) / rect.width - .5) * this.canvas.width;
    const y = (.5 - (clientY - frame.top - rect.top) / rect.height) * this.canvas.height;
    const world = this.canvas.convertToWorldSpaceAR(new this.cc.Vec3(x, y, 0));
    const point = this.rootTransform().convertToNodeSpaceAR(world); return [point.x, point.y];
  }
  bodyDelta(a, b) {
    const root = this.cat.poses[0], angle = root.r * Math.PI / 180;
    const x = (a[0] - b[0]) * root.s[0], y = (a[1] - b[1]) * root.s[1];
    return [Math.cos(angle) * x - Math.sin(angle) * y, Math.sin(angle) * x + Math.cos(angle) * y];
  }
  updateGuides() {
    const { cat } = this, pivot = cat.bowRotationPivot(), start = cat.bowDrawingStart();
    const right = cat.poses[cat.rig.attachments.gun.bone], tune = cat.getBowPoseTuning();
    const base = Math.hypot(...cat.bowDrawnGrip) * right.s[0], radius = base * tune.holdingRadiusScale;
    const center = this.rootToScreen(pivot), beginning = this.rootToScreen(start);
    const holding = this.toScreen(cat.hands[0].node.worldPosition);
    const drawing = this.toScreen(this.find(cat.skinLayer, 'hand_left').worldPosition);
    const points = Array.from({ length: 65 }, (_, i) => this.rootToScreen([pivot[0] + radius * Math.cos(i * Math.PI / 32), pivot[1] + radius * Math.sin(i * Math.PI / 32)]));
    $('#guides').setAttribute('viewBox', `0 0 ${$('#stage').clientWidth} ${$('#stage').clientHeight}`);
    $('#orbit').setAttribute('d', points.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ') + ' Z');
    $('#pull-line').setAttribute('d', `M${beginning} L${drawing}`);
    for (const [id, point] of [['holding-point', holding], ['drawing-point', drawing]]) {
      $(`#${id}`).setAttribute('cx', point[0]); $(`#${id}`).setAttribute('cy', point[1]);
    }
    const rootAngle = cat.poses[0].r * Math.PI / 180;
    this.radiusPoint = [pivot[0] + Math.cos(rootAngle) * radius, pivot[1] - Math.sin(rootAngle) * radius];
    for (const [id, point] of [['center-handle', center], ['start-handle', beginning], ['radius-handle', this.rootToScreen(this.radiusPoint)]])
      $(`#${id}`).setAttribute('transform', `translate(${point[0]},${point[1]})`);
    // When both anchors coincide, expose the center's larger ring around the start diamond.
    const def = cat.weaponAppearance, image = def.image;
    const fullDistance = def.bowString.drawPx * tune.drawDistanceScale * image.sizeUnits[0] / image.sizePx[0]
      * Math.abs((image.localScale ?? [1])[0]) * Math.abs((cat.rig.attachments.gun.localScale ?? [1])[0]) * right.s[0];
    $('#radius-readout').textContent = radius.toFixed(3);
    $('#distance-readout').textContent = fullDistance.toFixed(3);
    $('#pull-readout').textContent = (fullDistance * (cat.attackPose.bowHandPull ?? 0)).toFixed(3);
    this.geometry = { pivot, start, radius, base, fullDistance, center, beginning, holding, drawing };
  }
}

async function boot() {
  const start = performance.now(), frame = $('#runtime');
  while (performance.now() - start < 90000) {
    const win = frame.contentWindow;
    if (win?.__forestGunner && win.System) {
      const cc = await win.System.import('cc');
      const app = cc.director.getScene().getChildByName('Canvas').getComponent('GameBootstrap');
      if (!app.battlefield?.cat?.setBowPoseTuning) throw new Error('当前游戏包尚未包含调参接口，请重新构建 Web 包。');
      bridge = new GameBridge(win, cc, app); defaults = bridge.cat.getBowPoseTuning(); state.pose = { ...defaults };
      ready = true; mountControls();
      if (pendingSaved) {
        try { applyImport(pendingSaved); } catch { toast('旧参数格式已变化，已载入当前默认值。'); }
      }
      syncView(); changed(false); $('#stage').classList.add('ready'); $('#loading').hidden = true;
      $('#copy').disabled = false; $('#play').disabled = false;
      $('#save-status').textContent = pendingSaved ? '已恢复本地参数' : '使用当前游戏参数';
      window.__bowTuner = { state, defaults, bridge, config, importConfig: applyImport, setParameter, ready: true };
      requestAnimationFrame(tick); return;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('角色载入超时，请确认本地试玩包已经构建。');
}
function fail(error) {
  $('#loading').hidden = false; $('#loading .spinner').hidden = true;
  $('#loading strong').textContent = '预览暂时无法载入';
  $('#loading > span:last-of-type').textContent = error.message || String(error);
  $('#reload').hidden = false;
}
function tick(time) {
  const dt = lastFrame ? Math.min(.05, (time - lastFrame) / 1000) : 0; lastFrame = time;
  if (state.playing) state.phase = (state.phase + dt / state.view.duration) % 1;
  try { bridge.render(dt); } catch (error) { fail(error); return; }
  $('#timeline').value = state.phase; $('#timeline-value').value = `${Math.round(state.phase * 100)}%`;
  requestAnimationFrame(tick);
}

$('#play').addEventListener('click', () => { state.playing = !state.playing; syncView(); });
$('#timeline').addEventListener('input', event => { state.playing = false; state.phase = Number(event.target.value); syncView(); });
document.querySelectorAll('[data-phase]').forEach(button => button.addEventListener('click', () => {
  state.playing = false; state.phase = Number(button.dataset.phase); syncView();
}));
for (const [id, key] of [['weapon', 'weaponId'], ['skin', 'skinId'], ['aim', 'aim'], ['zoom', 'zoom']])
  $(`#${id}`).addEventListener('input', event => { state.view[key] = Number(event.target.value); syncView(); changed(); });
$('#duration').addEventListener('change', event => {
  state.view.duration = Math.max(.4, Math.min(6, Number(event.target.value) || 2)); syncView(); changed();
});
for (const [id, key] of [['walk', 'walk'], ['show-guides', 'guides']])
  $(`#${id}`).addEventListener('change', event => { state.view[key] = event.target.checked; syncView(); changed(); });
$('#facing').addEventListener('click', () => { state.view.facing *= -1; syncView(); changed(); });
$('#compare').addEventListener('click', () => { state.compare = !state.compare; syncView(); });
$('#reset').addEventListener('click', () => {
  if (!ready) return;
  for (const [key] of FIELDS) setParameter(key, defaults[key], false);
  state.compare = false; syncView(); changed(); toast('已恢复当前游戏的默认动作参数。');
});
$('#copy').addEventListener('click', async () => {
  const text = JSON.stringify(config(), null, 2);
  try { await navigator.clipboard.writeText(text); toast('参数已复制，直接粘贴到聊天里即可。'); }
  catch { $('.export-details').open = true; $('#json-output').focus(); $('#json-output').select(); toast('参数已选中，请按 Ctrl+C 复制。'); }
});
$('#download').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(config(), null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'bow-pose-settings.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000); toast('参数文件已导出。');
});
$('#import-open').addEventListener('click', () => {
  if (!ready) return toast('请等角色载入后再导入参数。');
  $('#import-error').textContent = ''; $('#import-dialog').showModal();
});
$('#import-apply').addEventListener('click', () => {
  try { applyImport(JSON.parse($('#import-text').value)); $('#import-dialog').close(); toast('参数已应用并保存。'); }
  catch (error) { $('#import-error').textContent = error instanceof SyntaxError ? 'JSON 格式不正确，请检查是否完整复制。' : error.message; }
});
$('#import-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  if (file.size > 100000) { $('#import-error').textContent = '参数文件过大，请选择本页导出的 JSON。'; return; }
  $('#import-text').value = await file.text();
});
$('#reload').addEventListener('click', () => location.reload());
let drag;
$('#guides').addEventListener('pointerdown', event => {
  const handle = event.target.closest('[data-drag]');
  if (!ready || !handle || state.compare) return;
  event.preventDefault(); state.playing = false; syncView();
  drag = { kind: handle.dataset.drag, point: bridge.screenToRoot(event.clientX, event.clientY), pose: { ...state.pose } };
  $('#guides').setPointerCapture(event.pointerId);
});
$('#guides').addEventListener('pointermove', event => {
  if (!drag) return;
  const point = bridge.screenToRoot(event.clientX, event.clientY), delta = bridge.bodyDelta(point, drag.point);
  if (drag.kind === 'radius') {
    const { pivot, base } = bridge.geometry;
    setParameter('holdingRadiusScale', Math.hypot(point[0] - pivot[0], point[1] - pivot[1]) / base);
  } else {
    const prefix = drag.kind === 'pivot' ? 'pivot' : 'drawHand';
    setParameter(prefix + 'X', drag.pose[prefix + 'X'] + delta[0], false);
    setParameter(prefix + 'Y', drag.pose[prefix + 'Y'] + delta[1]);
  }
});
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) $('#guides').addEventListener(event, () => { drag = null; });
document.addEventListener('keydown', event => {
  if (event.code === 'Space' && !/INPUT|TEXTAREA|SELECT|BUTTON/.test(event.target.tagName) && !$('#import-dialog').open) {
    event.preventDefault(); state.playing = !state.playing; syncView();
  }
});
window.addEventListener('pagehide', () => { if (ready) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config())); } catch {} } });
boot().catch(fail);
