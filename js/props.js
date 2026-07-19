// props.js — deterministic rigid-body props for the sandbox.
//
// Each prop build returns { group, bodies } where bodies is a stable-ordered
// list of { node, fixed, mass, friction, restitution, shapes }. Shapes are
// explicit collider recipes (never parsed from geometry) so the physics side
// stays deterministic and trivially reproducible. All local coordinates are in
// prop space: forward = +X, ground = y 0, same convention as vehicles.
import * as THREE from 'three';
import { matFactory, slab, box, cyl, faceQuad, subQuad, quadPrism } from './lib.js';

export const PROPS = [
  { id: 'ramp', label: 'Ramp', icon: '⤴' },
  { id: 'barrier', label: 'Barrier', icon: '🧱' },
  { id: 'boxes', label: 'Box stack', icon: '📦' },
  { id: 'pole', label: 'Pole', icon: '💡' },
];

export const isProp = (kind) => PROPS.some((p) => p.id === kind);

/* ramp: 6 m wedge, slope on the -X side — drive in +X and launch at ~1.5 m.
   Fixed body, single convex hull matching the visual wedge exactly. */
function ramp(M) {
  const g = new THREE.Group();
  const concrete = M('#8e9096', { rough: 0.9 });
  const wedge = slab(concrete, { x0: -3, x1: 3, y0: 0, y1: 1.52, w: 3.4, tail: 5.68 });
  g.add(wedge);
  // painted chevron stripes flush on the slope (the 'rear' face of the slab)
  const stripe = M('#e3c53a', { rough: 0.72 });
  const q = faceQuad(wedge.userData.pt, 'rear');
  for (const [f0, f1] of [[0.06, 0.18], [0.44, 0.56], [0.82, 0.94]]) {
    g.add(quadPrism(subQuad(q, f0, f1, 0.03, 0.97), 0.015, stripe));
  }
  // edge stripes along the top lip
  const lip = box(M('#d24a35', { rough: 0.7 }), 0.34, 0.06, 3.44);
  lip.position.set(2.85, 1.55, 0);
  g.add(lip);
  const hull = new Float32Array([
    -3, 0, -1.7, 3, 0, -1.7, 3, 0, 1.7, -3, 0, 1.7,
    2.68, 1.52, -1.7, 3, 1.52, -1.7, 3, 1.52, 1.7, 2.68, 1.52, 1.7,
  ]);
  return {
    group: g,
    bodies: [{ node: g, fixed: true, friction: 0.85, restitution: 0.05, shapes: [{ kind: 'hull', pts: hull }] }],
  };
}

/* barrier: jersey-profile concrete block, fixed. */
function barrier(M) {
  const g = new THREE.Group();
  const concrete = M('#a2a4aa', { rough: 0.92 });
  const body = slab(concrete, { x0: -1.9, x1: 1.9, y0: 0, y1: 0.84, w: 0.62, wT: 0.22 });
  g.add(body);
  const stripe = M('#e07b39', { rough: 0.7 });
  for (const side of ['left', 'right']) {
    const q = faceQuad(body.userData.pt, side);
    g.add(quadPrism(subQuad(q, 0.04, 0.22, 0.12, 0.88), 0.012, stripe));
    g.add(quadPrism(subQuad(q, 0.78, 0.96, 0.12, 0.88), 0.012, stripe));
  }
  const pt = body.userData.pt;
  const hull = new Float32Array([
    pt.x0b, 0, -0.31, pt.x1b, 0, -0.31, pt.x1b, 0, 0.31, pt.x0b, 0, 0.31,
    pt.x0t, 0.84, -0.11, pt.x1t, 0.84, -0.11, pt.x1t, 0.84, 0.11, pt.x0t, 0.84, 0.11,
  ]);
  return {
    group: g,
    bodies: [{ node: g, fixed: true, friction: 0.8, restitution: 0.1, shapes: [{ kind: 'hull', pts: hull }] }],
  };
}

/* box stack: 3-2-1 pyramid of light crates; every crate is its own dynamic
   body so they scatter on impact. Fixed poses/yaws — no randomness. */
function boxes(M) {
  const g = new THREE.Group();
  const S = 0.66, H = S / 2;
  const layout = [
    // [x, y, z, yaw, shade]
    [0, H, -0.72, 0.06, '#bf8f57'], [0, H, 0, -0.05, '#b28450'], [0, H, 0.72, 0.09, '#c69a63'],
    [0, H + S, -0.36, -0.07, '#ba8a54'], [0, H + S, 0.36, 0.05, '#c2925c'],
    [0, H + S * 2, 0, 0.12, '#b8874f'],
  ];
  const bodies = [];
  for (const [x, y, z, yaw, hex] of layout) {
    const crate = new THREE.Group();
    const b = box(M(hex, { rough: 0.82 }), S, S, S);
    crate.add(b);
    const band = box(M('#8a6338', { rough: 0.8 }), S + 0.02, 0.09, S + 0.02);
    crate.add(band);
    crate.position.set(x, y, z);
    crate.rotation.y = yaw;
    g.add(crate);
    bodies.push({
      node: crate, fixed: false, mass: 34, friction: 0.55, restitution: 0.16,
      shapes: [{ kind: 'box', he: [H, H, H], pos: [0, 0, 0], rot: [0, 0, 0, 1] }],
    });
  }
  return { group: g, bodies };
}

/* pole: knock-downable light pole, single dynamic body (origin at its center). */
function pole(M) {
  const g = new THREE.Group();
  const steel = M('#767c84', { rough: 0.6, metal: 0.4 });
  const H = 4.2;
  const mast = cyl(steel, { r: 0.09, r2: 0.065, len: H, seg: 8 });
  mast.position.y = 0; // body origin = pole center
  g.add(mast);
  const base = cyl(M('#565b62', { rough: 0.8 }), { r: 0.2, len: 0.16, seg: 8 });
  base.position.y = -H / 2 + 0.08;
  g.add(base);
  const arm = box(steel, 0.62, 0.07, 0.1);
  arm.position.set(0.28, H / 2 - 0.05, 0);
  g.add(arm);
  const head = box(M('#3a3e45', { rough: 0.5, emissive: '#ffd98a', emInt: 1.6 }), 0.4, 0.1, 0.2);
  head.position.set(0.5, H / 2 - 0.12, 0);
  g.add(head);
  return {
    group: g,
    bodies: [{
      node: g, fixed: false, mass: 120, friction: 0.5, restitution: 0.08, y: H / 2,
      shapes: [
        { kind: 'cyl', hh: H / 2, r: 0.09, pos: [0, 0, 0], rot: [0, 0, 0, 1] },
        { kind: 'box', he: [0.35, 0.06, 0.1], pos: [0.4, H / 2 - 0.1, 0], rot: [0, 0, 0, 1] },
      ],
    }],
  };
}

const BUILDERS = { ramp, barrier, boxes, pole };

// Returns { group, bodies } or null for an unknown kind. bodies[i].y is the
// body origin's rest height above ground (0 for props modelled from y 0).
export function buildProp(kind) {
  const b = BUILDERS[kind];
  if (!b) return null;
  const M = matFactory();
  return b(M);
}
