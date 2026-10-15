"""Convert BodyParts3D STL files into one compact GLB per anatomy layer.

Usage: python build_models.py <stl_dir> <named.tsv> <out_dir>

named.tsv lines: <FMA id>\t<english name>\t<bytes>. Each part is decimated to a
per-layer triangle budget, positions are quantized to int16 (KHR_mesh_quantization)
and every part becomes its own node, named by FMA id with its label in extras.
Also writes landmarks.json: bone axes and vessel end points used to route the
procedural limb vessels and nerves.

Source coordinates: millimetres, z up, the body faces -y, person's left is +x.
Output: metres, y up, the body faces +z, feet at y = 0.
"""
import json
import re
import struct
import sys
from pathlib import Path

import fast_simplification
import numpy as np

STL, NAMED, OUT = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
OUT.mkdir(parents=True, exist_ok=True)

names = {}
for line in NAMED.read_text(encoding='utf-8').splitlines():
    fid, name, _ = line.split('\t')
    names[fid] = name

Z0, Y0 = -13.5, -96.5  # skin min z and skin y-centre in source units


def to_out(p):
    p = np.asarray(p, dtype=np.float64)
    return np.stack([p[..., 0] / 1000, (p[..., 2] - Z0) / 1000, -(p[..., 1] - Y0) / 1000], axis=-1)


def load(fid):
    b = (STL / f'{fid}.stl').read_bytes()
    n = struct.unpack('<I', b[80:84])[0]
    d = np.frombuffer(b[84:84 + n * 50], dtype=np.dtype([('n', '<f4', 3), ('v', '<f4', (3, 3)), ('a', '<u2')]))
    tri = d['v'].reshape(-1, 3).astype(np.float64)
    verts, inv = np.unique(np.round(tri, 3), axis=0, return_inverse=True)
    faces = inv.reshape(-1, 3)
    faces = faces[(faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 0] != faces[:, 2])]
    return verts, faces


# ---------------------------------------------------------------- layer selection

R = lambda *words: re.compile('|'.join(words), re.I)
BRAIN = R(r'gyr', 'cerebell', 'cerebr', 'brain', 'thalam', 'pons', 'medulla oblongata', 'midbrain', 'callosum', 'ventricle',
          'putamen', 'pallid', 'caudate', 'amygdala', 'hippocamp', 'insula', 'fornix', 'pineal', 'pituitary', 'optic',
          'capsule', 'choroid', 'aqueduct', 'commissure', 'colliculus', 'geniculate', 'habenula', 'stria', 'lamina terminalis',
          'mammillary', 'tuber cinereum', 'septum pellucidum', 'interpeduncular', 'interventricular foramen', 'precuneus',
          'lobule', 'occipital lobe', 'white matter', 'hypothalamus', 'central canal')
VESSEL = R(r'arter', 'aorta', r'\bvein', 'vena cava', 'cardiac vein', 'coronary sinus')
ORGANS = {
    'FMA7197', 'FMA7148', 'FMA7196', 'FMA7198nsn', 'FMA7202', 'FMA7206', 'FMA7207', 'FMA7208', 'FMA14543nsn', 'FMA14544',
    'FMA14542', 'FMA7131', 'FMA7394', 'FMA7409', 'FMA7371', 'FMA7337', 'FMA7383', 'FMA7370', 'FMA7333', 'FMA7274',
    'FMA7205', 'FMA7204', 'FMA15630', 'FMA15629', 'FMA15572', 'FMA15571', 'FMA15900', 'FMA12513', 'FMA71195', 'FMA71194',
    'FMA7234', 'FMA7235', 'FMA7246', 'FMA10419',
}
SKIN = {'FMA7163', 'FMA70751', 'FMA71098'}
SKELETON = R(r'bone', 'vertebra', r'\brib\b', 'costal cartilage', 'sternum', 'manubrium', 'xiphoid', 'clavicle', 'scapula',
             'humerus', 'radius', 'ulna', 'scaphoid', 'lunate', 'triquetr', 'pisiform', 'trapezi', 'capitate', 'hamate',
             'metacarp', 'phalan', 'femur', 'patella', 'tibia', 'fibula', 'talus', 'calcane', 'navicular', 'cuboid',
             'cuneiform', 'metatars', 'sacrum', 'coccyx', 'mandible', 'maxilla', r'\batlas\b', r'\baxis\b', 'hyoid',
             'cartilage', 'sesamoid', 'intervertebral', 'tooth', 'gingiva', 'ethmoid', 'vomer', 'nasal concha')
SKIP = R('intercostal muscle', 'innermost', 'pubic hair', 'penis', 'testis', 'epididym', 'deferent', 'seminal', 'prostate',
         'urethra', 'taenia', 'mouth', r'\bear\b')


def layer_of(fid, name):
    if fid in SKIN:
        return 'skin'
    if fid in ORGANS:
        return 'organs'
    if fid == 'FMA9756':  # external intercostal muscle, keep one sheet
        return 'muscles'
    if SKIP.search(name):
        return None
    if BRAIN.search(name):
        return 'nerves'
    if VESSEL.search(name):
        return 'vessels'
    if SKELETON.search(name) and not R('muscle').search(name):
        return 'skeleton'
    return 'muscles'


BUDGET = {'skin': 150_000, 'muscles': 420_000, 'skeleton': 280_000, 'organs': 170_000, 'vessels': 70_000, 'nerves': 150_000}
BUDGET_OVERRIDE = {'FMA70751': 30_000, 'FMA71098': 1_500, 'FMA7274': 30_000}

parts = {}
for fid, name in names.items():
    if not (STL / f'{fid}.stl').exists():
        continue
    layer = layer_of(fid, name)
    if layer:
        parts.setdefault(layer, []).append(fid)

# ---------------------------------------------------------------- landmarks (source coords)

landmarks = {}


def by_name(pattern):
    rx = re.compile(pattern, re.I)
    hits = [f for f, n in names.items() if rx.fullmatch(n) and (STL / f'{f}.stl').exists()]
    assert len(hits) == 1, (pattern, hits)
    return hits[0]


def axis(fid):
    v, _ = load(fid)
    c = v.mean(0)
    _, _, vt = np.linalg.svd(v - c, full_matrices=False)
    d = vt[0]
    t = (v - c) @ d
    a = c + d * np.quantile(t, 0.02)
    b = c + d * np.quantile(t, 0.98)
    return (a, b) if a[2] > b[2] else (b, a)  # (proximal/upper, distal/lower)


def put(key, pts):
    landmarks[key] = np.round(to_out(np.asarray(pts)), 5).tolist()


for side, S in (('left', 1), ('right', -1)):
    for bone in ('humerus', 'radius', 'ulna', 'femur', 'tibia', 'fibula'):
        put(f'{bone}_{side}', axis(by_name(f'{side} {bone}')))
    for k, finger in enumerate(('thumb', 'index finger', 'middle finger', 'ring finger', 'little finger')):
        prox = load(by_name(f'proximal phalanx of {side} {finger}'))[0].mean(0)
        dist = load(by_name(f'distal phalanx of {side} {finger}'))[0].mean(0)
        put(f'finger{k}_{side}', [prox, dist])
    for k, toe in enumerate(('big toe', 'second toe', 'third toe', 'fourth toe', 'little toe')):
        prox = load(by_name(f'proximal phalanx of {side} {toe}'))[0].mean(0)
        dist = load(by_name(f'distal phalanx of {side} {toe}'))[0].mean(0)
        put(f'toe{k}_{side}', [prox, dist])
    put(f'metacarpal_{side}', [load(by_name(f'{side} third metacarpal bone'))[0].mean(0)])
    put(f'metatarsal_{side}', [load(by_name(f'{side} second metatarsal bone'))[0].mean(0)])
    put(f'calcaneus_{side}', [load(by_name(f'{side} calcaneus'))[0].mean(0)])
    put(f'hip_{side}', [load(by_name(f'{side} hip bone'))[0].mean(0)])
    for vessel in ('subclavian artery', 'subclavian vein'):
        v = load(by_name(f'{side} {vessel}'))[0]
        put(f'{vessel.replace(" ", "_")}_{side}', [v[np.argmax(v[:, 0] * S)]])
    for vessel in ('external iliac artery', 'external iliac vein'):
        v = load(by_name(f'{side} {vessel}'))[0]
        put(f'{vessel.replace(" ", "_")}_{side}', [v[np.argmin(v[:, 2])]])

# The spinal cord runs through the vertebral canal, approximated by vertebra centroids (top to bottom).
ORD = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth']
vert = ['atlas', 'axis'] + [f'{o} cervical vertebra' for o in ORD[2:7]] + [f'{o} thoracic vertebra' for o in ORD] + [f'{o} lumbar vertebra' for o in ORD[:5]]
put('spine', [load(by_name(n))[0].mean(0) for n in vert])
put('sacrum', [load(by_name('sacrum'))[0].mean(0)])

# ---------------------------------------------------------------- GLB writing


def write_glb(path, items):
    """items: list of (fid, label, verts_out(n,3) metres, faces)."""
    allv = np.concatenate([it[2] for it in items])
    lo, hi = allv.min(0), allv.max(0)
    centre = (lo + hi) / 2
    scale = np.maximum((hi - lo) / 2, 1e-6) / 32767
    blob = bytearray()
    views, accessors, meshes, nodes = [], [], [], []

    def add_view(data, target):
        while len(blob) % 4:
            blob.append(0)
        views.append({'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(data), 'target': target})
        if target == 34962:
            views[-1]['byteStride'] = 8
        blob.extend(data)
        return len(views) - 1

    for fid, label, v, f in items:
        q = np.round((v - centre) / scale).astype(np.int16)
        q4 = np.zeros((len(q), 4), np.int16)
        q4[:, :3] = q
        pv = add_view(q4.tobytes(), 34962)
        accessors.append({'bufferView': pv, 'componentType': 5122, 'count': len(q), 'type': 'VEC3',
                          'min': q.min(0).tolist(), 'max': q.max(0).tolist()})
        pa = len(accessors) - 1
        big = len(v) > 65535
        idx = f.astype(np.uint32 if big else np.uint16).ravel()
        iv = add_view(idx.tobytes(), 34963)
        accessors.append({'bufferView': iv, 'componentType': 5125 if big else 5123, 'count': len(idx), 'type': 'SCALAR'})
        meshes.append({'primitives': [{'attributes': {'POSITION': pa}, 'indices': len(accessors) - 1}]})
        nodes.append({'name': fid, 'mesh': len(meshes) - 1, 'translation': centre.tolist(), 'scale': scale.tolist(),
                      'extras': {'label': label}})

    while len(blob) % 4:
        blob.append(0)
    gltf = {
        'asset': {'version': '2.0', 'generator': 'anatomy-explorer build_models.py',
                  'copyright': 'BodyParts3D, (c) The Database Center for Life Science, CC BY-SA 2.1 JP'},
        'extensionsUsed': ['KHR_mesh_quantization'], 'extensionsRequired': ['KHR_mesh_quantization'],
        'scene': 0, 'scenes': [{'nodes': list(range(len(nodes)))}], 'nodes': nodes, 'meshes': meshes,
        'accessors': accessors, 'bufferViews': views, 'buffers': [{'byteLength': len(blob)}],
    }
    js = json.dumps(gltf, separators=(',', ':')).encode()
    js += b' ' * (-len(js) % 4)
    out = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(blob))
    out += struct.pack('<I4s', len(js), b'JSON') + js + struct.pack('<I4s', len(blob), b'BIN\0') + bytes(blob)
    path.write_bytes(out)


for layer, fids in ([] if '--landmarks-only' in sys.argv else parts.items()):
    ntri = {fid: ((STL / f'{fid}.stl').stat().st_size - 84) // 50 for fid in fids}
    ratio = BUDGET[layer] / sum(ntri.values())
    items = []
    for fid in fids:
        v, f = load(fid)
        target = BUDGET_OVERRIDE.get(fid, max(150, int(ntri[fid] * ratio)))
        if len(f) > target * 1.05:
            v, f = fast_simplification.simplify(v.astype(np.float32), f.astype(np.int64), 1 - target / len(f))
        if len(f) == 0:
            continue
        items.append((fid, names[fid], to_out(v).astype(np.float64), np.asarray(f)))
    write_glb(OUT / f'{layer}.glb', items)
    tris = sum(len(it[3]) for it in items)
    print(f'{layer:9s} parts={len(items):4d} tris={tris:7d} size={(OUT / f"{layer}.glb").stat().st_size / 1e6:.1f}MB')

(OUT / 'landmarks.json').write_text(json.dumps(landmarks, separators=(',', ':')))
print('landmarks', len(landmarks))
