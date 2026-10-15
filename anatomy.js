// Loads the real anatomy meshes (BodyParts3D, see tools/build_models.py) and adds
// procedural limb vessels, nerves and the spinal cord routed along the real bones.
// Units are metres: feet at y = 0, the body faces +z, person's left is +x.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const v = (x, y, z) => new THREE.Vector3(x, y, z);

export const LAYERS = [
  { id: 'skin', name: 'Skin', color: '#e7b08f', blurb: 'Skin and hair' },
  { id: 'muscles', name: 'Muscles', color: '#c8463e', blurb: 'Skeletal muscles and tendons' },
  { id: 'skeleton', name: 'Skeleton', color: '#eee3c7', blurb: 'Bones, cartilage and teeth' },
  { id: 'organs', name: 'Organs', color: '#d9827c', blurb: 'Chest and abdominal organs' },
  { id: 'vessels', name: 'Blood vessels', color: '#e0383e', blurb: 'Arteries (red) and veins (blue)' },
  { id: 'nerves', name: 'Nervous system', color: '#f2cf5b', blurb: 'Brain, spinal cord and nerves' },
];

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- colours per structure

const COLOR_RULES = {
  skin: [[/hair|eyebrow/, '#2a1c14'], [/./, '#dca283']],
  muscles: [[/tendon|aponeurosis|ligament|tract|fascia|retinaculum|linea alba/, '#e6d8c3'], [/./, '#a8322c']],
  skeleton: [[/tooth/, '#f7f3e6'], [/gingiva/, '#d07a78'], [/intervertebral|cartilage/, '#b9d2d0'], [/./, '#e9dcc0']],
  organs: [
    [/lung/, '#e8939a'], [/trachea|bronch/, '#e3c8bd'], [/esophagus/, '#c9786d'], [/wall of heart/, '#a3222c'], [/valve/, '#e8cfc0'],
    [/liver/, '#7a2a20'], [/gallbladder/, '#5c8a3a'], [/stomach/, '#d98a83'], [/spleen/, '#6e2b4d'], [/pancrea/, '#e5bb74'],
    [/adrenal/, '#e6b84a'], [/kidney/, '#8a3232'], [/ureter/, '#e8d39a'], [/colon|rectum|appendix/, '#c47f6b'],
    [/duodenum|jejunum|ileum/, '#e8a090'], [/bladder/, '#d9b65e'], [/eyeball/, '#f1ede6'], [/thymus/, '#e2b9a2'], [/./, '#d9827c'],
  ],
  vessels: [[/pulmonary artery/, '#3557c9'], [/pulmonary vein/, '#c8202a'], [/vein|vena|sinus/, '#3557c9'], [/./, '#c8202a']],
  nerves: [
    [/ventricle|aqueduct|choroid|interventricular|central canal/, '#6aa6d8'], [/white matter|callosum|capsule|fornix|commissure/, '#efe4da'],
    [/cerebell/, '#d6969a'], [/pons|medulla|midbrain|peduncle|colliculus/, '#dcb2a6'], [/optic/, '#f0cc5a'],
    [/thalam|putamen|pallid|caudate|amygdala|hippocamp|geniculate|habenula|mammillary|hypothalamus|stria/, '#c4877f'],
    [/pituitary|pineal/, '#c7856c'], [/./, '#dda4a6'],
  ],
};

function colorFor(layerId, label) {
  const l = label.toLowerCase();
  const hex = COLOR_RULES[layerId].find(([rx]) => rx.test(l))[1];
  const c = new THREE.Color(hex);
  // A little variation so neighbouring structures read as separate pieces.
  let h = 0;
  for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) | 0;
  const jitter = layerId === 'skin' ? 0 : ((h & 0xff) / 255 - 0.5) * 0.12;
  c.offsetHSL(0, 0, jitter);
  return c;
}

// ---------------------------------------------------------------- materials

function makeMaterial(layerId) {
  const base = { transparent: true, side: THREE.DoubleSide, vertexColors: true };
  switch (layerId) {
    case 'skin':
      return new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.52, sheen: 0.7, sheenColor: '#ffc7a8', sheenRoughness: 0.45, clearcoat: 0.12, clearcoatRoughness: 0.6 });
    case 'muscles':
      return new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.42, clearcoat: 0.35, clearcoatRoughness: 0.35, sheen: 0.35, sheenColor: '#ff9a8a' });
    case 'skeleton':
      return new THREE.MeshStandardMaterial({ ...base, roughness: 0.62, metalness: 0 });
    case 'organs':
      return new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.38, clearcoat: 0.6, clearcoatRoughness: 0.25 });
    case 'vessels':
      return new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.3, clearcoat: 0.5, clearcoatRoughness: 0.2 });
    default:
      return new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.5, clearcoat: 0.3, clearcoatRoughness: 0.4, sheen: 0.4, sheenColor: '#ffd9d9' });
  }
}

function flowTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 4;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 256, 0);
  grad.addColorStop(0, '#000');
  grad.addColorStop(0.55, '#000');
  grad.addColorStop(0.8, '#fff');
  grad.addColorStop(0.86, '#fff');
  grad.addColorStop(1, '#000');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// ---------------------------------------------------------------- merged real meshes

// Merge every part of a layer bucket into one mesh, remembering which triangles
// and vertices belong to which structure so picking and highlighting still work.
function mergeParts(parts, layerId, material) {
  const geos = [];
  const ranges = [];
  let tri = 0, vert = 0;
  for (const p of parts) {
    const g = p.geo;
    const n = g.attributes.position.count;
    const t = g.index.count / 3;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) p.color.toArray(col, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geos.push(g);
    ranges.push({ key: p.fid, label: p.label, triStart: tri, vStart: vert, vCount: n });
    tri += t;
    vert += n;
  }
  const merged = mergeGeometries(geos);
  merged.computeBoundingSphere();
  merged.userData.baseColors = merged.attributes.color.array.slice();
  const mesh = new THREE.Mesh(merged, material);
  mesh.userData.ranges = ranges;
  return mesh;
}

function partGeometry(node) {
  node.updateWorldMatrix(true, false);
  const src = node.geometry;
  const q = src.attributes.position;
  const pos = new Float32Array(q.count * 3);
  for (let i = 0; i < q.count; i++) {
    pos[i * 3] = q.getX(i);
    pos[i * 3 + 1] = q.getY(i);
    pos[i * 3 + 2] = q.getZ(i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(src.index.array), 1));
  g.applyMatrix4(node.matrixWorld);
  g.computeVertexNormals();
  return g;
}

// Parts that animate get their own mesh, pivoting around their own centre.
const DYNAMIC = { organs: [[/wall of heart|valve/, 'heart'], [/lobe of .* lung/, 'lungs']] };

function buildRealLayer(L, gltf) {
  const buckets = new Map();
  gltf.scene.traverse((node) => {
    if (!node.isMesh) return;
    const label = node.userData.label ?? node.name;
    const bucket = (DYNAMIC[L.id] ?? []).find(([rx]) => rx.test(label.toLowerCase()))?.[1] ?? 'static';
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push({ fid: node.name, label, geo: partGeometry(node), color: colorFor(L.id, label) });
  });
  const dynamic = {};
  for (const [bucket, parts] of buckets) {
    const mesh = mergeParts(parts, L.id, L.material);
    if (bucket !== 'static') {
      const c = mesh.geometry.boundingSphere.center.clone();
      mesh.geometry.translate(-c.x, -c.y, -c.z);
      mesh.geometry.computeBoundingSphere();
      mesh.position.copy(c);
      dynamic[bucket] = mesh;
    }
    L.group.add(mesh);
  }
  return dynamic;
}

// ---------------------------------------------------------------- procedural tubes

function tubeGeo(pts, r, { radial = 10, rFn = null, flow = 0 } = {}) {
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const len = curve.getLength();
  const n = Math.max(12, Math.ceil(len * 220));
  const geo = new THREE.TubeGeometry(curve, n, r, radial, false);
  if (rFn) {
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

// Collects tubes per part, then merges each part into one mesh with its own material.
function tubeSet(L, makeMat, seed) {
  const parts = new Map();
  const R = rng(seed);
  const set = {
    tube(part, pts, r, opts) {
      if (!parts.has(part)) parts.set(part, []);
      parts.get(part).push(tubeGeo(pts, r, opts));
    },
    twigs(part, pts, count, { len = 0.03, r = 0.0016, flow = 0 } = {}) {
      const curve = new THREE.CatmullRomCurve3(pts);
      for (let i = 0; i < count; i++) {
        const t = 0.1 + 0.85 * R();
        const p = curve.getPointAt(t);
        const dir = curve.getTangentAt(t).multiplyScalar(R() > 0.3 ? 0.8 : -0.5)
          .add(v(R() - 0.5, R() - 0.5, R() - 0.5).multiplyScalar(0.7)).normalize();
        const l = len * (0.6 + R() * 0.8);
        const mid = p.clone().addScaledVector(dir, l * 0.5).add(v(R() - 0.5, R() - 0.5, R() - 0.5).multiplyScalar(0.008));
        set.tube(part, [p, mid, p.clone().addScaledVector(dir, l)], r, { radial: 5, rFn: (k) => 1 - 0.6 * k, flow });
      }
    },
    finish() {
      for (const [part, geos] of parts) {
        const mesh = new THREE.Mesh(mergeGeometries(geos), makeMat(part));
        mesh.userData.part = part;
        mesh.geometry.computeBoundingSphere();
        L.group.add(mesh);
        L.extraMaterials.push(mesh.material);
      }
    },
  };
  return set;
}

function buildNetworks(vessels, nerves, LM, textures) {
  const P = (k, i = 0) => v(...LM[k][i]);
  const lerp = (a, b, t) => a.clone().lerp(b, t);
  const FLOW = 14;
  const base = { transparent: true, side: THREE.DoubleSide };
  const vesselMat = (part) => {
    const artery = /artery|arteriole/.test(part);
    return new THREE.MeshPhysicalMaterial({
      ...base, roughness: 0.3, clearcoat: 0.5, color: artery ? '#c8202a' : '#3557c9',
      emissive: artery ? '#ff5a4a' : '#5a86ff', emissiveIntensity: 0.8, emissiveMap: artery ? textures.flowA : textures.flowV,
    });
  };
  const nerveMat = () => new THREE.MeshStandardMaterial({ ...base, color: '#f0cc5a', emissive: '#a07a10', emissiveIntensity: 0.35, roughness: 0.45 });
  const V = tubeSet(vessels, vesselMat, 11);
  const N = tubeSet(nerves, nerveMat, 5);
  const A = (part, pts, r, taper = 0.5) => V.tube(part, pts, r, { flow: FLOW, rFn: (t) => 1 - taper * t });
  const NV = (part, pts, r, taper = 0.5) => N.tube(part, pts, r, { radial: 8, rFn: (t) => 1 - taper * t });

  // Spinal cord through the vertebral canal, then the cauda equina fanning down to the sacrum.
  const canal = LM.spine.map((p) => v(...p).add(v(0, 0, -0.012)));
  NV('spinal-cord', canal.slice(0, 20), 0.0058, 0.35);
  const conus = canal[19];
  const sacrum = P('sacrum');
  for (let i = 0; i < 7; i++) {
    const dx = (i - 3) * 0.004;
    NV('spinal-cord', [conus, lerp(conus, sacrum, 0.5).add(v(dx, 0, -0.012)), sacrum.clone().add(v(dx * 2.2, -0.02, -0.01))], 0.0016, 0.3);
  }
  const cordAt = (y) => canal.reduce((best, p) => (Math.abs(p.y - y) < Math.abs(best.y - y) ? p : best));

  for (const [side, s] of [['left', 1], ['right', -1]]) {
    const med = v(-s, 0, 0), lat = v(s, 0, 0), ant = v(0, 0, 1), post = v(0, 0, -1), up = v(0, 1, 0);
    const at = (p, ...offs) => offs.reduce((q, [dir, d]) => q.addScaledVector(dir, d), p.clone());
    const [humP, humD] = [P(`humerus_${side}`, 0), P(`humerus_${side}`, 1)];
    const [radP, radD] = [P(`radius_${side}`, 0), P(`radius_${side}`, 1)];
    const [ulnP, ulnD] = [P(`ulna_${side}`, 0), P(`ulna_${side}`, 1)];
    const [femP, femD] = [P(`femur_${side}`, 0), P(`femur_${side}`, 1)];
    const [tibP, tibD] = [P(`tibia_${side}`, 0), P(`tibia_${side}`, 1)];
    const [fibP, fibD] = [P(`fibula_${side}`, 0), P(`fibula_${side}`, 1)];
    const hum = (t) => lerp(humP, humD, t), rad = (t) => lerp(radP, radD, t), uln = (t) => lerp(ulnP, ulnD, t);
    const fem = (t) => lerp(femP, femD, t), tib = (t) => lerp(tibP, tibD, t), fib = (t) => lerp(fibP, fibD, t);
    const palm = at(P(`metacarpal_${side}`), [ant, 0.004]);
    const foot = at(P(`metatarsal_${side}`), [up, 0.012]);
    const heel = P(`calcaneus_${side}`);
    const fingers = [0, 1, 2, 3, 4].map((k) => [P(`finger${k}_${side}`, 0), P(`finger${k}_${side}`, 1)]);
    const toes = [0, 1, 2, 3, 4].map((k) => [P(`toe${k}_${side}`, 0), P(`toe${k}_${side}`, 1)]);

    // Arm arteries: axillary -> brachial -> radial & ulnar -> palm -> fingers
    const elbow = at(humD, [ant, 0.016], [med, 0.006]);
    const brachial = [P(`subclavian_artery_${side}`), at(hum(0.08), [med, 0.024], [ant, 0.006]), at(hum(0.5), [med, 0.016], [ant, 0.008]), elbow];
    A('arm-artery', brachial, 0.0042, 0.25);
    const radial = [elbow, at(rad(0.3), [ant, 0.01]), at(rad(0.95), [ant, 0.007]), palm];
    const ulnar = [elbow, at(uln(0.3), [ant, 0.012]), at(uln(0.95), [ant, 0.008]), palm];
    A('arm-artery', radial, 0.0032);
    A('arm-artery', ulnar, 0.0032);
    for (const [prox, dist] of fingers) A('arm-artery', [palm, at(prox, [ant, 0.004]), at(dist, [ant, 0.003])], 0.0014, 0.4);
    V.twigs('arterioles', [...brachial, ...radial.slice(1)], 10, { flow: FLOW });

    // Arm veins: deep veins beside the arteries, superficial cephalic and basilic veins
    A('arm-vein', [P(`subclavian_vein_${side}`), ...brachial.slice(1).map((p) => at(p, [lat, 0.006], [post, 0.004]))], 0.0045, 0.3);
    A('arm-vein', [at(hum(0.12), [lat, 0.02], [ant, 0.018]), at(hum(0.6), [lat, 0.022], [ant, 0.01]), at(humD, [lat, 0.022], [ant, 0.02]),
      at(rad(0.5), [lat, 0.012], [ant, 0.014]), at(radD, [lat, 0.01], [ant, 0.01]), at(palm, [post, 0.012])], 0.0032, 0.3);
    A('arm-vein', [at(hum(0.45), [med, 0.024], [post, 0.004]), at(humD, [med, 0.026], [ant, 0.012]), at(uln(0.5), [med, 0.008], [ant, 0.014]),
      at(ulnD, [ant, 0.01]), at(palm, [post, 0.012], [med, 0.004])], 0.003, 0.3);
    for (const [prox, dist] of fingers) A('arm-vein', [at(palm, [post, 0.012]), at(prox, [post, 0.005]), at(dist, [post, 0.004])], 0.0012, 0.4);

    // Leg arteries: femoral -> popliteal -> anterior/posterior tibial -> foot
    const knee = at(femD, [post, 0.026]);
    const legSplit = at(tib(0.1), [post, 0.022]);
    const femoral = [P(`external_iliac_artery_${side}`), at(fem(0.1), [med, 0.018], [ant, 0.03]), at(fem(0.45), [med, 0.02], [ant, 0.012]),
      at(fem(0.8), [med, 0.012], [post, 0.012]), knee, legSplit];
    A('leg-artery', femoral, 0.0055, 0.3);
    const antTibial = [legSplit, lerp(tib(0.2), fib(0.2), 0.5), at(lerp(tib(0.6), fib(0.6), 0.5), [ant, 0.008]), at(tibD, [ant, 0.022], [lat, 0.008]), foot];
    const postTibial = [legSplit, at(tib(0.5), [post, 0.022]), at(tibD, [post, 0.016], [med, 0.012]), at(heel, [med, 0.016], [ant, 0.02])];
    A('leg-artery', antTibial, 0.0035);
    A('leg-artery', postTibial, 0.0035);
    for (const [prox, dist] of toes) A('leg-artery', [foot, at(prox, [up, 0.006]), at(dist, [up, 0.004])], 0.0013, 0.4);
    V.twigs('arterioles', [...femoral, ...antTibial.slice(1)], 16, { flow: FLOW, len: 0.035 });

    // Leg veins: femoral vein beside the artery, great saphenous vein along the inner leg
    A('leg-vein', [P(`external_iliac_vein_${side}`), ...femoral.slice(1).map((p) => at(p, [med, 0.01], [post, 0.003]))], 0.006, 0.4);
    const saphenous = [at(fem(0.08), [med, 0.026], [ant, 0.03]), at(fem(0.5), [med, 0.034], [ant, 0.005]), at(femD, [med, 0.032], [post, 0.008]),
      at(tib(0.4), [med, 0.02]), at(tibD, [med, 0.014], [ant, 0.012]), at(foot, [med, 0.014])];
    A('leg-vein', saphenous, 0.0035, 0.3);
    for (const [prox, dist] of toes) A('leg-vein', [at(foot, [med, 0.01]), at(prox, [up, 0.008], [lat, 0.003]), at(dist, [up, 0.006])], 0.0012, 0.4);
    V.twigs('venules', saphenous.slice(0, 3), 6, { flow: FLOW, len: 0.02 });

    // Arm nerves: brachial plexus -> median, ulnar and radial nerves
    const plexus = [cordAt(humP.y + 0.08), at(P(`subclavian_artery_${side}`), [up, 0.012], [post, 0.006]), at(hum(0.06), [med, 0.02], [post, 0.004])];
    NV('arm-nerves', plexus, 0.004, 0.3);
    const fork = plexus[2];
    const median = [fork, at(hum(0.5), [med, 0.02], [ant, 0.004]), at(humD, [ant, 0.014], [med, 0.012]), at(lerp(rad(0.5), uln(0.5), 0.5), [ant, 0.012]), palm];
    const ulnarN = [fork, at(hum(0.5), [med, 0.024], [post, 0.01]), at(humD, [med, 0.03], [post, 0.012]), at(uln(0.5), [ant, 0.012], [med, 0.004]), at(ulnD, [ant, 0.008])];
    const radialN = [fork, at(hum(0.35), [post, 0.02]), at(hum(0.7), [lat, 0.016], [post, 0.01]), at(humD, [lat, 0.02], [ant, 0.008]), at(rad(0.5), [lat, 0.007]), at(radD, [lat, 0.009])];
    NV('arm-nerves', median, 0.0028, 0.3);
    NV('arm-nerves', ulnarN, 0.0024, 0.3);
    NV('arm-nerves', radialN, 0.0024, 0.3);
    fingers.forEach(([prox, dist], k) => {
      const from = k === 0 ? radialN.at(-1) : k >= 3 ? ulnarN.at(-1) : palm;
      NV('arm-nerves', [from, at(prox, [ant, 0.002], [lat, 0.002]), at(dist, [ant, 0.002])], 0.0011, 0.3);
    });
    N.twigs('arm-nerves', median.slice(1), 6);

    // Leg nerves: sciatic -> tibial & common peroneal; femoral nerve on the front of the thigh
    const lumbar = conus;
    const sciatic = [lerp(lumbar, sacrum, 0.6).addScaledVector(lat, 0.02), at(P(`hip_${side}`), [post, 0.045]), at(fem(0.15), [post, 0.035], [med, 0.012]),
      at(fem(0.5), [post, 0.03]), at(femD, [post, 0.032]), at(tib(0.08), [post, 0.028])];
    NV('sciatic', sciatic, 0.0048, 0.35);
    const tibial = [sciatic.at(-1), at(tib(0.5), [post, 0.026]), at(tibD, [post, 0.016], [med, 0.014]), at(heel, [med, 0.018], [ant, 0.025]), foot];
    const peroneal = [sciatic.at(-1), at(fibP, [lat, 0.008], [post, 0.004]), at(fib(0.4), [ant, 0.012]), at(tibD, [ant, 0.024]), foot];
    NV('sciatic', tibial, 0.003, 0.4);
    NV('sciatic', peroneal, 0.0024, 0.4);
    for (const [prox, dist] of toes) NV('sciatic', [foot, at(prox, [up, 0.004], [med, 0.003]), at(dist, [up, 0.003])], 0.001, 0.3);
    N.twigs('sciatic', [...sciatic.slice(2), ...tibial.slice(1, 3)], 10, { len: 0.04 });
    const femoralN = [cordAt(lumbar.y + 0.06), at(P(`hip_${side}`), [ant, 0.03], [med, 0.01]), at(P(`external_iliac_artery_${side}`), [lat, 0.014]),
      at(fem(0.15), [ant, 0.034], [lat, 0.004]), at(fem(0.4), [ant, 0.03])];
    NV('femoral-nerve', femoralN, 0.0032, 0.4);
    N.twigs('femoral-nerve', femoralN.slice(2), 6, { len: 0.045 });
  }
  V.finish();
  N.finish();
}

// ---------------------------------------------------------------- entry

export async function loadBody(base, onProgress) {
  const textures = { flowA: flowTexture(), flowV: flowTexture() };
  const loader = new GLTFLoader();
  const loaded = new Array(LAYERS.length).fill(0);
  const totals = new Array(LAYERS.length).fill(1);
  const report = () => onProgress?.(loaded.reduce((a, b) => a + b, 0) / totals.reduce((a, b) => a + b, 0));
  const [landmarks, ...gltfs] = await Promise.all([
    fetch(`${base}/landmarks.json`).then((r) => r.json()),
    ...LAYERS.map((meta, i) => loader.loadAsync(`${base}/${meta.id}.glb`, (e) => {
      loaded[i] = e.loaded;
      if (e.total) totals[i] = e.total;
      report();
    })),
  ]);

  const root = new THREE.Group();
  const anim = { heart: null, lungs: null, textures };
  const layers = LAYERS.map((meta, i) => {
    const L = { ...meta, group: new THREE.Group(), extraMaterials: [] };
    L.group.name = meta.id;
    L.material = makeMaterial(meta.id);
    const dyn = buildRealLayer(L, gltfs[i]);
    if (dyn.heart) anim.heart = dyn.heart;
    if (dyn.lungs) anim.lungs = dyn.lungs;
    root.add(L.group);
    return L;
  });
  buildNetworks(layers[4], layers[5], landmarks, textures);
  for (const L of layers) L.materials = [L.material, ...L.extraMaterials];
  return { root, layers, anim };
}

// Resolve a raycast hit to a structure: { key, label, mesh, range? }.
export function partOfHit(hit) {
  const o = hit.object;
  const ranges = o.userData.ranges;
  if (!ranges) return o.userData.part ? { key: o.userData.part, label: null, mesh: o } : null;
  let lo = 0, hi = ranges.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ranges[mid].triStart <= hit.faceIndex) lo = mid;
    else hi = mid - 1;
  }
  return { key: ranges[lo].key, label: ranges[lo].label, mesh: o, range: ranges[lo] };
}

// Tint one structure: level 0 = normal, 1 = hover, 2 = selected.
const HI = [null, new THREE.Color('#9fd0ff'), new THREE.Color('#7fe8ff')];
export function tintPart(part, level) {
  if (!part) return;
  if (part.range) {
    const g = part.mesh.geometry;
    const col = g.attributes.color;
    const base = g.userData.baseColors;
    const { vStart, vCount } = part.range;
    const c = new THREE.Color();
    for (let i = vStart; i < vStart + vCount; i++) {
      c.fromArray(base, i * 3);
      if (level) c.lerp(HI[level], level === 2 ? 0.45 : 0.35);
      c.toArray(col.array, i * 3);
    }
    col.needsUpdate = true;
  } else {
    const m = part.mesh.material;
    m.userData.baseColor ??= m.color.clone();
    m.color.copy(m.userData.baseColor);
    if (level) m.color.lerp(HI[level], 0.4);
  }
}

// World-space bounding box of one structure.
export function partBox(part) {
  const box = new THREE.Box3();
  part.mesh.updateWorldMatrix(true, false);
  if (part.range) {
    const pos = part.mesh.geometry.attributes.position;
    const p = new THREE.Vector3();
    for (let i = part.range.vStart; i < part.range.vStart + part.range.vCount; i += 3) {
      box.expandByPoint(p.fromBufferAttribute(pos, i).applyMatrix4(part.mesh.matrixWorld));
    }
  } else {
    box.expandByObject(part.mesh);
  }
  return box;
}
