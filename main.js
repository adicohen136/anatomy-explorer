import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildBody, INFO } from './anatomy.js';

const $ = (id) => document.getElementById(id);
const clamp = THREE.MathUtils.clamp;
const V3 = (a) => new THREE.Vector3(...a);
const WHITE = new THREE.Color('#ffffff');
const SHORT = ['Skin', 'Muscle', 'Bone', 'Organs', 'Vessels', 'Nerves'];
const XRAY = [0.22, 0.3, 0.55, 0.7, 0.95, 0.95];
const PANEL_SHIFT = 170;

// ---------------------------------------------------------------- renderer, scene, camera

const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.localClippingEnabled = true;

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

const camera = new THREE.PerspectiveCamera(36, innerWidth / innerHeight, 0.01, 50);
scene.add(camera);
const key = new THREE.DirectionalLight(0xffffff, 1.5);
key.position.set(1.2, 1.6, 0.6);
const fill = new THREE.DirectionalLight(0xffd8bf, 0.45);
fill.position.set(-1.5, 0.2, 0.5);
camera.add(key, fill);
scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x261812, 0.55));
const rim = new THREE.DirectionalLight(0x7cc4ff, 1.6);
rim.position.set(-2, 2.2, -2.5);
scene.add(rim);

const VIEWS = {
  full: { target: [0, 0.95, 0], pos: [0, 1.15, 3.7] },
  head: { target: [0, 1.67, 0.01], pos: [0.36, 1.75, 0.72] },
  chest: { target: [0, 1.28, 0.02], pos: [0.36, 1.4, 0.94] },
  abdomen: { target: [0, 1.0, 0.02], pos: [-0.32, 1.1, 0.92] },
  arm: { target: [0.27, 0.86, 0.02], pos: [0.95, 1.0, 0.85] },
  legs: { target: [0.1, 0.5, 0], pos: [0.7, 0.66, 0.85] },
};
camera.position.copy(V3(VIEWS.full.pos)).add(new THREE.Vector3(1.2, 0.2, 0.6));

const controls = new OrbitControls(camera, canvas);
controls.target.copy(V3(VIEWS.full.target));
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.16;
controls.maxDistance = 6;
controls.zoomToCursor = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.6;

// Floor glow
function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, 'rgba(90,209,230,0.35)');
  grad.addColorStop(0.45, 'rgba(90,150,230,0.12)');
  grad.addColorStop(1, 'rgba(90,150,230,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const floor = new THREE.Mesh(new THREE.CircleGeometry(1.0, 64), new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, depthWrite: false }));
floor.rotation.x = -Math.PI / 2;
floor.renderOrder = -2;
scene.add(floor);
for (const [r, o] of [[0.55, 0.45], [0.72, 0.2]]) {
  const ring = new THREE.Mesh(new THREE.RingGeometry(r, r + 0.004, 128), new THREE.MeshBasicMaterial({ color: 0x5ad1e6, transparent: true, opacity: o, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.002;
  ring.renderOrder = -1;
  scene.add(ring);
}

// ---------------------------------------------------------------- body

const { root, layers, anim } = buildBody();
scene.add(root);
const N = layers.length;
const clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 100);
const partMeshes = new Map();

layers.forEach((L, i) => {
  L.index = i;
  L.on = true;
  L.base = 1;
  L.op = 1;
  L.key = '';
  L.materials = [...L.mats.values()];
  for (const m of L.materials) {
    m.clippingPlanes = [clipPlane];
    m.userData.color = m.color.clone();
    m.userData.emissive = m.emissive.clone();
    m.userData.ei = m.emissiveIntensity;
  }
  // Depth pre-pass: a translucent layer only shows its front-most surface,
  // so overlapping shapes inside one layer don't stack into dark blotches.
  const pre = new THREE.MeshBasicMaterial({ colorWrite: false, transparent: true, side: THREE.DoubleSide, clippingPlanes: [clipPlane] });
  const order = (N - i) * 10;
  const meshes = [];
  L.group.traverse((o) => o.isMesh && meshes.push(o));
  for (const m of meshes) {
    m.userData.layerIndex = i;
    m.renderOrder = order + 1;
    const p = new THREE.Mesh(m.geometry, pre);
    p.renderOrder = order;
    p.raycast = () => {};
    m.add(p);
    const part = m.userData.part;
    if (!partMeshes.has(part)) partMeshes.set(part, []);
    partMeshes.get(part).push(m);
  }
});

// Cross-section plane outline
const cutVisual = new THREE.Group();
const cutFill = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x5ad1e6, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false }));
const cutEdge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)), new THREE.LineBasicMaterial({ color: 0x5ad1e6, transparent: true, opacity: 0.6 }));
cutVisual.add(cutFill, cutEdge);
cutVisual.renderOrder = 1000;
cutFill.renderOrder = cutEdge.renderOrder = 1000;
cutVisual.visible = false;
scene.add(cutVisual);

// ---------------------------------------------------------------- state & UI

const state = { peel: 0, eff: 0, autoPeel: true, xray: false, animate: true, spin: true, cut: 'off' };
const ui = {
  peel: $('peel'), depthName: $('depth-name'), ticks: $('depth-ticks'), list: $('layer-list'),
  fill: $('depth-fill'), dot: $('depth-dot'), labels: $('depth-labels'), cut: $('cut'),
  tooltip: $('tooltip'), info: $('info'), hint: $('hint'), heart: document.querySelector('#vitals .heart'),
};

const EYE_ON = '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A10.6 10.6 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3 3.8M6.1 6.1A17 17 0 0 0 2 12s3.6 7 10 7a10 10 0 0 0 4.3-.9"/></svg>';

layers.forEach((L, i) => {
  const tick = document.createElement('button');
  tick.textContent = SHORT[i];
  tick.addEventListener('click', () => animatePeel(i));
  ui.ticks.append(tick);

  const label = document.createElement('li');
  label.textContent = L.name;
  ui.labels.append(label);

  const li = document.createElement('li');
  li.innerHTML = `<span class="swatch" style="background:${L.color}"></span>
    <span class="name" title="${L.blurb}">${L.name}</span>
    <input type="range" class="plain" min="0" max="1" step="0.01" value="1" aria-label="${L.name} opacity">
    <button class="eye" aria-label="Show or hide ${L.name}">${EYE_ON}</button>`;
  const [range, eye] = [li.querySelector('input'), li.querySelector('.eye')];
  range.addEventListener('input', () => { L.base = +range.value; });
  eye.addEventListener('click', () => setLayerOn(L, !L.on));
  li.querySelector('.name').addEventListener('click', () => animatePeel(i));
  li.querySelector('.name').style.cursor = 'pointer';
  L.ui = { li, range, eye, tick, label };
  ui.list.append(li);
});

function setLayerOn(L, on) {
  L.on = on;
  L.ui.eye.innerHTML = on ? EYE_ON : EYE_OFF;
  L.ui.eye.classList.toggle('off', !on);
  L.ui.li.classList.toggle('hidden', !on);
}

let peelAnim = null;
function animatePeel(to) {
  peelAnim = { from: state.peel, to, start: performance.now() };
}

ui.peel.addEventListener('input', () => {
  peelAnim = null;
  state.peel = +ui.peel.value;
});

$('reset-layers').addEventListener('click', () => {
  for (const L of layers) {
    setLayerOn(L, true);
    L.base = 1;
    L.ui.range.value = 1;
  }
  animatePeel(0);
});

const bindToggle = (id, k, fn) => $(id).addEventListener('change', (e) => { state[k] = e.target.checked; fn?.(); });
bindToggle('auto-peel', 'autoPeel');
bindToggle('xray', 'xray');
bindToggle('animate', 'animate');
bindToggle('spin', 'spin', () => { lastInteract = 0; });

for (const b of document.querySelectorAll('#cut-mode button')) {
  b.addEventListener('click', () => {
    state.cut = b.dataset.cut;
    document.querySelectorAll('#cut-mode button').forEach((x) => x.classList.toggle('on', x === b));
    ui.cut.disabled = state.cut === 'off';
    applyCut();
  });
}
ui.cut.addEventListener('input', applyCut);

function applyCut() {
  const t = +ui.cut.value;
  cutVisual.visible = state.cut !== 'off';
  if (state.cut === 'off') {
    clipPlane.constant = 100;
  } else if (state.cut === 'front') {
    const c = THREE.MathUtils.lerp(0.14, -0.12, t);
    clipPlane.normal.set(0, 0, -1);
    clipPlane.constant = c;
    cutVisual.position.set(0, 0.95, c);
    cutVisual.rotation.set(0, 0, 0);
    cutVisual.scale.set(0.75, 1.95, 1);
  } else {
    const c = THREE.MathUtils.lerp(0.33, -0.33, t);
    clipPlane.normal.set(-1, 0, 0);
    clipPlane.constant = c;
    cutVisual.position.set(c, 0.95, 0.02);
    cutVisual.rotation.set(0, Math.PI / 2, 0);
    cutVisual.scale.set(0.42, 1.95, 1);
  }
}

for (const b of document.querySelectorAll('.presets button')) {
  b.addEventListener('click', () => {
    const view = VIEWS[b.dataset.view];
    tweenTo(V3(view.pos), V3(view.target));
  });
}

const panel = $('panel');
if (innerWidth <= 760) panel.classList.remove('open');
$('panel-toggle').addEventListener('click', () => panel.classList.toggle('open'));

// ---------------------------------------------------------------- camera tween

let tween = null;
let lastInteract = 0;
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

function tweenTo(pos, target, dur = 1200) {
  tween = { p0: camera.position.clone(), t0: controls.target.clone(), p1: pos, t1: target, start: performance.now(), dur };
  lastInteract = performance.now();
}

controls.addEventListener('start', () => {
  tween = null;
  lastInteract = performance.now();
  ui.hint.classList.add('fade');
});

// ---------------------------------------------------------------- picking, hover, info card

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let hovered = null;
let selected = null;

function pick(x, y) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  for (const h of raycaster.intersectObject(root, true)) {
    const L = layers[h.object.userData.layerIndex];
    if (!L || !h.object.userData.part || L.op < 0.3) continue;
    if (clipPlane.distanceToPoint(h.point) < 0) continue;
    return { part: h.object.userData.part, layer: L, point: h.point.clone() };
  }
  return null;
}

function glow(part, level) {
  for (const mesh of partMeshes.get(part) ?? []) {
    const m = mesh.material;
    m.color.copy(m.userData.color);
    m.emissive.copy(m.userData.emissive);
    m.emissiveIntensity = m.userData.ei;
    if (level) {
      m.color.lerp(WHITE, level === 2 ? 0.22 : 0.32);
      m.emissive.set(level === 2 ? '#1d9fc0' : '#3a78e0');
      m.emissiveIntensity = level === 2 ? 0.5 : 0.42;
    }
  }
}

function refreshGlow(prev = []) {
  for (const p of prev) if (p) glow(p, 0);
  if (selected) glow(selected.part, 2);
  if (hovered && hovered.part !== selected?.part) glow(hovered.part, 1);
}

function setHover(hit, x, y) {
  const prev = hovered?.part;
  hovered = hit;
  if (prev !== hit?.part) refreshGlow([prev]);
  if (hit) {
    const [name] = INFO[hit.part] ?? [hit.part];
    ui.tooltip.innerHTML = `${name}<i>${hit.layer.name}</i>`;
    ui.tooltip.style.left = x + 'px';
    ui.tooltip.style.top = y + 'px';
    ui.tooltip.classList.add('show');
    canvas.style.cursor = 'pointer';
  } else {
    ui.tooltip.classList.remove('show');
    canvas.style.cursor = '';
  }
}

function select(hit) {
  const prev = selected?.part;
  selected = hit;
  refreshGlow([prev]);
  if (!hit) {
    ui.info.hidden = true;
    return;
  }
  const [name, desc, fact] = INFO[hit.part] ?? [hit.part, '', ''];
  $('info-name').textContent = name;
  $('info-desc').textContent = desc;
  $('info-fact').textContent = fact;
  const chip = $('info-layer');
  chip.textContent = hit.layer.name;
  chip.style.setProperty('--chip', hit.layer.color);
  ui.info.hidden = false;
}

function focusOn(hit) {
  const box = new THREE.Box3();
  for (const m of partMeshes.get(hit.part)) box.expandByObject(m);
  const size = box.getSize(new THREE.Vector3()).length();
  let dist = clamp(Math.min(size, 0.5) * 2.2, 0.32, 1.6);
  // Stay far enough that zoom-peeling doesn't strip away the layer we're looking at.
  if (state.autoPeel && hit.layer.index < 3) dist = Math.max(dist, 2.45 - 0.6 * hit.layer.index);
  const dir = camera.position.clone().sub(controls.target).normalize();
  tweenTo(hit.point.clone().addScaledVector(dir, dist), hit.point.clone());
}

$('info-close').addEventListener('click', () => select(null));
$('info-focus').addEventListener('click', () => selected && focusOn(selected));
$('info-solo').addEventListener('click', () => {
  if (!selected) return;
  for (const L of layers) setLayerOn(L, L === selected.layer);
  animatePeel(0);
});

let down = null;
let pointer = null;
let lastHover = 0;
canvas.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY, t: performance.now() };
});
canvas.addEventListener('pointerup', (e) => {
  if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6 && performance.now() - down.t < 600) {
    const hit = pick(e.clientX, e.clientY);
    select(hit);
    if (hit && e.pointerType !== 'mouse') setHover(null);
  }
  down = null;
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse') pointer = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointerleave', () => {
  pointer = null;
  setHover(null);
});
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') select(null);
});

// ---------------------------------------------------------------- per-frame updates

function applyLayers(eff) {
  for (const L of layers) {
    const op = L.on ? L.base * clamp(1 - (eff - L.index), 0, 1) : 0;
    const k = op.toFixed(3) + state.xray;
    if (k === L.key) continue;
    L.key = k;
    L.op = op;
    L.group.visible = op > 0.01;
    const final = state.xray ? op * XRAY[L.index] : op;
    for (const m of L.materials) {
      m.opacity = final;
      m.depthWrite = final > 0.97;
      m.blending = state.xray ? THREE.AdditiveBlending : THREE.NormalBlending;
    }
    L.ui.li.classList.toggle('peeled', L.on && op < 0.05 && L.base > 0);
  }
}

let lastDepthIdx = -1;
function updateDepthUI(eff) {
  const pct = (eff / (N - 1)) * 100;
  ui.fill.style.height = pct + '%';
  ui.dot.style.top = pct + '%';
  if (!peelAnim && document.activeElement !== ui.peel) ui.peel.value = state.peel;
  let idx = Math.round(eff);
  while (idx < N - 1 && !layers[idx].on) idx++;
  if (idx !== lastDepthIdx) {
    lastDepthIdx = idx;
    ui.depthName.textContent = layers[idx].name;
    ui.depthName.style.background = layers[idx].color;
    layers.forEach((L, i) => {
      L.ui.tick.classList.toggle('active', i === idx);
      L.ui.label.classList.toggle('active', i === idx);
    });
  }
}

const clock = new THREE.Clock();
let sim = 0;
let firstFrame = true;

function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);
  const now = performance.now();

  if (tween) {
    const k = Math.min(1, (now - tween.start) / tween.dur);
    const e = ease(k);
    camera.position.lerpVectors(tween.p0, tween.p1, e);
    controls.target.lerpVectors(tween.t0, tween.t1, e);
    if (k === 1) tween = null;
  }
  controls.autoRotate = state.spin && !tween && now - lastInteract > 7000;
  controls.update();

  if (peelAnim) {
    const k = Math.min(1, (now - peelAnim.start) / 700);
    state.peel = THREE.MathUtils.lerp(peelAnim.from, peelAnim.to, ease(k));
    ui.peel.value = state.peel;
    if (k === 1) peelAnim = null;
  }

  // Zooming in peels outer layers: far = everything, close = down to the organs.
  const dist = camera.position.distanceTo(controls.target);
  const zoomPeel = state.autoPeel ? clamp((2.4 - dist) / 1.8, 0, 1) * 3 : 0;
  const target = Math.max(state.peel, zoomPeel);
  state.eff += (target - state.eff) * Math.min(1, dt * 10);
  if (Math.abs(target - state.eff) < 0.001) state.eff = target;
  applyLayers(state.eff);
  updateDepthUI(state.eff);

  // Heartbeat, breathing and blood flow
  if (state.animate) sim += dt;
  const period = 60 / 72;
  const p = (sim % period) / period;
  const beat = Math.exp(-(((p - 0.08) / 0.05) ** 2)) + 0.55 * Math.exp(-(((p - 0.3) / 0.05) ** 2));
  anim.heart.scale.setScalar(1 + 0.08 * beat);
  ui.heart.style.transform = `scale(${1 + 0.35 * beat})`;
  const br = Math.sin((sim * Math.PI * 2) / 4.5);
  for (const lung of anim.lungs) {
    const b = lung.userData.baseScale;
    lung.scale.set(b.x * (1 + 0.035 * br), b.y * (1 + 0.05 * br), b.z * (1 + 0.035 * br));
  }
  if (state.animate) {
    const speed = dt * (0.35 + 1.4 * beat);
    anim.textures.flowA.offset.x -= speed;
    anim.textures.flowV.offset.x += speed * 0.6;
  }

  if (pointer && now - lastHover > 60 && !down) {
    lastHover = now;
    setHover(pick(pointer.x, pointer.y), pointer.x, pointer.y);
  }

  renderer.render(scene, camera);
  if (firstFrame) {
    firstFrame = false;
    $('loading').classList.add('done');
  }
  requestAnimationFrame(frame);
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.fov = w / h < 0.8 ? 58 : 36; // portrait phones need a wider lens to frame the presets
  if (w > 760) camera.setViewOffset(w, h, -PANEL_SHIFT, 0, w, h);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
// Shareable deep links, e.g. ?view=chest&peel=2&xray=1&cut=front
const q = new URLSearchParams(location.search);
if (VIEWS[q.get('view')]) {
  camera.position.copy(V3(VIEWS[q.get('view')].pos));
  controls.target.copy(V3(VIEWS[q.get('view')].target));
  lastInteract = performance.now();
}
if (q.has('peel')) state.peel = state.eff = ui.peel.value = clamp(+q.get('peel') || 0, 0, N - 1);
if (q.get('xray') === '1') $('xray').click();
if (['front', 'side'].includes(q.get('cut'))) document.querySelector(`#cut-mode [data-cut="${q.get('cut')}"]`).click();

addEventListener('resize', resize);
resize();
applyCut();
requestAnimationFrame(frame);
