/**
 * Outro cinematic — "The Journey Back to Earth".
 * Self-contained ending sequence: its own overlay, THREE.WebGLRenderer,
 * procedural planets, procedural WebAudio and a single master timeline so
 * every frame is a pure function of elapsed seconds (deterministic, skippable).
 *
 * Contract: playOutro({ summary, onDone }) -> { skip(), isRunning(), close() }
 * Uses the global `THREE` (vendored r128) and the shared soundtrack bus.
 */

import { music } from './music.js';
import { createVisorMaterial } from './visor.js';

/* ─────────────────────────── timeline (seconds) ─────────────────────────── */

const T = {
  fuelStart: 0.6,
  ready: 7,        // launch-ready card + light sweep
  walk: 11.5,      // crew crosses the pad
  launch: 18.5,    // hatch sealed → gantry retracts, countdown
  ignite: 23.7,
  liftoff: 24.6,
  depart: 29,      // cut (under a dip-to-black) to the space scene
  cruise: 33.5,    // Mars/Earth both in frame, rocket between them
  arrive: 39.5,
  report: 44.2,    // ~44 s of animation; the report then waits for input
};

// Boarding choreography. Each walker starts on their own delay and is only
// hidden once they reach the vestibule interior point; the hatch shuts after
// the last one is inside and before the gantry begins to retract.
const BOARD = {
  start: T.walk,
  duration: 5.0,     // walker zero, path start → inside the hatch
  stagger: 0.34,     // gap between walkers along the column
  doorOpenAt: T.walk - 0.8,
  doorOpenDur: 1.1,
  doorCloseAt: 17.62,
  doorCloseDur: 0.75,
};
const BOARD_END = BOARD.start + (4 - 1) * BOARD.stagger + BOARD.duration;

const C = {
  rust: '#c96a3c', sand: '#e7c9a9', basalt: '#120c0a',
  cyan: '#6fe3d4', amber: '#f2b661', green: '#8fd06a',
  ink: '#f4e7db', dim: '#bfa695',
};
const MONO = 'ui-monospace, "SFMono-Regular", "Cascadia Mono", Consolas, monospace';

/* ─────────────────────────── tiny maths helpers ─────────────────────────── */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, f) => a + (b - a) * f;
const sstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};
const easeInOut = (f) => (f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Seamless 3D value noise so planet textures have no visible seam. */
function makeNoise3(seed) {
  const hash = (x, y, z) => {
    let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126677) ^ Math.imul(seed, 2147483647);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const sm = (t) => t * t * (3 - 2 * t);
  const noise = (x, y, z) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = sm(x - xi), yf = sm(y - yi), zf = sm(z - zi);
    const c = (dx, dy, dz) => hash(xi + dx, yi + dy, zi + dz);
    const x00 = lerp(c(0, 0, 0), c(1, 0, 0), xf);
    const x01 = lerp(c(0, 1, 0), c(1, 1, 0), xf);
    const x10 = lerp(c(0, 0, 1), c(1, 0, 1), xf);
    const x11 = lerp(c(0, 1, 1), c(1, 1, 1), xf);
    return lerp(lerp(x00, x01, yf), lerp(x10, x11, yf), zf);
  };
  return {
    noise,
    fbm(x, y, z, oct = 4) {
      let amp = 0.5, f = 1, sum = 0, norm = 0;
      for (let i = 0; i < oct; i++) {
        sum += amp * noise(x * f, y * f, z * f);
        norm += amp; amp *= 0.5; f *= 2.07;
      }
      return sum / norm;
    },
  };
}

/* ───────────────────────────── CSS (injected) ───────────────────────────── */

const STYLE = `
#outro-stage { position: fixed; inset: 0; z-index: 110; background: ${C.basalt};
  font-family: ${MONO}; color: ${C.ink}; overflow: hidden; }
#outro-stage canvas { position: absolute; inset: 0; display: block; }
#outro-stage .o-vig { position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(120% 90% at 50% 42%, transparent 55%, rgba(10,6,5,0.68) 100%); }
#outro-stage .o-scan { position: absolute; inset: 0; pointer-events: none; opacity: .12;
  background: repeating-linear-gradient(0deg, rgba(244,231,219,.05) 0 1px, transparent 1px 3px); }
#outro-stage .o-top { position: absolute; top: 0; left: 0; right: 0; display: flex;
  justify-content: space-between; align-items: center; padding: 16px 20px; pointer-events: none; }
#outro-stage .o-eyebrow { font-size: 10px; letter-spacing: .28em; color: ${C.cyan};
  text-transform: uppercase; opacity: .9; }
#outro-stage .o-eyebrow i { font-style: normal; color: ${C.dim}; }
#outro-stage .o-ctrl { display: flex; gap: 8px; pointer-events: auto; }
#outro-stage .o-btn { font: 600 11px/1 ${MONO}; letter-spacing: .22em; text-transform: uppercase;
  color: ${C.cyan}; background: rgba(18,12,10,.55); border: 1px solid rgba(111,227,212,.4);
  border-radius: 4px; padding: 9px 14px; cursor: pointer; transition: background .15s, color .15s; }
#outro-stage .o-btn:hover { background: rgba(111,227,212,.14); }
#outro-stage .o-btn[aria-pressed="true"] { color: ${C.dim}; border-color: rgba(191,166,149,.4); }
#outro-stage .o-hud { position: absolute; left: 22px; bottom: 26px; width: 300px;
  border-left: 2px solid ${C.cyan}; padding: 10px 14px; background: rgba(18,12,10,.5);
  transition: opacity .5s; }
#outro-stage .o-hud .lbl { font-size: 10px; letter-spacing: .24em; color: ${C.dim}; }
#outro-stage .o-hud .pct { font-size: 34px; color: ${C.cyan}; letter-spacing: .04em; margin-top: 4px; }
#outro-stage .o-hud .pct b { font-weight: 600; }
#outro-stage .o-hud .bar { height: 4px; margin-top: 8px; background: rgba(233,201,169,.14); }
#outro-stage .o-hud .bar i { display: block; height: 100%; width: 0%;
  background: linear-gradient(90deg, ${C.cyan}, ${C.amber}); }
#outro-stage .o-hud .done { color: ${C.green}; }
#outro-stage .o-card { position: absolute; right: 26px; top: 30%; width: 268px; padding: 16px 18px;
  border: 1px solid rgba(143,208,106,.55); background: rgba(18,12,10,.82);
  transform: translateX(130%); opacity: 0; transition: transform .7s cubic-bezier(.2,.9,.25,1), opacity .4s; }
#outro-stage .o-card.in { transform: translateX(0); opacity: 1; }
#outro-stage .o-card.out { transform: translateX(130%); opacity: 0; }
#outro-stage .o-card .t { font-size: 18px; font-weight: 700; letter-spacing: .18em; color: ${C.green}; }
#outro-stage .o-card .s { margin-top: 8px; font-size: 10px; letter-spacing: .16em; color: ${C.dim}; line-height: 1.9; }
#outro-stage .o-card .s em { font-style: normal; color: ${C.cyan}; }
#outro-stage .o-count { position: absolute; left: 50%; top: 16%; transform: translateX(-50%);
  font-size: clamp(56px, 9vw, 110px); font-weight: 700; color: ${C.cyan}; letter-spacing: .1em;
  opacity: 0; transition: opacity .18s; text-shadow: 0 0 34px rgba(111,227,212,.35); pointer-events: none; }
#outro-stage .o-count.show { opacity: 1; }
#outro-stage .o-count.go { color: ${C.green}; text-shadow: 0 0 34px rgba(143,208,106,.4); }
#outro-stage .o-caption { position: absolute; left: 50%; bottom: 150px; transform: translateX(-50%);
  font-size: 11px; letter-spacing: .3em; color: ${C.dim}; text-transform: uppercase;
  opacity: 0; transition: opacity .45s; white-space: nowrap; }
#outro-stage .o-caption.show { opacity: .95; }
#outro-stage .o-caption b { color: ${C.cyan}; font-weight: 600; }
#outro-stage .o-dist { position: absolute; left: 50%; bottom: 24px; transform: translateX(-50%);
  text-align: center; opacity: 0; transition: opacity .45s; pointer-events: none; }
#outro-stage .o-dist.show { opacity: 1; }
#outro-stage .o-dist .route { font-size: 11px; letter-spacing: .34em; color: ${C.dim}; }
#outro-stage .o-dist .route b.a { color: ${C.rust}; } #outro-stage .o-dist .route b.b { color: ${C.cyan}; }
#outro-stage .o-dist .au { margin-top: 6px; font-size: 26px; color: ${C.amber}; letter-spacing: .06em; }
#outro-stage .o-fade, #outro-stage .o-flash { position: absolute; inset: 0; pointer-events: none; }
#outro-stage .o-fade { background: #000; opacity: 0; }
#outro-stage .o-flash { background: ${C.sand}; opacity: 0; }
#outro-stage .o-report { position: absolute; inset: 0; display: grid; place-items: center;
  padding: 4vh 4vw; overflow-y: auto; background: rgba(10,6,5,.66); backdrop-filter: blur(3px);
  opacity: 0; transition: opacity .8s; }
#outro-stage .o-report.show { opacity: 1; }
#outro-stage .o-report[hidden] { display: none; }
#outro-stage .rep { width: min(760px, 100%); border: 1px solid rgba(233,176,133,.22);
  border-top: 2px solid ${C.cyan}; background: rgba(18,12,10,.93); padding: 30px 34px 26px; }
#outro-stage .rep .kick { font-size: 10px; letter-spacing: .3em; color: ${C.cyan}; }
#outro-stage .rep h2 { margin: 12px 0 4px; font-size: clamp(26px, 4.4vw, 44px);
  letter-spacing: .04em; color: ${C.ink}; }
#outro-stage .rep .sub { margin: 0 0 22px; font-size: 11px; letter-spacing: .22em; color: ${C.dim}; }
#outro-stage .rep .sect { margin-top: 18px; font-size: 10px; letter-spacing: .26em; color: ${C.amber};
  border-bottom: 1px solid rgba(233,176,133,.18); padding-bottom: 5px; }
#outro-stage .rep .row { display: flex; justify-content: space-between; gap: 16px;
  border-bottom: 1px solid rgba(233,176,133,.1); padding: 7px 0; font-size: 12px; }
#outro-stage .rep .row .k { color: ${C.dim}; letter-spacing: .08em; }
#outro-stage .rep .row .v { color: ${C.cyan}; text-align: right; font-variant-numeric: tabular-nums; }
#outro-stage .rep .row .v.g { color: ${C.green}; }
#outro-stage .rep .row .v.p { color: ${C.rust}; }
#outro-stage .rep .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 0 28px; }
@media (max-width: 640px) { #outro-stage .rep .cols { grid-template-columns: 1fr; } }
#outro-stage .rep .note { margin: 22px 0 18px; font-size: 10px; color: ${C.dim}; line-height: 1.7; }
#outro-stage .rep .actions { display: flex; gap: 12px; }
#outro-stage .rep button.primary { flex: 1; font: 700 12px/1 ${MONO}; letter-spacing: .26em;
  color: ${C.basalt}; background: ${C.cyan}; border: 0; border-radius: 4px; padding: 14px 18px; cursor: pointer; }
#outro-stage .rep button.primary:hover { filter: brightness(1.12); }
`;

/* ───────────────────────────── audio (WebAudio) ─────────────────────────── */

function createAudio() {
  const A = { ctx: null, master: null, muted: false, ok: false, nodes: {} };

  A.init = () => {
    if (A.ctx) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const master = ctx.createGain();
      master.gain.value = 0.8;
      master.connect(ctx.destination);
      A.ctx = ctx; A.master = master; A.ok = true;
      ctx.resume && ctx.resume().catch(() => {});

      const mk = (type, freq, gain, filterFreq) => {
        const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
        const g = ctx.createGain(); g.gain.value = gain;
        if (filterFreq) {
          const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = filterFreq;
          o.connect(f); f.connect(g);
        } else o.connect(g);
        return g;
      };
      const pair = mk('sawtooth', 41, 0.5, 210);
      mk('sawtooth', 42.7, 0.4, 190).connect(pair);
      mk('triangle', 82.4, 0.22, 260).connect(pair);
      pair.connect(master);
      A.nodes.drone = pair;

      const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource(); src.buffer = noise; src.loop = true;
      const bp = ctx.createBiquadFilter(); bp.type = 'lowpass'; bp.frequency.value = 170; bp.Q.value = 0.7;
      const roar = ctx.createGain(); roar.gain.value = 0;
      src.connect(bp); bp.connect(roar); roar.connect(master); src.start();
      const rum = ctx.createOscillator(); rum.type = 'sine'; rum.frequency.value = 34;
      const rumG = ctx.createGain(); rumG.gain.value = 0;
      rum.connect(rumG); rumG.connect(master); rum.start();
      A.nodes.roar = roar; A.nodes.roarFilter = bp; A.nodes.rum = rumG;

      const shim = ctx.createGain(); shim.gain.value = 0; shim.connect(master);
      const trem = ctx.createGain(); trem.gain.value = 0.5; trem.connect(shim);
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.35;
      const lfoG = ctx.createGain(); lfoG.gain.value = 0.45;
      lfo.connect(lfoG); lfoG.connect(trem.gain); lfo.start();
      [1174.7, 1567.98, 2093].forEach((f, i) => {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
        const g = ctx.createGain(); g.gain.value = i === 2 ? 0.05 : 0.11;
        o.connect(g); g.connect(trem); o.start();
      });
      A.nodes.shim = shim;

      const chord = ctx.createGain(); chord.gain.value = 0; chord.connect(master);
      [130.81, 196, 261.63, 329.63, 392].forEach((f, i) => {
        const o = ctx.createOscillator(); o.type = i === 0 ? 'sine' : 'triangle'; o.frequency.value = f;
        const g = ctx.createGain(); g.gain.value = 0.09;
        o.connect(g); g.connect(chord); o.start();
      });
      A.nodes.chord = chord;
    } catch (e) { A.ok = false; }
  };

  const now = () => A.ctx.currentTime;
  const tgt = (node, v, tc = 0.6) => { try { node.gain.setTargetAtTime(v, now(), tc); } catch (e) {} };
  A.setDrone = (v, tc) => A.ok && tgt(A.nodes.drone, v, tc);
  A.setRoar = (v, tc) => { if (!A.ok) return; tgt(A.nodes.roar, v, tc); tgt(A.nodes.rum, v * 0.7, tc); };
  A.setShimmer = (v, tc) => A.ok && tgt(A.nodes.shim, v, tc);
  A.setChord = (v, tc) => A.ok && tgt(A.nodes.chord, v, tc);

  const blip = (freq, dur, gain, type = 'sine', slide = 0) => {
    if (!A.ok) return;
    try {
      const t = now();
      const o = A.ctx.createOscillator(); o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
      const g = A.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(A.master);
      o.start(t); o.stop(t + dur + 0.05);
    } catch (e) {}
  };
  A.tick = () => blip(880, 0.09, 0.16);
  A.goBlip = () => blip(520, 0.5, 0.22, 'square', 1040);
  A.klaxon = () => { [0, 0.28, 0.56].forEach((dt) => setTimeout(() => blip(dt % 2 ? 590 : 740, 0.18, 0.2, 'square'), dt * 1000)); };
  A.setMuted = (m) => { A.muted = m; if (A.ok) { try { A.master.gain.setTargetAtTime(m ? 0 : 0.8, A.ctx.currentTime, 0.08); } catch (e) {} } };
  A.dispose = () => {
    if (!A.ok) return;
    try {
      A.setDrone(0, 0.05); A.setRoar(0, 0.05); A.setShimmer(0, 0.05); A.setChord(0, 0.05);
      setTimeout(() => { try { A.ctx.close(); } catch (e) {} }, 220);
    } catch (e) {}
    A.ok = false;
  };
  return A;
}

/* ────────────────────────────── main export ─────────────────────────────── */

export function playOutro({ summary = {}, onDone } = {}) {
  document.getElementById('outro-stage')?.remove();

  const s = summary || {};
  const num = (v) => (Number.isFinite(+v) ? +v : 0);
  const crew = Array.isArray(s.crew) ? s.crew : [];
  const topics = Array.isArray(s.topics) ? s.topics : [];
  const mats = s.materials || {};
  const res = s.resources || {};

  const audio = createAudio();
  audio.init();
  // The ending lifts the score instead of starting a second copy of it.
  music.ensure();
  music.pushScene('ending');

  let finished = false;
  let reportShown = false;
  let stage, canvas, renderer, surf = null, space = null, camera, raf = 0;
  let last = performance.now();
  const ownedTextures = [];
  const events = []; // timeline edge triggers
  const fired = new Set();
  const three = window.THREE;

  /* ---------- DOM scaffold ---------- */
  stage = document.createElement('div');
  stage.id = 'outro-stage';
  stage.innerHTML = `
    <div class="o-vig"></div>
    <div class="o-scan"></div>
    <div class="o-top">
      <div class="o-eyebrow">OUTRO <i>// THE JOURNEY BACK TO EARTH</i></div>
      <div class="o-ctrl">
        <button class="o-btn" id="o-mute" aria-pressed="false">SOUND</button>
        <button class="o-btn" id="o-skip">SKIP ▸</button>
      </div>
    </div>
    <div class="o-hud" id="o-fuel">
      <div class="lbl" id="o-fuel-lbl">PROPELLANT TRANSFER</div>
      <div class="pct"><b id="o-fuel-pct">000</b>%</div>
      <div class="bar"><i id="o-fuel-bar"></i></div>
    </div>
    <div class="o-card" id="o-card">
      <div class="t">LAUNCH READY</div>
      <div class="s">TANKS <em>100%</em> · CREW <em>4/4</em><br>WINDOW <em>OPEN</em> · RANGE SAFING <em>GO</em></div>
    </div>
    <div class="o-count" id="o-count"></div>
    <div class="o-caption" id="o-caption"></div>
    <div class="o-dist" id="o-dist">
      <div class="route"><b class="a">MARS</b> → <b class="b">EARTH</b></div>
      <div class="au"><span id="o-au">0.52</span> AU TO EARTH</div>
    </div>
    <div class="o-flash" id="o-flash"></div>
    <div class="o-fade" id="o-fade"></div>
    <div class="o-report" id="o-report" hidden></div>
  `;
  const css = document.createElement('style');
  css.textContent = STYLE;
  stage.prepend(css);
  document.body.appendChild(stage);

  const $ = (id) => stage.querySelector('#' + id);
  const ui = {
    fuel: $('o-fuel'), fuelPct: $('o-fuel-pct'), fuelLbl: $('o-fuel-lbl'), fuelBar: $('o-fuel-bar'),
    card: $('o-card'), count: $('o-count'), cap: $('o-caption'), dist: $('o-dist'), au: $('o-au'),
    flash: $('o-flash'), fade: $('o-fade'), report: $('o-report'),
    skip: $('o-skip'), mute: $('o-mute'),
  };

  ui.mute.addEventListener('click', () => {
    audio.init();
    const m = ui.mute.getAttribute('aria-pressed') !== 'true';
    ui.mute.setAttribute('aria-pressed', String(m));
    ui.mute.textContent = m ? 'MUTED' : 'SOUND';
    audio.setMuted(m);
    music.setMuted(m);
  });
  ui.skip.addEventListener('click', () => skip());

  const setCap = (html) => { ui.cap.innerHTML = html; ui.cap.classList.add('show'); };
  const hideCap = () => ui.cap.classList.remove('show');

  /* ---------- three setup (guarded: DOM-only still reaches the report) ---------- */
  try {
    if (!three) throw new Error('THREE unavailable');
    canvas = document.createElement('canvas');
    stage.insertBefore(canvas, stage.firstChild);
    renderer = new three.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputEncoding = three.sRGBEncoding;
    camera = new three.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 900);
    surf = buildSurface();
    space = buildSpace();
  } catch (e) {
    renderer = null;
  }

  function glowTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.35, 'rgba(255,255,255,0.5)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
    const tex = new three.CanvasTexture(c);
    ownedTextures.push(tex);
    return tex;
  }

  function planetTexture(kind) {
    const w = 512, h = 256;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    const n1 = makeNoise3(kind === 'mars' ? 8123 : 4271);
    const n2 = makeNoise3(kind === 'mars' ? 991 : 6611);
    const mix = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    for (let y = 0; y < h; y++) {
      const lat = (y / h) * Math.PI;
      const sy = Math.cos(lat), sp = Math.sin(lat);
      for (let x = 0; x < w; x++) {
        const lon = (x / w) * Math.PI * 2;
        const px = Math.cos(lon) * sp, py = sy, pz = Math.sin(lon) * sp;
        let col;
        if (kind === 'mars') {
          const base = n1.fbm(px * 3 + 9, py * 3 + 9, pz * 3 + 9, 5);
          const dark = n2.fbm(px * 1.6 + 2, py * 1.6 + 2, pz * 1.6 + 2, 4);
          col = mix([122, 61, 35], [201, 106, 60], clamp(base * 1.25 - 0.12, 0, 1));
          col = mix(col, [92, 43, 23], clamp((0.52 - dark) * 2.2, 0, 0.8));
          const capN = Math.abs(py);
          const capEdge = sstep(0.78, 0.94, capN + (base - 0.5) * 0.14);
          col = mix(col, [235, 228, 220], capEdge);
        } else {
          const land = n1.fbm(px * 2.6 + 1, py * 2.6, pz * 2.6 + 3, 5);
          const detail = n2.fbm(px * 6, py * 6 + 4, pz * 6, 4);
          const ocean = mix([13, 44, 84], [34, 92, 150], clamp(land * 1.15, 0, 1));
          const green = mix([52, 92, 58], [128, 138, 88], clamp(detail * 1.4 - 0.2, 0, 1));
          col = land > 0.52 ? mix(green, [168, 137, 79], clamp((detail - 0.55) * 2.4, 0, 0.7)) : ocean;
          const iceCap = sstep(0.82, 0.95, Math.abs(py) + (land - 0.5) * 0.1);
          col = mix(col, [238, 242, 244], iceCap);
          const cloud = n2.fbm(px * 3.4 + 20, py * 3.4 + 20, pz * 3.4, 5);
          col = mix(col, [244, 240, 234], clamp((cloud - 0.58) * 2.6, 0, 0.85) * 0.8);
        }
        const i = (y * w + x) * 4;
        img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new three.CanvasTexture(c);
    tex.encoding = three.sRGBEncoding;
    ownedTextures.push(tex);
    return tex;
  }

  function groundTexture() {
    const w = 256;
    const c = document.createElement('canvas'); c.width = c.height = w;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, w);
    const n = makeNoise3(555);
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
      const v = n.fbm(x * 0.045, y * 0.045, 7.7, 4);
      const g = 92 + v * 130;
      const i = (y * w + x) * 4;
      img.data[i] = g; img.data[i + 1] = g * 0.52; img.data[i + 2] = g * 0.34; img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const tex = new three.CanvasTexture(c);
    tex.wrapS = tex.wrapT = three.RepeatWrapping;
    tex.repeat.set(8, 8);
    tex.encoding = three.sRGBEncoding;
    ownedTextures.push(tex);
    return tex;
  }

  function starTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 32;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.4, 'rgba(255,255,255,0.35)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 32, 32);
    const tex = new three.CanvasTexture(c);
    ownedTextures.push(tex);
    return tex;
  }

  /* ---------- shared rocket ---------- */
  function buildRocket() {
    const g = new three.Group();
    const sand = new three.MeshStandardMaterial({ color: C.sand, roughness: 0.5, metalness: 0.25 });
    const rust = new three.MeshStandardMaterial({ color: C.rust, roughness: 0.6, metalness: 0.2 });
    const dark = new three.MeshStandardMaterial({ color: '#2b1d17', roughness: 0.9 });
    const cyan = new three.MeshStandardMaterial({ color: C.cyan, emissive: C.cyan, emissiveIntensity: 0.5, roughness: 0.4 });

    const body = new three.Mesh(new three.CylinderGeometry(1.1, 1.1, 10, 18), sand);
    body.position.y = 6.6; g.add(body);
    for (const y of [3.2, 8.6]) {
      const band = new three.Mesh(new three.CylinderGeometry(1.13, 1.13, 0.5, 18), rust);
      band.position.y = y; g.add(band);
    }
    const nose = new three.Mesh(new three.ConeGeometry(1.1, 3.4, 18), rust);
    nose.position.y = 13.3; g.add(nose);
    const beacon = new three.Mesh(new three.SphereGeometry(0.16, 8, 8), cyan);
    beacon.position.y = 15.2; g.add(beacon);
    for (let i = 0; i < 4; i++) {
      const fin = new three.Mesh(new three.BoxGeometry(0.14, 2.8, 1.3), rust);
      const a = (i * Math.PI) / 2;
      fin.position.set(Math.cos(a) * 1.6, 1.4, Math.sin(a) * 1.6);
      fin.rotation.y = -a;
      g.add(fin);
    }
    const skirt = new three.Mesh(new three.CylinderGeometry(1.05, 1.5, 1.6, 16, 1, true), dark);
    skirt.position.y = 0.8; g.add(skirt);

    // side boarding hatch: a small vestibule screwed onto the hull, with the
    // doorway facing the crew path so they walk in through the real opening.
    const hatchMetal = new three.MeshStandardMaterial({ color: '#5c4331', roughness: 0.5, metalness: 0.55 });
    const hatchDark = new three.MeshStandardMaterial({ color: '#0a0706', roughness: 1, metalness: 0 });
    const innerGlowMat = new three.MeshBasicMaterial({ color: C.amber, transparent: true, opacity: 0 });
    const hatch = new three.Group();
    hatch.position.set(-1.05, 0, 0); g.add(hatch);

    // tunnel side walls, roof and floor (opening faces local -x)
    for (const z of [-0.58, 0.58]) {
      const wall = new three.Mesh(new three.BoxGeometry(1.0, 2.0, 0.1), hatchMetal);
      wall.position.set(-0.5, 1.0, z); hatch.add(wall);
    }
    const hatchRoof = new three.Mesh(new three.BoxGeometry(1.04, 0.14, 1.26), hatchMetal);
    hatchRoof.position.set(-0.5, 2.03, 0); hatch.add(hatchRoof);
    const hatchFloor = new three.Mesh(new three.BoxGeometry(1.04, 0.12, 1.26), hatchMetal);
    hatchFloor.position.set(-0.5, 0, 0); hatch.add(hatchFloor);

    // dark cabin behind the opening + warm interior light
    const cabin = new three.Mesh(new three.BoxGeometry(0.08, 2.0, 1.12), hatchDark);
    cabin.position.set(-0.03, 1.0, 0); hatch.add(cabin);
    const innerGlow = new three.Mesh(new three.PlaneGeometry(0.94, 1.5), innerGlowMat);
    innerGlow.rotation.y = -Math.PI / 2;
    innerGlow.position.set(-0.09, 1.06, 0); hatch.add(innerGlow);
    const doorLight = new three.PointLight(0xf2b661, 0, 3.4, 2);
    doorLight.position.set(-0.5, 1.15, 0); hatch.add(doorLight);

    // frame posts + lintel around the outer mouth
    for (const z of [-0.62, 0.62]) {
      const post = new three.Mesh(new three.BoxGeometry(0.16, 2.14, 0.14), rust);
      post.position.set(-1.0, 1.05, z); hatch.add(post);
    }
    const lintel = new three.Mesh(new three.BoxGeometry(0.16, 0.18, 1.42), rust);
    lintel.position.set(-1.0, 2.1, 0); hatch.add(lintel);
    const hatchLamp = new three.Mesh(new three.SphereGeometry(0.09, 8, 8),
      new three.MeshBasicMaterial({ color: C.cyan }));
    hatchLamp.position.set(-1.02, 2.28, 0); hatch.add(hatchLamp);

    // hinged door, opens outward toward the approaching crew
    const doorPivot = new three.Group();
    doorPivot.position.set(-1.0, 0, -0.58); hatch.add(doorPivot);
    const hatchDoor = new three.Mesh(new three.BoxGeometry(0.1, 2.0, 1.12), hatchMetal);
    hatchDoor.position.set(0, 1.02, 0.56); doorPivot.add(hatchDoor);
    const doorStripe = new three.Mesh(new three.BoxGeometry(0.12, 0.1, 0.32),
      new three.MeshBasicMaterial({ color: C.amber }));
    doorStripe.position.set(0, 1.62, 0.56); doorPivot.add(doorStripe);
    const doorStep = new three.Mesh(new three.BoxGeometry(0.1, 0.5, 1.12), rust);
    doorStep.position.set(0.02, 0.25, 0.56); doorPivot.add(doorStep);

    // shallow ramp up to the threshold
    const ramp = new three.Mesh(new three.BoxGeometry(1.5, 0.08, 1.1), hatchMetal);
    ramp.position.set(-1.62, -0.02, 0); ramp.rotation.z = 0.2; hatch.add(ramp);

    // additive plume + nozzle glow, driven per frame
    const plume = new three.Mesh(
      new three.ConeGeometry(1.0, 7, 14, 1, true),
      new three.MeshBasicMaterial({ color: C.amber, transparent: true, opacity: 0.75, blending: three.AdditiveBlending, depthWrite: false, side: three.DoubleSide }),
    );
    plume.rotation.x = Math.PI; plume.position.y = -3.2; plume.visible = false; g.add(plume);
    const glow = new three.Sprite(new three.SpriteMaterial({
      map: glowTexture(), color: C.amber, transparent: true, opacity: 0.9,
      blending: three.AdditiveBlending, depthWrite: false,
    }));
    glow.scale.set(7, 7, 1); glow.position.y = -0.6; glow.visible = false; g.add(glow);

    return { group: g, plume, glow, doorPivot, doorLight, innerGlowMat };
  }

  /* ---------- surface scene (beats 1–5) ---------- */
  function buildSurface() {
    const scene = new three.Scene();
    scene.fog = new three.FogExp2(0xb0714e, 0.0042);

    // golden-hour sky: low warm band under a dusky rust dome
    const skyMat = new three.ShaderMaterial({
      side: three.BackSide, depthWrite: false, fog: false,
      uniforms: { warm: { value: new three.Color(C.amber) } },
      vertexShader: 'varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: `
        varying vec3 vP; uniform vec3 warm;
        void main(){
          float h = normalize(vP).y * 0.5 + 0.5;
          vec3 c = mix(vec3(0.62,0.31,0.17), vec3(0.10,0.05,0.04), smoothstep(0.5,0.9,h));
          c = mix(c, warm*0.85, smoothstep(0.42,0.5,h) * (1.0 - smoothstep(0.5,0.62,h)));
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    scene.add(new three.Mesh(new three.SphereGeometry(420, 32, 18), skyMat));

    const ground = new three.Mesh(
      new three.PlaneGeometry(520, 520),
      new three.MeshStandardMaterial({ map: groundTexture(), roughness: 1, metalness: 0 }),
    );
    ground.rotation.x = -Math.PI / 2; scene.add(ground);

    const sun = new three.DirectionalLight(0xf2b661, 1.25);
    sun.position.set(-70, 16, 42); scene.add(sun);
    scene.add(new three.HemisphereLight(0xd9a184, 0x3d2418, 0.75));

    const metal = new three.MeshStandardMaterial({ color: '#3a2a20', roughness: 0.85 });
    const panel = new three.MeshStandardMaterial({ color: '#1d2f4d', roughness: 0.4, metalness: 0.6 });

    const block = (w, h, d, x, z, mat = metal) => {
      const m = new three.Mesh(new three.BoxGeometry(w, h, d), mat);
      m.position.set(x, h / 2, z); scene.add(m); return m;
    };

    // colony cluster behind the refinery
    const dome = new three.Mesh(new three.SphereGeometry(3.4, 20, 12), new three.MeshStandardMaterial({ color: '#cfd8dc', roughness: 0.5 }));
    dome.position.set(-30, 1.2, 6); dome.scale.y = 0.75; scene.add(dome);
    const bio = new three.Mesh(new three.SphereGeometry(2.6, 18, 12), new three.MeshStandardMaterial({ color: '#7ea86c', transparent: true, opacity: 0.75, roughness: 0.3 }));
    bio.position.set(-26, 1, 12); scene.add(bio);
    block(4, 2.6, 3, -34, 0);
    for (let i = 0; i < 4; i++) {
      const p = new three.Mesh(new three.BoxGeometry(3.2, 0.12, 1.8), panel);
      p.position.set(-40 - i * 3.6, 1.4 + i * 0.15, -6);
      p.rotation.z = 0.5; scene.add(p);
    }

    // refinery (fuel plant)
    const ref = block(4.4, 3.2, 3.6, -16, 1, new three.MeshStandardMaterial({ color: '#57402f', roughness: 0.8 }));
    const stack = new three.Mesh(new three.CylinderGeometry(0.5, 0.6, 4.6, 12), metal);
    stack.position.set(-17.4, 3.9, 1); scene.add(stack);
    const refLight = new three.Mesh(new three.BoxGeometry(0.5, 0.16, 0.16),
      new three.MeshBasicMaterial({ color: C.cyan }));
    refLight.position.set(-13.85, 2.4, 1); scene.add(refLight);

    // pad
    const pad = new three.Mesh(new three.CylinderGeometry(5.4, 5.6, 0.36, 26), new three.MeshStandardMaterial({ color: '#241a13', roughness: 0.95 }));
    pad.position.set(10, 0.18, -4); scene.add(pad);

    // gantry tower with a hinged umbilical arm
    const tower = new three.Group(); tower.position.set(15.5, 0, -4.5); scene.add(tower);
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const leg = new three.Mesh(new three.BoxGeometry(0.26, 12, 0.26), metal);
      leg.position.set(dx * 1.1, 6, dz * 1.1); tower.add(leg);
    }
    for (let i = 1; i <= 5; i++) {
      const rung = new three.Mesh(new three.BoxGeometry(2.2, 0.14, 2.2), metal);
      rung.position.y = i * 2.2; tower.add(rung);
    }
    const arm = new three.Group(); arm.position.set(0, 8.6, 0); tower.add(arm);
    const armBar = new three.Mesh(new three.BoxGeometry(5.4, 0.4, 0.5), new three.MeshStandardMaterial({ color: C.rust, roughness: 0.6 }));
    armBar.position.set(-2.7, 0, 0.4); arm.add(armBar);

    // pipeline: dark conduit + inner glow + travelling fuel pulses
    const pipeCurve = new three.CatmullRomCurve3([
      new three.Vector3(-13.6, 0.55, 1.2), new three.Vector3(-8, 0.55, 0.6),
      new three.Vector3(0, 0.55, -1.6), new three.Vector3(7.2, 0.55, -3.6),
      new three.Vector3(9.0, 0.7, -4), new three.Vector3(9.9, 3.4, -4),
    ]);
    scene.add(new three.Mesh(new three.TubeGeometry(pipeCurve, 60, 0.24, 8, false), metal));
    const pipeGlowMat = new three.MeshBasicMaterial({
      color: C.cyan, transparent: true, opacity: 0, blending: three.AdditiveBlending, depthWrite: false,
    });
    scene.add(new three.Mesh(new three.TubeGeometry(pipeCurve, 60, 0.13, 8, false), pipeGlowMat));

    const pulses = [];
    const pulseMat = new three.SpriteMaterial({
      map: glowTexture(), color: C.cyan, transparent: true, opacity: 0.9,
      blending: three.AdditiveBlending, depthWrite: false,
    });
    for (let i = 0; i < 10; i++) {
      const sp = new three.Sprite(pulseMat.clone());
      sp.scale.set(1.5, 1.5, 1);
      ownedTextures.push(pulseMat.map);
      scene.add(sp); pulses.push(sp);
    }

    const rocket = buildRocket();
    rocket.group.position.set(10, 0.3, -4); scene.add(rocket.group);

    // cyan→green "GO" sweep ring climbing the rocket during launch-ready
    const sweepMat = new three.MeshBasicMaterial({
      color: C.cyan, transparent: true, opacity: 0, blending: three.AdditiveBlending, depthWrite: false, side: three.DoubleSide,
    });
    const sweep = new three.Mesh(new three.CylinderGeometry(1.4, 1.4, 0.7, 18, 1, true), sweepMat);
    scene.add(sweep);

    // crew in single file — one procedural EVA figure each (capsule body + helmet + backpack)
    // Path ends inside the hatch vestibule so each astronaut is hidden only
    // after crossing the threshold, never out on the pad.
    const crewPath = new three.CatmullRomCurve3([
      new three.Vector3(-27, 0, 8), new three.Vector3(-18, 0, 5),
      new three.Vector3(-9, 0, 1.6), new three.Vector3(0, 0, -1.6),
      new three.Vector3(6.2, 0, -3.1), new three.Vector3(7.1, 0.16, -3.62),
      new three.Vector3(8.0, 0.35, -3.96), new three.Vector3(8.72, 0.36, -4.0),
    ]);
    const walkers = [];
    const visorMat = createVisorMaterial();
    for (let i = 0; i < 4; i++) {
      const w = new three.Group();
      const suit = new three.MeshStandardMaterial({ color: '#e3e8ea', roughness: 0.6, metalness: 0.15 });
      const bodyC = new three.Mesh(new three.CylinderGeometry(0.2, 0.2, 0.42, 10), suit);
      bodyC.position.y = 0.62; w.add(bodyC);
      const capTop = new three.Mesh(new three.SphereGeometry(0.2, 10, 8), suit); capTop.position.y = 0.83; w.add(capTop);
      const capBot = new three.Mesh(new three.SphereGeometry(0.2, 10, 8), suit); capBot.position.y = 0.41; w.add(capBot);
      const helmet = new three.Mesh(new three.SphereGeometry(0.19, 12, 10), new three.MeshStandardMaterial({ color: '#dfe6ea', roughness: 0.35 }));
      helmet.position.y = 1.02; w.add(helmet);
      const visor = new three.Mesh(
        new three.SphereGeometry(0.195, 16, 12, Math.PI / 2 - 1.2, 2.4, 0.7, 1.4),
        visorMat,
      );
      helmet.add(visor);
      const pack = new three.Mesh(new three.BoxGeometry(0.26, 0.36, 0.14), suit);
      pack.position.set(0, 0.66, -0.26); w.add(pack);
      const stripe = new three.Mesh(new three.BoxGeometry(0.1, 0.05, 0.02),
        new three.MeshStandardMaterial({ color: C.cyan, emissive: C.cyan, emissiveIntensity: 0.6 }));
      stripe.position.set(0, 0.72, 0.2); w.add(stripe);
      const legs = [];
      for (const side of [-1, 1]) {
        const pivot = new three.Group(); pivot.position.set(side * 0.09, 0.4, 0); w.add(pivot);
        const leg = new three.Mesh(new three.BoxGeometry(0.11, 0.36, 0.11), suit);
        leg.position.y = -0.18; pivot.add(leg); legs.push(pivot);
      }
      w.userData = { legs, body: bodyC, helmet };
      scene.add(w); walkers.push(w);
    }

    // launch-day dust and steam pools; per-particle motion is a closed-form
    // function of (t - ignition) so frames stay deterministic and skippable.
    const rand = mulberry32(2026);
    const puffTex = glowTexture();
    const makePool = (count, color, size, spread, rise) => {
      const pos = new Float32Array(count * 3);
      const seeds = [];
      const geo = new three.BufferGeometry();
      geo.setAttribute('position', new three.BufferAttribute(pos, 3));
      const mat = new three.PointsMaterial({ map: puffTex, color, size, transparent: true, opacity: 0.5, depthWrite: false });
      const pts = new three.Points(geo, mat);
      pts.frustumCulled = false; scene.add(pts);
      for (let i = 0; i < count; i++) {
        seeds.push({
          a: rand() * Math.PI * 2, sp: 2 + rand() * spread, delay: rand() * 1.3,
          up: 1.4 + rand() * rise, wob: rand() * Math.PI * 2, life: 2.6 + rand() * 2,
        });
      }
      return { pts, seeds, count, mat };
    };
    const dustPool = makePool(340, 0xc98a5c, 0.55, 8, 4);
    const steamPool = makePool(260, 0xe7c9a9, 1.1, 5, 7);

    // ambient drifting dust for the wide golden-hour shot
    const amb = (() => {
      const n = 500, pos = new Float32Array(n * 3), r = mulberry32(77);
      for (let i = 0; i < n; i++) {
        pos[i * 3] = (r() - 0.5) * 130; pos[i * 3 + 1] = r() * 18; pos[i * 3 + 2] = (r() - 0.5) * 130;
      }
      const geo = new three.BufferGeometry();
      geo.setAttribute('position', new three.BufferAttribute(pos, 3));
      const p = new three.Points(geo, new three.PointsMaterial({ color: 0xd8a37a, size: 0.4, transparent: true, opacity: 0.35, depthWrite: false }));
      p.frustumCulled = false; scene.add(p); return p;
    })();

    // long soft shadows under the crew (cheap, no shadow pass)
    const shadowMat = new three.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false });
    const discs = walkers.map(() => {
      const d = new three.Mesh(new three.CircleGeometry(0.4, 12), shadowMat);
      d.rotation.x = -Math.PI / 2; d.position.y = 0.02; scene.add(d); return d;
    });

    return {
      scene, ref, refLight, rocket, sweep, sweepMat, arm, tower,
      pipeCurve, pipeGlowMat, pulses, walkers, crewPath, dustPool, steamPool, discs, amb,
    };
  }

  /* ---------- space scene (beats 6–8 + report backdrop) ---------- */
  function buildSpace() {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#050403');

    const layers = [];
    const starTex = starTexture();
    const starSeeds = [[130, 260, 0.2, 1.5], [220, 330, 0.5, 2.1], [380, 190, 0.85, 2.9]];
    for (const [radius, count, k, size] of starSeeds) {
      const r = mulberry32(Math.round(radius));
      const pos = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const th = r() * Math.PI * 2, ph = Math.acos(2 * r() - 1), rr = radius * (0.7 + r() * 0.6);
        pos[i * 3] = Math.sin(ph) * Math.cos(th) * rr;
        pos[i * 3 + 1] = Math.cos(ph) * rr;
        pos[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * rr;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const p = new THREE.Points(geo, new THREE.PointsMaterial({
        map: starTex, size, transparent: true, opacity: size > 2.5 ? 0.65 : 0.9,
        depthWrite: false, sizeAttenuation: true, color: size > 2.5 ? C.sand : '#ffffff',
      }));
      p.frustumCulled = false; scene.add(p); layers.push({ pts: p, k });
    }

    const mars = new THREE.Mesh(
      new THREE.SphereGeometry(20, 48, 32),
      new THREE.MeshStandardMaterial({ map: planetTexture('mars'), roughness: 1, metalness: 0 }),
    );
    mars.position.set(-70, 0, 0); scene.add(mars);
    const earth = new THREE.Mesh(
      new THREE.SphereGeometry(30, 48, 32),
      new THREE.MeshStandardMaterial({ map: planetTexture('earth'), roughness: 0.9, metalness: 0.05 }),
    );
    earth.position.set(95, 8, -60); scene.add(earth);

    // fresnel atmosphere rims (blue for Earth, rust haze for Mars)
    const atmo = (color, pw) => new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { col: { value: new THREE.Color(color) }, pw: { value: pw } },
      vertexShader: 'varying vec3 vN; varying vec3 vP; void main(){ vN=normalize(normalMatrix*normal); vec4 mv=modelViewMatrix*vec4(position,1.0); vP=mv.xyz; gl_Position=projectionMatrix*mv; }',
      fragmentShader: 'varying vec3 vN; varying vec3 vP; uniform vec3 col; uniform float pw; void main(){ float f=pow(1.0-abs(dot(normalize(vN),normalize(-vP))),3.0); gl_FragColor=vec4(col*f*f, f); }',
    });
    const marsAtmo = new THREE.Mesh(new THREE.SphereGeometry(21.2, 40, 26), atmo('#b0512e', 1));
    marsAtmo.position.copy(mars.position); scene.add(marsAtmo);
    const earthAtmo = new THREE.Mesh(new THREE.SphereGeometry(31.8, 40, 26), atmo(C.cyan, 1));
    earthAtmo.position.copy(earth.position); scene.add(earthAtmo);

    const sun = new THREE.DirectionalLight(0xfff2df, 1.6);
    sun.position.set(140, 60, 120); scene.add(sun);
    scene.add(new THREE.AmbientLight(0x40342e, 0.7));

    // transfer trajectory: dashed guide ahead of the rocket + glowing arc left behind
    const curve = new THREE.CubicBezierCurve3(
      new THREE.Vector3(-46, 8, 4), new THREE.Vector3(-8, 28, 16),
      new THREE.Vector3(30, 14, -20), new THREE.Vector3(66, 12, -26),
    );
    const guide = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(curve.getPoints(240)),
      new THREE.LineDashedMaterial({ color: C.cyan, dashSize: 2.6, gapSize: 2.2, transparent: true, opacity: 0.45 }),
    );
    guide.computeLineDistances(); scene.add(guide);

    const arcGeo = new THREE.TubeGeometry(curve, 240, 0.55, 6, false);
    const arcMat = new THREE.MeshBasicMaterial({
      color: C.cyan, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const arc = new THREE.Mesh(arcGeo, arcMat);
    arc.geometry.setDrawRange(0, 0);
    scene.add(arc);
    const arcTotal = arcGeo.index.count;

    const rocket = buildRocket();
    rocket.group.scale.setScalar(0.26);
    scene.add(rocket.group);

    const reentry = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), color: C.amber, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    reentry.scale.set(10, 10, 1); scene.add(reentry);

    return { scene, layers, mars, marsAtmo, earth, earthAtmo, curve, guide, arc, arcMat, arcTotal, rocket, reentry };
  }

  /* ---------- camera keyframes ---------- */
  const KF_SURF = [
    { t: 0, p: [-27, 9, 31], l: [-6, 2.2, -1] },
    { t: T.ready, p: [-9, 7, 24], l: [7, 6, -4] },
    { t: T.walk, p: [-18, 5, 14], l: [-22, 1.4, 6.5] },
    { t: 13.6, p: [-7, 4.2, 12.2], l: [-8, 1.2, 2] },
    { t: 16.4, p: [2.4, 3.0, 10.8], l: [7, 1.2, -3.6] },
    { t: T.launch, p: [6.9, 3.8, 12.4], l: [8.9, 4.0, -4] },
    { t: 21.5, p: [9.5, 6.5, 11.5], l: [10, 9.5, -4] },
    { t: T.ignite, p: [10.5, 8, 13], l: [10, 11, -4] },
  ];
  const KF_SPACE = [
    { t: T.depart, p: [-50, 5, 10.5], l: [-70, 0, 0] },
    { t: 30.6, p: [-34, 10, 55], l: [-52, 2, -2] },
    { t: T.cruise, p: [0, 14, 176], l: [2, 4, -10] },
    { t: 36.5, p: [14, 14, 176], l: [12, 5, -12] },
    { t: T.arrive, p: [42, 14, 108], l: [52, 8, -24] },
    { t: 42.6, p: [55, 12, 62], l: [66, 8, -28] },
    { t: T.report, p: [52, 13, 56], l: [66, 8, -28] },
  ];

  function sampleKF(list, t, outP, outL) {
    let i = list.length - 1;
    for (let k = 0; k < list.length - 1; k++) {
      if (t <= list[k + 1].t) { i = k; break; }
    }
    const a = list[i], b = list[Math.min(i + 1, list.length - 1)];
    const f = a === b ? 0 : easeInOut(clamp((t - a.t) / (b.t - a.t), 0, 1));
    outP.set(lerp(a.p[0], b.p[0], f), lerp(a.p[1], b.p[1], f), lerp(a.p[2], b.p[2], f));
    outL.set(lerp(a.l[0], b.l[0], f), lerp(a.l[1], b.l[1], f), lerp(a.l[2], b.l[2], f));
  }

  /* ---------- trajectory progress per beat ---------- */
  function trajectoryU(t) {
    if (t < T.cruise) return lerp(0.015, 0.45, sstep(T.depart, T.cruise, t));
    if (t < T.arrive) return lerp(0.45, 0.8, (t - T.cruise) / (T.arrive - T.cruise));
    return lerp(0.8, 0.985, easeInOut(sstep(T.arrive, T.report, t)));
  }

  /* ---------- timeline edge events (audio + DOM) ---------- */
  const countdown = [
    { at: 19.9, text: '5' }, { at: 20.9, text: '4' }, { at: 21.9, text: '3' },
    { at: 22.9, text: '2' }, { at: 23.7, text: '0' },
  ];
  events.push(
    { at: 0.1, fn: () => { audio.setDrone(0.1, 2); setCap('SOL 10 · <b>PROPELLANT TRANSFER</b> · FUEL PLANT → LAUNCH VEHICLE'); } },
    { at: T.ready, fn: () => {
      ui.card.classList.add('in');
      ui.fuelLbl.textContent = 'PROPELLANT TRANSFER COMPLETE';
      ui.fuelLbl.classList.add('done');
      audio.klaxon();
      setCap('<b>LAUNCH READY</b> · ALL SYSTEMS GO');
    } },
    { at: T.ready + 2.8, fn: () => audio.klaxon() },
    { at: 11.3, fn: () => ui.card.classList.add('out') },
    { at: T.walk, fn: () => setCap('CREW <b>4/4</b> INGRESS · PAD 1') },
    { at: BOARD_END + 0.05, fn: () => { setCap('CREW <b>4/4</b> ABOARD · HATCH SEALING'); audio.klaxon(); } },
    { at: 18.3, fn: () => hideCap() },
    { at: T.launch, fn: () => setCap('SEQUENCE START · GANTRY CLEAR') },
    ...countdown.map((c) => ({ at: c.at, fn: () => { ui.count.textContent = c.text; ui.count.classList.add('show'); audio.tick(); } })),
    { at: T.ignite, fn: () => {
      audio.setDrone(0.05, 0.4); audio.setRoar(0.5, 0.5);
    } },
    { at: T.liftoff, fn: () => {
      ui.count.textContent = 'LIFTOFF'; ui.count.classList.add('go');
      audio.goBlip();
      ui.fuel.style.opacity = '0'; hideCap(); setCap('<b>DEPARTURE</b> · MARS ASCENT');
    } },
    { at: 27.4, fn: () => { ui.count.classList.remove('show', 'go'); } },
    { at: 27.6, fn: () => hideCap() },
    { at: T.depart, fn: () => { audio.setRoar(0.07, 1.1); } },
    { at: 30.2, fn: () => { ui.dist.classList.add('show'); setCap('<b>MARS</b> → <b>EARTH</b> · TRANSFER BURN COMPLETE'); } },
    { at: T.cruise, fn: () => { audio.setRoar(0, 1.2); audio.setShimmer(0.22, 2); audio.setDrone(0.05, 2); } },
    { at: 38.8, fn: () => hideCap() },
    { at: T.arrive, fn: () => {
      audio.setShimmer(0, 1.5); audio.setChord(0.4, 1.6); audio.setDrone(0.04, 1.5);
      setCap('APPROACHING <b>EARTH</b> · ENTRY INTERFACE');
    } },
    { at: 41.6, fn: () => { audio.setChord(0.55, 1); audio.setRoar(0.14, 0.8); } },
    { at: 42.9, fn: () => audio.setRoar(0, 0.9) },
  );

  function fireDue(t) {
    for (let i = 0; i < events.length; i++) {
      if (!fired.has(i) && events[i].at <= t) { fired.add(i); try { events[i].fn(); } catch (e) {} }
    }
  }

  /* ---------- per-frame world update ---------- */
  const vP = three ? new three.Vector3() : null;
  const vL = three ? new three.Vector3() : null;
  const vTmp = three ? new three.Vector3() : null;
  const vTrack = three ? new three.Vector3() : null;
  const UP = three ? new three.Vector3(0, 1, 0) : null;
  let reportT = 0;

  function applyFrame(t, dt) {
    // HUD numerics straight from the timeline
    const fuelP = easeInOut(clamp((t - T.fuelStart) / (T.ready - 1 - T.fuelStart), 0, 1));
    ui.fuelPct.textContent = String(Math.round(fuelP * 100)).padStart(3, '0');
    ui.fuelBar.style.width = (fuelP * 100).toFixed(1) + '%';
    ui.fuel.style.opacity = t > T.liftoff + 1.4 ? '0' : '1';

    if (renderer) {
      const surface = t < T.depart;
      const sc = surface ? surf : space;

      if (surface) paintSurface(t, fuelP);
      else paintSpace(t, dt);

      // dip to black across the Mars-surface → space cut
      const dip = t > 28.5 && t < 29.85
        ? Math.sin(clamp((t - 28.5) / 1.35, 0, 1) * Math.PI)
        : 0;
      ui.fade.style.opacity = dip.toFixed(3);

      renderer.render(sc.scene, camera);
    }

    // arrival flash then report fade-in
    const flash = t > 42.5 && t < 43.4 ? Math.sin((t - 42.5) / 0.9 * Math.PI) * 0.55 : 0;
    ui.flash.style.opacity = flash.toFixed(3);
  }

  function paintSurface(t, fuelP) {
    const S = surf;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();

    sampleKF(KF_SURF, clamp(t, 0, T.ignite), vP, vL);

    // pipeline glow + pulses
    S.pipeGlowMat.opacity = 0.25 + fuelP * 0.5;
    S.pulses.forEach((sp, i) => {
      const u = ((t * 0.24 + i * 0.1) % 1) * fuelP;
      S.pipeCurve.getPoint(clamp(u, 0, 1), sp.position);
      sp.material.opacity = fuelP > 0.02 && fuelP < 1 ? 0.9 : Math.max(0, 0.9 - (t - T.ready) * 0.6);
    });
    S.refLight.material.color.setHex(t % 1 < 0.5 ? 0x6fe3d4 : 0x2a6660);

    // cyan→green readiness sweep climbing the rocket
    if (t >= T.ready && t <= T.walk + 0.6) {
      const cyc = ((t - T.ready) / 2.1) % 1;
      S.sweep.position.set(10, 0.6 + cyc * 14.5, -4);
      S.sweepMat.opacity = clamp((t - T.ready) * 2, 0, 1) * clamp((T.walk + 0.6 - t) * 2, 0, 1) * 0.8;
      S.sweepMat.color.lerpColors(new three.Color(C.cyan), new three.Color(C.green), cyc);
      S.sweep.visible = true;
    } else S.sweep.visible = false;

    // The gantry arm only moves once the hatch is sealed and everyone is aboard.
    const doorOpen = sstep(BOARD.doorOpenAt, BOARD.doorOpenAt + BOARD.doorOpenDur, t);
    const doorShut = sstep(BOARD.doorCloseAt, BOARD.doorCloseAt + BOARD.doorCloseDur, t);
    const doorSwing = doorOpen * (1 - doorShut);
    S.rocket.doorPivot.rotation.y = -doorSwing * 1.62;
    S.rocket.doorLight.intensity = doorSwing * 1.5;
    S.rocket.innerGlowMat.opacity = doorSwing * 0.85;

    // crew filing into the hatch: staggered start, each hidden at the threshold
    let tracked = null;
    S.walkers.forEach((w, i) => {
      const t0 = BOARD.start + i * BOARD.stagger;
      const u = clamp((t - t0) / BOARD.duration, 0, 1);
      const walking = t >= t0 && t < t0 + BOARD.duration;
      S.crewPath.getPoint(u, w.position);
      S.crewPath.getTangent(u, vTmp);
      w.rotation.y = Math.atan2(vTmp.x, vTmp.z);
      const speed = walking ? 1 : 0;
      const phase = t * 8 + i * 0.7;
      w.userData.legs[0].rotation.x = Math.sin(phase) * 0.55 * speed;
      w.userData.legs[1].rotation.x = -Math.sin(phase) * 0.55 * speed;
      w.position.y += Math.abs(Math.sin(phase)) * 0.035 * speed;
      w.visible = walking;
      if (walking && !tracked) tracked = w;
      S.discs[i].position.set(w.position.x, 0.02, w.position.z);
      S.discs[i].visible = walking && u < 0.9;
    });
    if (t >= BOARD.start && t < T.launch) {
      // live-track the lead astronaut still on the pad so the column reads as
      // movement, then hold on the hatch once the last one is inside
      const focus = tracked ?? S.walkers[3];
      focus.getWorldPosition(vTrack);
      vL.set(vTrack.x, vTrack.y + 1.0, vTrack.z);
    }

    if (t >= T.launch) S.arm.rotation.z = sstep(T.launch, T.launch + 2.4, t) * 1.25;

    // ignition: plume, nozzle glow, dust/steam bloom, shake
    const ig = t - T.ignite;
    const igOn = ig >= 0;
    S.rocket.plume.visible = igOn && t < T.depart;
    S.rocket.glow.visible = igOn && t < T.depart;
    if (igOn) {
      const fl = 0.85 + Math.sin(t * 47) * 0.12 + Math.sin(t * 89) * 0.06;
      S.rocket.plume.scale.set(1, fl, 1);
      S.rocket.glow.material.opacity = 0.9 * fl;
      const updatePool = (pool) => {
        const arr = pool.pts.geometry.attributes.position.array;
        for (let i = 0; i < pool.count; i++) {
          const sd = pool.seeds[i];
          const τ = ig - sd.delay;
          const life = τ > 0 && τ < sd.life ? 1 : 0;
          const ang = sd.a + τ * 0.9;
          const r = sd.sp * τ * (1 + τ * 0.2);
          arr[i * 3] = 10 + Math.cos(ang) * r;
          arr[i * 3 + 1] = 0.3 + sd.up * τ + Math.sin(sd.wob + τ * 2) * 0.4;
          arr[i * 3 + 2] = -4 + Math.sin(ang) * r;
          if (!life) arr[i * 3 + 1] = -50;
        }
        pool.pts.geometry.attributes.position.needsUpdate = true;
        pool.mat.opacity = clamp(0.55 - ig * 0.09, 0, 0.55);
      };
      updatePool(S.dustPool); updatePool(S.steamPool);
    }

    // liftoff: quadratic climb + pitch-over, camera tilts up with shake
    const rocketY = t < T.liftoff ? 0.3 : 0.3 + 1.15 * Math.pow(Math.max(0, t - T.ignite - 0.9), 2) + 2.1 * Math.max(0, t - T.liftoff);
    S.rocket.group.position.set(10 - Math.max(0, t - 27) * 0.7, Math.max(0.3, rocketY), -4);
    S.rocket.group.rotation.z = -sstep(26.4, 29, t) * 0.42;
    if (t >= T.liftoff) {
      const up = clamp((t - T.liftoff) / (T.depart - T.liftoff), 0, 1);
      vP.y = lerp(vP.y, 12 + up * 24, up);
      vL.set(S.rocket.group.position.x, S.rocket.group.position.y + 6, S.rocket.group.position.z);
      const shake = igOn ? clamp(1.2 - (t - T.ignite) * 0.18, 0, 1) * 0.35 : 0;
      vP.x += Math.sin(t * 43) * shake;
      vP.y += Math.sin(t * 37) * shake * 0.7;
    }

    S.amb.rotation.y = t * 0.01;
    camera.position.copy(vP);
    camera.lookAt(vL);
  }

  function paintSpace(t, dt) {
    const S = space;
    S.mars.rotation.y += dt * 0.03;
    S.earth.rotation.y += dt * 0.018;
    S.marsAtmo.position.copy(S.mars.position);
    S.earthAtmo.position.copy(S.earth.position);

    // recession drift makes "leaving Mars" legible even when the rocket is small
    S.mars.position.x = -70 - Math.max(0, t - T.depart) * 2.2;

    const u = trajectoryU(t);
    S.curve.getPoint(u, S.rocket.group.position);
    S.curve.getTangent(u, vTmp).normalize();
    S.rocket.group.quaternion.setFromUnitVectors(UP, vTmp);
    S.rocket.group.rotateY(t * 0.15);

    const run = t >= T.arrive ? sstep(T.arrive + 1.4, T.report, t) : 0;
    S.rocket.plume.visible = run < 0.5 && t > T.depart + 0.5;
    S.rocket.glow.visible = t > T.depart + 0.5;
    S.rocket.glow.material.opacity = lerp(0.7, 0.1, u);
    S.rocket.plume.scale.setScalar(0.8 + Math.sin(t * 30) * 0.12);

    S.arc.geometry.setDrawRange(0, Math.floor(clamp((u - 0.01) / 0.99, 0, 1) * S.arcTotal));
    arcMatFade(t);

    ui.au.textContent = (0.52 * (1 - u)).toFixed(2);

    // re-entry: nose glow sprite + streak cone as the rocket clips the atmo
    if (run > 0) {
      S.reentry.visible = true;
      S.reentry.position.copy(S.rocket.group.position);
      S.reentry.material.opacity = run;
      const sc = 6 + run * 22;
      S.reentry.scale.set(sc, sc, 1);
      S.rocket.plume.visible = false;
    } else S.reentry.visible = false;

    // report backdrop: keep the Earth turning, slow camera drift
    if (t >= T.report) reportT += dt;
    const drift = t >= T.report ? reportT : 0;
    sampleKF(KF_SPACE, clamp(t, T.depart, T.report), vP, vL);
    if (drift > 0) {
      vP.x += Math.sin(drift * 0.07) * 5;
      vP.y += Math.sin(drift * 0.05) * 2;
    }
    camera.position.copy(vP);
    camera.lookAt(vL);

    // parallax: layers ride with the camera at different fractions, so
    // nearer stars sweep past while distant ones hang almost still
    S.layers.forEach((L) => {
      L.pts.position.set(camera.position.x * L.k, camera.position.y * L.k, camera.position.z * L.k);
    });

    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  }

  function arcMatFade(t) {
    // brighter while it is being drawn behind the rocket, then let it fade at arrival
    space.arcMat.opacity = t < T.arrive ? 0.85 : lerp(0.85, 0.15, sstep(T.arrive, T.report, t));
  }

  /* ---------- report ---------- */
  const esc = (v) => String(v ?? '—').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const row = (k, v, cls = '') => `<div class="row"><span class="k">${esc(k)}</span><span class="v ${cls}">${esc(v)}</span></div>`;

  function buildReport() {
    const done = topics.filter((tp) => tp && tp.done);
    const crewRows = crew.length
      ? crew.map((c) => row(`${c.name || 'Crew'} · ${c.role || ''}`, `${c.status || '—'} · fatigue ${num(c.fatigue)}%`)).join('')
      : row('Crew', 'no manifest');
    const topicRows = topics.length
      ? topics.map((tp) => row(tp.name || 'Topic', tp && tp.done ? 'DONE' : 'PENDING', tp && tp.done ? 'g' : 'p')).join('')
      : row('Research', 'none recorded');
    const pct = (v) => `${Math.round(num(v))}%`;

    ui.report.innerHTML = `
      <div class="rep">
        <div class="kick">TELEMETRY // FINAL TRANSMISSION</div>
        <h2>MISSION SUCCESSFUL</h2>
        <p class="sub">FOUR ASTRONAUTS. ONE COLONY. ONE JOURNEY HOME.</p>
        <div class="cols">
          <div>
            <div class="sect">ENDURANCE</div>
            ${row('SOLS SURVIVED', num(s.solsSurvived))}
            ${row('HAZARDS SURVIVED', num(s.eventsSurvived))}
            ${row('ROVER TRIPS', num(s.roverTrips))}
            ${row('ICE COLLECTED', `${Math.round(num(s.iceCollected))} kg`)}
            <div class="sect">PROPULSION</div>
            ${row('PROPELLANT MANUFACTURED', pct(s.fuelMade), 'g')}
            ${row('ROCKET FUEL LOADED', pct(s.rocketFuel), 'g')}
            ${row('CARBON COLLECTED', `${Math.round(num(mats.carbon))} kg`)}
            ${row('OXYGEN COLLECTED', `${Math.round(num(mats.oxygen))} kg`)}
            ${row('HYDROGEN COLLECTED', `${Math.round(num(mats.hydrogen))} kg`)}
          </div>
          <div>
            <div class="sect">CREW</div>
            ${crewRows}
            <div class="sect">RESEARCH</div>
            ${topicRows}
            <div class="sect">FINAL RESERVES</div>
            ${row('OXYGEN', pct(res.oxygen))}
            ${row('WATER', pct(res.water))}
            ${row('FOOD', pct(res.food))}
            ${row('POWER', pct(res.battery))}
          </div>
        </div>
        <div class="sect">SUMMARY</div>
        ${row('TOPICS COMPLETED', `${done.length}/${topics.length || 0}`)}
        ${row('CREW RETURNED', `${crew.length || 4}/4`, 'g')}
        <p class="note">Simulation values are simplified for gameplay and are not real Mars engineering data. Transmission logged at ${done.length > 0 ? 'SCI relay' : 'deep-space'} uplink · offline prototype.</p>
        <div class="actions">
          <button class="primary" id="o-return">RETURN TO COLONY</button>
        </div>
      </div>`;
    ui.report.querySelector('#o-return').addEventListener('click', () => finish());
  }

  function enterReport(fromSkip) {
    if (reportShown) return;
    reportShown = true;
    if (fromSkip) {
      timeline.t = T.report;
      // jump the visual state to the last cinematic frame before the panel lands
      for (let i = 0; i < events.length; i++) if (!fired.has(i)) { fired.add(i); }
      ui.count.classList.remove('show');
      ui.fuel.style.opacity = '0';
      ui.dist.classList.add('show');
      ui.au.textContent = '0.01';
      if (renderer) applyFrame(T.report, 0);
      audio.setRoar(0, 0.3); audio.setShimmer(0.05, 0.6); audio.setChord(0.5, 1.2); audio.setDrone(0.05, 1.2);
    }
    buildReport();
    ui.report.hidden = false;
    ui.skip.style.display = 'none';
    requestAnimationFrame(() => ui.report.classList.add('show'));
    setCap('');
    hideCap();
  }

  /* ---------- lifecycle ---------- */
  const timeline = { t: 0 };
  let paused = false;

  function tick(now) {
    if (finished) return;
    raf = requestAnimationFrame(tick);
    const dt = clamp((now - last) / 1000, 0, 0.05);
    last = now;
    if (!reportShown && !paused) timeline.t += dt;
    const t = timeline.t;
    fireDue(t);
    applyFrame(t, paused ? 0 : dt);
    if (t >= T.report) enterReport(false);
  }

  function onResize() {
    if (!renderer) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener('resize', onResize);

  function finish() {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
    try {
      if (renderer) {
        for (const sc of [surf && surf.scene, space && space.scene]) {
          if (!sc) continue;
          sc.traverse((o) => {
            o.geometry?.dispose?.();
            if (o.material) {
              const mats = Array.isArray(o.material) ? o.material : [o.material];
              for (const m of mats) { m.map?.dispose?.(); m.dispose?.(); }
            }
          });
        }
        for (const tex of ownedTextures) tex.dispose?.();
        renderer.dispose();
        try { renderer.forceContextLoss(); } catch (e) {}
      }
    } catch (e) {}
    audio.dispose();
    music.popScene();
    stage.remove();
    try { onDone && onDone(); } catch (e) {}
  }

  function skip() {
    if (finished || reportShown) return;
    enterReport(true);
  }

  /** Cheat-mode shorthand: jump straight to the hatch-boarding beat. */
  function previewBoarding() {
    if (finished || reportShown || !renderer) return false;
    const t0 = T.walk - 1.0;
    timeline.t = t0;
    for (let i = 0; i < events.length; i++) if (events[i].at < t0) fired.add(i);
    ui.card.classList.add('in', 'out');
    ui.fuelLbl.textContent = 'PROPELLANT TRANSFER COMPLETE';
    ui.fuelLbl.classList.add('done');
    ui.fuel.style.opacity = '1';
    applyFrame(t0, 0);
    return true;
  }

  /** Deterministic inspection hook (cheat/testing only): jump, freeze or read the beat. */
  function seek(target) {
    if (finished || reportShown) return false;
    timeline.t = clamp(target, 0, T.report - 0.01);
    for (let i = 0; i < events.length; i++) if (events[i].at < timeline.t) fired.add(i);
    applyFrame(timeline.t, 0);
    return true;
  }

  function boardingState() {
    if (!surf) return null;
    const t = timeline.t;
    const us = surf.walkers.map((w, i) => clamp((t - (BOARD.start + i * BOARD.stagger)) / BOARD.duration, 0, 1));
    const open = sstep(BOARD.doorOpenAt, BOARD.doorOpenAt + BOARD.doorOpenDur, t);
    const shut = sstep(BOARD.doorCloseAt, BOARD.doorCloseAt + BOARD.doorCloseDur, t);
    return {
      t: Number(t.toFixed(2)),
      u: us.map((u) => Number(u.toFixed(2))),
      aboard: us.filter((u) => u >= 1).length,
      walking: us.filter((u) => u > 0 && u < 1).length,
      hatch: Number((open * (1 - shut)).toFixed(2)),
      sealed: shut >= 1,
      paused,
    };
  }

  if (renderer) raf = requestAnimationFrame(tick);
  else enterReport(true); // DOM-only fallback: the report is never skippable, so keep the contract

  return {
    skip,
    isRunning: () => !finished,
    close: finish,
    previewBoarding,
    timeTotal: T.report,
    seek,
    pause: () => { paused = true; },
    resume: () => { paused = false; last = performance.now(); },
    boardingState,
  };
}
