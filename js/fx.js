// fx.js — crash effects layer for Crash Bet. Strictly render-side: it reads
// sim state and sim event hooks, and NOTHING here ever feeds back into the
// physics world (the determinism contract stays intact — fx uses its own rng).
//
// Systems (all pooled, zero allocation per frame):
//  - three point clouds: sparks (additive), puffs (smoke/steam/dust/tire smoke),
//    blaze (additive fire)
//  - instanced glass shards + instanced paint-debris chips (tumble, bounce, fade)
//  - ground decal ring buffer: skid marks, scrapes, fluid-leak spots
//  - impact flash light, camera shake, procedural WebAudio (crunch / glass /
//    scrape / detach thunk)
// Hooks consumed: sim.onImpact / onScrape / onGlass / onDetach, plus per-frame
// emitters derived from rig damage state (radiator steam → engine smoke → fire).
import * as THREE from 'three';
import { makeRng, clamp } from './lib.js';

/* ---------------- soft point-sprite material ---------------- */
function makePointsMat(blending, soft) {
  return new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 300 } },
    vertexShader: `
      attribute float psize; attribute float palpha; attribute vec3 pcolor;
      varying float vA; varying vec3 vC; uniform float uScale;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = psize * uScale / max(0.1, -mv.z);
        gl_Position = projectionMatrix * mv;
        vA = palpha; vC = pcolor;
      }`,
    fragmentShader: `
      varying float vA; varying vec3 vC;
      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        float a = (1.0 - smoothstep(${soft}, 0.5, d)) * vA;
        if (a < 0.004) discard;
        gl_FragColor = vec4(vC, a);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, blending,
  });
}

/* one pooled point cloud; caller integrates via opts {g, drag, grow} */
class Cloud {
  constructor(scene, cap, blending, soft, opts = {}) {
    this.cap = cap;
    this.g = opts.g !== undefined ? opts.g : 9.8;
    this.drag = opts.drag !== undefined ? opts.drag : 0.98;
    this.grow = opts.grow || 0;
    this.linearFade = opts.fade === 'linear'; // smoke thins out; sparks burn bright then die
    this.pos = new Float32Array(cap * 3);
    this.vel = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 3);
    this.size = new Float32Array(cap);
    this.alpha = new Float32Array(cap);
    this.life = new Float32Array(cap);
    this.life0 = new Float32Array(cap);
    this.a0 = new Float32Array(cap);
    this.s0 = new Float32Array(cap);
    this.head = 0;
    this.alive = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute('psize', new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute('palpha', new THREE.BufferAttribute(this.alpha, 1));
    this.geo = geo;
    this.mat = makePointsMat(blending, soft);
    this.mesh = new THREE.Points(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    scene.add(this.mesh);
  }
  spawn(x, y, z, vx, vy, vz, life, sizeV, color, a0) {
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.col[i * 3] = color.r; this.col[i * 3 + 1] = color.g; this.col[i * 3 + 2] = color.b;
    this.life[i] = this.life0[i] = life;
    this.s0[i] = sizeV; this.size[i] = sizeV;
    this.a0[i] = a0; this.alpha[i] = a0;
  }
  update(dt) {
    let alive = 0;
    const { pos, vel, life } = this;
    for (let i = 0; i < this.cap; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      if (life[i] <= 0) { this.alpha[i] = 0; continue; }
      alive++;
      const t = life[i] / this.life0[i]; // 1 → 0
      vel[i * 3 + 1] -= this.g * dt;
      const dr = Math.pow(this.drag, dt * 60);
      vel[i * 3] *= dr; vel[i * 3 + 1] *= dr; vel[i * 3 + 2] *= dr;
      pos[i * 3] += vel[i * 3] * dt;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      if (pos[i * 3 + 1] < 0.02 && this.g > 0) { pos[i * 3 + 1] = 0.02; vel[i * 3 + 1] = 0; }
      this.alpha[i] = this.a0[i] * (this.linearFade ? t : (t < 0.35 ? t / 0.35 : 1));
      this.size[i] = this.s0[i] * (1 + this.grow * (1 - t));
    }
    this.alive = alive;
    if (alive) {
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.palpha.needsUpdate = true;
      this.geo.attributes.psize.needsUpdate = true;
      this.geo.attributes.pcolor.needsUpdate = true;
    }
    return alive > 0;
  }
  clear() { this.life.fill(0); this.alpha.fill(0); this.geo.attributes.palpha.needsUpdate = true; }
}

/* pooled instanced rigid bits (glass shards / paint chips): tumble + bounce */
class Bits {
  constructor(scene, cap, geo, mat, opts = {}) {
    this.cap = cap;
    this.bounce = opts.bounce !== undefined ? opts.bounce : 0.4;
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    if (opts.color) { // enable per-instance color
      this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    scene.add(this.mesh);
    this.p = new Float32Array(cap * 3);
    this.v = new Float32Array(cap * 3);
    this.rot = []; for (let i = 0; i < cap; i++) this.rot.push(new THREE.Quaternion());
    this.w = new Float32Array(cap * 3); // angular vel (axis*speed, small-angle integration)
    this.s = new Float32Array(cap);
    this.life = new Float32Array(cap);
    this.life0 = new Float32Array(cap);
    this.head = 0;
    this.alive = 0;
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._sv = new THREE.Vector3();
    this._zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < cap; i++) this.mesh.setMatrixAt(i, this._zero);
  }
  spawn(x, y, z, vx, vy, vz, scale, life, rng, color) {
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z;
    this.v[i * 3] = vx; this.v[i * 3 + 1] = vy; this.v[i * 3 + 2] = vz;
    this.rot[i].setFromAxisAngle(_ax.set(rng() - 0.5, rng() - 0.5, rng() - 0.5).normalize(), rng() * Math.PI);
    this.w[i * 3] = (rng() - 0.5) * 18; this.w[i * 3 + 1] = (rng() - 0.5) * 18; this.w[i * 3 + 2] = (rng() - 0.5) * 18;
    this.s[i] = scale;
    this.life[i] = this.life0[i] = life;
    if (color && this.mesh.instanceColor) {
      this.mesh.instanceColor.setXYZ(i, color.r, color.g, color.b);
      this.mesh.instanceColor.needsUpdate = true;
    }
  }
  update(dt) {
    let alive = 0;
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.mesh.setMatrixAt(i, this._zero); this.mesh.instanceMatrix.needsUpdate = true; continue; }
      alive++;
      this.v[i * 3 + 1] -= 12 * dt;
      this.p[i * 3] += this.v[i * 3] * dt;
      this.p[i * 3 + 1] += this.v[i * 3 + 1] * dt;
      this.p[i * 3 + 2] += this.v[i * 3 + 2] * dt;
      if (this.p[i * 3 + 1] < 0.03) { // ground bounce, then slide out
        this.p[i * 3 + 1] = 0.03;
        this.v[i * 3 + 1] = Math.abs(this.v[i * 3 + 1]) * this.bounce;
        this.v[i * 3] *= 0.72; this.v[i * 3 + 2] *= 0.72;
        this.w[i * 3] *= 0.6; this.w[i * 3 + 1] *= 0.6; this.w[i * 3 + 2] *= 0.6;
      }
      const wl = Math.hypot(this.w[i * 3], this.w[i * 3 + 1], this.w[i * 3 + 2]);
      if (wl > 0.01) {
        this._q.setFromAxisAngle(_ax.set(this.w[i * 3] / wl, this.w[i * 3 + 1] / wl, this.w[i * 3 + 2] / wl), wl * dt);
        this.rot[i].premultiply(this._q);
      }
      const t = this.life[i] / this.life0[i];
      const k = this.s[i] * (t < 0.22 ? t / 0.22 : 1); // shrink out at end of life
      this._sv.set(k, k, k);
      this._m.compose(_ax.set(this.p[i * 3], this.p[i * 3 + 1], this.p[i * 3 + 2]), this.rot[i], this._sv);
      this.mesh.setMatrixAt(i, this._m);
    }
    if (alive) this.mesh.instanceMatrix.needsUpdate = true;
    this.alive = alive;
    return alive > 0;
  }
  clear() {
    this.life.fill(0);
    for (let i = 0; i < this.cap; i++) this.mesh.setMatrixAt(i, this._zero);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/* ground decal ring buffer: skid marks / scrapes / leak spots (flat quads) */
class Decals {
  constructor(scene, cap) {
    this.cap = cap;
    this.head = 0;
    this.posA = new Float32Array(cap * 18); // 6 verts per quad
    this.colA = new Float32Array(cap * 18);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.posA, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colA, 3));
    this.geo = geo;
    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
    this.dirty = false;
  }
  // quad from (x0,z0) to (x1,z1) with half-width hw, color c (linear THREE.Color)
  strip(x0, z0, x1, z1, hw, c) {
    let dx = x1 - x0, dz = z1 - z0;
    const l = Math.hypot(dx, dz) || 1;
    const nx = (-dz / l) * hw, nz = (dx / l) * hw;
    const i = this.head; this.head = (this.head + 1) % this.cap;
    const y = 0.012 + (i % 7) * 0.0007; // deterministic micro-offset kills z-fighting
    const P = this.posA, C = this.colA, o = i * 18;
    const ax = x0 + nx, az = z0 + nz, bx = x0 - nx, bz = z0 - nz;
    const cx = x1 - nx, cz = z1 - nz, ex = x1 + nx, ez = z1 + nz;
    P[o] = ax; P[o + 1] = y; P[o + 2] = az;
    P[o + 3] = bx; P[o + 4] = y; P[o + 5] = bz;
    P[o + 6] = cx; P[o + 7] = y; P[o + 8] = cz;
    P[o + 9] = ax; P[o + 10] = y; P[o + 11] = az;
    P[o + 12] = cx; P[o + 13] = y; P[o + 14] = cz;
    P[o + 15] = ex; P[o + 16] = y; P[o + 17] = ez;
    for (let k = 0; k < 6; k++) { C[o + k * 3] = c.r; C[o + k * 3 + 1] = c.g; C[o + k * 3 + 2] = c.b; }
    this.dirty = true;
  }
  spot(x, z, r, c) { this.strip(x - r, z, x + r, z, r, c); }
  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }
  clear() { this.posA.fill(0); this.geo.attributes.position.needsUpdate = true; this.head = 0; }
}

/* ---------------- procedural audio (no assets) ---------------- */
class Sfx {
  constructor() { this.ctx = null; this.master = null; this.noise = null; this.scrapeGain = null; this.oneshots = 0; this.oneshotT = 0; }
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch { return; }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(ctx.destination);
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    // persistent scrape loop, silent until fed
    const src = ctx.createBufferSource();
    src.buffer = this.noise; src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1050; bp.Q.value = 0.8;
    this.scrapeGain = ctx.createGain();
    this.scrapeGain.gain.value = 0;
    src.connect(bp); bp.connect(this.scrapeGain); this.scrapeGain.connect(this.master);
    src.start();
  }
  _slot() { // cap one-shots so a pileup doesn't clip into mush
    if (!this.ctx) return false;
    const t = this.ctx.currentTime;
    if (t - this.oneshotT > 0.1) { this.oneshotT = t; this.oneshots = 0; }
    return this.oneshots++ < 6;
  }
  _burst(vol, freq, type, dur, q = 0.7) {
    if (!this._slot()) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.7 + Math.random() * 0.5;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + dur + 0.02);
  }
  _thump(vol, freq, dur) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(28, freq * 0.4), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }
  impact(dv) {
    if (!this.ctx) return;
    const k = clamp(dv / 12, 0.12, 1);
    this._burst(0.5 * k, 260 + dv * 35, 'lowpass', 0.28 + 0.12 * k, 0.4);
    this._thump(0.55 * k, 64 + dv * 2.5, 0.22);
  }
  glass(big) {
    this._burst(big ? 0.34 : 0.16, 4200, 'highpass', big ? 0.3 : 0.12, 0.4);
    if (big) this._burst(0.2, 2600, 'bandpass', 0.22, 2.2);
  }
  detach() { this._thump(0.5, 95, 0.3); this._burst(0.3, 700, 'bandpass', 0.25, 1.2); }
  setScrape(level) {
    if (!this.scrapeGain) return;
    const t = this.ctx.currentTime;
    this.scrapeGain.gain.cancelScheduledValues(t);
    this.scrapeGain.gain.setTargetAtTime(clamp(level, 0, 0.22), t, level > this.scrapeGain.gain.value ? 0.02 : 0.18);
  }
  mute(on) { if (this.master) this.master.gain.value = on ? 0 : 0.5; }
}

/* ---------------- the fx manager ---------------- */
const _ax = new THREE.Vector3();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _c1 = new THREE.Color();

const COL = {
  spark: [new THREE.Color('#ffe9a8'), new THREE.Color('#ffb14e'), new THREE.Color('#ff7a3d')],
  smoke: new THREE.Color('#5a5c60'), smokeDark: new THREE.Color('#26272a'),
  steam: new THREE.Color('#cfd4d9'), dust: new THREE.Color('#8d7d68'),
  tire: new THREE.Color('#7b7e82'),
  fire: [new THREE.Color('#ffdf8a'), new THREE.Color('#ff9c3a'), new THREE.Color('#ff5a26')],
  glassTint: new THREE.Color('#bcd8ea'),
  skid: new THREE.Color('#141518'), leak: new THREE.Color('#17130d'), scrapeMark: new THREE.Color('#3a3d42'),
};

export function initFX(scene, opts = {}) {
  const small = !!opts.small;
  const K = small ? 0.5 : 1;
  const rng = makeRng('fx');
  // soft param = where the radial fade STARTS (0 = fade from the very center)
  const sparks = new Cloud(scene, Math.round(700 * K), THREE.AdditiveBlending, '0.10', { g: 16, drag: 0.965, grow: 0 });
  const puffs = new Cloud(scene, Math.round(560 * K), THREE.NormalBlending, '0.02', { g: -0.85, drag: 0.985, grow: 1.9, fade: 'linear' });
  const blaze = new Cloud(scene, Math.round(220 * K), THREE.AdditiveBlending, '0.05', { g: -2.6, drag: 0.97, grow: 0.8, fade: 'linear' });
  const shardGeo = new THREE.PlaneGeometry(0.085, 0.065);
  const shardMat = new THREE.MeshStandardMaterial({
    color: '#a8cee6', metalness: 0.35, roughness: 0.12, envMapIntensity: 2.2,
    transparent: true, opacity: 0.85, side: THREE.DoubleSide, flatShading: true,
  });
  const shards = new Bits(scene, Math.round(380 * K), shardGeo, shardMat, { bounce: 0.42 });
  const chipGeo = new THREE.BoxGeometry(0.085, 0.045, 0.06);
  const chipMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.6, metalness: 0.1 });
  const chips = new Bits(scene, Math.round(240 * K), chipGeo, chipMat, { bounce: 0.3, color: true });
  const decals = new Decals(scene, Math.round(1600 * K));
  const flash = new THREE.PointLight('#ffd9a0', 0, 26, 1.8);
  flash.castShadow = false;
  scene.add(flash);
  const sfx = new Sfx();

  let sim = null;
  let shake = 0;
  let scrapeLevel = 0;
  const perCar = new Map(); // rig → { lastWheel: [xz…], steamT, leakT, fireT }
  const shakeOff = new THREE.Vector3();

  function carState(car) {
    let s = perCar.get(car);
    if (!s) { s = { wheelLast: new Map(), emitT: 0, leakT: 0 }; perCar.set(car, s); }
    return s;
  }

  /* ---- event handlers (hooked onto the sim) ---- */
  function onImpact(car, ev) {
    const dv = ev.dv;
    const p = ev.point;
    const n = Math.min(60, Math.round(6 + dv * 3.2));
    for (let i = 0; i < n; i++) { // spark fan biased away from the push direction
      _v1.set(rng() - 0.5, rng() * 0.8, rng() - 0.5).normalize();
      _v1.addScaledVector(_v2.set(ev.dir.x, ev.dir.y, ev.dir.z), -0.7).normalize();
      const sp = 3 + rng() * (4 + dv * 0.5);
      sparks.spawn(p.x, p.y, p.z, _v1.x * sp, _v1.y * sp + 1.5, _v1.z * sp,
        0.25 + rng() * 0.45, 0.05 + rng() * 0.075, COL.spark[(rng() * 3) | 0], 1);
    }
    const nc = Math.min(14, Math.round(dv * 0.8));
    _c1.set(car.paintHex);
    for (let i = 0; i < nc; i++) {
      _v1.set(rng() - 0.5, rng() * 0.9 + 0.15, rng() - 0.5).normalize().multiplyScalar(2.5 + rng() * dv * 0.4);
      chips.spawn(p.x, p.y, p.z, _v1.x, _v1.y, _v1.z, 0.7 + rng() * 0.8, 1.6 + rng() * 1.6, rng,
        rng() < 0.65 ? _c1 : COL.smokeDark);
    }
    const np = Math.min(10, Math.round(2 + dv * 0.5));
    for (let i = 0; i < np; i++) {
      puffs.spawn(p.x + (rng() - 0.5) * 0.5, p.y + rng() * 0.3, p.z + (rng() - 0.5) * 0.5,
        (rng() - 0.5) * 2, 0.8 + rng() * 1.4, (rng() - 0.5) * 2,
        0.7 + rng() * 0.8, 0.35 + rng() * 0.4, COL.dust, 0.3);
    }
    if (dv > 4) {
      flash.position.set(p.x, p.y + 0.4, p.z);
      flash.intensity = Math.min(60, dv * 3.5);
    }
    shake = Math.min(0.6, shake + clamp(dv * 0.022, 0.03, 0.4));
    sfx.impact(dv);
  }

  function onScrape(car, ev) {
    scrapeLevel = Math.min(1, scrapeLevel + 0.25);
    if (rng() < 0.55) {
      const p = ev.point;
      const nb = 2 + ((rng() * 4) | 0);
      const lv = car.body.linvel();
      for (let i = 0; i < nb; i++) {
        sparks.spawn(p.x, Math.max(0.03, p.y), p.z,
          lv.x * 0.35 + (rng() - 0.5) * 2.5, 0.5 + rng() * 2, lv.z * 0.35 + (rng() - 0.5) * 2.5,
          0.16 + rng() * 0.3, 0.04 + rng() * 0.05, COL.spark[(rng() * 3) | 0], 1);
      }
      // grind marks on the ground while a wrecked corner drags
      if (p.y < 0.35 && rng() < 0.4) decals.spot(p.x, p.z, 0.08 + rng() * 0.1, COL.scrapeMark);
    }
  }

  function onGlass(car, ev) {
    const big = ev.type === 'glassShatter';
    const p = ev.point;
    const n = big ? Math.min(70, Math.round(ev.r * 130)) : 6;
    for (let i = 0; i < n; i++) {
      _v1.set(rng() - 0.5, rng() * 0.7, rng() - 0.5).normalize().multiplyScalar(1.2 + rng() * 3.4);
      shards.spawn(
        p.x + (rng() - 0.5) * ev.r * 1.2, p.y + (rng() - 0.5) * ev.r * 0.8, p.z + (rng() - 0.5) * ev.r * 1.2,
        _v1.x, _v1.y + 1, _v1.z, 0.6 + rng() * 0.9, 1.4 + rng() * 1.4, rng);
    }
    sfx.glass(big);
  }

  function onDetach(car, ev) {
    const p = ev.point;
    for (let i = 0; i < 26; i++) {
      _v1.set(rng() - 0.5, rng() * 0.9, rng() - 0.5).normalize().multiplyScalar(3 + rng() * 6);
      sparks.spawn(p.x, p.y, p.z, _v1.x, _v1.y + 2, _v1.z, 0.3 + rng() * 0.4, 0.06 + rng() * 0.07, COL.spark[(rng() * 3) | 0], 1);
    }
    for (let i = 0; i < 6; i++) {
      _v1.set(rng() - 0.5, rng() * 1.2 + 0.3, rng() - 0.5).multiplyScalar(3);
      chips.spawn(p.x, p.y, p.z, _v1.x, _v1.y, _v1.z, 0.8 + rng() * 0.6, 1.8, rng, COL.smokeDark);
    }
    puffs.spawn(p.x, p.y, p.z, 0, 1.2, 0, 0.9, 0.5, COL.dust, 0.4);
    shake = Math.min(0.6, shake + 0.22);
    sfx.detach();
  }

  /* ---- per-frame emitters from rig damage state ---- */
  function carEmitters(dt) {
    if (!sim) return false;
    let busy = false;
    for (const car of sim.cars) {
      const st = carState(car);
      // engine bay: steam → smoke → fire, positioned at the (crumpled) nose
      const f = car.frontDmg;
      if (f > 8) {
        busy = true;
        st.emitT -= dt;
        if (st.emitT <= 0) {
          st.emitT = f > 26 ? 0.035 : f > 16 ? 0.07 : 0.13;
          _v1.set(car.size.x * 0.4, 0.62, 0).applyQuaternion(car.wrap.quaternion).add(car.wrap.position);
          if (f > 26) { // burning
            _v2.set((rng() - 0.5) * 0.5, 1.6 + rng(), (rng() - 0.5) * 0.5);
            blaze.spawn(_v1.x + (rng() - 0.5) * 0.5, _v1.y, _v1.z + (rng() - 0.5) * 0.6,
              _v2.x, _v2.y, _v2.z, 0.3 + rng() * 0.3, 0.34 + rng() * 0.3, COL.fire[(rng() * 3) | 0], 0.85);
            if (rng() < 0.55) {
              puffs.spawn(_v1.x, _v1.y + 0.5, _v1.z, (rng() - 0.5) * 0.6, 1.6 + rng() * 0.8, (rng() - 0.5) * 0.6,
                1.6 + rng() * 1.2, 0.5 + rng() * 0.45, COL.smokeDark, 0.5);
            }
          } else {
            const dark = f > 16;
            puffs.spawn(_v1.x + (rng() - 0.5) * 0.4, _v1.y, _v1.z + (rng() - 0.5) * 0.4,
              (rng() - 0.5) * 0.5, 1 + rng() * 0.9, (rng() - 0.5) * 0.5,
              1.1 + rng() * 0.9, 0.3 + rng() * 0.3, dark ? COL.smoke : COL.steam, dark ? 0.42 : 0.3);
          }
        }
        // fluid trail under the engine while moving
        st.leakT -= dt;
        if (f > 10 && st.leakT <= 0) {
          st.leakT = 0.5;
          _v1.set(car.size.x * 0.3, 0, 0).applyQuaternion(car.wrap.quaternion).add(car.wrap.position);
          decals.spot(_v1.x + (rng() - 0.5) * 0.2, _v1.z + (rng() - 0.5) * 0.2, 0.09 + rng() * 0.09, COL.leak);
        }
      }
      // tires: skid ribbons + smoke while sliding or hard-braking on the ground
      const lv = car.body.linvel();
      const speed = Math.hypot(lv.x, lv.z);
      if (speed > 4 && car.vis.length) {
        _v2.set(0, 0, 1).applyQuaternion(car.wrap.quaternion);
        const lat = Math.abs(lv.x * _v2.x + lv.z * _v2.z);
        const skidding = lat > 3.4 || (car.brakingNow && speed > 6);
        if (skidding) {
          busy = true;
          for (const v of car.vis) {
            const m = car.wheelMeta[v.phys];
            v.obj.getWorldPosition(_v1);
            if (_v1.y > m.r + 0.14) continue; // airborne
            const key = v.phys * 2 + (v.z > 0 ? 1 : 0);
            const last = st.wheelLast.get(key);
            if (last && Math.hypot(_v1.x - last.x, _v1.z - last.z) > 0.34) {
              decals.strip(last.x, last.z, _v1.x, _v1.z, Math.max(0.05, m.w * 0.42), COL.skid);
              st.wheelLast.set(key, { x: _v1.x, z: _v1.z });
              if (rng() < 0.5) {
                puffs.spawn(_v1.x, 0.12, _v1.z, (rng() - 0.5) * 1.4, 0.7 + rng() * 0.8, (rng() - 0.5) * 1.4,
                  0.8 + rng() * 0.6, 0.3 + rng() * 0.3, COL.tire, 0.26);
              }
            } else if (!last) st.wheelLast.set(key, { x: _v1.x, z: _v1.z });
          }
        } else st.wheelLast.clear();
      } else st.wheelLast.clear();
    }
    return busy;
  }

  return {
    sfx,
    attach(newSim) {
      sim = newSim;
      perCar.clear();
      sim.onImpact = onImpact;
      sim.onScrape = onScrape;
      sim.onGlass = onGlass;
      sim.onDetach = onDetach;
    },
    detachSim() { sim = null; },
    unlockAudio() { sfx.unlock(); },
    update(dt, camera) {
      // point-size scale follows the viewport (world-size → px)
      const h = (camera && camera.isPerspectiveCamera) ? Math.abs(window.innerHeight / (2 * Math.tan((camera.fov * Math.PI) / 360))) : 300;
      sparks.mat.uniforms.uScale.value = h;
      puffs.mat.uniforms.uScale.value = h;
      blaze.mat.uniforms.uScale.value = h;
      let busy = false;
      if (sparks.update(dt)) busy = true;
      if (puffs.update(dt)) busy = true;
      if (blaze.update(dt)) busy = true;
      if (shards.update(dt)) busy = true;
      if (chips.update(dt)) busy = true;
      if (carEmitters(dt)) busy = true;
      decals.flush();
      if (flash.intensity > 0.01) { flash.intensity *= Math.pow(0.0001, dt); busy = true; }
      else flash.intensity = 0;
      if (shake > 0.001) { shake *= Math.pow(0.012, dt); busy = true; }
      else shake = 0;
      scrapeLevel = Math.max(0, scrapeLevel - dt * 3.2);
      sfx.setScrape(scrapeLevel * 0.22);
      return busy;
    },
    applyShake(camera) {
      if (shake <= 0.001) { shakeOff.set(0, 0, 0); return; }
      shakeOff.set((rng() - 0.5) * shake, (rng() - 0.5) * shake * 0.7, (rng() - 0.5) * shake);
      camera.position.add(shakeOff);
    },
    undoShake(camera) {
      camera.position.sub(shakeOff);
      shakeOff.set(0, 0, 0);
    },
    reset() {
      sparks.clear(); puffs.clear(); blaze.clear(); shards.clear(); chips.clear(); decals.clear();
      flash.intensity = 0;
      shake = 0; scrapeLevel = 0;
      sfx.setScrape(0);
      perCar.clear();
    },
    dispose() {
      this.reset();
      for (const s of [sparks, puffs, blaze]) { scene.remove(s.mesh); s.geo.dispose(); s.mat.dispose(); }
      for (const b of [shards, chips]) { scene.remove(b.mesh); b.mesh.geometry.dispose(); b.mesh.material.dispose(); b.mesh.dispose(); }
      scene.remove(decals.mesh); decals.geo.dispose(); decals.mesh.material.dispose();
      scene.remove(flash);
    },
  };
}
