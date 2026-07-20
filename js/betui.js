// betui.js — the betting HUD (game phase G3).
//
// Owns every pixel of the betting layer: the bankroll pill, the market
// browser (grouped per object), the slip (singles + one parlay group), live
// chip settlement during resolve, the payout count-up and the scene summary.
//
// Division of labour with main.js: main.js owns the round lifecycle (deal →
// preview → freeze → resolve → done) and CALLS INTO this module at each beat;
// this module owns no sim state and never touches the camera. The one thing
// it calls back for is `onLock` — the player pressing BET, which is what
// resumes time at the freeze.
//
// IMPORTANT — live chips are a PREVIEW, not settlement. `liveState` below
// re-derives win/lose from the recorder summary so a chip can flip green the
// instant its trigger tick passes; the money is always settled by
// economy.settleRound() → markets.settleMarket(), and `settle()` reconciles
// the chips to that authoritative report. If the two ever disagree, the
// report wins and the chip is corrected.
import { REG } from './vehicles.js';
import * as Econ from './economy.js';
import { settleMarket } from './markets.js';

const $ = (id) => document.getElementById(id);
// sign goes OUTSIDE the currency mark — "$-10" reads like a typo
const money = (n) => ((n | 0) < 0 ? '−$' : '$') + Math.abs(n | 0).toLocaleString('en-US');
// odds are integer hundredths (250 = ×2.50) — never format with float math
const oddsTxt = (h) => '×' + (h / 100).toFixed(2);
const labelOf = (id) => (REG.find((e) => e.id === id) || {}).label || String(id).replace(/_/g, ' ');

/* ---------------- module state ---------------- */
const S = {
  scene: null, markets: [], profile: null, store: null,
  slip: null,          // Econ.makeSlip() — {legs:[{id,stake}], parlay:{ids,stake}|null}
  placed: false,       // slip locked in (stakes deducted)
  phase: 'idle',
  exhibition: false,
  onLock: null,        // () => void — main.js resumes the sim
  onNext: null,        // () => void — deal the next round
  stakeSel: 5,         // current quick-stake amount
  open: false,
};

/* ---------------- mount (once) ---------------- */
export function mountBetUI({ onLock, onNext }) {
  S.onLock = onLock;
  S.onNext = onNext;

  $('betToggle').addEventListener('click', () => setOpen(!S.open));
  $('bpClose').addEventListener('click', () => setOpen(false));
  $('betPlace').addEventListener('click', place);
  $('sumNext').addEventListener('click', () => { $('summary').hidden = true; if (S.onNext) S.onNext(); });

  // quick stakes — these set the amount used by the NEXT tapped market and
  // retro-apply to the focused leg, which is what makes one-thumb betting work
  for (const b of document.querySelectorAll('#stakebtns .stakebtn')) {
    b.addEventListener('click', () => {
      const v = b.dataset.stake;
      S.stakeSel = v === 'half' ? Math.max(1, Math.floor(bankroll() / 2))
        : v === 'all' ? Math.max(1, bankroll())
        : parseInt(v, 10);
      syncStakeBtns();
      renderSlip();
    });
  }
  // one delegated listener for the whole market list (it re-renders often)
  $('mklist').addEventListener('click', (e) => {
    const row = e.target.closest('.mkrow');
    if (row) toggleLeg(row.dataset.id);
  });
  $('sliplegs').addEventListener('click', (e) => {
    const leg = e.target.closest('.slipleg');
    if (!leg) return;
    const id = leg.dataset.id;
    if (e.target.closest('.legdel')) removeLeg(id);
    else if (e.target.closest('.legpar')) toggleParlay(id);
    else if (e.target.closest('.legminus')) bumpStake(id, -1);
    else if (e.target.closest('.legplus')) bumpStake(id, +1);
  });
}

function setOpen(v) {
  S.open = v;
  document.body.classList.toggle('betopen', v);
  $('betpanel').classList.toggle('open', v);
  $('betToggle').classList.toggle('on', v);
}

/* ---------------- round lifecycle ---------------- */
// called by main.js right after the scene is dealt and markets generated
export function openRound({ scene, markets, profile, store, exhibition }) {
  S.scene = scene; S.markets = markets; S.profile = profile; S.store = store;
  S.exhibition = !!exhibition;
  S.placed = false;
  S.phase = 'preview';
  S._idx = null; S._final = null; S._tick = 0;
  // a resumed round restores its slip draft (spec: boot resumes the round)
  const r = profile && profile.round;
  S.slip = (r && r.slip) ? r.slip : Econ.makeSlip();
  if (r && r.staked) S.placed = true;
  S.stakeSel = Math.min(5, Math.max(1, bankroll()));

  $('betui').hidden = false;
  $('summary').hidden = true;
  document.body.classList.toggle('exhibition', S.exhibition);
  $('exhTag').hidden = !S.exhibition;
  syncBank(0);
  syncStakeBtns();
  renderMarkets();
  renderSlip();
  setOpen(false);
}

export function closeRound() {
  $('betui').hidden = true;
  $('summary').hidden = true;
  setOpen(false);
  S.scene = null; S.markets = []; S.slip = null; S.phase = 'idle';
}

export function setPhase(p) {
  S.phase = p;
  document.body.classList.toggle('betlocked', !bettingOpen());
  // Betting stays open through the freeze — the spec's beat is "study the
  // frozen scene, THEN press BET to resume". Time restarting is the lock.
  if (p === 'resolve') {
    if (!S.placed && hasStakes()) place(); // a drafted slip rides at the lock
    setOpen(false);
  }
  syncMarketRows();
  renderSlip();
}

const bankroll = () => (S.profile ? S.profile.bankroll : 0);
const bettingOpen = () => S.phase === 'preview' || S.phase === 'freeze';
const hasStakes = () => S.slip && (S.slip.legs.length > 0 || (S.slip.parlay && S.slip.parlay.ids.length >= 2));

// main.js reads this to label the freeze button ("Bet $12 & go" vs "Resume")
export function slipSummary() {
  const n = S.slip ? S.slip.legs.length + (S.slip.parlay ? S.slip.parlay.ids.length : 0) : 0;
  return { n, total: slipTotal(), placed: S.placed };
}

/* ---------------- slip editing ---------------- */
function findMarket(id) { return S.markets.find((m) => m.id === id); }
function legOf(id) { return S.slip.legs.find((l) => l.id === id); }
function inParlay(id) { return !!(S.slip.parlay && S.slip.parlay.ids.includes(id)); }
function onSlip(id) { return !!legOf(id) || inParlay(id); }

function toggleLeg(id) {
  if (S.placed || !bettingOpen()) return;
  if (onSlip(id)) { removeLeg(id); return; }
  if (!findMarket(id)) return;
  const stake = Math.max(1, Math.min(S.stakeSel, Math.max(1, bankroll() - slipTotal())));
  if (bankroll() - slipTotal() < 1) { flashSlip('Bankroll is fully staked'); return; }
  S.slip.legs.push({ id, stake });
  saveDraft();
  syncMarketRows(); renderSlip();
  if (!S.open) setOpen(true);
}

function removeLeg(id) {
  if (S.placed) return;
  S.slip.legs = S.slip.legs.filter((l) => l.id !== id);
  if (S.slip.parlay) {
    S.slip.parlay.ids = S.slip.parlay.ids.filter((x) => x !== id);
    if (S.slip.parlay.ids.length < 2) S.slip.parlay = null;
  }
  saveDraft();
  syncMarketRows(); renderSlip();
}

// move a leg between "single" and the one parlay group (spec: singles + ONE
// parlay). A parlay leg carries no stake of its own — the group has one stake.
function toggleParlay(id) {
  if (S.placed) return;
  // A parlay is allowed to sit at one leg while the player builds it — never
  // silently drag another pick in to satisfy the ≥2 rule. The half-built
  // group is shown with a "needs one more" hint and simply blocks PLACE.
  if (inParlay(id)) {
    S.slip.parlay.ids = S.slip.parlay.ids.filter((x) => x !== id);
    S.slip.legs.push({ id, stake: Math.max(1, S.stakeSel) });
    if (!S.slip.parlay.ids.length) S.slip.parlay = null;
  } else {
    S.slip.legs = S.slip.legs.filter((l) => l.id !== id);
    if (!S.slip.parlay) S.slip.parlay = { ids: [], stake: Math.max(1, S.stakeSel) };
    S.slip.parlay.ids.push(id);
  }
  saveDraft();
  syncMarketRows(); renderSlip();
}

function bumpStake(id, dir) {
  if (S.placed) return;
  const step = S.stakeSel >= 25 ? 25 : S.stakeSel >= 5 ? 5 : 1;
  if (id === '_parlay') {
    if (!S.slip.parlay) return;
    S.slip.parlay.stake = Math.max(1, S.slip.parlay.stake + dir * step);
  } else {
    const l = legOf(id);
    if (!l) return;
    l.stake = Math.max(1, l.stake + dir * step);
  }
  // never let the draft exceed the bankroll — clamp the leg we just touched
  const over = slipTotal() - bankroll();
  if (over > 0) {
    if (id === '_parlay') S.slip.parlay.stake = Math.max(1, S.slip.parlay.stake - over);
    else { const l = legOf(id); if (l) l.stake = Math.max(1, l.stake - over); }
    flashSlip('That is all you have');
  }
  saveDraft();
  renderSlip();
}

function slipTotal() {
  if (!S.slip) return 0;
  let t = 0;
  for (const l of S.slip.legs) t += l.stake;
  if (S.slip.parlay) t += S.slip.parlay.stake;
  return t;
}

function saveDraft() {
  if (!S.profile || !S.profile.round || !S.store) return;
  S.profile.round.slip = S.slip;
  Econ.saveProfile(S.store, S.profile);
}

/* ---------------- placing ---------------- */
function place() {
  if (S.placed || !hasStakes()) return;
  const v = Econ.placeSlip(S.profile, S.slip, S.markets);
  if (!v.ok) { flashSlip(v.errors[0] || 'Slip rejected'); return; }
  S.placed = true;
  Econ.saveProfile(S.store, S.profile);
  syncBank(-v.total);
  syncMarketRows(); renderSlip();
  pulse($('betToggle'));
}

/* ---------------- rendering: markets ---------------- */
const GROUP_ICON = { headline: '🏁', scene: '🌍', special: '⭐' };

function renderMarkets() {
  const list = $('mklist');
  if (!S.markets.length) { list.innerHTML = '<p class="mkempty">No markets for this scene.</p>'; return; }
  // group in the order the generator emitted them, but titled per object so
  // the browser reads as "things in the world", not a flat odds dump
  const order = [];
  const byGroup = new Map();
  for (const m of S.markets) {
    if (!byGroup.has(m.group)) { byGroup.set(m.group, []); order.push(m.group); }
    byGroup.get(m.group).push(m);
  }
  let html = '';
  for (const g of order) {
    html += `<section class="mkgroup" data-group="${esc(g)}"><h4>${groupTitle(g)}</h4>`;
    for (const m of byGroup.get(g)) {
      const on = onSlip(m.id);
      const par = inParlay(m.id);
      html += `<button class="mkrow${on ? ' on' : ''}${par ? ' par' : ''}" data-id="${m.id}" ${S.placed || !bettingOpen() ? 'disabled' : ''}>` +
        `<span class="mklabel">${esc(m.label)}</span>` +
        `<span class="mkodds">${oddsTxt(m.oddsH)}</span></button>`;
    }
    html += '</section>';
  }
  list.innerHTML = html;
}

// Update chip state on the rows already in the DOM. Never re-render the list
// on a tap: rewriting #mklist innerHTML resets its scrollTop and throws the
// player back to the top of the market list mid-browse.
function syncMarketRows() {
  const dis = S.placed || !bettingOpen();
  for (const row of $('mklist').querySelectorAll('.mkrow')) {
    const id = row.dataset.id;
    row.classList.toggle('on', onSlip(id));
    row.classList.toggle('par', inParlay(id));
    row.disabled = dis;
  }
}

function groupTitle(g) {
  if (g === 'headline') return `${GROUP_ICON.headline} Headline`;
  if (g === 'scene') return `${GROUP_ICON.scene} Scene`;
  if (g === 'special') return `${GROUP_ICON.special} Special`;
  if (g.startsWith('car:')) {
    const i = +g.slice(4);
    const c = S.scene.cars[i];
    const role = S.scene.meta.aggressor === i ? ' · the one to watch' : '';
    return `🚗 ${esc(labelOf(c.type))}${role}`;
  }
  if (g.startsWith('prop:')) {
    const i = +g.slice(5);
    return `🏠 ${esc(String(S.scene.props[i].kind).replace(/_/g, ' '))}`;
  }
  return esc(g);
}

/* ---------------- crosshair targeting (G3) ----------------
   main.js raycasts the world and hands us a group id; we open the panel on
   that object's markets. Not every object HAS markets (the generator only
   lists props near the action), so callers check groupExists first and show
   a "no market" tell rather than opening an empty panel. */
export function groupExists(g) { return S.markets.some((m) => m.group === g); }

export function focusGroup(g) {
  if (!groupExists(g)) return false;
  setOpen(true);
  const sec = [...$('mklist').querySelectorAll('.mkgroup')].find((s) => s.dataset.group === g);
  if (sec) {
    sec.scrollIntoView({ block: 'center', behavior: 'smooth' });
    sec.classList.remove('flash');
    void sec.offsetWidth; // restart the flash
    sec.classList.add('flash');
  }
  return true;
}

// label for the crosshair tag — the market label if we have one, else the
// object's own name so freecam still reads as "you are looking at X"
export function groupLabel(g) {
  if (g.startsWith('car:')) {
    const c = S.scene && S.scene.cars[+g.slice(4)];
    return c ? labelOf(c.type) : 'vehicle';
  }
  if (g.startsWith('prop:')) {
    const p = S.scene && S.scene.props[+g.slice(5)];
    return p ? String(p.kind).replace(/_/g, ' ') : 'object';
  }
  return g;
}

/* ---------------- rendering: slip ---------------- */
function renderSlip() {
  const legs = S.slip ? S.slip.legs : [];
  const par = S.slip ? S.slip.parlay : null;
  const n = legs.length + (par ? par.ids.length : 0);
  $('betN').textContent = String(n);
  $('betToggle').classList.toggle('empty', n === 0);

  let html = '';
  for (const l of legs) {
    const m = findMarket(l.id);
    if (!m) continue;
    html += legRow(l.id, m, l.stake, false);
  }
  if (par) {
    const short = par.ids.length < 2;
    const oddsH = Econ.parlayOddsH(par.ids, S.markets);
    const capped = oddsH >= Econ.PARLAY_CAP;
    html += `<div class="parbox${short ? ' short' : ''}"><div class="parhead"><b>⛓ PARLAY</b>` +
      `<span class="parodds">${short ? 'needs 1 more' : oddsTxt(oddsH) + (capped ? ' <i>cap</i>' : '')}</span></div>`;
    for (const id of par.ids) {
      const m = findMarket(id);
      if (m) html += legRow(id, m, null, true);
    }
    if (!short) html += stakeRow('_parlay', par.stake, oddsH);
    html += '</div>';
  }
  $('sliplegs').innerHTML = html || '<p class="slipempty">Tap a market to add it to your slip.</p>';

  const total = slipTotal();
  const win = potentialWin();
  $('slipTot').textContent = money(total);
  $('slipWin').textContent = money(win);
  // a half-built parlay blocks PLACE rather than being silently dropped
  const parlayOk = !par || par.ids.length >= 2;
  const canPlace = !S.placed && bettingOpen() && hasStakes() && parlayOk && total <= bankroll();
  $('betPlace').disabled = !canPlace;
  $('betPlace').textContent = S.placed ? '✓ Bet placed' : S.exhibition ? 'Place (exhibition)' : 'PLACE BET';
  $('slipwrap').classList.toggle('placed', S.placed);
}

function legRow(id, m, stake, isPar) {
  const st = liveClass(id);
  return `<div class="slipleg ${st}" data-id="${id}">` +
    `<div class="legtop"><span class="leglabel">${esc(m.label)}</span>` +
    `<span class="legodds">${oddsTxt(m.oddsH)}</span></div>` +
    (isPar ? '' : stakeRow(id, stake, m.oddsH)) +
    `<div class="legacts">` +
    (S.placed ? '' : `<button class="legpar" title="${inParlay(id) ? 'Make it a single' : 'Add to parlay'}">${inParlay(id) ? '↩ single' : '⛓ parlay'}</button>` +
      `<button class="legdel" title="Remove">✕</button>`) +
    `</div></div>`;
}

function stakeRow(id, stake, oddsH) {
  const pay = Math.floor((stake * oddsH) / 100);
  return `<div class="legstake" data-id="${id}">` +
    (S.placed ? '' : '<button class="legminus" aria-label="Less">−</button>') +
    `<span class="stakeamt">${money(stake)}</span>` +
    (S.placed ? '' : '<button class="legplus" aria-label="More">+</button>') +
    `<span class="stakepay">to win ${money(pay)}</span></div>`;
}

function potentialWin() {
  if (!S.slip) return 0;
  let w = 0;
  for (const l of S.slip.legs) {
    const m = findMarket(l.id);
    if (m) w += Math.floor((l.stake * m.oddsH) / 100);
  }
  if (S.slip.parlay) {
    const o = Econ.parlayOddsH(S.slip.parlay.ids, S.markets);
    w += Math.floor((S.slip.parlay.stake * o) / 100);
  }
  return w;
}

function syncStakeBtns() {
  for (const b of document.querySelectorAll('#stakebtns .stakebtn')) {
    const v = b.dataset.stake;
    const amt = v === 'half' ? Math.max(1, Math.floor(bankroll() / 2)) : v === 'all' ? Math.max(1, bankroll()) : parseInt(v, 10);
    b.classList.toggle('sel', amt === S.stakeSel);
  }
}

/* ---------------- live chip settlement ---------------- */
// Presentation only (see the header note). We precompute, per market, the
// tick at which it becomes definitively WON and the tick at which it becomes
// definitively LOST — both straight off the recording, so a chip flips the
// same frame the player sees the event happen. Markets that can only resolve
// by surviving (untouched / no-crash / prop survives) carry restTick on the
// winning side, so they stay pending until the scene actually settles.
//
// By construction the state at restTick equals settleMarket(); settle() then
// overwrites every chip with the authoritative report regardless.
const INF = Infinity;
const at = (t) => (t >= 0 ? t : INF); // recorder uses -1 for "never happened"

function buildLiveIndex(markets, rec) {
  const sum = rec.summary, ev = rec.events, rest = rec.restTick;
  const nCars = sum.perCar.length;

  // first tick each car was touched / shed a wheel, and the first glass tick.
  // `touched` is a bare boolean in the summary, so the tick has to come from
  // the event stream — the first hit per car↔object pair is never deduped,
  // so a touched car always has a logged hit.
  const touchAt = new Array(nCars).fill(INF);
  const wheelAt = new Array(nCars).fill(INF);
  let glassAt = INF;
  for (const e of ev) {
    if (e.k === 'hit' && e.car !== undefined) { if (e.t < touchAt[e.car]) touchAt[e.car] = e.t; }
    else if (e.k === 'wheel') { if (e.t < wheelAt[e.car]) wheelAt[e.car] = e.t; }
    else if (e.k === 'glass') { if (e.t < glassAt) glassAt = e.t; }
  }
  // tick at which the crash COUNT first reaches n
  const crashTicks = sum.perCar.map((p) => p.crashedAt).filter((t) => t >= 0).sort((a, b) => a - b);
  const nth = (n) => (n >= 1 && crashTicks.length >= n ? crashTicks[n - 1] : INF);
  const propAt = (i) => Math.min(at(sum.perProp[i].hitAt), at(sum.perProp[i].movedAt));

  const idx = new Map();
  for (const m of markets) {
    const s = m.settle;
    let win = INF, lose = INF;
    if (s.carCrash !== undefined) { win = at(sum.perCar[s.carCrash].crashedAt); lose = rest; }
    else if (s.carUntouched !== undefined) { win = rest; lose = touchAt[s.carUntouched]; }
    else if (s.carFlip !== undefined) { win = at(sum.perCar[s.carFlip].flipAt); lose = rest; }
    else if (s.carWheel !== undefined) { win = wheelAt[s.carWheel]; lose = rest; }
    else if (s.carFire !== undefined) { win = at(sum.perCar[s.carFire].fireAt); lose = rest; }
    else if (s.carOffroad !== undefined) { win = at(sum.perCar[s.carOffroad].offroadAt); lose = rest; }
    else if (s.carFirst !== undefined) {
      const c = sum.perCar[s.carFirst];
      if (sum.firstCrashTick >= 0 && c.crashedAt === sum.firstCrashTick) win = at(c.crashedAt);
      else lose = at(sum.firstCrashTick) === INF ? rest : at(sum.firstCrashTick);
    } else if (s.propHit !== undefined) { win = propAt(s.propHit); lose = rest; }
    else if (s.propTop !== undefined) { win = at(sum.perProp[s.propTop].movedAt); lose = rest; }
    else if (s.propSafe !== undefined) { win = rest; lose = propAt(s.propSafe); }
    else if (s.anyCrash !== undefined) {
      const f = at(sum.firstCrashTick);
      if (s.anyCrash) { win = f; lose = rest; } else { win = rest; lose = f; }
    } else if (s.crashedGte !== undefined) { win = nth(s.crashedGte); lose = rest; }
    else if (s.crashedOver !== undefined) { win = nth(Math.floor(s.crashedOver) + 1); lose = rest; }
    else if (s.crashedUnder !== undefined) { win = rest; lose = nth(Math.ceil(s.crashedUnder)); }
    else if (s.anyGlass !== undefined) { win = glassAt; lose = rest; }
    else if (s.anyFlip !== undefined) {
      let t = INF;
      for (const p of sum.perCar) t = Math.min(t, at(p.flipAt));
      win = t; lose = rest;
    } else if (s.anyWheel !== undefined) {
      let t = INF;
      for (const w of wheelAt) t = Math.min(t, w);
      win = t; lose = rest;
    } else if (s.hitPair !== undefined) {
      const [a, b] = s.hitPair;
      let t = INF;
      for (const e of ev) {
        if (e.k !== 'hit' || e.o !== 'car') continue;
        if ((e.car === a && e.oi === b) || (e.car === b && e.oi === a)) { t = e.t; break; }
      }
      win = t; lose = rest;
    }
    idx.set(m.id, { win, lose });
  }
  return idx;
}

function liveClass(id) {
  if (S._final) return S._final[id] ? 'won' : 'lost';
  if (!S._idx || S.phase !== 'resolve') return '';
  const e = S._idx.get(id);
  if (!e) return '';
  // whichever fires FIRST wins the display — at restTick both sides are in
  // range for survive-markets, and the earlier tick is the true one
  if (e.win <= S._tick && e.win <= e.lose) return 'won';
  if (e.lose <= S._tick) return 'lost';
  return '';
}

// main.js calls this every frame during resolve
export function tickLive(rec, tick) {
  S._tick = tick;
  if (S.phase !== 'resolve') return;
  if (!S._idx) S._idx = buildLiveIndex(S.markets, rec);
  renderSlip();
}

/* ---------------- settlement + summary ---------------- */
export function settle(report, rec) {
  // authoritative: every chip reads settleMarket, the same function the
  // economy settled the money with — never the live approximation
  S._final = {};
  for (const m of S.markets) S._final[m.id] = settleMarket(m, rec);
  renderSlip();

  const won = report.payout;
  const net = report.net;
  countUp(net);

  // scene summary card
  const s = rec.summary;
  const bits = [];
  bits.push(s.crashed ? `<b>${s.crashed}</b> crashed` : '<b>no crash</b>');
  if (s.propsMoved) bits.push(`<b>${s.propsMoved}</b> object${s.propsMoved === 1 ? '' : 's'} hit`);
  if (s.anyFlip) bits.push('<b>rollover</b>');
  if (s.anyWheel) bits.push('<b>wheel off</b>');
  if (s.anyGlass) bits.push('<b>glass</b>');
  // "first to go" — the detail that makes the recap read like a story rather
  // than a tally (falls back to the scene's tell when nothing crashed)
  const first = s.perCar.findIndex((p) => p.crashedAt >= 0 && p.crashedAt === s.firstCrashTick);
  let sub = '';
  if (first >= 0 && S.scene) {
    const secs = ((s.firstCrashTick - 600) / 60).toFixed(1);
    sub = `<span class="sumsub">first to go: the ${esc(labelOf(S.scene.cars[first].type))} · ${secs}s after the incident</span>`;
  } else if (S.scene && S.scene.meta.tell) {
    sub = `<span class="sumsub">${esc(S.scene.meta.tell)}</span>`;
  }

  const rows = [];
  for (const l of report.legs) {
    const m = findMarket(l.id);
    rows.push(sumRow(m ? m.label : l.id, l.stake, l.win, l.payout, false));
  }
  if (report.parlay) {
    const labels = report.parlay.ids.map((id) => { const m = findMarket(id); return m ? m.label : id; });
    rows.push(sumRow('⛓ Parlay: ' + labels.join(' + '), report.parlay.stake, report.parlay.win, report.parlay.payout, true));
  }

  const head = report.forMoney
    ? (net > 0 ? `<span class="sumwin">+${money(net)}</span>` : net < 0 ? `<span class="sumloss">${money(net)}</span>` : '<span>Even</span>')
    : '<span class="sumexh">Exhibition — no money</span>';

  $('sumHead').innerHTML = head;
  $('sumScene').innerHTML = bits.join(' · ') + sub;
  $('sumRows').innerHTML = rows.length ? rows.join('') : '<p class="slipempty">No bets placed on this one.</p>';
  $('sumBank').textContent = money(report.bankroll);
  $('summary').hidden = false;
  $('sumBust').hidden = !report.busted;
  if (report.busted) $('sumHead').innerHTML = '<span class="sumloss">ROCK BOTTOM</span>';
}

function sumRow(label, stake, win, payout, isPar) {
  return `<div class="sumrow ${win ? 'won' : 'lost'}${isPar ? ' par' : ''}">` +
    `<span class="srlabel">${esc(label)}</span>` +
    `<span class="srres">${win ? '+' + money(payout) : '−' + money(stake)}</span></div>`;
}

/* ---------------- bankroll pill ---------------- */
let bankShown = 0;
export function syncBank(delta) {
  const b = bankroll();
  $('bkamt').textContent = money(b);
  bankShown = b;
  if (delta) {
    const el = $('bkdelta');
    el.textContent = (delta > 0 ? '+' : '') + money(delta);
    el.className = 'bkdelta ' + (delta > 0 ? 'up' : 'down');
    el.classList.remove('show');
    void el.offsetWidth; // restart the animation
    el.classList.add('show');
  }
}

// animate the bankroll from its pre-settlement value to the new one
function countUp(net) {
  const target = bankroll();
  const from = bankShown;
  if (from === target) { syncBank(0); return; }
  const t0 = performance.now();
  const dur = 900;
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    $('bkamt').textContent = money(Math.round(from + (target - from) * e));
    if (k < 1) requestAnimationFrame(step);
    else { bankShown = target; syncBank(net); }
  };
  requestAnimationFrame(step);
}

/* ---------------- misc ---------------- */
function pulse(el) {
  el.classList.remove('pulse');
  void el.offsetWidth;
  el.classList.add('pulse');
}
function flashSlip(msg) {
  const el = $('slipMsg');
  el.textContent = msg;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export const _test = { buildLiveIndex, slipTotal: () => slipTotal(), state: S };
