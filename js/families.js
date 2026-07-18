// families.js — shared material bundle + the big vehicle family builders
import * as THREE from 'three';
import { slab, wedge, faceQuad, subQuad, quadPrism, panesOnQuad, box, cyl, PAINT, shade, jitterColor } from './lib.js';
import * as P from './parts.js';

/* ---------------- standard material bundle ---------------- */
// 1-in-100 easter egg: buildVehicle passes GOLD as the paint, stdMats turns it chrome
export const GOLD = '#e8b33a';
export function stdMats(r, M, o = {}) {
  const baseHex = o.bodyHex || r.weighted(PAINT);
  if (baseHex === GOLD) {
    return {
      bodyHex: GOLD,
      body: M(GOLD, { rough: 0.22, metal: 0.9, env: 1.3 }),
      body2: M(shade(GOLD, -0.08), { rough: 0.26, metal: 0.9, env: 1.15 }),
      glass: M('#1b2836', { rough: 0.32, metal: 0.05, env: 0.85 }),
      trim: M('#c9ced4', { rough: 0.35, metal: 0.55, env: 0.9 }),
      dark: M('#2c2f34', { rough: 0.75 }),
      steel: M('#9aa0a7', { rough: 0.4, metal: 0.6, env: 1 }),
    };
  }
  const bodyHex = o.noJitter ? baseHex : jitterColor(r, baseHex);
  const glassLight = o.glassLight !== undefined ? o.glassLight : r.chance(0.14);
  return {
    bodyHex,
    body: M(bodyHex, { rough: 0.55, env: 0.42 }),
    body2: M(shade(bodyHex, -0.09), { rough: 0.58, env: 0.4 }),
    glass: M(glassLight ? '#7da0b8' : '#1b2836', { rough: 0.32, metal: 0.05, env: 0.85 }),
    trim: M('#c9ced4', { rough: 0.35, metal: 0.55, env: 0.9 }),
    dark: M('#2c2f34', { rough: 0.75 }),
    steel: M('#9aa0a7', { rough: 0.4, metal: 0.6, env: 1 }),
  };
}

/* cabin with windshield/rear/side windows */
export function cabin(g, mats, o) {
  const cab = slab(o.mat || mats.body, {
    x0: o.x0, x1: o.x1, y0: o.y0, y1: o.y0 + o.h,
    w: o.w, wT: o.wT !== undefined ? o.wT : o.w * 0.78,
    nose: o.rakeF !== undefined ? o.rakeF : 0.45,
    tail: o.rakeR !== undefined ? o.rakeR : 0.35,
    shiftT: o.shiftT || 0,
  });
  g.add(cab);
  const pt = cab.userData.pt, gl = mats.glass;
  if (o.front !== false) g.add(quadPrism(subQuad(faceQuad(pt, 'front'), 0.1, 0.9, 0.14, 0.85), 0.022, gl, 0.012));
  if (o.rear !== false) g.add(quadPrism(subQuad(faceQuad(pt, 'rear'), 0.12, 0.88, 0.18, 0.83), 0.022, gl, 0.012));
  const cols = o.sideCols !== undefined ? o.sideCols : 2;
  if (cols > 0) {
    for (const s of ['left', 'right']) {
      g.add(panesOnQuad(faceQuad(pt, s), gl, {
        cols, gap: o.gap || 0.05, f0: 0.07, f1: 0.93, t: 0.022,
        v0: o.sideV0 !== undefined ? o.sideV0 : 0.18, v1: o.sideV1 !== undefined ? o.sideV1 : 0.84,
      }));
    }
  }
  return cab;
}

/* ============================================================
   CAR — generic passenger car; nearly all car types are configs
   ============================================================ */
export function car(r, M, ctx, k = {}) {
  const g = new THREE.Group();
  const mats = stdMats(r, M, { bodyHex: ctx.paint || k.paintHex, glassLight: k.glassLight });

  const L = r.jitter(k.L || 4.5, 0.05);
  const W = r.jitter(k.W || 1.95, 0.04);
  const bodyH = r.jitter(k.bodyH || 0.6, 0.06);
  const clear = k.clear || 0.32;
  const wR = r.jitter(k.wheelR || 0.4, 0.05);
  const wRr = k.wheelRr ? r.jitter(k.wheelRr, 0.05) : wR;
  const wW = k.wheelW || 0.3;
  const bodyTop = clear + bodyH;

  // body slab
  const body = slab(mats.body, {
    x0: -L / 2, x1: L / 2, y0: clear, y1: bodyTop,
    w: W, wT: W * (k.topWf || 0.9),
    nose: k.nose !== undefined ? k.nose : 0.24,
    tail: k.tail !== undefined ? k.tail : 0.18,
    noseB: k.noseB !== undefined ? k.noseB : 0.07,
    tailB: k.tailB !== undefined ? k.tailB : 0.05,
  });
  g.add(body);
  const bpt = body.userData.pt;

  // cabin
  const cabL = r.jitter(k.cabL || L * 0.47, 0.04);
  const cabX = k.cabX !== undefined ? k.cabX : -L * 0.02;
  const cabH = r.jitter(k.cabH || 0.58, 0.06);
  let cabMat = mats.body;
  if (k.roofHex) cabMat = M(k.roofHex, { rough: 0.55, env: 0.55 });
  else if (k.twoTone && r.chance(0.5)) cabMat = M(r.pick(['#eceff1', '#26292e', '#efe3c8']), { rough: 0.55, env: 0.55 });
  let cabPt = null;
  if (!k.noCabin) {
    const cab = cabin(g, mats, {
      x0: cabX - cabL / 2, x1: cabX + cabL / 2, y0: bodyTop - 0.02, h: cabH,
      w: W * (k.cabWf || 0.9), wT: W * (k.cabTopWf || 0.68),
      rakeF: k.rakeF !== undefined ? k.rakeF : 0.5,
      rakeR: k.rakeR !== undefined ? k.rakeR : 0.38,
      sideCols: k.sideCols !== undefined ? k.sideCols : 2,
      mat: cabMat, rear: k.cabRear !== false,
    });
    cabPt = cab.userData.pt;
  } else {
    // convertible: raked windshield + seats + folded top
    const ws = slab(mats.glass, { x0: cabX - 0.5, x1: cabX - 0.28, y0: bodyTop - 0.02, y1: bodyTop + 0.34, w: W * 0.82, wT: W * 0.74, nose: 0.22 });
    g.add(ws);
    for (const s of [-1, 1]) {
      const seat = box(mats.dark, 0.42, 0.24, 0.5);
      seat.position.set(cabX + 0.18, bodyTop + 0.1, s * W * 0.2);
      g.add(seat);
      const back = box(mats.dark, 0.14, 0.3, 0.5);
      back.position.set(cabX + 0.42, bodyTop + 0.18, s * W * 0.2);
      g.add(back);
    }
    const roll = cyl(mats.dark, { r: 0.12, len: W * 0.7, axis: 'z', seg: 8 });
    roll.position.set(cabX + 0.72, bodyTop + 0.05, 0);
    g.add(roll);
  }

  // wheels
  const axF = k.axF !== undefined ? k.axF : L / 2 - (k.axInF || 0.78);
  const axR = k.axR !== undefined ? k.axR : -L / 2 + (k.axInR || 0.78);
  const track = W - wW * (k.poke ? 0.55 : 0.85) + (k.trackAdd || 0);
  const wOpt = { hub: k.hub, hubR: k.hubR, white: k.white && r.chance(0.7), seg: k.wheelSeg, rod: k.rod };
  P.axle(g, M, { x: axF, track, r: wR, w: wW, ...wOpt });
  P.axle(g, M, { x: axR, track, r: wRr, w: k.wheelWr || wW, dual: k.dualRear, ...wOpt });

  // face details + chrome
  P.headlightsOn(g, M, bpt, k.lights);
  P.taillightsOn(g, M, bpt);
  if (k.grille !== false) P.grilleOn(g, M, bpt);
  if (k.bumpers !== false) {
    P.bumper(g, M, { x: L / 2 + 0.03, y: clear + 0.1, w: W * 0.92 });
    P.bumper(g, M, { x: -L / 2 - 0.03, y: clear + 0.1, w: W * 0.92 });
  }
  if (r.chance(k.mirrorP !== undefined ? k.mirrorP : 0.75) && cabPt) {
    P.mirrors(g, M, { x: cabPt.x1b - 0.18, y: cabPt.y0 + 0.16, w: W * (k.cabWf || 0.9) });
  }
  if (k.plates !== false) P.licensePlates(g, M, bpt);
  if (r.chance(k.antennaP !== undefined ? k.antennaP : 0.25)) {
    P.antenna(g, M, { x: -L / 2 + 0.45, y: bodyTop, z: -W * 0.34 });
  }
  if (k.mudflaps && r.chance(0.6)) {
    P.mudflaps(g, M, { x: axR - wRr - 0.05, track: track * 0.98, y0: wRr * 1.05, w: k.wheelW || 0.3 });
  }

  // extras
  const topY = bodyTop + (k.noCabin ? 0 : cabH);
  if (k.spoiler && r.chance(k.spoilerP || 1)) {
    P.spoiler(g, M, { x: -L / 2 + 0.22, y: bodyTop, w: W, hex: mats.bodyHex, big: k.bigWing });
  }
  if (k.scoop && r.chance(0.7)) P.hoodScoop(g, M, { x: L * 0.28, y: bodyTop, hex: shade(mats.bodyHex, -0.07) });
  if (k.stripes && r.chance(0.6)) {
    P.racingStripes(g, M, { x0: -L / 2 + 0.3, x1: L / 2 - 0.28, y: bodyTop, hex: r.pick(['#eceff1', '#26292e', '#e3c53a']) });
  }
  let hasRack = false;
  if (k.roofRack && r.chance(0.45) && cabPt) {
    hasRack = true;
    P.roofRack(g, M, { x0: cabPt.x0t + 0.15, x1: cabPt.x1t - 0.15, y: cabPt.y1, w: W * 0.7 });
    if (r.chance(0.45)) P.roofCargo(g, M, r, { x: (cabPt.x0t + cabPt.x1t) / 2, y: cabPt.y1 + 0.1, w: W * 0.7 });
  }
  if (!hasRack && !k.lightbar && !k.taxiSign && cabPt && r.chance(k.sunroofP !== undefined ? k.sunroofP : 0.18)) {
    P.sunroof(g, M, { x: (cabPt.x0t + cabPt.x1t) / 2 + 0.08, y: cabPt.y1, len: Math.min(0.6, cabL * 0.3), w: W * (k.cabTopWf || 0.68) * 0.6 });
  }
  if (k.lightbar && cabPt) P.lightbar(g, M, { x: (cabPt.x0t + cabPt.x1t) / 2, y: cabPt.y1, w: W * 0.62 });
  if (k.taxiSign && cabPt) P.taxiSign(g, M, { x: (cabPt.x0t + cabPt.x1t) / 2, y: cabPt.y1 });
  if (k.spotPod && cabPt) { // rally roof lights
    const podY = cabPt.y1, podX = cabPt.x1t - 0.18;
    for (let i = 0; i < 4; i++) {
      const lamp = cyl(M('#ffedb8', { rough: 0.25, env: 1.2, emissive: '#ffd98a', emInt: 0.6 }), { r: 0.07, len: 0.09, axis: 'x', seg: 8 });
      lamp.position.set(podX, podY + 0.08, -0.3 + i * 0.2);
      g.add(lamp);
    }
    const podBar = box(mats.dark, 0.08, 0.06, 0.72);
    podBar.position.set(podX - 0.05, podY + 0.04, 0);
    g.add(podBar);
  }
  if (k.pushBar) P.bullbar(g, M, { x: L / 2 + 0.12, y: clear + 0.24, w: W * 0.8 });
  if (k.spare && r.chance(0.75)) P.spareWheel(g, M, { x: -L / 2 - 0.14, y: clear + bodyH * 0.55, r: wR * 0.9, w: 0.2, hub: k.hub });
  if (k.fenders) {
    for (const [ax, rr] of [[axF, wR], [axR, wRr]]) {
      for (const s of [-1, 1]) {
        const f = slab(mats.body2, { x0: ax - rr * 1.3, x1: ax + rr * 1.3, y0: rr * 1.55, y1: rr * 1.55 + 0.1, w: 0.24, nose: rr * 0.55, tail: rr * 0.55 });
        f.position.z = s * (W / 2 + 0.05);
        g.add(f);
      }
    }
    for (const s of [-1, 1]) { // running boards
      const rb = box(mats.dark, axF - axR - 1, 0.07, 0.26);
      rb.position.set((axF + axR) / 2, clear - 0.02, s * (W / 2 + 0.06));
      g.add(rb);
    }
  }
  return { g, mats, L, W, bodyH, clear, bodyTop, cabPt, bpt, topY };
}

/* ============================================================
   TRUCK CAB + CHASSIS — semis, rigid trucks, service trucks
   ============================================================ */
export function truckFront(r, M, ctx, k = {}) {
  const g = new THREE.Group();
  const mats = stdMats(r, M, { bodyHex: ctx.paint || k.paintHex });
  const W = k.W || 2.35;
  const clear = k.clear || 0.55;
  const wR = k.wheelR || 0.5;
  const cabH = r.jitter(k.cabH || 1.75, 0.05); // above clear
  const cabL = k.cabL || 1.7;
  const nose = k.nose !== undefined ? k.nose : (r.chance(0.5) ? r.range(0.9, 1.35) : 0); // american vs cabover
  const x1 = k.x1 !== undefined ? k.x1 : 2.6; // front bumper x
  const cabX1 = x1 - nose;

  // hood (if nosed)
  let hoodPt = null;
  if (nose > 0) {
    const hood = slab(mats.body, { x0: cabX1 - 0.06, x1, y0: clear, y1: clear + cabH * 0.52, w: W * 0.86, wT: W * 0.78, nose: 0.16, noseB: 0.04 });
    g.add(hood);
    hoodPt = hood.userData.pt;
  }
  // cab
  const cab = slab(mats.body, {
    x0: cabX1 - cabL, x1: cabX1, y0: clear, y1: clear + cabH,
    w: W, wT: W * 0.9, nose: nose > 0 ? 0.3 : 0.22, noseB: nose > 0 ? 0 : 0.05, tail: 0.06,
  });
  g.add(cab);
  const cpt = cab.userData.pt;
  // windshield + side windows high band
  g.add(quadPrism(subQuad(faceQuad(cpt, 'front'), 0.08, 0.92, nose > 0 ? 0.62 : 0.52, 0.9), 0.028, mats.glass, 0.014));
  for (const s of ['left', 'right']) {
    g.add(panesOnQuad(faceQuad(cpt, s), mats.glass, { cols: k.sideCols || 1, f0: 0.12, f1: 0.9, v0: nose > 0 ? 0.6 : 0.55, v1: 0.88 }));
  }
  // face details
  const facePt = nose > 0 ? hoodPt : cpt;
  P.headlightsOn(g, M, facePt, { v0: nose > 0 ? 0.42 : 0.3, v1: nose > 0 ? 0.66 : 0.42, w: 0.14 });
  P.grilleOn(g, M, facePt, { f0: 0.3, f1: 0.7, v0: 0.1, v1: nose > 0 ? 0.36 : 0.26 });
  P.bumper(g, M, { x: x1 + 0.04, y: clear + 0.06, w: W * 0.96, h: 0.18, hex: k.bumperHex || '#c9ced4' });
  P.mirrors(g, M, { x: cpt.x1b - 0.05, y: clear + cabH * 0.68, w: W });
  if (k.sunvisor !== false) {
    const sv = box(mats.body2, 0.3, 0.06, W * 0.86);
    sv.position.set(cpt.x1t + 0.02, clear + cabH * 0.93, 0);
    g.add(sv);
  }
  if (k.stacks || (k.stacks !== false && nose > 0 && r.chance(0.6))) {
    for (const s of [-1, 1]) P.exhaustStack(g, M, { x: cabX1 - cabL - 0.12, z: s * (W / 2 - 0.12), y0: clear + 0.3, h: cabH * 1.05 });
  }
  if (k.beaconHex) P.beacon(g, M, { x: (cpt.x0t + cpt.x1t) / 2, y: clear + cabH, hex: k.beaconHex });
  // front wheels
  P.axle(g, M, { x: x1 - (nose > 0 ? 0.55 : 0.75), track: W - 0.3, r: wR, w: 0.32, hubR: 0.5 });

  return { g, mats, W, clear, wR, cabRearX: cabX1 - cabL, x1, cabH, cpt };
}

// chassis rails + rear axles + fuel tanks, from cab rear to xEnd
export function chassis(t, M, xEnd, o = {}) {
  const { g, W, clear, wR } = t;
  const rail = box(M('#2c2f34', { rough: 0.8 }), t.cabRearX - xEnd + 0.6, 0.3, W * 0.55);
  rail.position.set((t.cabRearX + xEnd) / 2 + 0.2, clear + 0.02, 0);
  g.add(rail);
  const axles = o.axles || 1;
  for (let i = 0; i < axles; i++) {
    P.axle(t.g, M, { x: xEnd + 0.55 + i * (wR * 2.35), track: W - 0.32, r: wR, w: 0.32, dual: o.dual !== false, hubR: 0.5 });
  }
  if (o.tanks !== false) {
    for (const s of [-1, 1]) {
      const tank = cyl(M('#b9bec4', { rough: 0.3, metal: 0.6, env: 1 }), { r: 0.26, len: 0.95, axis: 'x', seg: 10 });
      tank.position.set(t.cabRearX + 0.55, clear + 0.1, s * (W / 2 - 0.18));
      t.g.add(tank);
    }
  }
}

/* ============================================================
   VAN — one-box body; panel vans, campers, ambulances, minibuses
   ============================================================ */
export function van(r, M, ctx, k = {}) {
  const g = new THREE.Group();
  const mats = stdMats(r, M, { bodyHex: ctx.paint || k.paintHex });
  const L = r.jitter(k.L || 4.9, 0.04);
  const W = r.jitter(k.W || 2.05, 0.03);
  const H = r.jitter(k.H || 1.75, 0.05);
  const clear = k.clear || 0.34;
  const wR = k.wheelR || 0.4;
  const topY = clear + H;

  let lowMat = mats.body, upMat = mats.body;
  if (k.twoTone) {
    const upHex = k.upHex || r.pick(['#f2ead9', '#eceff1']);
    upMat = M(upHex, { rough: 0.55, env: 0.55 });
  }
  const splitY = clear + H * (k.splitF || 0.45);
  const common = { x0: -L / 2, x1: L / 2, w: W };
  // winPt: slab the windows sit on; lightPt: slab lights/grille sit on
  let bpt, winPt, lightPt;
  let wsV = [k.wsV0 || 0.58, 0.9], sideV = [0.56, 0.86], rearV = [0.6, 0.88];
  let lightV = [0.32, 0.44], tailV = [0.34, 0.52], grilleV = [0.2, 0.32];
  if (k.twoTone) {
    const lo = slab(lowMat, { ...common, y0: clear, y1: splitY, noseB: 0.1, tailB: 0.06 });
    g.add(lo);
    const up = slab(upMat, { ...common, y0: splitY, y1: topY, wT: W * 0.88, nose: k.noseCut !== undefined ? k.noseCut : 0.55, tail: 0.3 });
    g.add(up);
    bpt = up.userData.pt;
    winPt = bpt;
    lightPt = lo.userData.pt;
    wsV = [0.3, 0.86]; sideV = [0.24, 0.76]; rearV = [0.3, 0.78];
    lightV = [0.5, 0.74]; tailV = [0.5, 0.76]; grilleV = [0.16, 0.42];
  } else {
    const body = slab(mats.body, {
      ...common, y0: clear, y1: topY, wT: W * 0.88,
      nose: k.noseCut !== undefined ? k.noseCut : 0.55, tail: 0.3, noseB: 0.1, tailB: 0.06,
    });
    g.add(body);
    bpt = body.userData.pt;
    winPt = bpt;
    lightPt = bpt;
  }

  // windshield high on the sloped front + door windows
  g.add(quadPrism(subQuad(faceQuad(winPt, 'front'), 0.08, 0.92, wsV[0], wsV[1]), 0.028, mats.glass, 0.014));
  for (const s of ['left', 'right']) {
    const fq = faceQuad(winPt, s);
    // front door window
    g.add(quadPrism(subQuad(fq, 0.8, 0.95, sideV[0], sideV[1]), 0.026, mats.glass, 0.012));
    if (k.sideWindows) { // passenger versions
      g.add(panesOnQuad(fq, mats.glass, { cols: k.sideCols || 3, f0: 0.08, f1: 0.76, v0: sideV[0], v1: sideV[1] }));
    }
  }
  if (k.rearWindow !== false) g.add(quadPrism(subQuad(faceQuad(winPt, 'rear'), 0.14, 0.86, rearV[0], rearV[1]), 0.026, mats.glass, 0.012));

  P.headlightsOn(g, M, lightPt, { v0: lightV[0], v1: lightV[1], w: 0.12 });
  P.taillightsOn(g, M, lightPt, { v0: tailV[0], v1: tailV[1], w: 0.08 });
  P.grilleOn(g, M, lightPt, { f0: 0.34, f1: 0.66, v0: grilleV[0], v1: grilleV[1] });
  P.bumper(g, M, { x: L / 2 + 0.03, y: clear + 0.1, w: W * 0.94 });
  P.bumper(g, M, { x: -L / 2 - 0.03, y: clear + 0.1, w: W * 0.94 });
  P.licensePlates(g, M, lightPt, { v0: 0.1, v1: 0.22, w: 0.08 });
  P.mirrors(g, M, { x: L / 2 - 0.5, y: clear + H * 0.62, w: W });
  P.axle(g, M, { x: L / 2 - 0.85, track: W - 0.28, r: wR, w: 0.28, white: k.white, hub: k.hub });
  P.axle(g, M, { x: -L / 2 + 0.95, track: W - 0.28, r: wR, w: 0.28, white: k.white, hub: k.hub });

  if (k.stripeHex) P.sideStripe(g, M, { x0: -L / 2 + 0.15, x1: L / 2 - 0.35, y: clear + H * (k.stripeF || 0.38), w: W, hex: k.stripeHex, h: k.stripeH || 0.14 });
  return { g, mats, L, W, H, clear, topY, bpt };
}

/* ============================================================
   BUS — big slab with window bands
   ============================================================ */
export function bus(r, M, ctx, k = {}) {
  const g = new THREE.Group();
  const mats = stdMats(r, M, { bodyHex: ctx.paint || k.paintHex });
  const L = r.jitter(k.L || 9, 0.06);
  const W = k.W || 2.5;
  const H = r.jitter(k.H || 2.5, 0.04);
  const clear = 0.45;
  const wR = 0.54;
  const nose = k.nose || 0; // school bus hood
  const bodyX1 = L / 2 - nose;

  const body = slab(mats.body, {
    x0: -L / 2, x1: bodyX1, y0: clear, y1: clear + H,
    w: W, wT: W * 0.92, nose: 0.22, tail: 0.24, noseB: 0.06, tailB: 0.08,
  });
  g.add(body);
  const bpt = body.userData.pt;

  let frontPt = bpt;
  if (nose > 0) {
    const hood = slab(mats.body, { x0: bodyX1 - 0.05, x1: L / 2, y0: clear, y1: clear + H * 0.42, w: W * 0.82, wT: W * 0.72, nose: 0.14 });
    g.add(hood);
    frontPt = hood.userData.pt;
  }

  // windshield + window band(s)
  g.add(quadPrism(subQuad(faceQuad(bpt, 'front'), 0.08, 0.92, nose > 0 ? 0.55 : (k.wsV0 || 0.52), 0.88), 0.028, mats.glass, 0.014));
  const bands = k.bands || [[k.winV0 || 0.52, k.winV1 || 0.84]];
  for (const s of ['left', 'right']) {
    const fq = faceQuad(bpt, s);
    for (const [v0, v1] of bands) {
      g.add(panesOnQuad(fq, mats.glass, { cols: k.cols || 5, gap: 0.028, f0: 0.05, f1: s === 'right' ? 0.8 : 0.95, v0, v1 }));
    }
    if (s === 'right') { // passenger door
      g.add(quadPrism(subQuad(fq, 0.84, 0.96, 0.06, bands[0][1]), 0.03, mats.glass, 0.014));
    }
  }
  g.add(quadPrism(subQuad(faceQuad(bpt, 'rear'), 0.12, 0.88, bands[bands.length - 1][0], bands[bands.length - 1][1]), 0.026, mats.glass, 0.012));

  P.headlightsOn(g, M, frontPt, { v0: nose > 0 ? 0.4 : 0.16, v1: nose > 0 ? 0.62 : 0.28, w: 0.1 });
  P.taillightsOn(g, M, bpt, { v0: 0.12, v1: 0.24, w: 0.06 });
  if (nose > 0) P.grilleOn(g, M, frontPt, { v0: 0.12, v1: 0.4 });
  P.bumper(g, M, { x: L / 2 + 0.03, y: clear + 0.12, w: W * 0.95, h: 0.16, hex: k.bumperHex || '#33373d' });
  P.bumper(g, M, { x: -L / 2 - 0.03, y: clear + 0.12, w: W * 0.95, h: 0.16, hex: k.bumperHex || '#33373d' });
  P.mirrors(g, M, { x: bodyX1 - 0.15, y: clear + H * 0.72, w: W });
  if (nose === 0) P.licensePlates(g, M, bpt, { v0: 0.05, v1: 0.13, w: 0.07 });
  P.axle(g, M, { x: L / 2 - (nose > 0 ? 0.7 : 1.3), track: W - 0.3, r: wR, w: 0.3, hubR: 0.5 });
  P.axle(g, M, { x: -L / 2 + 1.35, track: W - 0.3, r: wR, w: 0.3, hubR: 0.5, dual: k.dualRear });

  return { g, mats, L, W, H, clear, topY: clear + H, bpt };
}
