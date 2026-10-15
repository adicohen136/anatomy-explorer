// Procedural human anatomy, built from simple shapes and curves.
// Units are metres: feet at y = 0, top of head ~1.79, the body faces +z.
// Person's right side is -x, left side is +x.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Field, ellipsoid, cone, lathe } from './sdf.js';

const UP = new THREE.Vector3(0, 1, 0);
const v = (x, y, z) => new THREE.Vector3(x, y, z);
const SIDES = [-1, 1];
const SPHERE = new THREE.SphereGeometry(1, 32, 20);

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- layers

export const LAYERS = [
  { id: 'skin', name: 'Skin', color: '#e7b08f', blurb: 'Outer protective layer' },
  { id: 'muscles', name: 'Muscles', color: '#c8463e', blurb: 'Skeletal muscle groups' },
  { id: 'skeleton', name: 'Skeleton', color: '#eee3c7', blurb: 'Bones and cartilage' },
  { id: 'organs', name: 'Organs', color: '#d9827c', blurb: 'Chest and abdominal organs' },
  { id: 'vessels', name: 'Blood vessels', color: '#e0383e', blurb: 'Arteries (red) and veins (blue)' },
  { id: 'nerves', name: 'Nervous system', color: '#f2cf5b', blurb: 'Brain, spinal cord and nerves' },
];

// Landmark joints, s = side (-1 right, +1 left).
const J = {
  shoulder: (s) => v(0.19 * s, 1.43, 0),
  elbow: (s) => v(0.235 * s, 1.16, -0.01),
  wrist: (s) => v(0.27 * s, 0.9, 0.02),
  hip: (s) => v(0.09 * s, 0.9, 0),
  knee: (s) => v(0.1 * s, 0.5, 0.01),
  ankle: (s) => v(0.1 * s, 0.085, -0.01),
};

// Centre of the right/left eyeball (multiply x by the side).
const EYE = v(0.033, 1.675, 0.077);

// Finger positions across the hand (z) and their lengths, index to little finger.
const FINGERS = [[0.042, 0.1], [0.024, 0.11], [0.006, 0.105], [-0.011, 0.086]];

function orient(obj, a, b) {
  const dir = new THREE.Vector3().subVectors(b, a);
  obj.position.copy(a).addScaledVector(dir, 0.5);
  obj.quaternion.setFromUnitVectors(UP, dir.normalize());
}

function tubeGeo(pts, r, { radial = 12, rFn = null, flow = 0, segs } = {}) {
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const len = curve.getLength();
  const n = segs ?? Math.max(12, Math.ceil(len * 260));
  const geo = new THREE.TubeGeometry(curve, n, r, radial, false);
  if (rFn) {
    // Vary the radius along the tube: ring i is centred on curve.getPointAt(i / n).
    const pos = geo.attributes.position;
    const c = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (let i = 0; i <= n; i++) {
      curve.getPointAt(i / n, c);
      const k = rFn(i / n);
      for (let j = 0; j <= radial; j++) {
        const idx = i * (radial + 1) + j;
        p.fromBufferAttribute(pos, idx).sub(c).multiplyScalar(k).add(c);
        pos.setXYZ(idx, p.x, p.y, p.z);
      }
    }
  }
  if (flow) {
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * len * flow);
  }
  return geo;
}

function makeLayer(meta, factory) {
  const group = new THREE.Group();
  group.name = meta.id;
  const mats = new Map();
  const L = {
    ...meta,
    group,
    mats,
    mat(key) {
      if (!mats.has(key)) mats.set(key, factory(key));
      return mats.get(key);
    },
    mesh(part, geo, { mat = part, parent = group, dynamic = false } = {}) {
      const m = new THREE.Mesh(geo, L.mat(mat));
      m.userData.part = part;
      m.userData.matKey = mat;
      m.userData.dynamic = dynamic;
      parent.add(m);
      return m;
    },
    ellipsoid(part, pos, scale, opts = {}) {
      const m = L.mesh(part, opts.geo ?? SPHERE, opts);
      m.position.copy(pos);
      m.scale.copy(scale);
      if (opts.rot) m.rotation.set(...opts.rot);
      return m;
    },
    sphere(part, pos, r, opts) {
      return L.ellipsoid(part, pos, v(r, r, r), opts);
    },
    limb(part, a, b, ra, rb, opts = {}) {
      const m = L.mesh(part, new THREE.CylinderGeometry(rb, ra, a.distanceTo(b), 24, 1, true), opts);
      orient(m, a, b);
      if (opts.caps !== false) {
        L.sphere(part, a, ra, opts);
        L.sphere(part, b, rb, opts);
      }
      return m;
    },
    bone(part, a, b, r, knob = 1.7, opts = {}) {
      L.limb(part, a, b, r, r * 0.9, { ...opts, caps: false });
      L.sphere(part, a, r * knob, opts);
      L.sphere(part, b, r * knob, opts);
    },
    tube(part, pts, r, opts = {}) {
      return L.mesh(part, tubeGeo(pts, r, opts), opts);
    },
  };
  return L;
}

// ---------------------------------------------------------------- textures

function canvasTexture(w, h, draw, repeat = true) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

function muscleTexture() {
  const R = rng(3);
  return canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#a8302c';
    g.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 2) {
      const l = 30 + R() * 30;
      g.fillStyle = `hsla(${358 + R() * 8}, 62%, ${l}%, ${0.35 + R() * 0.4})`;
      g.fillRect(x, 0, 1 + (R() > 0.7 ? 1 : 0), h);
    }
    for (let i = 0; i < 40; i++) {
      g.fillStyle = `rgba(255,220,210,${R() * 0.12})`;
      g.fillRect(R() * w, R() * h, 1, 20 + R() * 60);
    }
  });
}

function flowTexture() {
  return canvasTexture(256, 4, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, '#000');
    grad.addColorStop(0.55, '#000');
    grad.addColorStop(0.8, '#fff');
    grad.addColorStop(0.86, '#fff');
    grad.addColorStop(1, '#000');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
  });
}

// ---------------------------------------------------------------- skin

const TORSO = [
  [0, 0.8], [0.07, 0.805], [0.13, 0.83], [0.165, 0.88], [0.172, 0.94], [0.16, 1.0],
  [0.145, 1.06], [0.142, 1.12], [0.152, 1.2], [0.168, 1.28], [0.18, 1.35], [0.185, 1.41],
  [0.178, 1.44], [0.14, 1.47], [0.085, 1.5], [0.055, 1.52], [0, 1.53],
];

// The skin is one continuous surface sculpted from smoothly blended shapes.
function sculptSkin() {
  const field = new Field(v(-0.34, -0.01, -0.17), v(0.34, 1.81, 0.2), 0.004);
  const E = (c, r, k = 0.03) => field.add(ellipsoid(c, r), k);
  const C = (a, b, ra, rb, k = 0.03) => field.add(cone(a, b, ra, rb), k);
  const lerp = (a, b, t) => a.clone().lerp(b, t);

  // Torso
  // A spline through the profile points, so the torso has no ridges at the corners.
  const spline = new THREE.CatmullRomCurve3(TORSO.map(([r, y]) => v(r, y, 0)), false, 'centripetal');
  field.add(lathe(spline.getPoints(80).map((p) => [Math.max(0, p.x), p.y]), 0.6));
  E(v(0, 1.06, 0.015), v(0.13, 0.15, 0.078), 0.05); // abdomen
  C(v(0, 1.44, -0.01), v(0, 1.6, 0), 0.054, 0.047, 0.035); // neck
  for (const s of SIDES) {
    E(v(0.068 * s, 1.345, 0.06), v(0.075, 0.058, 0.045), 0.035); // chest
    E(v(0.105 * s, 1.27, -0.02), v(0.07, 0.15, 0.08), 0.05); // ribs and lats
    E(v(0.08 * s, 1.37, -0.075), v(0.06, 0.07, 0.035), 0.04); // shoulder blade
    E(v(0.068 * s, 0.88, -0.055), v(0.085, 0.09, 0.072), 0.04); // buttock
    C(v(0, 1.53, -0.025), v(0.17 * s, 1.45, -0.012), 0.032, 0.04, 0.05); // trapezius
    E(v(0.188 * s, 1.425, 0), v(0.062, 0.062, 0.06), 0.04); // shoulder
  }

  // Head and face
  E(v(0, 1.685, -0.005), v(0.082, 0.1, 0.1), 0.02); // cranium
  E(v(0, 1.62, 0.028), v(0.064, 0.075, 0.072), 0.03); // face
  E(v(0, 1.572, 0.062), v(0.026, 0.022, 0.024), 0.02); // chin
  E(v(0, 1.7, 0.078), v(0.058, 0.015, 0.02), 0.02); // brow ridge
  E(v(0, 1.605, 0.075), v(0.03, 0.018, 0.018), 0.02); // mouth
  C(v(0, 1.688, 0.088), v(0, 1.646, 0.104), 0.008, 0.011, 0.012); // nose bridge
  E(v(0, 1.642, 0.103), v(0.013, 0.011, 0.012), 0.01); // nose tip
  for (const s of SIDES) {
    E(v(0.045 * s, 1.6, 0), v(0.02, 0.033, 0.038), 0.03); // jaw angle
    E(v(0.042 * s, 1.652, 0.06), v(0.024, 0.02, 0.022), 0.02); // cheekbone
    E(v(0.011 * s, 1.638, 0.097), v(0.007, 0.006, 0.007), 0.008); // nostril
    E(v(0.081 * s, 1.665, -0.008), v(0.011, 0.03, 0.019), 0.008); // ear
  }

  // Limbs
  for (const s of SIDES) {
    const [sh, el, wr, hip, kn, an] = [J.shoulder(s), J.elbow(s), J.wrist(s), J.hip(s), J.knee(s), J.ankle(s)];
    C(sh, el, 0.05, 0.038);
    E(lerp(sh, el, 0.45).add(v(0, 0, 0.014)), v(0.032, 0.07, 0.032)); // biceps
    E(lerp(sh, el, 0.4).add(v(0, 0, -0.016)), v(0.033, 0.08, 0.03)); // triceps
    E(el, v(0.036, 0.03, 0.034), 0.02);
    C(el, wr, 0.038, 0.026);
    E(lerp(el, wr, 0.25).add(v(0, 0, 0.004)), v(0.04, 0.07, 0.035)); // forearm
    C(wr, v(0.278 * s, 0.875, 0.018), 0.025, 0.021, 0.02); // wrist
    E(v(0.281 * s, 0.86, 0.016), v(0.013, 0.034, 0.038), 0.012); // palm
    for (const [z, len] of FINGERS) C(v(0.282 * s, 0.832, z), v(0.283 * s, 0.857 - len, z + 0.006), 0.0085, 0.0068, 0.004);
    C(v(0.276 * s, 0.875, 0.04), v(0.285 * s, 0.835, 0.066), 0.012, 0.009, 0.01); // thumb

    C(hip, kn, 0.092, 0.056, 0.04);
    E(lerp(hip, kn, 0.42).add(v(0.008 * s, 0, 0.022)), v(0.062, 0.14, 0.055), 0.04); // quadriceps
    E(lerp(hip, kn, 0.4).add(v(0, 0, -0.025)), v(0.06, 0.13, 0.05), 0.04); // hamstrings
    E(lerp(hip, kn, 0.22).add(v(-0.035 * s, 0, 0)), v(0.045, 0.11, 0.05), 0.04); // inner thigh
    E(kn.clone().add(v(0, 0, 0.012)), v(0.05, 0.045, 0.048), 0.03); // knee
    C(kn, an, 0.055, 0.033);
    E(v(0.1 * s, 0.37, -0.022), v(0.045, 0.09, 0.04), 0.04); // calf
    E(an, v(0.034, 0.03, 0.036), 0.02); // ankle
    E(v(0.103 * s, 0.033, 0.035), v(0.042, 0.033, 0.09), 0.03); // foot
    E(v(0.1 * s, 0.035, -0.035), v(0.034, 0.035, 0.035), 0.03); // heel
    for (let t = 0; t < 5; t++) {
      const x = (0.083 + t * 0.0095) * s;
      C(v(x, 0.022, 0.115 - t * 0.006), v(x, 0.016, 0.145 - t * 0.008), 0.009 - t * 0.0008, 0.008 - t * 0.0008, 0.006);
    }
  }

  return field;
}

// Eye openings, carved after the inner layers are covered so the eyeballs show through.
function carveEyes(field) {
  for (const s of SIDES) field.add(ellipsoid(v(EYE.x * s, EYE.y + 0.001, EYE.z + 0.017), v(0.016, 0.008, 0.012)), 0.005, true);
}

// Bulge the skin over anything inside that would otherwise touch or break through it.
function coverInnerLayers(field, layers) {
  const p = new THREE.Vector3(), n = new THREE.Vector3();
  for (const L of layers) {
    L.group.updateMatrixWorld(true);
    L.group.traverse((m) => {
      if (!m.isMesh || m.userData.part === 'eyes') return;
      const pos = m.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        p.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
        const s = field.at(p);
        if (s < -0.0015) continue;
        field.gradient(p.x, p.y, p.z, n);
        field.add(cone(p.clone().addScaledVector(n, -(s + 0.006)), p.clone(), 0.003, 0.0015), 0.03);
      }
    });
  }
}

// True when every point is at least 4 mm inside the skin; branches that fail are dropped.
const inBody = (skin, ...pts) => pts.every((p) => skin.at(p) < -0.004);

// Faces of a mesh where every vertex passes `keep`, pushed out along the normal.
function surfacePatch(geo, keep, offset) {
  const p = geo.attributes.position, n = geo.attributes.normal, idx = geo.index.array;
  const remap = new Int32Array(p.count).fill(-1);
  const pos = [], nrm = [], index = [];
  for (let t = 0; t < idx.length; t += 3) {
    const tri = [idx[t], idx[t + 1], idx[t + 2]];
    if (!tri.every((i) => keep(p.getX(i), p.getY(i), p.getZ(i)))) continue;
    for (const i of tri) {
      if (remap[i] < 0) {
        remap[i] = pos.length / 3;
        const o = offset(i);
        pos.push(p.getX(i) + n.getX(i) * o, p.getY(i) + n.getY(i) * o, p.getZ(i) + n.getZ(i) * o);
        nrm.push(n.getX(i), n.getY(i), n.getZ(i));
      }
      index.push(remap[i]);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  out.setIndex(index);
  return out;
}

function buildSkin(L, field) {
  const geo = field.mesh();

  // Skin tone: warmer on cheeks, elbows, knees and hands; darker in creases.
  const ao = field.occlusion(geo);
  const p = geo.attributes.position;
  const col = new Float32Array(p.count * 3);
  const tone = new THREE.Color('#e3ab8b'), warm = new THREE.Color('#d4826f'), c = new THREE.Color(), q = new THREE.Vector3();
  const blush = SIDES.flatMap((s) => [
    [v(0.045 * s, 1.645, 0.075), 0.028], [J.elbow(s).add(v(0, 0, -0.035)), 0.04],
    [J.knee(s).add(v(0, 0, 0.055)), 0.045], [v(0.282 * s, 0.82, 0.02), 0.07],
  ]);
  for (let i = 0; i < p.count; i++) {
    q.fromBufferAttribute(p, i);
    const w = Math.max(...blush.map(([at, r]) => Math.exp(-q.distanceToSquared(at) / (r * r))));
    c.copy(tone).lerp(warm, 0.55 * w).multiplyScalar(0.5 + 0.5 * Math.pow(ao[i], 0.8));
    c.toArray(col, i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  L.mesh('skin', geo);

  // Short hair: the scalp part of the skin, lifted a few millimetres.
  const onScalp = (x, y, z) => y > 1.63 + 0.105 * THREE.MathUtils.smoothstep(z, -0.06, 0.07) && !(Math.abs(x) > 0.07 && y < 1.71 && z > -0.04 && z < 0.03);
  const R = rng(9);
  L.mesh('hair', surfacePatch(geo, onScalp, () => 0.002 + R() * 0.0015));

  // Eyebrows and lips follow the face surface.
  const onFace = (pts, depth) => pts.map(([x, y]) => field.surfaceFromFront(x, y).add(v(0, 0, depth)));
  for (const s of SIDES) {
    const brow = onFace([[0.014, 1.692], [0.025, 1.696], [0.036, 1.696], [0.047, 1.692]].map(([x, y]) => [x * s, y]), 0.001);
    L.mesh('hair', tubeGeo(brow, 0.0028, { radial: 6, rFn: (t) => 1 - 0.5 * t }), { mat: 'brows' });
  }
  const lip = (y, r) => tubeGeo(onFace([-0.022, -0.011, 0, 0.011, 0.022].map((x) => [x, y]), -0.003), r, { radial: 8, rFn: (t) => 0.45 + 0.55 * Math.sin(Math.PI * t) });
  L.mesh('lips', lip(1.614, 0.0042));
  L.mesh('lips', lip(1.606, 0.0046));
}

// ---------------------------------------------------------------- muscles

function buildMuscles(L) {
  const prof = [
    [0, 0.81], [0.07, 0.815], [0.13, 0.84], [0.165, 0.89], [0.172, 0.94], [0.16, 1.0],
    [0.145, 1.06], [0.142, 1.12], [0.152, 1.2], [0.168, 1.28], [0.18, 1.35], [0.185, 1.41],
    [0.165, 1.455], [0.1, 1.485], [0, 1.495],
  ].map(([r, y]) => new THREE.Vector2(r * 0.935, y));
  const core = L.mesh('core-muscles', new THREE.LatheGeometry(prof, 64));
  core.scale.z = 0.585;

  for (const s of SIDES) {
    L.ellipsoid('pectoralis', v(0.06 * s, 1.35, 0.07), v(0.058, 0.048, 0.028), { rot: [0, 0.2 * s, -0.25 * s] });
    L.ellipsoid('deltoid', v(0.186 * s, 1.42, 0), v(0.05, 0.06, 0.05));
    L.limb('arm-muscles', J.shoulder(s), J.elbow(s), 0.045, 0.035);
    L.ellipsoid('arm-muscles', J.shoulder(s).lerp(J.elbow(s), 0.45).add(v(0, 0, 0.01)), v(0.028, 0.065, 0.028),
      { rot: [0, 0, 0.17 * s] });
    L.limb('forearm-muscles', J.elbow(s), J.wrist(s), 0.036, 0.025);
    L.ellipsoid('forearm-muscles', v(0.284 * s, 0.82, 0.022), v(0.016, 0.055, 0.036));
    L.ellipsoid('gluteus', v(0.068 * s, 0.885, -0.045), v(0.08, 0.08, 0.062));
    L.limb('quadriceps', J.hip(s), J.knee(s), 0.082, 0.047);
    L.ellipsoid('quadriceps', J.hip(s).lerp(J.knee(s), 0.45).add(v(0, 0, 0.012)), v(0.05, 0.1, 0.045));
    L.limb('calf', J.knee(s), J.ankle(s), 0.049, 0.028);
    L.ellipsoid('calf', v(0.1 * s, 0.37, -0.012), v(0.035, 0.08, 0.022));
    L.ellipsoid('calf', v(0.103 * s, 0.035, 0.035), v(0.034, 0.028, 0.085));
  }
  for (let row = 0; row < 4; row++) {
    for (const s of SIDES) {
      L.ellipsoid('abdominals', v(0.024 * s, 1.21 - row * 0.06, 0.066), v(0.021, 0.026, 0.012));
    }
  }
  L.ellipsoid('trapezius', v(0, 1.42, -0.045), v(0.13, 0.07, 0.045));
  L.limb('neck-muscles', v(0, 1.45, 0), v(0, 1.6, 0.005), 0.049, 0.045);
}

// ---------------------------------------------------------------- skeleton

export const SPINE = new THREE.CatmullRomCurve3([
  v(0, 0.9, -0.05), v(0, 0.98, -0.035), v(0, 1.08, -0.035), v(0, 1.2, -0.05),
  v(0, 1.32, -0.06), v(0, 1.44, -0.045), v(0, 1.52, -0.025), v(0, 1.6, -0.02),
]);

// Arc-length position of vertebra i (0 = lowest lumbar, 23 = top cervical).
const VERT_W = Array.from({ length: 24 }, (_, i) => (i < 5 ? 1.4 : i < 17 ? 1 : 0.7));
const VERT_SUM = VERT_W.reduce((a, b) => a + b, 0);
function vertT(i) {
  let acc = 0;
  for (let k = 0; k < i; k++) acc += VERT_W[k];
  return 0.06 + ((acc + VERT_W[i] / 2) / VERT_SUM) * 0.9;
}

function buildSkeleton(L, ribCurves) {
  // Skull
  L.ellipsoid('skull', v(0, 1.692, 0), v(0.075, 0.085, 0.088));
  L.ellipsoid('skull', v(0, 1.635, 0.04), v(0.05, 0.04, 0.045));
  for (const s of SIDES) {
    L.ellipsoid('skull', v(0.03 * s, 1.675, 0.07), v(0.02, 0.017, 0.02), { mat: 'socket' });
    L.bone('skull', v(0.035 * s, 1.65, 0.06), v(0.066 * s, 1.655, 0.015), 0.007, 1.3);
  }
  L.ellipsoid('skull', v(0, 1.655, 0.082), v(0.008, 0.012, 0.006), { mat: 'socket' }); // nasal cavity
  const jaw = L.mesh('jaw', new THREE.TorusGeometry(0.045, 0.01, 10, 24, Math.PI));
  jaw.position.set(0, 1.595, 0.025);
  jaw.rotation.x = Math.PI / 2;
  for (const s of SIDES) L.bone('jaw', v(0.045 * s, 1.595, 0.025), v(0.052 * s, 1.65, 0.0), 0.008, 1.2);
  const tooth = new THREE.BoxGeometry(0.006, 0.009, 0.005);
  for (let i = 0; i < 14; i++) {
    const a = 0.25 + (i / 13) * (Math.PI - 0.5);
    for (const y of [1.608, 1.62]) {
      const t = L.mesh('jaw', tooth, { mat: 'teeth' });
      t.position.set(Math.cos(a) * 0.039, y, 0.025 + Math.sin(a) * 0.039);
      t.rotation.y = Math.PI / 2 - a;
    }
  }

  // Spine: 24 movable vertebrae along the S-curve
  for (let i = 0; i < 24; i++) {
    const t = vertT(i);
    const p = SPINE.getPointAt(t);
    const tan = SPINE.getTangentAt(t);
    const r = i < 5 ? 0.02 : i < 17 ? 0.016 : 0.011;
    const h = 0.0165 * VERT_W[i];
    const body = L.mesh('spine', new THREE.CylinderGeometry(r, r, h, 16));
    body.position.copy(p);
    body.quaternion.setFromUnitVectors(UP, tan);
    const proc = L.mesh('spine', new THREE.BoxGeometry(0.006, h * 0.8, 0.018));
    proc.position.copy(p).add(v(0, -0.004, -(r + 0.009)));
    proc.quaternion.copy(body.quaternion);
    const tp = L.mesh('spine', new THREE.BoxGeometry(r * 3.4, h * 0.45, 0.007));
    tp.position.copy(p).add(v(0, 0, -r * 0.6));
    tp.quaternion.copy(body.quaternion);
  }
  const sacrum = L.mesh('pelvis', new THREE.ConeGeometry(0.036, 0.09, 16));
  sacrum.position.set(0, 0.89, -0.05);
  sacrum.rotation.x = Math.PI - 0.35;
  sacrum.scale.z = 0.5;

  // Ribs, sternum and costal cartilage
  for (const { bone, cartilage } of ribCurves) {
    L.tube('ribs', bone, 0.0055, { radial: 8 });
    if (cartilage) L.tube('costal-cartilage', cartilage, 0.005, { radial: 8 });
  }
  const st = L.mesh('sternum', new THREE.BoxGeometry(0.028, 0.19, 0.01));
  st.position.set(0, 1.32, 0.085);
  const man = L.mesh('sternum', new THREE.BoxGeometry(0.045, 0.04, 0.011));
  man.position.set(0, 1.405, 0.083);
  const xi = L.mesh('sternum', new THREE.ConeGeometry(0.01, 0.025, 8));
  xi.position.set(0, 1.213, 0.084);
  xi.rotation.x = Math.PI;

  for (const s of SIDES) {
    L.tube('clavicle', [v(0.018 * s, 1.45, 0.065), v(0.08 * s, 1.465, 0.06), v(0.13 * s, 1.462, 0.03), v(0.175 * s, 1.46, -0.005)], 0.0065, { radial: 8 });
    const shape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(0.075, 0), new THREE.Vector2(0.015, -0.11)]);
    const sc = L.mesh('scapula', new THREE.ExtrudeGeometry(shape, { depth: 0.005, bevelEnabled: false }));
    sc.position.set(0.06 * s, 1.44, -0.087);
    sc.scale.x = s;
    sc.rotation.y = -0.35 * s;
    L.bone('scapula', v(0.07 * s, 1.43, -0.085), v(0.175 * s, 1.455, -0.02), 0.005, 1.4);

    // Pelvis
    L.ellipsoid('pelvis', v(0.075 * s, 0.96, -0.01), v(0.065, 0.055, 0.02), { rot: [0, -0.5 * s, 0.25 * s] });
    L.bone('pelvis', v(0.06 * s, 0.86, 0), v(0.075 * s, 0.93, -0.03), 0.01, 1.3);
    L.sphere('pelvis', v(0.085 * s, 0.892, 0), 0.023);

    // Arm
    L.sphere('humerus', v(0.185 * s, 1.425, -0.005), 0.021);
    L.limb('humerus', v(0.19 * s, 1.41, -0.005), v(0.233 * s, 1.17, -0.01), 0.0105, 0.0095, { caps: false });
    L.ellipsoid('humerus', v(0.233 * s, 1.17, -0.01), v(0.022, 0.012, 0.014));
    L.bone('radius-ulna', v(0.24 * s, 1.15, 0.0), v(0.272 * s, 0.905, 0.028), 0.0065, 1.6);
    L.bone('radius-ulna', v(0.232 * s, 1.155, -0.02), v(0.268 * s, 0.9, 0.01), 0.006, 1.6);
    L.ellipsoid('hand-bones', v(0.275 * s, 0.885, 0.02), v(0.012, 0.012, 0.022));
    for (const [z, len] of FINGERS) {
      L.tube('hand-bones', [v(0.277 * s, 0.875, z), v(0.283 * s, 0.875 - len * 0.55, z + 0.002), v(0.281 * s, 0.875 - len, z + 0.006)], 0.0035, { radial: 6 });
      L.sphere('hand-bones', v(0.282 * s, 0.875 - len * 0.45, z + 0.001), 0.0048);
    }
    L.tube('hand-bones', [v(0.273 * s, 0.88, 0.032), v(0.278 * s, 0.855, 0.05), v(0.28 * s, 0.83, 0.058)], 0.004, { radial: 6 });

    // Leg
    L.sphere('femur', v(0.085 * s, 0.895, 0), 0.02);
    L.bone('femur', v(0.085 * s, 0.895, 0), v(0.125 * s, 0.88, -0.005), 0.011, 1.4);
    L.limb('femur', v(0.115 * s, 0.87, 0), v(0.1 * s, 0.515, 0), 0.013, 0.012, { caps: false });
    L.ellipsoid('femur', v(0.1 * s, 0.512, 0), v(0.024, 0.018, 0.022));
    L.ellipsoid('patella', v(0.1 * s, 0.505, 0.035), v(0.015, 0.018, 0.007));
    L.ellipsoid('tibia-fibula', v(0.1 * s, 0.485, 0.003), v(0.024, 0.012, 0.022));
    L.limb('tibia-fibula', v(0.1 * s, 0.485, 0.005), v(0.1 * s, 0.1, -0.005), 0.012, 0.01, { caps: false });
    L.ellipsoid('tibia-fibula', v(0.098 * s, 0.093, -0.005), v(0.016, 0.014, 0.018));
    L.bone('tibia-fibula', v(0.118 * s, 0.475, -0.008), v(0.115 * s, 0.09, -0.012), 0.006, 1.5);
    L.ellipsoid('foot-bones', v(0.1 * s, 0.03, -0.035), v(0.018, 0.02, 0.03));
    L.ellipsoid('foot-bones', v(0.1 * s, 0.06, 0.0), v(0.018, 0.016, 0.025));
    for (let k = 0; k < 5; k++) {
      const x = (0.083 + k * 0.009) * s;
      L.tube('foot-bones', [v(x, 0.045, 0.01), v(x * 1.01, 0.025, 0.08), v(x * 1.02, 0.012, 0.13 - k * 0.006)], 0.0045 - k * 0.0003, { radial: 6 });
    }
  }
}

function makeRibCurves() {
  const widths = [0.085, 0.11, 0.125, 0.135, 0.14, 0.142, 0.142, 0.14, 0.135, 0.128, 0.118, 0.105];
  const ribs = [];
  for (let i = 0; i < 12; i++) {
    const p = SPINE.getPointAt(vertT(16 - i));
    const y0 = p.y, zs = p.z, f = widths[i];
    const drop = 0.03 + i * 0.004;
    for (const s of SIDES) {
      const back = [v(0.012 * s, y0, zs), v(0.045 * s, y0 + 0.004, zs - 0.02), v(0.8 * f * s, y0 - 0.01, zs - 0.012), v(f * s, y0 - drop * 0.6, -0.01)];
      let bone, cartilage = null;
      if (i < 10) {
        const front = v(0.5 * f * s, y0 - drop - 0.005, 0.072);
        bone = [...back, v(0.82 * f * s, y0 - drop * 0.9, 0.05), front];
        const sy = i < 7 ? 1.41 - i * 0.025 : 1.245;
        cartilage = [front, v(0.03 * s, (front.y + sy) / 2, 0.082), v(0.014 * s, sy, 0.085)];
      } else {
        bone = [...back, v(0.9 * f * s, y0 - drop, 0.03)];
      }
      ribs.push({ bone, cartilage, side: s, index: i });
    }
  }
  return ribs;
}

// ---------------------------------------------------------------- organs

function lungGeometry(side) {
  const g = new THREE.SphereGeometry(1, 48, 32);
  const pos = g.attributes.position;
  const med = -side; // direction toward the midline
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const w = 1 - 0.38 * Math.max(0, y);
    x *= w;
    z *= w;
    if (y < -0.55) y = -0.55 + (y + 0.55) * 0.35;
    if (x * med > 0.35) x = med * (0.35 + (x * med - 0.35) * 0.4);
    pos.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  return g;
}

function buildOrgans(L, anim) {
  // Lungs (breathe), right lung has 3 lobes, left 2 to make room for the heart
  for (const s of SIDES) {
    const lung = L.mesh('lungs', lungGeometry(s), { dynamic: true });
    lung.position.set(s < 0 ? -0.075 : 0.084, 1.3, s < 0 ? 0 : -0.006);
    lung.scale.set(s < 0 ? 0.058 : 0.05, 0.115, 0.066);
    lung.userData.baseScale = lung.scale.clone();
    anim.lungs.push(lung);
  }
  L.tube('trachea', [v(0, 1.56, 0.03), v(0, 1.48, 0.025), v(0, 1.4, 0.015)], 0.0085);
  for (const s of SIDES) L.tube('trachea', [v(0, 1.405, 0.015), v(0.03 * s, 1.37, 0.01), v(0.055 * s, 1.34, 0)], 0.0055);
  L.tube('esophagus', [v(0, 1.56, 0.005), v(0, 1.47, -0.005), v(0.002, 1.38, -0.015), v(0.008, 1.28, -0.012), v(0.02, 1.2, -0.005), v(0.04, 1.17, 0)], 0.0065);
  for (const s of SIDES) L.ellipsoid('thyroid', v(0.012 * s, 1.5, 0.032), v(0.009, 0.015, 0.008));
  L.ellipsoid('thyroid', v(0, 1.497, 0.036), v(0.008, 0.005, 0.004));

  // Heart (beats)
  const heart = new THREE.Group();
  heart.position.set(0.018, 1.255, 0.045);
  heart.rotation.set(-0.3, 0, 0.45);
  L.group.add(heart);
  const hopts = { parent: heart, dynamic: true };
  L.ellipsoid('heart', v(0, -0.005, 0), v(0.042, 0.048, 0.036), hopts);
  const apex = L.mesh('heart', new THREE.ConeGeometry(0.03, 0.045, 24), hopts);
  apex.position.set(0.003, -0.05, 0);
  apex.rotation.x = Math.PI;
  L.ellipsoid('heart', v(-0.022, 0.035, -0.005), v(0.022, 0.02, 0.022), hopts);
  L.ellipsoid('heart', v(0.02, 0.035, -0.012), v(0.02, 0.018, 0.02), hopts);
  L.tube('heart', [v(-0.01, 0.04, 0.03), v(0.0, 0.0, 0.037), v(0.006, -0.04, 0.03), v(0.004, -0.066, 0.008)], 0.0025, { ...hopts, mat: 'coronary' });
  L.tube('heart', [v(0.0, 0.025, 0.034), v(0.032, 0.0, 0.025), v(0.04, -0.03, 0.0)], 0.0022, { ...hopts, mat: 'coronary' });
  anim.heart = heart;

  // Abdomen
  L.ellipsoid('liver', v(-0.04, 1.115, 0.015), v(0.085, 0.048, 0.05), { rot: [0, 0, -0.3] });
  L.ellipsoid('liver', v(0.02, 1.125, 0.025), v(0.045, 0.028, 0.04));
  L.ellipsoid('gallbladder', v(-0.045, 1.07, 0.058), v(0.012, 0.02, 0.012), { rot: [0.3, 0, 0.2] });
  L.sphere('stomach', v(0.065, 1.15, 0.015), 0.03);
  L.tube('stomach', [v(0.04, 1.17, 0), v(0.07, 1.15, 0.02), v(0.085, 1.11, 0.035), v(0.07, 1.07, 0.045), v(0.035, 1.055, 0.045), v(0, 1.065, 0.04), v(-0.02, 1.075, 0.03)], 0.025,
    { rFn: (t) => 0.75 + 0.45 * Math.sin(Math.PI * Math.min(1, t * 1.3)) });
  L.ellipsoid('spleen', v(0.1, 1.11, -0.02), v(0.02, 0.042, 0.025), { rot: [0, 0, 0.3] });
  L.tube('pancreas', [v(-0.025, 1.045, 0), v(0.02, 1.055, -0.005), v(0.06, 1.07, -0.012), v(0.095, 1.085, -0.02)], 0.011, { rFn: (t) => 1.2 - 0.6 * t });
  for (const s of SIDES) {
    const y = s < 0 ? 1.03 : 1.042;
    L.ellipsoid('kidneys', v(0.06 * s, y, -0.04), v(0.022, 0.042, 0.017), { rot: [0, 0, 0.2 * s] });
    const ad = L.mesh('adrenal', new THREE.ConeGeometry(0.012, 0.018, 12));
    ad.position.set(0.053 * s, y + 0.047, -0.04);
    L.tube('kidneys', [v(0.05 * s, y - 0.015, -0.035), v(0.045 * s, 0.95, -0.03), v(0.035 * s, 0.88, 0), v(0.015 * s, 0.857, 0.03)], 0.0028, { mat: 'ureter', radial: 6 });
  }
  L.tube('large-intestine', [
    v(-0.085, 0.89, 0.03), v(-0.1, 0.93, 0.03), v(-0.105, 0.99, 0.025), v(-0.095, 1.025, 0.035), v(-0.05, 1.015, 0.05),
    v(0, 1.005, 0.052), v(0.05, 1.015, 0.05), v(0.1, 1.035, 0.03), v(0.11, 0.98, 0.02), v(0.105, 0.92, 0.025),
    v(0.08, 0.875, 0.04), v(0.04, 0.865, 0.045), v(0.01, 0.875, 0.02), v(0, 0.86, -0.02), v(0, 0.82, -0.035),
  ], 0.019, { radial: 16, rFn: (t) => (0.85 + 0.15 * Math.abs(Math.sin(t * Math.PI * 34))) * (t > 0.85 ? 0.8 : 1) });
  const pts = [];
  for (let layer = 0; layer < 3; layer++) {
    const z = layer * 0.022;
    for (let row = 0; row < 5; row++) {
      const y = 0.985 - row * 0.026 - (layer % 2) * 0.013;
      const dir = (row + layer) % 2 ? 1 : -1;
      for (let k = 0; k <= 8; k++) {
        pts.push(v(dir * (-0.07 + k * 0.0175), y + Math.sin(k * 1.7 + row) * 0.008, z + Math.cos(k * 2.1 + layer) * 0.008));
      }
    }
  }
  L.tube('small-intestine', pts, 0.0095, { radial: 10 });
  L.tube('small-intestine', [v(-0.02, 1.075, 0.03), v(-0.04, 1.06, 0.01), v(-0.04, 1.02, 0), v(-0.01, 1.0, 0.005), v(0.02, 1.01, 0)], 0.011);
  L.ellipsoid('bladder', v(0, 0.84, 0.045), v(0.03, 0.025, 0.028));

  // Eyes
  for (const s of SIDES) {
    const c = v(EYE.x * s, EYE.y, EYE.z);
    L.sphere('eyes', c, 0.0135);
    L.ellipsoid('eyes', c.clone().add(v(0, 0, 0.0115)), v(0.0072, 0.0072, 0.003), { mat: 'iris' });
    L.ellipsoid('eyes', c.clone().add(v(0, 0, 0.0135)), v(0.0032, 0.0032, 0.0012), { mat: 'pupil' });
  }
}

// ---------------------------------------------------------------- vessels

const ARTERY = 'a', VEIN = 'v';
const VESSEL_TYPE = {
  aorta: ARTERY, carotid: ARTERY, 'arm-artery': ARTERY, 'leg-artery': ARTERY, 'renal-vessels': ARTERY,
  mesenteric: ARTERY, 'scalp-vessels': ARTERY, arterioles: ARTERY, 'pulmonary-veins': ARTERY,
  'vena-cava': VEIN, jugular: VEIN, 'arm-vein': VEIN, 'leg-vein': VEIN, venules: VEIN, 'pulmonary-artery': VEIN,
};

function buildVessels(L, skin) {
  const FLOW = 14;
  const A = (part, pts, r, opts = {}) => L.tube(part, pts, r, { flow: FLOW, radial: 10, ...opts });
  const taper = (k) => (t) => 1 - k * t;
  const off = (pts, d) => pts.map((p) => p.clone().add(d));
  const R = rng(11);

  function branches(part, pts, count, len = 0.03, r = 0.0022) {
    const curve = new THREE.CatmullRomCurve3(pts);
    for (let i = 0; i < count; i++) {
      const t = 0.12 + 0.85 * R();
      const p = curve.getPointAt(t);
      const tan = curve.getTangentAt(t).multiplyScalar(R() > 0.3 ? 0.8 : -0.5);
      const dir = tan.add(v(R() - 0.5, R() - 0.5, R() - 0.5).multiplyScalar(0.6)).normalize();
      const l = len * (0.6 + R() * 0.8);
      const mid = p.clone().addScaledVector(dir, l * 0.5).add(v((R() - 0.5) * 0.01, (R() - 0.5) * 0.01, (R() - 0.5) * 0.01));
      const end = p.clone().addScaledVector(dir, l);
      const fork = R() > 0.5 ? mid.clone().addScaledVector(dir.clone().add(v(R() - 0.5, R() - 0.5, R() - 0.5)).normalize(), l * 0.5) : null;
      if (!inBody(skin, mid, end)) continue;
      A(part, [p, mid, end], r, { radial: 6, rFn: taper(0.6) });
      if (fork && inBody(skin, fork)) A(part, [mid, fork], r * 0.6, { radial: 5, rFn: taper(0.6) });
    }
  }

  // Arteries (carry oxygen-rich blood away from the heart)
  const aorta = [v(0.01, 1.29, 0.04), v(0, 1.34, 0.035), v(-0.005, 1.37, 0.01), v(0, 1.36, -0.02), v(0.012, 1.33, -0.035),
    v(0.015, 1.25, -0.04), v(0.012, 1.12, -0.035), v(0.008, 1.0, -0.025), v(0, 0.94, -0.015)];
  A('aorta', aorta, 0.009, { rFn: taper(0.35) });
  for (const s of SIDES) {
    const leg = [v(0, 0.94, -0.015), v(0.04 * s, 0.91, 0), v(0.075 * s, 0.86, 0.025), v(0.09 * s, 0.75, 0.03), v(0.1 * s, 0.6, 0.01),
      v(0.1 * s, 0.5, -0.025), v(0.1 * s, 0.4, -0.02), v(0.1 * s, 0.2, -0.005), v(0.1 * s, 0.09, 0), v(0.105 * s, 0.05, 0.05), v(0.11 * s, 0.035, 0.11)];
    A('leg-artery', leg, 0.0062, { rFn: taper(0.5) });
    branches('arterioles', leg.slice(2), 14);
    const carotid = [v(0.01 * s, 1.36, 0.02), v(0.022 * s, 1.45, 0.025), v(0.03 * s, 1.55, 0.03), v(0.035 * s, 1.6, 0.025), v(0.05 * s, 1.65, 0), v(0.058 * s, 1.72, -0.01)];
    A('carotid', carotid, 0.0048, { rFn: taper(0.4) });
    const arm = [v(0.01 * s, 1.36, 0.01), v(0.06 * s, 1.41, 0.01), v(0.14 * s, 1.43, 0), v(0.19 * s, 1.4, 0.005), v(0.215 * s, 1.28, 0.012),
      v(0.235 * s, 1.16, 0.012), v(0.25 * s, 1.03, 0.025), v(0.268 * s, 0.91, 0.022), v(0.28 * s, 0.82, 0.022)];
    A('arm-artery', arm, 0.0048, { rFn: taper(0.5) });
    branches('arterioles', arm.slice(3), 8, 0.03, 0.0018);
    A('renal-vessels', [v(0.01 * s, 1.04, -0.03), v(0.035 * s, 1.042, -0.036), v(0.05 * s, 1.04, -0.04)], 0.0035);

    // Scalp: superficial temporal artery over the side of the head
    const scalp = (th, ph) => v(0.081 * Math.cos(th) * Math.sin(ph), 1.688 + 0.097 * Math.sin(th), 0.003 + 0.093 * Math.cos(th) * Math.cos(ph));
    const temporal = [-0.45, -0.1, 0.25, 0.6, 0.9].map((th) => scalp(th, s * (Math.PI / 2 + 0.1)));
    A('scalp-vessels', temporal, 0.0028, { rFn: taper(0.5) });
    A('scalp-vessels', [0.25, 0.5, 0.75, 1.0].map((th, i) => scalp(th, s * (Math.PI / 2 - i * 0.35))), 0.002, { rFn: taper(0.5) });
    A('scalp-vessels', [0.25, 0.45, 0.65, 0.85].map((th, i) => scalp(th, s * (Math.PI / 2 + 0.1 + i * 0.4))), 0.002, { rFn: taper(0.5) });

    // Pulmonary circulation: arteries carry oxygen-poor blood to the lungs (shown blue)
    // Drawn lung-to-heart so the vein-style flow animation runs toward the lung.
    A('pulmonary-artery', [v(0.065 * s, 1.31, 0), v(0.035 * s, 1.325, 0.02), v(0.02, 1.32, 0.045), v(0.02, 1.29, 0.06)], 0.0055, { rFn: (t) => 0.6 + 0.4 * t });
    A('pulmonary-veins', [v(0.06 * s, 1.27, 0.0), v(0.03 * s, 1.265, 0.015), v(0.01, 1.27, 0.03)], 0.0045);
  }
  for (let i = 0; i < 6; i++) {
    const a = -1 + (i / 5) * 2;
    A('mesenteric', [v(0.01, 1.05, -0.025), v(0.01 + a * 0.02, 1.0, 0.0), v(a * 0.06, 0.94 + Math.sin(i * 2.3) * 0.03, 0.02)], 0.0026, { rFn: taper(0.6), radial: 6 });
  }

  // Veins (carry blood back toward the heart)
  A('vena-cava', [v(-0.02, 1.27, 0.04), v(-0.025, 1.34, 0.03), v(-0.02, 1.4, 0.025)], 0.0085);
  A('vena-cava', [v(-0.02, 1.24, 0.035), v(-0.025, 1.18, 0), v(-0.025, 1.1, -0.02), v(-0.02, 1.0, -0.02), v(-0.012, 0.94, -0.01)], 0.0095, { rFn: taper(0.3) });
  for (const s of SIDES) {
    A('jugular', [v(-0.02, 1.4, 0.025), v(0.03 * s, 1.45, 0.022), v(0.035 * s, 1.55, 0.025), v(0.05 * s, 1.62, 0.02), v(0.064 * s, 1.7, -0.02)], 0.0055, { rFn: taper(0.4) });
    const armV = off([v(0.06 * s, 1.41, 0.01), v(0.14 * s, 1.43, 0), v(0.19 * s, 1.4, 0.005), v(0.215 * s, 1.28, 0.012),
      v(0.235 * s, 1.16, 0.012), v(0.25 * s, 1.03, 0.025), v(0.268 * s, 0.91, 0.022), v(0.28 * s, 0.82, 0.022)], v(0.01 * s, 0.006, -0.012));
    A('arm-vein', [v(-0.02, 1.4, 0.025), ...armV], 0.0052, { rFn: taper(0.5) });
    branches('venules', armV.slice(2), 8, 0.03, 0.0018);
    const legV = off([v(0.04 * s, 0.91, 0), v(0.075 * s, 0.86, 0.025), v(0.09 * s, 0.75, 0.03), v(0.1 * s, 0.6, 0.01),
      v(0.1 * s, 0.5, -0.025), v(0.1 * s, 0.4, -0.02), v(0.1 * s, 0.2, -0.005), v(0.1 * s, 0.09, 0), v(0.105 * s, 0.05, 0.05), v(0.11 * s, 0.035, 0.11)], v(-0.014 * s, 0, 0.006));
    A('leg-vein', [v(-0.012, 0.94, -0.01), ...legV], 0.0068, { rFn: taper(0.5) });
    branches('venules', legV.slice(2), 14);
    A('renal-vessels', [v(-0.02, 1.035, -0.02), v(0.03 * s - 0.005, 1.035, -0.03), v(0.05 * s, 1.035, -0.035)], 0.0035, { mat: 'renal-vein' });
  }
}

// ---------------------------------------------------------------- nerves

function brainGeometry(freq, amp, folia = false) {
  const g = new THREE.SphereGeometry(1, 96, 64);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let n;
    if (folia) {
      n = Math.abs(Math.sin(y * freq + Math.sin(z * 6) * 0.6));
    } else {
      n = Math.abs(Math.sin(x * freq + 2.5 * Math.sin(y * 9)) * Math.sin(y * freq + 2.5 * Math.sin(z * 8)) * Math.sin(z * freq + 2.5 * Math.sin(x * 7)));
      n = Math.pow(n, 0.5);
    }
    const k = 1 - amp + amp * n;
    pos.setXYZ(i, x * k, y * k, z * k);
  }
  g.computeVertexNormals();
  return g;
}

function buildNerves(L, ribCurves, skin) {
  const N = (part, pts, r, opts = {}) => L.tube(part, pts, r, { radial: 8, ...opts });
  const R = rng(5);
  const cortex = brainGeometry(17, 0.07);
  for (const s of SIDES) L.ellipsoid('brain', v(0.034 * s, 1.7, 0), v(0.033, 0.054, 0.068), { geo: cortex });
  L.ellipsoid('cerebellum', v(0, 1.648, -0.045), v(0.045, 0.022, 0.028), { geo: brainGeometry(55, 0.1, true) });
  N('brainstem', [v(0, 1.685, -0.008), v(0, 1.64, -0.016), v(0, 1.6, -0.022)], 0.0105, { rFn: (t) => 1 - 0.35 * t });

  const cord = [];
  for (let i = 0; i <= 20; i++) {
    const p = SPINE.getPointAt(0.98 - i * 0.038);
    cord.push(p.add(v(0, 0, -0.018)));
  }
  N('spinal-cord', cord, 0.0055, { rFn: (t) => 1 - 0.4 * t });
  const end = cord[cord.length - 1];
  for (let i = 0; i < 6; i++) {
    const dx = (i - 2.5) * 0.004;
    N('spinal-cord', [end, v(dx, 0.95, -0.055), v(dx * 1.6, 0.89, -0.058)], 0.0015, { radial: 5 });
  }

  function twigs(part, pts, count, len = 0.035) {
    const curve = new THREE.CatmullRomCurve3(pts);
    for (let i = 0; i < count; i++) {
      const t = 0.15 + 0.8 * R();
      const p = curve.getPointAt(t);
      const dir = curve.getTangentAt(t).multiplyScalar(0.7).add(v(R() - 0.5, R() - 0.5, R() - 0.5)).normalize();
      const mid = p.clone().addScaledVector(dir, len * 0.5).add(v(0, (R() - 0.5) * 0.01, 0));
      const end = p.clone().addScaledVector(dir, len);
      if (!inBody(skin, mid, end)) continue;
      N(part, [p, mid, end], 0.0014, { radial: 5, rFn: (t) => 1 - 0.6 * t });
    }
  }

  for (const s of SIDES) {
    const arm = [SPINE.getPointAt(0.84).add(v(0.006 * s, 0, -0.012)), v(0.05 * s, 1.47, -0.01), v(0.12 * s, 1.44, 0), v(0.19 * s, 1.405, 0),
      v(0.205 * s, 1.3, 0.012), v(0.228 * s, 1.17, 0.006), v(0.245 * s, 1.03, 0.014), v(0.265 * s, 0.92, 0.016)];
    N('arm-nerves', arm, 0.0032, { rFn: (t) => 1 - 0.4 * t });
    N('arm-nerves', [arm[3], v(0.208 * s, 1.3, -0.018), v(0.236 * s, 1.17, -0.024), v(0.262 * s, 1.03, -0.005), v(0.27 * s, 0.92, 0.0)], 0.0024, { rFn: (t) => 1 - 0.5 * t });
    for (const [z, len] of [...FINGERS, [0.05, 0.07]]) {
      N('arm-nerves', [v(0.265 * s, 0.92, 0.016), v(0.276 * s, 0.875, (z + 0.016) / 2), v(0.284 * s, 0.875 - len * 0.6, z)], 0.0012, { radial: 5 });
    }
    twigs('arm-nerves', arm.slice(4), 6);

    const sciatic = [v(0.02 * s, 0.97, -0.045), v(0.06 * s, 0.89, -0.05), v(0.09 * s, 0.78, -0.04), v(0.1 * s, 0.6, -0.03), v(0.1 * s, 0.5, -0.03),
      v(0.1 * s, 0.3, -0.025), v(0.1 * s, 0.1, -0.025), v(0.105 * s, 0.03, 0), v(0.11 * s, 0.025, 0.1)];
    N('sciatic', sciatic, 0.0045, { rFn: (t) => 1 - 0.6 * t });
    twigs('sciatic', sciatic.slice(2), 10, 0.045);
    const femoral = [v(0.03 * s, 0.98, -0.025), v(0.07 * s, 0.88, 0.035), v(0.09 * s, 0.78, 0.042), v(0.1 * s, 0.64, 0.03)];
    N('femoral-nerve', femoral, 0.003, { rFn: (t) => 1 - 0.5 * t });
    twigs('femoral-nerve', femoral.slice(1), 5, 0.04);

    N('optic', [v(0.033 * s, 1.675, 0.064), v(0.016 * s, 1.67, 0.035), v(0.003 * s, 1.668, 0.016)], 0.0026);
    N('cranial-nerves', [v(0.03 * s, 1.66, 0.0), v(0.045 * s, 1.645, 0.03), v(0.05 * s, 1.63, 0.06)], 0.0018);
    N('cranial-nerves', [v(0.045 * s, 1.645, 0.03), v(0.04 * s, 1.6, 0.05), v(0.03 * s, 1.59, 0.07)], 0.0014);
  }

  for (const rib of ribCurves) {
    const pts = rib.bone.map((p) => v(p.x * 0.97, p.y - 0.007, p.z * 0.97));
    N('intercostal', pts, 0.0013, { radial: 5 });
  }
}

// ---------------------------------------------------------------- materials

const ORGAN_COLORS = {
  lungs: ['#e58b95', 0.6], trachea: ['#e9d1c6', 0.5], esophagus: ['#c9786d', 0.45], thyroid: ['#b4475a', 0.4],
  heart: ['#b2202d', 0.3], coronary: ['#e8443f', 0.3], liver: ['#7e2d22', 0.35], gallbladder: ['#5c8a3a', 0.3],
  stomach: ['#d98c86', 0.4], spleen: ['#6e2b4d', 0.35], pancreas: ['#e7bf78', 0.5], kidneys: ['#8e3535', 0.35],
  adrenal: ['#e6b84a', 0.5], ureter: ['#e8d39a', 0.5], 'large-intestine': ['#c78470', 0.45], 'small-intestine': ['#eaa595', 0.4],
  bladder: ['#d9b65e', 0.35], eyes: ['#f4f1ea', 0.15], iris: ['#6a4b30', 0.2], pupil: ['#050505', 0.1],
};

function makeFactories(textures) {
  const base = { transparent: true, side: THREE.DoubleSide };
  return {
    skin: (key) => {
      if (key === 'hair' || key === 'brows') return new THREE.MeshStandardMaterial({ ...base, color: '#2e1f16', roughness: 0.85 });
      if (key === 'lips') return new THREE.MeshPhysicalMaterial({ ...base, color: '#b8695f', roughness: 0.4, clearcoat: 0.3 });
      return new THREE.MeshPhysicalMaterial({ ...base, vertexColors: true, roughness: 0.5, sheen: 0.6, sheenColor: '#ffcfb0', sheenRoughness: 0.5, clearcoat: 0.08 });
    },
    muscles: (key) => new THREE.MeshStandardMaterial({
      ...base, map: textures.muscle, bumpMap: textures.muscle, bumpScale: 1.4, roughness: 0.5,
      color: key === 'core-muscles' ? '#e8c4c0' : '#ffffff',
    }),
    skeleton: (key) => new THREE.MeshStandardMaterial({
      ...base, roughness: key === 'teeth' ? 0.25 : 0.7,
      color: { socket: '#3a2a22', 'costal-cartilage': '#c8dcdc', teeth: '#fbf8ef' }[key] ?? '#ece2c8',
    }),
    organs: (key) => {
      const [color, rough] = ORGAN_COLORS[key] ?? ['#d9827c', 0.4];
      return new THREE.MeshPhysicalMaterial({ ...base, color, roughness: rough, clearcoat: 0.45, clearcoatRoughness: 0.3 });
    },
    vessels: (key) => {
      const artery = (VESSEL_TYPE[key] ?? ARTERY) === ARTERY && key !== 'renal-vein';
      return new THREE.MeshStandardMaterial({
        ...base, roughness: 0.35, metalness: 0.05,
        color: artery ? '#c81f26' : '#2c4fc4',
        emissive: artery ? '#ff5a4a' : '#5a86ff', emissiveIntensity: 0.9,
        emissiveMap: artery ? textures.flowA : textures.flowV,
      });
    },
    nerves: (key) => (['brain', 'cerebellum', 'brainstem'].includes(key)
      ? new THREE.MeshPhysicalMaterial({ ...base, color: key === 'brainstem' ? '#d9a6a0' : '#e9b3b0', roughness: 0.5, clearcoat: 0.35, clearcoatRoughness: 0.4, sheen: 0.4, sheenColor: '#ffd9d9' })
      : new THREE.MeshStandardMaterial({ ...base, color: '#f0cc5a', emissive: '#a07a10', emissiveIntensity: 0.35, roughness: 0.45 })),
  };
}

// Merge static meshes of the same part and material into one draw call.
function mergeLayer(L) {
  L.group.updateMatrixWorld(true);
  const buckets = new Map();
  L.group.traverse((o) => {
    if (!o.isMesh || o.userData.dynamic) return;
    const key = o.userData.part + '|' + o.userData.matKey;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(o);
  });
  for (const [key, meshes] of buckets) {
    const geos = meshes.map((m) => {
      m.parent.remove(m);
      let g = m.geometry.clone().applyMatrix4(m.matrixWorld);
      if (meshes.length === 1) return g; // nothing to merge with: keep it indexed (the skin is large)
      if (g.index) g = g.toNonIndexed();
      for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
      return g;
    });
    const [part, matKey] = key.split('|');
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos);
    merged.computeBoundingSphere();
    L.mesh(part, merged, { mat: matKey });
  }
}

// ---------------------------------------------------------------- entry

export function buildBody() {
  const textures = { muscle: muscleTexture(), flowA: flowTexture(), flowV: flowTexture() };
  const factories = makeFactories(textures);
  const anim = { heart: null, lungs: [], textures };
  const ribCurves = makeRibCurves();
  const root = new THREE.Group();
  const layers = LAYERS.map((meta) => makeLayer(meta, factories[meta.id]));
  const [skin, muscles, skeleton, organs, vessels, nerves] = layers;
  buildMuscles(muscles);
  buildSkeleton(skeleton, ribCurves);
  buildOrgans(organs, anim);
  const field = sculptSkin();
  buildVessels(vessels, field);
  buildNerves(nerves, ribCurves, field);
  coverInnerLayers(field, [muscles, skeleton, organs, vessels, nerves]);
  carveEyes(field);
  buildSkin(skin, field);
  for (const L of layers) {
    mergeLayer(L);
    root.add(L.group);
  }
  return { root, layers, anim };
}

// ---------------------------------------------------------------- info

export const INFO = {
  skin: ['Skin', 'The body\'s largest organ: a waterproof barrier that controls temperature, senses touch, heat and pain, and makes vitamin D.', 'An adult\'s skin covers about 1.8 m² and you shed tens of thousands of skin cells every minute.'],
  hair: ['Hair', 'Hair keeps the head warm and shields it from the sun; eyebrows keep sweat out of the eyes.', 'A scalp has about 100,000 hairs, each growing roughly 1 cm a month.'],
  lips: ['Lips', 'Soft, flexible edges of the mouth used for eating, speaking and expression.', 'Lips look red because their skin is very thin, letting blood vessels show through.'],
  'core-muscles': ['Core & back muscles', 'Obliques, latissimus dorsi and the deep back muscles wrap the torso, keeping you upright and twisting the trunk.', 'Your core muscles fire just before you move an arm or leg, to brace the spine.'],
  pectoralis: ['Pectoralis major', 'The large chest muscle that pulls the arm forward and across the body, as in a push-up or a hug.', 'It has two heads, clavicular and sternal, which can be trained separately.'],
  abdominals: ['Rectus abdominis', 'The "six-pack" muscle that flexes the spine and supports the organs of the abdomen.', 'The "packs" come from tendon bands (tendinous intersections) crossing the muscle.'],
  trapezius: ['Trapezius', 'A large diamond-shaped muscle across the upper back that lifts, rotates and steadies the shoulder blades.', 'It is named after the trapezium shape the left and right halves make together.'],
  'neck-muscles': ['Neck muscles', 'Sternocleidomastoid and friends turn, tilt and nod the head, which weighs about 5 kg.', 'Looking down at a phone can load the neck with several times the head\'s weight.'],
  deltoid: ['Deltoid', 'The rounded shoulder muscle that lifts the arm out to the side, forward and backward.', 'It is a common site for vaccine injections.'],
  'arm-muscles': ['Biceps & triceps', 'Biceps bends the elbow and turns the palm up; triceps on the back straightens the elbow.', 'The triceps makes up about two thirds of the upper arm\'s muscle mass.'],
  'forearm-muscles': ['Forearm & hand muscles', 'Muscles in the forearm move the wrist and fingers through long tendons.', 'Your fingers have no muscles of their own; they are pulled like puppets from the forearm.'],
  gluteus: ['Gluteus maximus', 'The buttock muscle that extends the hip when you stand up, climb or run.', 'It is the largest muscle in the human body.'],
  quadriceps: ['Quadriceps', 'Four muscles on the front of the thigh that straighten the knee.', 'They are among the strongest muscles in the body and key to walking and jumping.'],
  calf: ['Calf & foot muscles', 'Gastrocnemius and soleus point the foot and push you forward with every step.', 'They attach to the heel by the Achilles tendon, the strongest tendon in the body.'],
  skull: ['Skull (cranium)', 'Protects the brain and holds the eyes, ears, nose and teeth.', 'The adult skull is made of 22 bones fused at joints called sutures.'],
  jaw: ['Mandible & teeth', 'The lower jaw, the only movable bone of the skull, used for chewing and speaking.', 'Adults have 32 teeth; enamel is the hardest substance in the body.'],
  spine: ['Vertebral column', 'A stack of 24 movable vertebrae plus the sacrum and coccyx that holds you up and protects the spinal cord.', 'Its S-shaped curve works like a spring to absorb shock when you walk.'],
  ribs: ['Ribs', '12 pairs of curved bones forming a protective cage around the heart and lungs.', '7 "true" pairs attach to the sternum, 3 "false" pairs attach indirectly, and 2 "floating" pairs attach only to the spine.'],
  'costal-cartilage': ['Costal cartilage', 'Flexible cartilage joining the ribs to the sternum so the chest can expand when you breathe.', 'It gradually calcifies with age, making the rib cage stiffer.'],
  sternum: ['Sternum', 'The breastbone, a flat bone at the front of the chest that anchors the ribs.', 'Its marrow keeps making blood cells throughout adult life.'],
  clavicle: ['Clavicle', 'The collarbone, a strut that holds the shoulder away from the body.', 'It is one of the most commonly broken bones.'],
  scapula: ['Scapula', 'The shoulder blade, a flat triangular bone that gives the arm its huge range of motion.', 'Seventeen muscles attach to each scapula.'],
  pelvis: ['Pelvis & sacrum', 'A basin of bone that carries the upper body\'s weight to the legs and protects the bladder and reproductive organs.', 'The sacrum forms from five vertebrae that fuse in early adulthood.'],
  humerus: ['Humerus', 'The upper arm bone, from shoulder to elbow.', 'The "funny bone" is really the ulnar nerve crossing the end of the humerus.'],
  'radius-ulna': ['Radius & ulna', 'The two forearm bones; the radius rotates around the ulna to turn the palm up or down.', 'A fall on an outstretched hand often breaks the radius near the wrist.'],
  'hand-bones': ['Hand bones', 'Carpals, metacarpals and phalanges give the hand its strength and fine control.', 'Each hand has 27 bones, so your hands hold over a quarter of your skeleton.'],
  femur: ['Femur', 'The thigh bone, connecting hip to knee.', 'It is the longest and strongest bone in the body, about a quarter of your height.'],
  patella: ['Patella', 'The kneecap, which protects the knee and gives the quadriceps more leverage.', 'It is the largest sesamoid bone, a bone that grows inside a tendon.'],
  'tibia-fibula': ['Tibia & fibula', 'The shin bones; the thick tibia bears the weight, the thin fibula anchors muscles.', 'The tibia is the most common long bone to break.'],
  'foot-bones': ['Foot bones', 'Tarsals, metatarsals and phalanges form arches that spring with each step.', 'Each foot has 26 bones.'],
  lungs: ['Lungs', 'Exchange gases: oxygen enters the blood and carbon dioxide leaves through millions of tiny air sacs.', 'The right lung has three lobes, the left only two to make room for the heart.'],
  trachea: ['Trachea & bronchi', 'The windpipe carries air from the throat to the lungs, splitting into two bronchi.', 'It is held open by 16 to 20 C-shaped rings of cartilage.'],
  esophagus: ['Esophagus', 'A muscular tube about 25 cm long that pushes food from the throat to the stomach.', 'Waves of muscle contraction (peristalsis) move food along, even if you eat upside down.'],
  thyroid: ['Thyroid', 'A butterfly-shaped gland in the neck whose hormones set how fast the body burns energy.', 'It is one of the largest purely endocrine glands.'],
  heart: ['Heart', 'A four-chambered muscular pump that pushes blood through the lungs and the whole body.', 'It beats about 100,000 times a day and pumps around 7,000 litres of blood.'],
  liver: ['Liver', 'The largest internal organ: it processes nutrients, stores energy, makes bile and clears toxins.', 'It can regrow to full size after up to two thirds of it is removed.'],
  gallbladder: ['Gallbladder', 'A small sac under the liver that stores and concentrates bile to digest fats.', 'You can live a normal life without it; bile then flows straight from the liver.'],
  stomach: ['Stomach', 'A stretchy muscular bag that churns food with acid and enzymes.', 'Its acid is strong enough to dissolve metal, so its lining renews every few days.'],
  spleen: ['Spleen', 'Filters the blood, recycles old red blood cells and helps fight infection.', 'It stores a reserve of blood cells that can be released after an injury.'],
  pancreas: ['Pancreas', 'Releases digestive enzymes into the gut and insulin and glucagon into the blood.', 'The insulin-making cells sit in clusters called islets of Langerhans.'],
  kidneys: ['Kidneys & ureters', 'Filter the blood, balance salts and water, and send urine down the ureters to the bladder.', 'Together they filter about 180 litres of blood plasma every day.'],
  adrenal: ['Adrenal glands', 'Small glands on top of the kidneys that make adrenaline and cortisol.', 'Adrenaline can raise your heart rate within seconds of a scare.'],
  'large-intestine': ['Large intestine', 'Absorbs water and salts and forms waste; home to trillions of gut bacteria.', 'It is about 1.5 m long and wider than the small intestine, hence "large".'],
  'small-intestine': ['Small intestine', 'Where most digestion and absorption of nutrients happens.', 'It is about 6 m long, folded into the abdomen.'],
  bladder: ['Bladder', 'A stretchy muscular bag that stores urine.', 'It comfortably holds about 400 to 600 ml.'],
  eyes: ['Eyes', 'Focus light onto the retina, which turns it into nerve signals for the brain.', 'The eye can distinguish around a million different colours.'],
  aorta: ['Aorta', 'The body\'s largest artery, carrying oxygen-rich blood from the heart to everything else.', 'It is about 2.5 cm wide, roughly the size of a garden hose.'],
  carotid: ['Carotid arteries', 'Carry blood up the neck to the brain and face.', 'This is where you feel your pulse on the side of your neck.'],
  'arm-artery': ['Arm arteries', 'Subclavian, brachial, radial and ulnar arteries supply the shoulder, arm and hand.', 'The radial artery at the wrist is where doctors usually take your pulse.'],
  'leg-artery': ['Leg arteries', 'Iliac, femoral, popliteal and tibial arteries supply the legs and feet.', 'The femoral artery can be felt pulsing in the groin.'],
  'renal-vessels': ['Renal vessels', 'Short, wide vessels carrying blood to and from the kidneys.', 'About a fifth of every heartbeat\'s blood goes to the kidneys.'],
  mesenteric: ['Mesenteric arteries', 'Fan out through the gut to supply the intestines.', 'After a meal, blood flow to the gut can roughly double.'],
  'scalp-vessels': ['Scalp arteries', 'The superficial temporal artery and branches supply the scalp.', 'The scalp is so rich in blood vessels that even small cuts bleed a lot.'],
  arterioles: ['Small arteries', 'Branches that divide again and again into arterioles and capillaries.', 'Laid end to end, all your blood vessels would wrap around the Earth more than twice.'],
  'pulmonary-artery': ['Pulmonary arteries', 'Carry oxygen-poor blood from the heart to the lungs (drawn blue).', 'They are the only arteries in an adult that carry oxygen-poor blood.'],
  'pulmonary-veins': ['Pulmonary veins', 'Bring oxygen-rich blood back from the lungs to the heart (drawn red).', 'They are the only veins that carry oxygen-rich blood.'],
  'vena-cava': ['Venae cavae', 'The superior and inferior venae cavae return blood from the whole body to the heart.', 'The inferior vena cava is the largest vein in the body.'],
  jugular: ['Jugular veins', 'Drain blood from the head and brain back toward the heart.', 'Doctors look at the jugular vein in the neck to estimate pressure in the heart.'],
  'arm-vein': ['Arm veins', 'Return blood from the hand and arm; the ones near the surface are used for blood tests.', 'Veins have one-way valves so blood cannot pool when you lower your arms.'],
  'leg-vein': ['Leg veins', 'Femoral and saphenous veins return blood up the legs against gravity.', 'Calf muscles squeeze the veins like a pump each time you walk.'],
  venules: ['Small veins', 'Venules collect blood from the capillaries and merge into larger veins.', 'At any moment about 70% of your blood is in your veins.'],
  'renal-vein': ['Renal veins', 'Carry filtered blood from the kidneys back to the vena cava.', 'The left renal vein is longer than the right because the vena cava sits on the right.'],
  brain: ['Cerebrum', 'The thinking brain: senses, movement, language, memory and decisions, split into two hemispheres.', 'About 2% of body weight, it uses about 20% of the body\'s energy.'],
  cerebellum: ['Cerebellum', 'Coordinates movement, balance and timing.', 'It is only about 10% of the brain\'s volume yet holds most of its neurons.'],
  brainstem: ['Brainstem', 'Connects the brain to the spinal cord and runs breathing, heart rate and sleep.', 'Ten of the twelve cranial nerves start in the brainstem.'],
  'spinal-cord': ['Spinal cord', 'The main cable between brain and body, carrying signals both ways and running reflexes.', 'It ends around the first lumbar vertebra; below it a bundle of nerve roots called the cauda equina continues.'],
  'arm-nerves': ['Arm nerves', 'The brachial plexus splits into the median, ulnar and radial nerves that run the arm and hand.', 'Hitting your "funny bone" is really bumping the ulnar nerve.'],
  sciatic: ['Sciatic nerve', 'Runs from the lower back down the back of the leg, controlling the leg and foot.', 'It is the longest and thickest nerve in the body, about as wide as a finger.'],
  'femoral-nerve': ['Femoral nerve', 'Supplies the front of the thigh, letting you straighten your knee.', 'It is the nerve tested by the knee-jerk reflex.'],
  optic: ['Optic nerves', 'Carry visual signals from each eye to the brain, crossing at the optic chiasm.', 'Each one contains about 1.2 million nerve fibres.'],
  'cranial-nerves': ['Facial nerves', 'Branches of the trigeminal and facial nerves bring feeling and movement to the face.', 'The trigeminal nerve is what makes a toothache hurt so much.'],
  intercostal: ['Intercostal nerves', 'Run under each rib, controlling the breathing muscles between the ribs.', 'They are why shingles often appears as a band around one side of the chest.'],
};
