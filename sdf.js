// Signed-distance sculpting: shapes are blended with a smooth minimum on a voxel
// grid (like clay), then the zero surface is extracted with surface nets.
// Distances are in metres; negative values are inside the body.
import * as THREE from 'three';

function smin(a, b, k) {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

// ---------------------------------------------------------------- primitives
// Each returns { f(x, y, z) -> distance, lo, hi } where lo/hi bound the shape.

export function ellipsoid(c, r) {
  const ix = 1 / r.x, iy = 1 / r.y, iz = 1 / r.z, rMin = Math.min(r.x, r.y, r.z);
  return {
    lo: c.clone().sub(r), hi: c.clone().add(r),
    f(x, y, z) {
      // Inigo Quilez's ellipsoid bound: exact on the surface, good enough nearby.
      const ax = (x - c.x) * ix, ay = (y - c.y) * iy, az = (z - c.z) * iz;
      const k0 = Math.sqrt(ax * ax + ay * ay + az * az);
      const k1 = Math.sqrt(ax * ax * ix * ix + ay * ay * iy * iy + az * az * iz * iz);
      return k1 === 0 ? -rMin : (k0 * (k0 - 1)) / k1;
    },
  };
}

// A capsule whose radius changes linearly from ra at a to rb at b.
export function cone(a, b, ra, rb) {
  const bax = b.x - a.x, bay = b.y - a.y, baz = b.z - a.z;
  const l2 = bax * bax + bay * bay + baz * baz;
  const m = Math.max(ra, rb);
  return {
    lo: a.clone().min(b).subScalar(m), hi: a.clone().max(b).addScalar(m),
    f(x, y, z) {
      const pax = x - a.x, pay = y - a.y, paz = z - a.z;
      const h = Math.min(1, Math.max(0, (pax * bax + pay * bay + paz * baz) / l2));
      const ex = pax - bax * h, ey = pay - bay * h, ez = paz - baz * h;
      return Math.sqrt(ex * ex + ey * ey + ez * ez) - (ra + (rb - ra) * h);
    },
  };
}

// A surface of revolution around the y axis, squashed front-to-back by zs.
// prof: [[radius, y], ...] with y increasing, starting and ending on the axis (radius 0).
export function lathe(prof, zs) {
  const rMax = Math.max(...prof.map((p) => p[0]));
  const n = prof.length;
  const y0 = prof[0][1], y1 = prof[n - 1][1];
  // Index of the segment containing height y (binary search).
  const segAt = (y) => {
    let lo = 1, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (prof[mid][1] < y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const segDist = (i, r, y) => {
    const [ra, ya] = prof[i - 1], [rb, yb] = prof[i];
    const dr = rb - ra, dy = yb - ya;
    const t = Math.min(1, Math.max(0, ((r - ra) * dr + (y - ya) * dy) / (dr * dr + dy * dy)));
    const ex = r - ra - dr * t, ey = y - ya - dy * t;
    return Math.sqrt(ex * ex + ey * ey);
  };
  return {
    lo: new THREE.Vector3(-rMax, y0, -rMax * zs), hi: new THREE.Vector3(rMax, y1, rMax * zs),
    f(x, y, z) {
      // Distance to the profile in the (radius, y) plane, exact before the z squash; only segments whose
      // height range is closer than the best distance so far can be nearer.
      const zz = z / zs;
      const r = Math.sqrt(x * x + zz * zz);
      const yc = Math.min(Math.max(y, y0), y1);
      const s = segAt(yc);
      let best = segDist(s, r, y);
      for (let i = s - 1; i >= 1 && y - prof[i][1] < best; i--) best = Math.min(best, segDist(i, r, y));
      for (let i = s + 1; i < n && prof[i - 1][1] - y < best; i++) best = Math.min(best, segDist(i, r, y));
      const [ra, ya] = prof[s - 1], [rb, yb] = prof[s];
      const inside = y > y0 && y < y1 && r < ra + ((rb - ra) * (y - ya)) / (yb - ya);
      return inside ? -best : best;
    },
  };
}

// ---------------------------------------------------------------- grid

export class Field {
  constructor(lo, hi, h) {
    this.h = h;
    this.lo = lo.clone();
    this.nx = Math.ceil((hi.x - lo.x) / h) + 1;
    this.ny = Math.ceil((hi.y - lo.y) / h) + 1;
    this.nz = Math.ceil((hi.z - lo.z) / h) + 1;
    this.d = new Float32Array(this.nx * this.ny * this.nz).fill(1);
  }

  // Blend a shape in (union), or carve it out (subtract), with blend radius k.
  add(shape, k = 0, subtract = false) {
    const { h, lo, nx, ny, d } = this;
    const pad = k + 2 * h;
    const i0 = Math.max(0, Math.floor((shape.lo.x - pad - lo.x) / h)), i1 = Math.min(nx - 1, Math.ceil((shape.hi.x + pad - lo.x) / h));
    const j0 = Math.max(0, Math.floor((shape.lo.y - pad - lo.y) / h)), j1 = Math.min(ny - 1, Math.ceil((shape.hi.y + pad - lo.y) / h));
    const k0 = Math.max(0, Math.floor((shape.lo.z - pad - lo.z) / h)), k1 = Math.min(this.nz - 1, Math.ceil((shape.hi.z + pad - lo.z) / h));
    for (let kk = k0; kk <= k1; kk++) {
      const z = lo.z + kk * h;
      for (let j = j0; j <= j1; j++) {
        const y = lo.y + j * h;
        let idx = i0 + nx * (j + ny * kk);
        for (let i = i0; i <= i1; i++, idx++) {
          const s = shape.f(lo.x + i * h, y, z);
          d[idx] = subtract ? -smin(-d[idx], s, k) : smin(d[idx], s, k);
        }
      }
    }
  }

  // Trilinear distance at a point; 1 outside the grid.
  sample(x, y, z) {
    const { h, lo, nx, ny, nz, d } = this;
    const fx = (x - lo.x) / h, fy = (y - lo.y) / h, fz = (z - lo.z) / h;
    const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
    if (i < 0 || j < 0 || k < 0 || i >= nx - 1 || j >= ny - 1 || k >= nz - 1) return 1;
    const tx = fx - i, ty = fy - j, tz = fz - k;
    const a = i + nx * (j + ny * k), sy = nx, sz = nx * ny;
    const c00 = d[a] + (d[a + 1] - d[a]) * tx, c10 = d[a + sy] + (d[a + sy + 1] - d[a + sy]) * tx;
    const c01 = d[a + sz] + (d[a + sz + 1] - d[a + sz]) * tx, c11 = d[a + sy + sz] + (d[a + sy + sz + 1] - d[a + sy + sz]) * tx;
    const c0 = c00 + (c10 - c00) * ty, c1 = c01 + (c11 - c01) * ty;
    return c0 + (c1 - c0) * tz;
  }

  gradient(x, y, z, out = new THREE.Vector3()) {
    const e = this.h * 0.5;
    return out.set(
      this.sample(x + e, y, z) - this.sample(x - e, y, z),
      this.sample(x, y + e, z) - this.sample(x, y - e, z),
      this.sample(x, y, z + e) - this.sample(x, y, z - e),
    ).normalize();
  }

  // Distance from p to the surface (negative inside).
  at(p) {
    return this.sample(p.x, p.y, p.z);
  }

  // March from (x, y, +far) toward -z and return the first point on the surface.
  surfaceFromFront(x, y) {
    for (let z = 0.3; z > -0.3; z -= this.h * 0.25) {
      if (this.sample(x, y, z) <= 0) return new THREE.Vector3(x, y, z);
    }
    return null;
  }

  // Surface nets: one vertex per surface cell, one quad per sign-changing grid edge.
  mesh() {
    const { h, lo, nx, ny, nz, d } = this;
    const sy = nx, sz = nx * ny;
    const cell = new Int32Array(nx * ny * nz).fill(-1);
    const pos = [];
    const corner = [0, 1, sy, sy + 1, sz, sz + 1, sy + sz, sy + sz + 1];
    const cx = [0, 1, 0, 1, 0, 1, 0, 1], cy = [0, 0, 1, 1, 0, 0, 1, 1], cz = [0, 0, 0, 0, 1, 1, 1, 1];
    const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    const val = new Float32Array(8);
    for (let k = 0; k < nz - 1; k++) {
      for (let j = 0; j < ny - 1; j++) {
        for (let i = 0; i < nx - 1; i++) {
          const a = i + sy * j + sz * k;
          let mask = 0;
          for (let c = 0; c < 8; c++) {
            val[c] = d[a + corner[c]];
            if (val[c] < 0) mask |= 1 << c;
          }
          if (mask === 0 || mask === 255) continue;
          let px = 0, py = 0, pz = 0, n = 0;
          for (const [e0, e1] of edges) {
            if ((val[e0] < 0) === (val[e1] < 0)) continue;
            const t = val[e0] / (val[e0] - val[e1]);
            px += cx[e0] + (cx[e1] - cx[e0]) * t;
            py += cy[e0] + (cy[e1] - cy[e0]) * t;
            pz += cz[e0] + (cz[e1] - cz[e0]) * t;
            n++;
          }
          cell[a] = pos.length / 3;
          pos.push(lo.x + (i + px / n) * h, lo.y + (j + py / n) * h, lo.z + (k + pz / n) * h);
        }
      }
    }
    const index = [];
    const quad = (a, b, c, e, flip) => (flip ? index.push(a, c, b, a, e, c) : index.push(a, b, c, a, c, e));
    for (let k = 1; k < nz - 1; k++) {
      for (let j = 1; j < ny - 1; j++) {
        for (let i = 1; i < nx - 1; i++) {
          const a = i + sy * j + sz * k;
          if (cell[a] < 0) continue;
          const inside = d[a] < 0;
          // Each sign-changing edge leaving this grid point is shared by four cells.
          if (inside !== d[a + 1] < 0) quad(cell[a], cell[a - sy], cell[a - sy - sz], cell[a - sz], !inside);
          if (inside !== d[a + sy] < 0) quad(cell[a], cell[a - sz], cell[a - 1 - sz], cell[a - 1], !inside);
          if (inside !== d[a + sz] < 0) quad(cell[a], cell[a - 1], cell[a - 1 - sy], cell[a - sy], !inside);
        }
      }
    }
    // Snap vertices onto the true zero surface and take normals from the field gradient.
    const g = new THREE.Vector3();
    const nrm = new Float32Array(pos.length);
    for (let v = 0; v < pos.length; v += 3) {
      for (let it = 0; it < 2; it++) {
        const s = this.sample(pos[v], pos[v + 1], pos[v + 2]);
        this.gradient(pos[v], pos[v + 1], pos[v + 2], g);
        pos[v] -= g.x * s;
        pos[v + 1] -= g.y * s;
        pos[v + 2] -= g.z * s;
      }
      this.gradient(pos[v], pos[v + 1], pos[v + 2], g).toArray(nrm, v);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setIndex(index);
    return geo;
  }

  // Ambient occlusion per vertex: how much open space there is just above the surface.
  occlusion(geo) {
    const p = geo.attributes.position, n = geo.attributes.normal;
    const ao = new Float32Array(p.count);
    const steps = [0.008, 0.02, 0.04];
    for (let i = 0; i < p.count; i++) {
      let open = 0;
      for (const s of steps) {
        const d = this.sample(p.getX(i) + n.getX(i) * s, p.getY(i) + n.getY(i) * s, p.getZ(i) + n.getZ(i) * s);
        open += Math.min(1, Math.max(0, d / s));
      }
      ao[i] = open / steps.length;
    }
    return ao;
  }
}
