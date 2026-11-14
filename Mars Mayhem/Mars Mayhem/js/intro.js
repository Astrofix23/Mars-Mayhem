/**
 * Cinematic opening sequence for "MARS MAYHEM — The Journey Home".
 *
 * Self-contained visuals: no images or audio files of its own. It builds its own
 * overlay, renderer, scene graph, procedural textures, particles and WebAudio bed,
 * all driven by one master timeline (a single `t` in seconds) so every beat is
 * deterministic and the whole piece can be cut at any instant.
 * Shares the project soundtrack bus (js/music.js); requires the vendored global
 * THREE (js/vendor/three.min.js).
 */

import { music } from './music.js';
import { createVisorMaterial } from './visor.js';

const PAL = {
  rust: '#c96a3c',
  sand: '#e7c9a9',
  basalt: '#120c0a',
  cyan: '#6fe3d4',
  amber: '#f2b661',
  ink: '#f4e7db',
};
const MONO = 'ui-monospace, "SFMono-Regular", "Cascadia Mono", Consolas, monospace';

/* ── master timeline, seconds ────────────────────────────────────────────── */
const T = {
  wide1: 8.2,      // 01 wide, ground level: three rockets on Martian land
  dolly1: 15.0,    // 02 low pass along the bases
  tig1: 20.6,      // 04 M1 ignition, then a vertical climb
  tig2: 25.7,      // 05 M2 ignition and climb — both ships now in the sky
  dipIn: 30.4,     // cut: the plain swaps for the outbound corridor
  space1: 35.8,    // 06 Earth-bound cruise, Mars astern
  padBack: 39.4,   // 07 cut back to the plain: M3 still on its pad
  mars1: 40.0,     // 08 flash — entry to the colony
  colony0: 41.0,
  colony1: 47.4,   // 09 title card
  title0: 47.4,
  title1: 52.4,
};
const TOTAL = 52.5;

/* Region swaps, each hidden by a full-frame dip or flash:
 * pad [0, DIP.mid) · space [DIP.mid, DIP2.mid) · pad [DIP2.mid, FLASH.mid) · surface from FLASH.mid */
const DIP = { in0: T.dipIn - 0.4, mid: T.dipIn + 0.45, out1: T.dipIn + 1.0 };
const DIP2 = { in0: T.space1 + 0.2, mid: T.space1 + 0.5, out1: T.space1 + 0.9 };
const FLASH = { in0: T.padBack, mid: T.mars1, out1: T.colony1 - 2.2 };

const CAPTIONS = [
  [1.2, 7.4, '2041. Three Ares Home rockets stand on the Martian plain. Only two were ever fuelled.'],
  [8.8, 14.6, 'M3 \u2014 the return ship \u2014 is dry. Its propellant went into the two that could fly.'],
  [15.6, 20.0, 'The two loaded ships burn for Earth. The empty one stays on the ground.'],
  [21.4, 25.0, 'M1 away. Vertical off the pad, dust rolling flat across the plain.'],
  [26.2, 29.8, 'M2 away. Two ships climbing out of the Martian sky \u2014 and M3, still standing.'],
  [31.8, 35.2, 'Both ships run down the corridor toward Earth. Four crew stay behind them.'],
  [37.0, 38.9, 'Stranded. Build the propellant, then fly home on the ship that never left.'],
  [40.8, 46.8, 'Outpost protocol: keep the crew alive. Learn the planet. Build the fuel.'],
];
const TAGLINE = 'SURVIVE MARS. BUILD YOUR FUEL. FIND YOUR WAY HOME.';

const TELE_LINES = [
  'INK // ARES-HOME RELAY    DELAY 11:04',
  'FROM: MISSION CONTROL  TO: M3 CREW',
  '',
  'M1 AWAY. M2 AWAY. BOTH FOR EARTH.',
  'M3 HELD ON THE PAD - TANKS DRY.',
  'PROPELLANT COVERED TWO SHIPS ONLY.',
  'FOUR ASTRONAUTS REMAIN ON MARS.',
  '',
  'SURVIVE. BUILD THE RETURN.',
];
const TELE_TEXT = TELE_LINES.join('\n');
const TELE_START = 31.6;
/* Rate is derived so the message always finishes typing before the cut back to M3. */
const TELE_RATE = Math.min(40, TELE_TEXT.length / (T.padBack - TELE_START - 0.5));

/* ── maths ───────────────────────────────────────────────────────────────── */
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, k) => a + (b - a) * k;
const seg = (t, a, b) => clamp01((t - a) / (b - a));
const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
const easeOut = (k) => 1 - (1 - k) ** 3;
const tri = (t, a, b, c) => Math.min(seg(t, a, b), 1 - seg(t, b, c));

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Value noise that wraps on `px` in x, because a sphere map is periodic in
 * longitude; without the wrap every generated planet shows a seam.
 */
function noise2(x, y, px, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const h = (a, b) => {
    const wrapped = ((a % px) + px) % px;
    let n = Math.imul(wrapped + 1, 374761393) ^ Math.imul(b + 1, 668265263) ^ Math.imul(seed, 2246822519);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    n ^= n >>> 16;
    return (n >>> 0) / 4294967296;
  };
  return lerp(lerp(h(ix, iy), h(ix + 1, iy), sx), lerp(h(ix, iy + 1), h(ix + 1, iy + 1), sx), sy);
}

function fbm2(x, y, px, oct, seed) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * noise2(x * freq, y * freq, px * freq, seed + i * 97);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

const height01 = (x, z) => clamp01((fbm2(x * 0.02, z * 0.02, 4096, 4, 733) * 0.72 + 0.14) * 1.6);
/** Distant massif. It only rises beyond 108 m, so the launch plain itself stays flat ground. */
function ridgeY(x, z) {
  const t = clamp01((Math.hypot(x, z) - 108) / 96);
  if (t <= 0) return 0;
  return t * t * (6 + fbm2(x * 0.011, z * 0.011, 4096, 4, 611) * 40);
}
function groundYRaw(x, z) {
  return (height01(x, z) - 0.5) * 9.5 + Math.sin(x * 0.03) * 0.7 + ridgeY(x, z);
}
/* Launch mounts are graded into the plain, so a rocket's base sits on level ground
 * and the terrain still meets the pad at its edge. Register before generating any mesh. */
const LEVEL_PADS = [];
function gradePad(x, z, inner, outer) {
  LEVEL_PADS.push({ x, z, y: groundYRaw(x, z), inner, outer });
}
function gradeY(x, z) {
  let dy = 0;
  for (const p of LEVEL_PADS) {
    const k = 1 - clamp01((Math.hypot(x - p.x, z - p.z) - p.inner) / (p.outer - p.inner));
    if (k <= 0) continue;
    dy += (p.y - groundYRaw(x, z)) * k * k;
  }
  return dy;
}
const groundY = (x, z) => groundYRaw(x, z) + gradeY(x, z);

/* ── procedural canvas textures ──────────────────────────────────────────── */
function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function encode(tex) {
  tex.encoding = THREE.sRGBEncoding;
  tex.needsUpdate = true;
  return tex;
}

function radialTexture(size, stops) {
  const c = canvasOf(size, size);
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const stop of stops) grd.addColorStop(stop[0], stop[1]);
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

function labelTexture(text, color) {
  const c = canvasOf(160, 80);
  const g = c.getContext('2d');
  g.clearRect(0, 0, 160, 80);
  g.font = `bold 42px ${MONO}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = color;
  g.fillText(text, 80, 42);
  return new THREE.CanvasTexture(c);
}

function earthTexture() {
  const w = 512;
  const h = 256;
  const c = canvasOf(w, h);
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    const lat = (y / h) * 2 - 1;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const cont = fbm2(x * 0.0155, y * 0.0155, 512 * 0.0155, 5, 21);
      const detail = fbm2(x * 0.055, y * 0.055, 512 * 0.055, 3, 909);
      const ice = Math.abs(lat) > 0.83 ? clamp01((Math.abs(lat) - 0.83) / 0.13) : 0;
      let r;
      let gr;
      let b;
      if (cont > 0.52 || ice > 0.6) {
        const veg = clamp01(detail * 1.5 - 0.18);
        r = lerp(124, 76, veg);
        gr = lerp(106, 120, veg);
        b = lerp(86, 74, veg);
        r = lerp(r, 244, ice);
        gr = lerp(gr, 247, ice);
        b = lerp(b, 250, ice);
      } else {
        const depth = clamp01((0.52 - cont) * 3.1);
        r = lerp(48, 12, depth);
        gr = lerp(112, 48, depth);
        b = lerp(162, 100, depth);
      }
      const swirl = fbm2(x * 0.021 + lat * 8, y * 0.031, 512 * 0.021, 4, 4477);
      const cloud = clamp01((swirl - 0.46) * 5.2) * (0.5 + 0.5 * Math.cos(lat * 2.3));
      d[i] = lerp(r, 249, cloud);
      d[i + 1] = lerp(gr, 251, cloud);
      d[i + 2] = lerp(b, 254, cloud);
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  return encode(tex);
}

function cloudTexture() {
  const w = 512;
  const h = 256;
  const c = canvasOf(w, h);
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    const lat = (y / h) * 2 - 1;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const band = fbm2(x * 0.019 + Math.sin(lat * 3.4) * 7, y * 0.028, 512 * 0.019, 5, 8123);
      const a = clamp01((band - 0.49) * 4.4) * (0.4 + 0.6 * (1 - lat * lat));
      d[i] = 252;
      d[i + 1] = 252;
      d[i + 2] = 255;
      d[i + 3] = Math.round(clamp01(a) * 205);
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  return encode(tex);
}

function marsTexture() {
  const w = 512;
  const h = 256;
  const c = canvasOf(w, h);
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    const lat = (y / h) * 2 - 1;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const base = fbm2(x * 0.021, y * 0.021, 512 * 0.021, 5, 606);
      const maria = fbm2(x * 0.0075 + 4, y * 0.009, 512 * 0.0075, 3, 1717);
      const streak = fbm2(x * 0.05, y * 0.012, 512 * 0.05, 3, 3311);
      const pole = Math.abs(lat) > 0.88 ? clamp01((Math.abs(lat) - 0.88) / 0.09) : 0;
      let r = lerp(152, 208, base);
      let gr = lerp(72, 112, base);
      let b = lerp(46, 76, base);
      const dark = clamp01((0.5 - maria) * 2.6);
      r = lerp(r, 94, dark * 0.7);
      gr = lerp(gr, 50, dark * 0.7);
      b = lerp(b, 34, dark * 0.7);
      r = lerp(r, 228, streak * 0.13);
      gr = lerp(gr, 188, streak * 0.13);
      b = lerp(b, 152, streak * 0.13);
      d[i] = lerp(r, 242, pole);
      d[i + 1] = lerp(gr, 238, pole);
      d[i + 2] = lerp(b, 234, pole);
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  return encode(tex);
}

function groundTexture() {
  const w = 256;
  const h = 256;
  const c = canvasOf(w, h);
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const n = fbm2(x * 0.05, y * 0.05, 256 * 0.05, 4, 5150);
      const grit = noise2(x * 0.6, y * 0.6, 256 * 0.6, 77);
      const vein = fbm2(x * 0.018, y * 0.09, 256 * 0.018, 3, 991);
      let r = lerp(128, 198, n);
      let gr = lerp(64, 106, n);
      let b = lerp(42, 70, n);
      const shade = clamp01((0.5 - vein) * 1.9);
      r = lerp(r, 90, shade);
      gr = lerp(gr, 46, shade);
      b = lerp(b, 32, shade);
      const speck = 0.82 + grit * 0.34;
      d[i] = Math.min(255, r * speck);
      d[i + 1] = Math.min(255, gr * speck);
      d[i + 2] = Math.min(255, b * speck);
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(7, 7);
  return encode(tex);
}

/* ── particles ───────────────────────────────────────────────────────────── */
const PARTICLE_VS = `
attribute float aLife;
attribute float aSize;
varying float vAlpha;
void main() {
  vAlpha = clamp(aLife, 0.0, 1.0);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (330.0 / max(1.0, -mv.z));
  gl_Position = projectionMatrix * mv;
}`;

const PARTICLE_FS = `
uniform vec3 colorA;
uniform vec3 colorB;
uniform float uAlpha;
varying float vAlpha;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float d = 1.0 - smoothstep(0.04, 0.5, length(p));
  if (d <= 0.001) discard;
  gl_FragColor = vec4(mix(colorA, colorB, 1.0 - vAlpha), d * vAlpha * uAlpha);
}`;

/** Pooled GPU points integrated in JS so plumes, smoke and dust share one path. */
function makeParticles(opts) {
  const count = opts.count;
  const size = opts.size;
  const span = opts.span || 0;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const life = new Float32Array(count);
  const sizes = new Float32Array(count);
  const vel = new Float32Array(count * 3);
  const decay = new Float32Array(count);
  for (let i = 0; i < count; i++) sizes[i] = size;
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aLife', new THREE.BufferAttribute(life, 1));
  geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      colorA: { value: new THREE.Color(opts.colorA) },
      colorB: { value: new THREE.Color(opts.colorB) },
      uAlpha: { value: opts.alpha === undefined ? 1 : opts.alpha },
    },
    vertexShader: PARTICLE_VS,
    fragmentShader: PARTICLE_FS,
    transparent: true,
    depthWrite: false,
    blending: opts.blending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return {
    points,
    geo,
    mat,
    pos,
    life,
    sizes,
    vel,
    decay,
    count,
    span,
    cursor: 0,
    emit(x, y, z, vx, vy, vz, scale) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % count;
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
      vel[i * 3] = vx;
      vel[i * 3 + 1] = vy;
      vel[i * 3 + 2] = vz;
      life[i] = 1;
      sizes[i] = size * (0.55 + Math.random() * 0.8) * (scale || 1);
      decay[i] = 1.05 + Math.random() * 0.8;
    },
    seed(i, x, y, z) {
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
      life[i] = 1;
      decay[i] = 0;
    },
    step(dt, drift) {
      for (let i = 0; i < count; i++) {
        if (life[i] <= 0 && decay[i] === 0) continue;
        if (decay[i] > 0) life[i] -= dt * decay[i];
        pos[i * 3] += vel[i * 3] * dt;
        pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
        pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
        if (drift) {
          pos[i * 3] += drift * dt;
          pos[i * 3 + 1] += Math.sin(pos[i * 3] * 0.09 + i) * dt * 0.45;
        }
        if (span) {
          // ambient field: wrap through the box instead of dying
          if (pos[i * 3] > span * 0.5) pos[i * 3] -= span;
          if (pos[i * 3 + 2] > span * 0.5) pos[i * 3 + 2] -= span;
          if (pos[i * 3 + 1] > 14) pos[i * 3 + 1] = groundY(pos[i * 3], pos[i * 3 + 2]) + 0.4;
        }
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aLife.needsUpdate = true;
      geo.attributes.aSize.needsUpdate = true;
    },
    kill() {
      for (let i = 0; i < count; i++) life[i] = 0;
      geo.attributes.aLife.needsUpdate = true;
    },
  };
}

/** Motion streaks: one additive line per mote, length driven by flow speed. */
function makeStreaks(count, spread, depth) {
  const rnd = mulberry32(90210);
  const pos = new Float32Array(count * 6);
  const motes = [];
  for (let i = 0; i < count; i++) {
    motes.push({
      x: (rnd() - 0.5) * spread,
      y: (rnd() - 0.5) * spread * 0.6,
      z: -depth + rnd() * depth * 1.5,
      s: 0.6 + rnd() * 0.8,
    });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.LineBasicMaterial({
    color: 0xcfe2e6,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;
  return {
    lines,
    mat,
    step(dt, flow, len) {
      for (let i = 0; i < count; i++) {
        const m = motes[i];
        m.z += m.s * flow * dt;
        if (m.z > 80) {
          m.z = -depth + Math.random() * 30;
          m.x = (Math.random() - 0.5) * spread;
          m.y = (Math.random() - 0.5) * spread * 0.6;
        }
        const o = i * 6;
        pos[o] = m.x;
        pos[o + 1] = m.y;
        pos[o + 2] = m.z;
        pos[o + 3] = m.x;
        pos[o + 4] = m.y;
        pos[o + 5] = m.z - len * m.s;
      }
      geo.attributes.position.needsUpdate = true;
    },
  };
}

/* ── builders ────────────────────────────────────────────────────────────── */
function glowSprite(map, color, scale, opacity) {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map,
    color,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity,
  }));
  sprite.scale.setScalar(scale);
  return sprite;
}

/**
 * A two-stage return ship, 25.6 m tall, modelled with its engines at y = 0 so the
 * group can be dropped straight onto the terrain and read as standing on the ground.
 */
function buildRocket(label, tex) {
  const group = new THREE.Group();
  const hull = new THREE.MeshStandardMaterial({ color: 0xdcd6d0, roughness: 0.5, metalness: 0.34 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2c2422, roughness: 0.76, metalness: 0.3 });
  const soot = new THREE.MeshStandardMaterial({ color: 0x17120f, roughness: 0.96, metalness: 0.08 });
  const band = new THREE.MeshStandardMaterial({ color: 0xc96a3c, roughness: 0.62, metalness: 0.2 });

  // Stage one, standing on the engine skirt.
  const s1 = new THREE.Mesh(new THREE.CylinderGeometry(1.62, 1.62, 13.4, 22), hull);
  s1.position.y = 7.6;
  group.add(s1);
  const skirt = new THREE.Mesh(new THREE.CylinderGeometry(1.66, 1.84, 1.5, 22), dark);
  skirt.position.y = 0.75;
  group.add(skirt);
  const bellGeo = new THREE.CylinderGeometry(0.34, 0.62, 1.15, 14);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const bell = new THREE.Mesh(bellGeo, soot);
    bell.position.set(Math.cos(a) * 0.86, 0.58, Math.sin(a) * 0.86);
    group.add(bell);
  }
  const bayRing = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 0.3, 22), soot);
  bayRing.position.y = 1.6;
  group.add(bayRing);

  // Fins, canted outward from the base.
  const finGeo = new THREE.BoxGeometry(0.16, 3.4, 2.1);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const fin = new THREE.Mesh(finGeo, dark);
    fin.position.set(Math.cos(a) * 1.9, 1.9, Math.sin(a) * 1.9);
    fin.rotation.y = -a;
    fin.rotation.z = -0.16;
    group.add(fin);
  }

  // Interstage, stage two, adapter and the crew fairing.
  const inter = new THREE.Mesh(new THREE.CylinderGeometry(1.66, 1.66, 1.1, 22), dark);
  inter.position.y = 14.85;
  group.add(inter);
  const s2 = new THREE.Mesh(new THREE.CylinderGeometry(1.38, 1.38, 5.2, 20), hull);
  s2.position.y = 18.0;
  group.add(s2);
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(1.44, 1.44, 0.34, 20), band);
  collar.position.y = 20.75;
  group.add(collar);
  const adapter = new THREE.Mesh(new THREE.CylinderGeometry(1.16, 1.4, 1.5, 18), hull);
  adapter.position.y = 21.6;
  group.add(adapter);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(1.16, 3.6, 20), hull);
  nose.position.y = 23.9;
  group.add(nose);
  const rollStripe = new THREE.Mesh(new THREE.BoxGeometry(0.1, 11.4, 0.34), dark);
  rollStripe.position.set(0, 8.4, 1.63);
  group.add(rollStripe);

  const plateMat = new THREE.MeshBasicMaterial({ map: tex.labels[label], transparent: true, depthWrite: false });
  const plateGeo = new THREE.PlaneGeometry(3.1, 1.5);
  const front = new THREE.Mesh(plateGeo, plateMat);
  front.position.set(0, 10.4, 1.66);
  group.add(front);
  const back = new THREE.Mesh(plateGeo, plateMat);
  back.position.set(0, 10.4, -1.66);
  back.rotation.y = Math.PI;
  group.add(back);

  const beaconMat = new THREE.MeshStandardMaterial({ color: 0xff5a3c, emissive: 0xff5a3c, emissiveIntensity: 2.4 });
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), beaconMat);
  beacon.position.y = 25.7;
  group.add(beacon);

  const nozzleGlow = glowSprite(tex.glow, 0xffc98a, 5.2, 0);
  nozzleGlow.position.y = -0.5;
  group.add(nozzleGlow);

  return { group, label, beacon, nozzleGlow, home: new THREE.Vector3(), thrust: 0, launched: label !== 'M3', flight: null };
}

/**
 * A launch mount: an octagonal slab graded into the plain, a flame duct cut into the
 * dirt downwind, a low blast fence and ground lamps. Nothing stands over the ship.
 */
function buildLaunchPad(tex) {
  const group = new THREE.Group();
  const concrete = new THREE.MeshStandardMaterial({ color: 0x8c8276, roughness: 0.94, metalness: 0.04 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x7d7068, roughness: 0.58, metalness: 0.4 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x241c18, roughness: 0.9, metalness: 0.2 });

  const slab = new THREE.Mesh(new THREE.CylinderGeometry(6.0, 6.6, 0.8, 8), concrete);
  slab.position.y = 0.1;
  group.add(slab);
  const lip = new THREE.Mesh(new THREE.TorusGeometry(6.05, 0.18, 6, 8), steel);
  lip.rotation.x = Math.PI / 2;
  lip.position.y = 0.5;
  group.add(lip);

  const duct = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.7, 13), dark);
  duct.position.set(0, -0.6, 9.2);
  group.add(duct);
  for (const s of [-1, 1]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.0, 13), concrete);
    wall.position.set(s * 2.5, -0.05, 9.2);
    group.add(wall);
  }

  const fenceGeo = new THREE.BoxGeometry(3.4, 1.7, 0.22);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.52;
    const panel = new THREE.Mesh(fenceGeo, steel);
    panel.position.set(Math.cos(a) * 9.8, 0.65, Math.sin(a) * 9.8);
    panel.rotation.y = -a + Math.PI / 2;
    group.add(panel);
  }

  const lampMat = new THREE.MeshStandardMaterial({
    color: 0xf2b661, emissive: 0xf2b661, emissiveIntensity: 1.5, roughness: 0.5,
  });
  const postGeo = new THREE.CylinderGeometry(0.08, 0.08, 1.3, 6);
  const bulbGeo = new THREE.SphereGeometry(0.16, 8, 6);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const px = Math.cos(a) * 7.1;
    const pz = Math.sin(a) * 7.1;
    const post = new THREE.Mesh(postGeo, steel);
    post.position.set(px, 0.9, pz);
    group.add(post);
    const bulb = new THREE.Mesh(bulbGeo, lampMat);
    bulb.position.set(px, 1.6, pz);
    group.add(bulb);
  }

  const burn = new THREE.Mesh(new THREE.CircleGeometry(6.4, 24),
    new THREE.MeshBasicMaterial({ color: 0x1b120d, transparent: true, opacity: 0, depthWrite: false }));
  burn.rotation.x = -Math.PI / 2;
  burn.position.y = 0.53;
  group.add(burn);

  return { group, burn, lampMat };
}

/**
 * Umbilical tower for one mount: a narrow lattice mast with two swing arms that fold
 * back before flight. It stands beside the rocket, never above it.
 */
function buildServiceTower(tex) {
  const group = new THREE.Group();
  const truss = new THREE.MeshStandardMaterial({ color: 0x544945, roughness: 0.78, metalness: 0.35 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x7d7068, roughness: 0.58, metalness: 0.4 });
  const H = 15.5;

  const legGeo = new THREE.BoxGeometry(0.26, H, 0.26);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, truss);
      leg.position.set(sx * 0.9, H / 2, sz * 0.9);
      group.add(leg);
    }
  }
  const rungX = new THREE.BoxGeometry(2.0, 0.12, 0.12);
  const rungZ = new THREE.BoxGeometry(0.12, 0.12, 2.0);
  for (let j = 1; j < 9; j++) {
    for (const sz of [-1, 1]) {
      const rung = new THREE.Mesh(rungX, steel);
      rung.position.set(0, j * 1.7, sz * 0.9);
      group.add(rung);
    }
    const cross = new THREE.Mesh(rungZ, steel);
    cross.position.set(0, j * 1.7 + 0.85, 0);
    group.add(cross);
  }
  const housing = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.7, 2.2), truss);
  housing.position.y = 0.85;
  group.add(housing);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 3.0, 6), steel);
  mast.position.y = H + 1.5;
  group.add(mast);

  const arms = [];
  for (const y of [4.6, 10.2]) {
    const pivot = new THREE.Group();
    pivot.position.y = y;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(8.4, 0.22, 0.34), steel);
    arm.position.x = 4.2;
    pivot.add(arm);
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.34, 1.0, 0.7), truss);
    shoe.position.x = 8.3;
    pivot.add(shoe);
    group.add(pivot);
    arms.push(pivot);
  }

  const halo = glowSprite(tex.glow, 0xff5a3c, 3.2, 0.5);
  halo.position.y = H + 3.1;
  group.add(halo);
  return { group, arms };
}

/** The supporting launch facility: control bunker, tank farm, comms mast, fenced apron and haul road. */
function buildLaunchFacility(tex) {
  const group = new THREE.Group();
  const shellMat = new THREE.MeshStandardMaterial({ color: 0x9a9086, roughness: 0.9, metalness: 0.06 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x6d6158, roughness: 0.72, metalness: 0.42 });
  const glowMats = [];

  const bunker = new THREE.Mesh(new THREE.BoxGeometry(11, 3.4, 7.4), shellMat);
  bunker.position.set(0, 1.7, 0);
  group.add(bunker);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(11.8, 0.3, 8.2), steel);
  roof.position.y = 3.5;
  group.add(roof);
  const glass = new THREE.MeshStandardMaterial({ color: 0x6fe3d4, emissive: 0x6fe3d4, emissiveIntensity: 1.4, roughness: 0.3 });
  glowMats.push(glass);
  const window = new THREE.Mesh(new THREE.BoxGeometry(7.4, 0.7, 0.16), glass);
  window.position.set(0, 2.5, 3.75);
  group.add(window);

  const sphereGeo = new THREE.SphereGeometry(2.5, 18, 12);
  const legGeo = new THREE.CylinderGeometry(0.14, 0.14, 2.2, 6);
  for (let i = 0; i < 4; i++) {
    const t = new THREE.Mesh(sphereGeo, shellMat);
    t.position.set(-15 + (i % 2) * 6.4, 3.6, -8 - Math.floor(i / 2) * 6.2);
    group.add(t);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + 0.7;
      const leg = new THREE.Mesh(legGeo, steel);
      leg.position.set(t.position.x + Math.cos(a) * 1.9, 1.1, t.position.z + Math.sin(a) * 1.9);
      group.add(leg);
    }
  }
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 13, 8), steel);
  pipe.rotation.z = Math.PI / 2;
  pipe.position.set(-11.8, 1.4, -11.1);
  group.add(pipe);

  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 15, 8), steel);
  mast.position.set(9.5, 7.5, -6);
  group.add(mast);
  const dish = new THREE.Mesh(new THREE.SphereGeometry(1.9, 16, 9, 0, Math.PI * 2, 0, Math.PI / 2.6), shellMat);
  dish.position.set(9.5, 15.2, -6);
  dish.rotation.x = 2.05;
  group.add(dish);

  const postGeo = new THREE.CylinderGeometry(0.09, 0.09, 1.5, 5);
  for (let i = 0; i <= 14; i++) {
    const p = new THREE.Mesh(postGeo, steel);
    p.position.set(-20 + i * 2.6, 0.75, 9);
    group.add(p);
  }
  const rail = new THREE.Mesh(new THREE.BoxGeometry(36.4, 0.08, 0.08), steel);
  rail.position.set(-1.8, 1.45, 9);
  group.add(rail);

  const lampMat = new THREE.MeshStandardMaterial({ color: 0xf2b661, emissive: 0xf2b661, emissiveIntensity: 1.3, roughness: 0.5 });
  glowMats.push(lampMat);
  for (const x of [-13, 6]) {
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 7.4, 6), steel);
    column.position.set(x, 3.7, 6.4);
    group.add(column);
    const head = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.3, 0.5), lampMat);
    head.position.set(x, 7.5, 6.4);
    group.add(head);
    const halo = glowSprite(tex.glow, 0xf2b661, 5, 0.34);
    halo.position.set(x, 7.4, 6.4);
    group.add(halo);
  }

  const roadMat = new THREE.MeshStandardMaterial({ color: 0x6a4230, roughness: 1, metalness: 0.02 });
  const road = new THREE.Mesh(new THREE.BoxGeometry(58, 0.06, 6.2), roadMat);
  road.position.set(24, 0.06, 20);
  road.rotation.y = -0.62;
  group.add(road);

  return { group, glowMats };
}

/** Shallow impact rings on the plain, read as dark basins with a raised rim. */
function buildCraters(seed, count, rMin, rMax) {
  const group = new THREE.Group();
  const rnd = mulberry32(seed);
  const wallMat = new THREE.MeshLambertMaterial({
    color: 0x3f1d13, side: THREE.DoubleSide,
  });
  const floorMat = new THREE.MeshLambertMaterial({ color: 0x2a130c });
  const rimMat = new THREE.MeshLambertMaterial({ color: 0x7a4128 });
  for (let i = 0; i < count; i++) {
    const a = rnd() * Math.PI * 2;
    const d = lerp(rMin, rMax, rnd());
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const r = 7 + rnd() * 16;
    let clear = true;
    for (const p of LEVEL_PADS) {
      if (Math.hypot(x - p.x, z - p.z) < p.outer + r) clear = false;
    }
    if (!clear) continue;
    const c = new THREE.Group();
    c.position.set(x, groundY(x, z), z);
    c.rotation.y = a;
    // A tapered bowl with a floor and a low raised lip: a vertical wall plus a flat ring
    // reads as a plate from a low camera, a cone reads as a hole.
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.46, 3.2, 22, 1, true), wallMat);
    wall.position.y = -1.5;
    c.add(wall);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(r * 0.46, 20), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -3.1;
    c.add(floor);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(r * 1.05, r * 0.1, 5, 20), rimMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.05;
    c.add(rim);
    group.add(c);
  }
  return group;
}

function buildShip(tex, tint, tag) {
  const group = new THREE.Group();
  const hull = new THREE.MeshStandardMaterial({ color: 0xcfc9c4, roughness: 0.5, metalness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x332b28, roughness: 0.7, metalness: 0.5 });

  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, 4.2, 12), hull);
  body.rotation.x = Math.PI / 2;
  group.add(body);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.4, 12), hull);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -2.8;
  group.add(nose);
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 2.4, 10), dark);
  tank.rotation.x = Math.PI / 2;
  tank.position.set(0, -0.72, 0.3);
  group.add(tank);
  for (const s of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.12, 0.9), dark);
    wing.position.set(s * 1.1, 0, 0.4);
    group.add(wing);
  }
  const window = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.1),
    new THREE.MeshStandardMaterial({ color: tint, emissive: tint, emissiveIntensity: 1.5 }));
  window.position.set(0, 0.34, -1.4);
  group.add(window);
  const bellGeo = new THREE.CylinderGeometry(0.2, 0.34, 0.7, 10);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const bell = new THREE.Mesh(bellGeo, dark);
    bell.rotation.x = Math.PI / 2;
    bell.position.set(Math.cos(a) * 0.34, Math.sin(a) * 0.34, 2.25);
    group.add(bell);
  }
  const flare = glowSprite(tex.glow, tint, 4.6, 0);
  flare.position.z = 2.6;
  group.add(flare);
  // A camera-facing tag keeps the two departing ships individually identifiable in the dark.
  let plate = null;
  if (tag) {
    plate = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex.labels[tag], transparent: true, depthWrite: false, opacity: 0.92,
    }));
    plate.scale.set(4.6, 2.3, 1);
    plate.position.y = 2.1;
    group.add(plate);
  }
  return { group, flare, plate };
}

/** Blocky EVA figures — exactly four, matching the stranded crew. */
function buildCrew() {
  const suit = new THREE.MeshStandardMaterial({ color: 0xe3e8ea, roughness: 0.62, metalness: 0.18 });
  const soft = new THREE.MeshStandardMaterial({ color: 0x9aa3a8, roughness: 0.95 });
  const visorMat = createVisorMaterial();
  const lampMat = new THREE.MeshStandardMaterial({
    color: 0x6fe3d4, emissive: 0x6fe3d4, emissiveIntensity: 1.2, roughness: 0.5,
  });
  const crew = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.45;
    const g = new THREE.Group();
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.34), suit);
    torso.position.y = 1.1;
    g.add(torso);
    const hips = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.22, 0.32), suit);
    hips.position.y = 0.7;
    g.add(hips);
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.28, 14, 10), suit);
    helmet.position.y = 1.66;
    g.add(helmet);
    const visor = new THREE.Mesh(
      new THREE.SphereGeometry(0.288, 20, 14, Math.PI / 2 - 1.2, 2.4, 0.7, 1.4),
      visorMat,
    );
    helmet.add(visor);
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.55, 0.22), soft);
    pack.position.set(0, 1.14, -0.28);
    g.add(pack);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.05), lampMat);
    lamp.position.set(0, 1.36, 0.19);
    g.add(lamp);
    for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.66, 0.18), suit);
      leg.position.set(s * 0.13, 0.34, 0);
      g.add(leg);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.52, 0.15), suit);
      arm.position.set(s * 0.32, 1.14, 0);
      g.add(arm);
    }
    const x = Math.cos(a) * 4.4;
    const z = Math.sin(a) * 4.4;
    g.position.set(x, groundY(x, z), z);
    g.rotation.y = -a + Math.PI * 0.6;
    crew.push({ group: g, helmet, baseY: groundY(x, z), phase: i * 1.7 });
  }
  return crew;
}

/** Ten small emissive structures in a ring, used as the distant settlement and the near outpost. */
function buildStructures(tex, radius, seed) {
  const group = new THREE.Group();
  const glowMats = [];
  const metal = new THREE.MeshStandardMaterial({ color: 0x3a2c26, roughness: 0.78, metalness: 0.42 });
  const rnd = mulberry32(seed || 4242);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + 0.2;
    const r = (radius || 30) + rnd() * 8;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const unit = new THREE.Group();
    unit.position.set(x, groundY(x, z), z);
    unit.rotation.y = -a;

    const kind = i % 3;
    const bh = 2.4 + rnd() * 2.2;
    if (kind === 0) {
      const shell = new THREE.Mesh(new THREE.BoxGeometry(3.4, bh, 2.6), metal);
      shell.position.y = bh / 2;
      unit.add(shell);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(3.9, 0.24, 3.1), metal);
      cap.position.y = bh + 0.1;
      unit.add(cap);
    } else if (kind === 1) {
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 3.8, 14), metal);
      drum.rotation.z = Math.PI / 2;
      drum.position.y = 1.5;
      unit.add(drum);
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 3.4, 8), metal);
      mast.position.y = 3.5;
      unit.add(mast);
    } else {
      const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 1.12, bh + 1.6, 12), metal);
      stack.position.y = (bh + 1.6) / 2;
      unit.add(stack);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.1, 6, 18), metal);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = bh + 1.5;
      unit.add(ring);
    }

    const col = i % 4 === 0 ? 0xf2b661 : 0x6fe3d4;
    const gm = new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 1.1 });
    glowMats.push(gm);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.2, 0.09), gm);
    strip.position.set(0, 1 + rnd() * 1.1, 1.33);
    unit.add(strip);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), gm);
    dot.position.set(0, kind === 1 ? 5.2 : bh + 0.5, 0);
    unit.add(dot);

    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex.glow,
      color: col,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.4,
    }));
    halo.scale.setScalar(5);
    halo.position.copy(strip.position);
    unit.add(halo);
    group.add(unit);
  }
  return { group, glowMats };
}

/**
 * Martian terrain: one heightmap function, vertex-tinted by altitude. Both the launch
 * plain and the colony beat build from this so the two shots share one geography.
 */
function buildGround(tex, size, seg) {
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  const cols = new Float32Array(p.count * 3);
  // Same palette as the live world (js/world.js), unconverted: the renderer's ACES pass
  // already lifts these, so a linear-space conversion here made the plain blood-red.
  const low = new THREE.Color(0x3f2218);
  const mid = new THREE.Color(0x7a3d23);
  const high = new THREE.Color(0xa8633a);
  const tmp = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    p.setY(i, groundY(x, z));
    const h = height01(x, z);
    tmp.copy(low).lerp(mid, clamp01(h * 1.6));
    tmp.lerp(high, clamp01((h - 0.5) * 1.4));
    cols[i * 3] = tmp.r;
    cols[i * 3 + 1] = tmp.g;
    cols[i * 3 + 2] = tmp.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  p.needsUpdate = true;
  geo.computeVertexNormals();
  // Lambert, not Standard: a rough PBR surface still hits Fresnel ~1 at grazing angles,
  // which laid a white sheet of specular across the plain between camera and horizon.
  return new THREE.Mesh(
    geo,
    new THREE.MeshLambertMaterial({ map: tex.ground, vertexColors: true }),
  );
}

/** Angular scatter across the plain, sunk into the surface so it reads as buried rock. */
function buildRockField(seed, count, rMin, rMax) {
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  const rockMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x6d4230).convertSRGBToLinear(), roughness: 1, flatShading: true,
  });
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, count);
  const dummy = new THREE.Object3D();
  const rnd = mulberry32(seed);
  for (let i = 0; i < count; i++) {
    const a = rnd() * Math.PI * 2;
    const d = lerp(rMin, rMax, rnd());
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const s = 0.3 + rnd() * 1.5;
    dummy.position.set(x, groundY(x, z) - s * 0.3, z);
    dummy.rotation.set(rnd() * 3.14, rnd() * 3.14, rnd() * 3.14);
    dummy.scale.set(s, s * (0.5 + rnd() * 0.6), s * (0.8 + rnd() * 0.5));
    dummy.updateMatrix();
    rocks.setMatrixAt(i, dummy.matrix);
  }
  rocks.instanceMatrix.needsUpdate = true;
  return rocks;
}

/** Airborne regolith that wraps through a box around the camera: the dusty atmosphere. */
function buildDustField(tex, span, seed, count) {
  const dust = makeParticles({
    count: count || 700, size: 0.4, colorA: 0xe7c9a9, colorB: 0xc96a3c,
    blending: THREE.NormalBlending, alpha: 0.16, span,
  });
  const rnd = mulberry32(seed);
  for (let i = 0; i < dust.count; i++) {
    const x = (rnd() - 0.5) * span;
    const z = (rnd() - 0.5) * span;
    dust.seed(i, x, groundY(x, z) + 1.1 + rnd() * 5.4, z);
    dust.sizes[i] = 0.1 + rnd() * 0.18;
  }
  dust.geo.attributes.aSize.needsUpdate = true;
  return dust;
}

function skyDome(topHex, bottomHex, radius) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { top: { value: new THREE.Color(topHex) }, bottom: { value: new THREE.Color(bottomHex) } },
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec3 vPos;
      uniform vec3 top;
      uniform vec3 bottom;
      void main() {
        float h = normalize(vPos).y * 0.5 + 0.5;
        gl_FragColor = vec4(mix(bottom, top, smoothstep(0.36, 0.94, h)), 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 24, 16), mat);
  mesh.frustumCulled = false;
  return { mesh, mat };
}

/* ── procedural WebAudio ─────────────────────────────────────────────────── */
function createAudio() {
  let ctx = null;
  let master = null;
  let drone = null;
  let rumbleGain = null;
  let rumbleFilter = null;
  let noiseBuffer = null;
  let muted = false;
  let broken = false;

  function build() {
    if (ctx || broken) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('AudioContext unavailable');
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.85;
      master.connect(ctx.destination);

      const frames = Math.floor(ctx.sampleRate * 2);
      noiseBuffer = ctx.createBuffer(1, frames, ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      let acc = 0;
      for (let i = 0; i < frames; i++) {
        // brown noise reads as machinery and wind; white noise only hisses
        acc = (acc + 0.02 * (Math.random() * 2 - 1)) / 1.02;
        data[i] = acc * 3.4;
      }

      const droneGain = ctx.createGain();
      droneGain.gain.value = 0.0001;
      const droneFilter = ctx.createBiquadFilter();
      droneFilter.type = 'lowpass';
      droneFilter.frequency.value = 240;
      droneFilter.Q.value = 5;
      droneGain.connect(droneFilter);
      droneFilter.connect(master);
      const voices = [['sine', 55, 0, 0.5], ['sine', 82.4, -7, 0.3], ['triangle', 110, 9, 0.18], ['sawtooth', 27.5, 3, 0.11]];
      for (const v of voices) {
        const osc = ctx.createOscillator();
        osc.type = v[0];
        osc.frequency.value = v[1];
        osc.detune.value = v[2];
        const g = ctx.createGain();
        g.gain.value = v[3];
        osc.connect(g);
        g.connect(droneGain);
        osc.start();
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 0.05 + Math.random() * 0.06;
        const lfoGain = ctx.createGain();
        lfoGain.gain.value = 1.6;
        lfo.connect(lfoGain);
        lfoGain.connect(osc.detune);
        lfo.start();
      }
      const sweep = ctx.createOscillator();
      sweep.frequency.value = 0.07;
      const sweepDepth = ctx.createGain();
      sweepDepth.gain.value = 140;
      sweep.connect(sweepDepth);
      sweepDepth.connect(droneFilter.frequency);
      sweep.start();
      drone = { gain: droneGain, filter: droneFilter };

      const rumbleSrc = ctx.createBufferSource();
      rumbleSrc.buffer = noiseBuffer;
      rumbleSrc.loop = true;
      rumbleFilter = ctx.createBiquadFilter();
      rumbleFilter.type = 'lowpass';
      rumbleFilter.frequency.value = 80;
      rumbleFilter.Q.value = 3;
      rumbleGain = ctx.createGain();
      rumbleGain.gain.value = 0;
      rumbleSrc.connect(rumbleFilter);
      rumbleFilter.connect(rumbleGain);
      rumbleGain.connect(master);
      rumbleSrc.start();
    } catch (err) {
      broken = true;
      ctx = null;
    }
  }

  function noiseSource() {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    return src;
  }

  return {
    resume() {
      build();
      if (!broken) {
        try {
          ctx.resume();
        } catch (err) {
          /* ignore */
        }
      }
    },
    isBroken() {
      return broken;
    },
    toggleMute() {
      muted = !muted;
      build();
      if (!broken) {
        try {
          master.gain.setTargetAtTime(muted ? 0 : 0.85, ctx.currentTime, 0.05);
        } catch (err) {
          /* ignore */
        }
      }
      return muted;
    },
    setBed(level, cutoff, rumble) {
      if (broken) return;
      try {
        const now = ctx.currentTime;
        drone.gain.gain.setTargetAtTime(level, now, 0.35);
        drone.filter.frequency.setTargetAtTime(cutoff, now, 0.6);
        rumbleGain.gain.setTargetAtTime(rumble, now, 0.2);
        rumbleFilter.frequency.setTargetAtTime(70 + rumble * 420, now, 0.3);
      } catch (err) {
        /* ignore */
      }
    },
    whoosh(strength) {
      if (broken) return;
      try {
        const now = ctx.currentTime;
        const src = noiseSource();
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(1500 * strength, now);
        bp.frequency.exponentialRampToValueAtTime(110, now + 1.1);
        bp.Q.value = 1.4;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(0.45, now + 0.12);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 1.15);
        src.connect(bp);
        bp.connect(g);
        g.connect(master);
        src.start(now);
        src.stop(now + 1.3);
      } catch (err) {
        /* ignore */
      }
    },
    blip(pitch) {
      if (broken) return;
      try {
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.value = pitch;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 1450;
        bp.Q.value = 5.5;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(0.14, now + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
        osc.connect(bp);
        bp.connect(g);
        g.connect(master);
        osc.start(now);
        osc.stop(now + 0.09);

        const crackle = noiseSource();
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 900;
        const cg = ctx.createGain();
        cg.gain.setValueAtTime(0.045, now);
        cg.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
        crackle.connect(hp);
        hp.connect(cg);
        cg.connect(master);
        crackle.start(now);
        crackle.stop(now + 0.06);
      } catch (err) {
        /* ignore */
      }
    },
    chord() {
      if (broken) return;
      try {
        const now = ctx.currentTime;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(320, now);
        lp.frequency.linearRampToValueAtTime(2600, now + 2.8);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, now);
        g.gain.linearRampToValueAtTime(0.3, now + 2.6);
        g.gain.linearRampToValueAtTime(0.0001, now + 7.4);
        lp.connect(g);
        g.connect(master);
        for (const v of [[110, 'sine', 0.6], [164.81, 'triangle', 0.4], [220, 'sine', 0.34], [329.63, 'triangle', 0.22], [440, 'sine', 0.15]]) {
          const osc = ctx.createOscillator();
          osc.type = v[1];
          osc.frequency.value = v[0];
          const og = ctx.createGain();
          og.gain.value = v[2];
          osc.connect(og);
          og.connect(lp);
          osc.start(now);
          osc.stop(now + 7.5);
        }
      } catch (err) {
        /* ignore */
      }
    },
    dispose() {
      if (broken || !ctx) return;
      broken = true;
      try {
        ctx.close();
      } catch (err) {
        /* ignore */
      }
      ctx = null;
    },
  };
}

/* ── injected stylesheet ─────────────────────────────────────────────────── */
const STYLE_TEXT = `
#intro-stage {
  position: fixed; inset: 0; z-index: 100; background: ${PAL.basalt};
  color: ${PAL.ink}; font-family: ${MONO}; overflow: hidden;
}
#intro-stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
#intro-stage .lyr { position: absolute; inset: 0; pointer-events: none; }
#intro-vignette { background: radial-gradient(120% 88% at 50% 48%, transparent 40%, rgba(9,5,4,0.8) 100%); }
#intro-scan {
  background: repeating-linear-gradient(to bottom, rgba(111,227,212,0.035) 0 1px, transparent 1px 3px);
  mix-blend-mode: screen;
}
#intro-fade { background: ${PAL.basalt}; opacity: 0; }
#intro-flash {
  background: radial-gradient(circle at 50% 46%, #fff6ec 0%, ${PAL.amber} 42%, rgba(201,106,60,0) 76%);
  opacity: 0;
}
.c-mark {
  position: absolute; top: 18px; left: 22px; font-size: 11px; letter-spacing: 0.18em;
  color: ${PAL.cyan}; text-transform: uppercase; opacity: 0.85; pointer-events: none;
}
.c-mark b { color: ${PAL.amber}; font-weight: 600; }
.c-rule {
  position: absolute; top: 40px; left: 22px; width: 200px; height: 1px;
  background: linear-gradient(to right, ${PAL.cyan}, transparent); pointer-events: none;
}
#intro-controls { position: absolute; top: 14px; right: 16px; display: flex; gap: 8px; }
.intro-btn {
  font-family: ${MONO}; font-size: 12px; letter-spacing: 0.16em; text-transform: uppercase;
  color: ${PAL.ink}; background: rgba(18,12,10,0.74); border: 1px solid ${PAL.rust};
  padding: 9px 15px; cursor: pointer; pointer-events: auto;
  transition: background 150ms linear, color 150ms linear, border-color 150ms linear;
}
.intro-btn:hover { background: ${PAL.rust}; color: #1a0f0a; }
.intro-btn.ghost { border-color: rgba(231,201,169,0.42); color: ${PAL.sand}; background: rgba(18,12,10,0.6); }
.intro-btn.ghost:hover { border-color: ${PAL.cyan}; color: ${PAL.cyan}; background: rgba(111,227,212,0.14); }
.intro-btn kbd {
  font-family: inherit; font-size: 10px; border: 1px solid rgba(244,231,219,0.34);
  padding: 0 4px; margin-left: 7px; opacity: 0.72;
}
#intro-caption {
  position: absolute; left: 50%; bottom: 7vh; transform: translateX(-50%);
  width: min(90vw, 880px); text-align: center; font-size: clamp(13px, 1.55vw, 20px);
  letter-spacing: 0.045em; line-height: 1.5; color: ${PAL.ink}; opacity: 0; pointer-events: none;
  text-shadow: 0 0 18px rgba(111,227,212,0.32), 0 2px 12px rgba(0,0,0,0.85);
}
#intro-caption::before {
  content: ""; display: block; width: 46px; height: 1px; margin: 0 auto 12px;
  background: ${PAL.cyan}; opacity: 0.8;
}
#intro-tele {
  position: absolute; left: 6vw; top: 17vh; width: min(430px, 74vw);
  border: 1px solid rgba(111,227,212,0.5); background: rgba(12,8,7,0.8);
  padding: 14px 16px; font-size: 12.5px; line-height: 1.74; letter-spacing: 0.06em;
  color: ${PAL.cyan}; white-space: pre-wrap; opacity: 0; pointer-events: none;
  box-shadow: 0 0 44px rgba(111,227,212,0.16);
}
#intro-tele .th {
  color: ${PAL.amber}; letter-spacing: 0.22em; font-size: 10.5px; text-transform: uppercase;
  border-bottom: 1px solid rgba(242,182,97,0.35); padding-bottom: 6px; margin-bottom: 9px;
}
#intro-tele .caret {
  display: inline-block; width: 8px; height: 13px; vertical-align: -2px;
  background: ${PAL.cyan}; animation: intro-blink 0.9s steps(1) infinite;
}
@keyframes intro-blink { 50% { opacity: 0; } }
#intro-title {
  position: absolute; inset: 0; display: grid; place-items: center; opacity: 0; pointer-events: none;
  background: radial-gradient(72% 54% at 50% 52%, rgba(18,12,10,0.86) 0%, rgba(18,12,10,0.58) 44%, rgba(18,12,10,0) 76%);
}
#intro-title .stack { text-align: center; padding: 0 6vw; }
.t-eyebrow { font-size: 11px; letter-spacing: 0.4em; color: ${PAL.cyan}; text-transform: uppercase; }
.t-main { font-size: clamp(26px, 5.1vw, 66px); margin: 10px 0 0; font-weight: 700; letter-spacing: 6px; color: ${PAL.ink}; }
.t-sub { font-size: clamp(14px, 2vw, 25px); letter-spacing: 0.34em; color: ${PAL.rust}; margin-top: 8px; text-transform: uppercase; }
.t-tag { font-size: clamp(12px, 1.5vw, 19px); letter-spacing: 0.2em; color: ${PAL.amber}; margin-top: 26px; }
.t-brief { font-size: clamp(11px, 1.15vw, 14px); line-height: 1.9; color: ${PAL.sand}; margin: 20px auto 0; max-width: 640px; }
.t-obj {
  display: inline-block; margin-top: 22px; padding: 10px 18px; font-size: clamp(11px, 1.2vw, 15px);
  letter-spacing: 0.18em; color: ${PAL.ink}; border: 1px solid ${PAL.cyan}; background: rgba(111,227,212,0.1);
}
`;

/* ───────────────────────────── entry point ─────────────────────────────── */
let activeFinish = null;

export function playIntro({ onDone } = {}) {
  if (activeFinish) activeFinish();
  // A previous instance that died mid-build can leave nodes behind; never stack overlays.
  document.querySelectorAll('#intro-stage, #intro-style').forEach((node) => node.remove());

  const styleEl = document.createElement('style');
  styleEl.id = 'intro-style';
  styleEl.textContent = STYLE_TEXT;
  document.head.appendChild(styleEl);

  const root = document.createElement('div');
  root.id = 'intro-stage';
  root.setAttribute('role', 'presentation');

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.setClearColor(0x03020a, 1);
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.06;
  root.appendChild(renderer.domElement);

  function makeLayer(id) {
    const el = document.createElement('div');
    el.id = id;
    el.className = 'lyr';
    root.appendChild(el);
    return el;
  }
  makeLayer('intro-vignette');
  const scanEl = makeLayer('intro-scan');
  const fadeEl = makeLayer('intro-fade');
  const flashEl = makeLayer('intro-flash');

  const chrome = document.createElement('div');
  chrome.style.position = 'absolute';
  chrome.style.inset = '0';
  chrome.style.pointerEvents = 'none';
  chrome.innerHTML =
    '<div class="c-mark">ARES-HOME // SEQ <b id="intro-seq">01</b> &nbsp;<span id="intro-tc">T+000.0</span></div>' +
    '<div class="c-rule"></div>';
  root.appendChild(chrome);
  const seqEl = chrome.querySelector('#intro-seq');
  const tcEl = chrome.querySelector('#intro-tc');

  const captionEl = document.createElement('div');
  captionEl.id = 'intro-caption';
  root.appendChild(captionEl);

  const teleEl = document.createElement('div');
  teleEl.id = 'intro-tele';
  teleEl.innerHTML = '<div class="th">incoming transmission</div><span id="intro-tele-body"></span><span class="caret"></span>';
  root.appendChild(teleEl);
  const teleBody = teleEl.querySelector('#intro-tele-body');

  const titleEl = document.createElement('div');
  titleEl.id = 'intro-title';
  titleEl.innerHTML =
    '<div class="stack">' +
    '<div class="t-eyebrow">2041 \u00b7 Ares Home Expedition</div>' +
    '<div class="t-main" id="tt-main">MARS MAYHEM</div>' +
    '<div class="t-sub" id="tt-sub">The Journey Home</div>' +
    `<div class="t-tag" id="tt-tag">${TAGLINE}</div>` +
    '<p class="t-brief" id="tt-brief">Three rockets were planned. Two left the pad. Four astronauts stay on Mars' +
    ' with a station to keep alive, a planet to learn and a return propellant still to be built.</p>' +
    '<div class="t-obj" id="tt-obj">OBJECTIVE: BUILD RETURN PROPELLANT. FLY ALL FOUR HOME.</div>' +
    '</div>';
  root.appendChild(titleEl);
  const ttMain = titleEl.querySelector('#tt-main');
  const ttSub = titleEl.querySelector('#tt-sub');
  const ttTag = titleEl.querySelector('#tt-tag');
  const ttBrief = titleEl.querySelector('#tt-brief');
  const ttObj = titleEl.querySelector('#tt-obj');

  const controls = document.createElement('div');
  controls.id = 'intro-controls';
  const muteBtn = document.createElement('button');
  muteBtn.className = 'intro-btn ghost';
  muteBtn.type = 'button';
  muteBtn.innerHTML = 'SOUND ON<kbd>M</kbd>';
  const skipBtn = document.createElement('button');
  skipBtn.className = 'intro-btn';
  skipBtn.type = 'button';
  skipBtn.innerHTML = 'SKIP INTRO<kbd>ESC</kbd>';
  skipBtn.setAttribute('aria-label', 'Skip the opening sequence');
  controls.appendChild(muteBtn);
  controls.appendChild(skipBtn);
  root.appendChild(controls);

  document.body.appendChild(root);

  /* ── scene, textures ── */
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 2600);
  scene.add(camera);

  const textures = [];
  const audio = createAudio();
  // Layer the score under the procedural bed; the gameplay level returns on exit.
  music.ensure();
  music.pushScene('intro');
  const keep = (tex) => {
    textures.push(tex);
    return tex;
  };
  const texLib = {
    glow: keep(radialTexture(128, [[0, 'rgba(255,255,255,1)'], [0.32, 'rgba(255,216,164,0.5)'], [1, 'rgba(255,186,116,0)']])),
    ground: keep(groundTexture()),
    labels: {
      M1: keep(labelTexture('M1', PAL.ink)),
      M2: keep(labelTexture('M2', PAL.ink)),
      M3: keep(labelTexture('M3', PAL.cyan)),
    },
  };

  const rnd = mulberry32(2041);

  /* Starfield is re-centred on the camera each frame, so a modest field reads as deep space. */
  const STAR_COUNT = 2400;
  const starPos = new Float32Array(STAR_COUNT * 3);
  const starLife = new Float32Array(STAR_COUNT);
  const starSize = new Float32Array(STAR_COUNT);
  for (let i = 0; i < STAR_COUNT; i++) {
    const u = rnd() * 2 - 1;
    const th = rnd() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const r = 620 + rnd() * 420;
    starPos[i * 3] = s * Math.cos(th) * r;
    starPos[i * 3 + 1] = u * r;
    starPos[i * 3 + 2] = s * Math.sin(th) * r;
    starLife[i] = 0.3 + rnd() * 0.7;
    starSize[i] = 0.7 + rnd() * 2.1;
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  starGeo.setAttribute('aLife', new THREE.BufferAttribute(starLife, 1));
  starGeo.setAttribute('aSize', new THREE.BufferAttribute(starSize, 1));
  const starMat = new THREE.ShaderMaterial({
    uniforms: {
      colorA: { value: new THREE.Color(PAL.ink) },
      colorB: { value: new THREE.Color(0x9fb8d6) },
      uAlpha: { value: 1 },
    },
    vertexShader: PARTICLE_VS,
    fragmentShader: PARTICLE_FS,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const stars = new THREE.Points(starGeo, starMat);
  stars.frustumCulled = false;
  scene.add(stars);

  /* ── Earth: the destination, held back for the outbound corridor ── */
  const earthGroup = new THREE.Group();
  earthGroup.position.set(26, 44, -300);
  scene.add(earthGroup);

  const earthTex = keep(earthTexture());
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(30, 48, 32),
    new THREE.MeshStandardMaterial({ map: earthTex, color: 0xd8e4f0, roughness: 0.92, metalness: 0 }),
  );
  earthGroup.add(earth);

  const cloudTex = keep(cloudTexture());
  const clouds = new THREE.Mesh(
    new THREE.SphereGeometry(30.6, 40, 26),
    new THREE.MeshStandardMaterial({ map: cloudTex, transparent: true, roughness: 1, depthWrite: false }),
  );
  earthGroup.add(clouds);

  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(32.4, 40, 26),
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { rim: { value: new THREE.Color(0x7fc4ff) } },
      vertexShader: `
        varying vec3 vN;
        varying vec3 vView;
        void main() {
          vN = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vView = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vN;
        varying vec3 vView;
        uniform vec3 rim;
        void main() {
          float f = pow(1.0 - max(dot(normalize(vN), normalize(vView)), 0.0), 2.7);
          gl_FragColor = vec4(rim, f * 0.85);
        }`,
    }),
  );
  earthGroup.add(atmosphere);
  const earthHalo = glowSprite(texLib.glow, 0x8fd0ff, 74, 0.3);
  earthGroup.add(earthHalo);

  /* ── region 1: the launch plain — three ships standing on Martian ground ── */
  const pad = new THREE.Group();
  scene.add(pad);
  const padFog = new THREE.FogExp2(0xb0714e, 0.0026);

  const MOUNTS = [
    { label: 'M1', x: -22, z: 10, tig: T.tig1 },
    { label: 'M2', x: 0, z: 0, tig: T.tig2 },
    { label: 'M3', x: 22, z: 10, tig: null },
  ];
  // Graded apron under each mount: wide enough for the flame duct, blast fence and lamps
  // so nothing on the pad sits on an unlevelled slope.
  for (const m of MOUNTS) gradePad(m.x, m.z, 13, 38);
  gradePad(-64, -46, 20, 58);

  pad.add(buildGround(texLib, 480, 160));
  const plainDome = skyDome(0x6d4634, 0xc07f52, 250);
  pad.add(plainDome.mesh);
  pad.add(buildRockField(606, 150, 13, 205));
  pad.add(buildCraters(4747, 9, 74, 200));

  const plainDust = buildDustField(texLib, 210, 555, 320);
  pad.add(plainDust.points);

  // The settlement, well out on the plain but inside the ridge wall: the ships' crew are
  // already living there.
  const farColony = buildStructures(texLib, 94, 1313);
  pad.add(farColony.group);
  {
    const shellMat = new THREE.MeshStandardMaterial({ color: 0x8c8276, roughness: 0.9, metalness: 0.06 });
    const glass = new THREE.MeshStandardMaterial({
      color: 0xbfe4dd, roughness: 0.35, metalness: 0.1, transparent: true, opacity: 0.45,
      emissive: 0x2c5c58, emissiveIntensity: 0.7,
    });
    for (const s of [[-72, -56, 8], [-47, -85, 6.2], [22, -94, 7.4], [68, -67, 5.6]]) {
      const shell = new THREE.Mesh(new THREE.SphereGeometry(s[2], 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), shellMat);
      shell.position.set(s[0], groundY(s[0], s[1]), s[1]);
      pad.add(shell);
      const band = new THREE.Mesh(new THREE.SphereGeometry(s[2] * 0.88, 18, 6, 0, Math.PI * 2, 1.1, 0.55), glass);
      band.position.copy(shell.position);
      pad.add(band);
    }
  }

  const facility = buildLaunchFacility(texLib);
  facility.group.position.set(-64, groundY(-64, -46), -46);
  facility.group.rotation.y = 0.66;
  pad.add(facility.group);

  // Three separate mounts, three separate ships. Each stands on its own graded ground.
  const mounts = [];
  const rockets = [];
  for (const m of MOUNTS) {
    const gx = groundY(m.x, m.z);
    const mount = buildLaunchPad(texLib);
    mount.group.position.set(m.x, gx, m.z);
    pad.add(mount.group);

    const tower = buildServiceTower(texLib);
    tower.group.position.set(m.x - 10, groundY(m.x - 10, m.z), m.z);
    pad.add(tower.group);

    const rocket = buildRocket(m.label, texLib);
    rocket.home.set(m.x, gx + 0.5, m.z);
    rocket.group.position.copy(rocket.home);
    rocket.tig = m.tig;
    pad.add(rocket.group);

    mounts.push({ mount, tower, rocket });
    rockets.push(rocket);
  }

  const plume = makeParticles({ count: 1500, size: 1.5, colorA: 0xfff0c4, colorB: 0xc96a3c, blending: THREE.AdditiveBlending, alpha: 0 });
  pad.add(plume.points);
  const smoke = makeParticles({ count: 700, size: 4.2, colorA: 0xd8c6ba, colorB: 0x3a2a24, blending: THREE.NormalBlending, alpha: 0.5 });
  pad.add(smoke.points);
  // Ground wash: the exhaust turning the regolith sideways across the plain.
  const kick = makeParticles({ count: 1100, size: 3.1, colorA: 0xe7c9a9, colorB: 0x8a4a2c, blending: THREE.NormalBlending, alpha: 0.9 });
  pad.add(kick.points);

  const padSun = new THREE.DirectionalLight(0xffe0bd, 1.5);
  padSun.position.set(-150, 66, -180);
  pad.add(padSun);
  const padBounce = new THREE.DirectionalLight(0x8f5a3c, 0.25);
  padBounce.position.set(120, 40, 150);
  pad.add(padBounce);
  pad.add(new THREE.HemisphereLight(0xd9a184, 0x3d2418, 0.6));
  const padSunDisc = glowSprite(texLib.glow, 0xfff2dc, 30, 0.6);
  padSunDisc.position.set(-115, 50, -138);
  pad.add(padSunDisc);
  const padFlood = new THREE.PointLight(0x6fe3d4, 0, 90);
  padFlood.position.set(-64, 12, -46);
  pad.add(padFlood);

  /* ── region 2: the outbound corridor — both ships climbing away from Mars ── */
  const transit = new THREE.Group();
  transit.visible = false;
  scene.add(transit);
  transit.add(earthGroup);

  const marsTex = keep(marsTexture());
  const mars = new THREE.Mesh(
    new THREE.SphereGeometry(26, 48, 32),
    new THREE.MeshStandardMaterial({ map: marsTex, roughness: 0.94, metalness: 0, emissive: 0x2a110a, emissiveIntensity: 0.3 }),
  );
  // Six times the sphere, hung low and astern of the corridor: the planet they have left.
  mars.scale.setScalar(6);
  mars.position.set(-40, -175, -70);
  transit.add(mars);
  const marsHalo = glowSprite(texLib.glow, 0xd07a44, 300, 0.24);
  marsHalo.position.copy(mars.position);
  transit.add(marsHalo);

  const ships = [buildShip(texLib, 0x6fe3d4, 'M1'), buildShip(texLib, 0xf2b661, 'M2')];
  for (const s of ships) transit.add(s.group);

  const streaks = makeStreaks(320, 280, 320);
  transit.add(streaks.lines);
  const driveFlame = makeParticles({ count: 420, size: 0.85, colorA: 0xdff6ff, colorB: 0x6fe3d4, blending: THREE.AdditiveBlending, alpha: 0.9 });
  transit.add(driveFlame.points);

  const transitLight = new THREE.DirectionalLight(0xfff4e4, 2.4);
  transitLight.position.set(-1050, 420, 300);
  transit.add(transitLight);
  transit.add(new THREE.AmbientLight(0x141a24, 0.5));

  /* ── region 3: the Martian surface and the outpost ── */
  const surface = new THREE.Group();
  surface.visible = false;
  scene.add(surface);

  surface.add(buildGround(texLib, 480, 160));

  const dome = skyDome(0x24140f, 0xb0714e, 250);
  surface.add(dome.mesh);

  surface.add(buildRockField(8181, 110, 12, 150));

  const structures = buildStructures(texLib, 30, 4242);
  surface.add(structures.group);

  {
    const shellMat = new THREE.MeshStandardMaterial({ color: 0x4a352d, roughness: 0.78, metalness: 0.3 });
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 8.6, 18), shellMat);
    drum.rotation.z = Math.PI / 2;
    drum.position.set(-7, groundY(-7, -9) + 2.6, -9);
    surface.add(drum);
    const igloo = new THREE.Mesh(new THREE.SphereGeometry(3.4, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), shellMat);
    igloo.position.set(8, groundY(8, -7), -7);
    surface.add(igloo);
    const pvMat = new THREE.MeshStandardMaterial({
      color: 0x1d2b33, roughness: 0.4, metalness: 0.7, emissive: 0x0d2a2a, emissiveIntensity: 0.6,
    });
    for (let i = 0; i < 3; i++) {
      const pv = new THREE.Mesh(new THREE.BoxGeometry(6.4, 0.16, 2.6), pvMat);
      pv.position.set(-17 + i * 0.6, groundY(-17, 11 + i * 3.2) + 1.7 + i * 0.2, 11 + i * 3.2);
      pv.rotation.set(-0.5, 0.18, 0);
      surface.add(pv);
    }
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 9, 8), shellMat);
    mast.position.set(3, groundY(3, -15) + 4.5, -15);
    surface.add(mast);
    const dish = new THREE.Mesh(new THREE.SphereGeometry(1.2, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2.4), shellMat);
    dish.position.set(3, groundY(3, -15) + 9, -15);
    dish.rotation.x = 2.1;
    surface.add(dish);
  }

  const crew = buildCrew();
  for (const c of crew) surface.add(c.group);

  const dust = buildDustField(texLib, 170, 2041, 700);
  surface.add(dust.points);

  const sunLight = new THREE.DirectionalLight(0xffb07a, 1.6);
  surface.add(sunLight);
  const skyLight = new THREE.HemisphereLight(0xc07f52, 0x3a2118, 0.75);
  surface.add(skyLight);
  const siteLight = new THREE.PointLight(0x6fe3d4, 6, 70);
  siteLight.position.set(0, 8, 0);
  surface.add(siteLight);
  const sunDisc = glowSprite(texLib.glow, 0xffd2a0, 62, 0);
  surface.add(sunDisc);

  /* ── camera ── */
  const _cTop = new THREE.Color(0x4a2e22);
  const _cBottom = new THREE.Color(0xc9784a);
  const _p = new THREE.Vector3();
  const _q = new THREE.Vector3();
  const _look = new THREE.Vector3();
  const _la = new THREE.Vector3();
  const _lb = new THREE.Vector3();

  function placeCam(ax, ay, az, bx, by, bz, k, lax, lay, laz, lbx, lby, lbz, lk) {
    _p.set(ax, ay, az);
    _q.set(bx, by, bz);
    camera.position.lerpVectors(_p, _q, k);
    _la.set(lax, lay, laz);
    _lb.set(lbx, lby, lbz);
    _look.lerpVectors(_la, _lb, lk);
    camera.lookAt(_look);
  }

  function cameraTrack(t) {
    let shake = 0;

    if (t < T.wide1) {
      // 01 Wide at ground level: the plain, three ships standing on it, the settlement beyond.
      const k = easeInOut(seg(t, 0.4, T.wide1));
      const cx = lerp(74, 50, k);
      const cz = lerp(110, 78, k);
      camera.position.set(cx, groundY(cx, cz) + lerp(7.5, 5.4, k), cz);
      _look.set(-2, lerp(15, 12, k), 4);
      camera.lookAt(_look);
      camera.fov = lerp(54, 47, k);
    } else if (t < T.dolly1) {
      // 02 A low pass along the bases. The ground line stays in frame the whole way.
      const k = easeInOut(seg(t, T.wide1, T.dolly1));
      placeCam(-52, groundY(-52, 62) + 5.2, 62, 50, groundY(50, 58) + 5.6, 58, k,
        -22, 9, 10, 22, 10, 10, k);
      camera.fov = lerp(48, 44, k);
    } else if (t < T.tig1) {
      // 03 Hold: the umbilicals swing clear and the plain settles.
      const k = easeInOut(seg(t, T.dolly1, T.tig1));
      placeCam(36, groundY(36, 66) + 5.4, 66, 28, groundY(28, 60) + 5.0, 60, k,
        -2, 12, 4, 0, 13, 2, k);
      camera.fov = lerp(46, 48, k);
      shake = tri(t, T.tig1 - 1.2, T.tig1 - 0.3, T.tig1) * 0.12;
    } else if (t < T.tig2) {
      // 04 M1 lights and climbs straight off the deck; the camera tracks it up.
      const k = easeInOut(seg(t, T.tig1 + 1.4, T.tig2));
      const up = clamp01((rockets[0].group.position.y - rockets[0].home.y) / 150);
      placeCam(40, groundY(40, 56) + 3.6, 58, 78, groundY(78, 104) + 16, 104, k,
        -22, lerp(11, 34, up), 10, -22, lerp(34, 132, up), 10, k);
      camera.fov = lerp(46, 54, k);
      shake = Math.max(0, 0.5 - seg(t, T.tig1, T.tig1 + 2.6) * 0.5);
    } else if (t < DIP.mid) {
      // 05 M2 follows. Both ships in one frame; the third is still on its mount.
      const k = easeInOut(seg(t, T.tig2, DIP.in0));
      const midY = (rockets[0].group.position.y + rockets[1].group.position.y) * 0.5;
      placeCam(-14, groundY(-14, 128) + 8, 128, 10, groundY(10, 150) + 20, 150, k,
        -2, lerp(26, midY, 0.9), 8, -2, lerp(54, midY, 0.9), 8, k);
      camera.fov = lerp(52, 62, k);
      shake = 0.16 * (1 - seg(t, T.tig2, T.tig2 + 3));
    } else if (t < DIP2.mid) {
      // 06 The corridor: both ships running down the road to Earth, Mars astern and below.
      const k = easeInOut(seg(t, DIP.mid, DIP2.in0));
      placeCam(4, 8, 132, -18, 30, 46, k, 6, 26, -140, 22, 40, -250, k);
      camera.fov = lerp(50, 44, k);
    } else if (t < FLASH.mid) {
      // 07 Back on the plain: two burnt-out mounts and the ship that never left.
      const k = easeInOut(seg(t, DIP2.out1, FLASH.in0));
      placeCam(-52, groundY(-52, 86) + 6.5, 86, -18, groundY(-18, 70) + 9, 70, k,
        -22, 11, 10, 22, 13, 10, k);
      camera.fov = lerp(52, 46, k);
    } else if (t < T.colony1) {
      const k = easeInOut(seg(t, T.mars1, T.colony0 + 3.2));
      placeCam(-14, 152, 118, 26, groundY(26, 48) + 2.6, 48, k, 0, 26, 0, 0, 4.4, 0, easeOut(seg(t, T.mars1, T.colony0 + 2.4)));
      const drift = easeInOut(seg(t, T.colony0 + 3.2, T.colony1));
      const cx = lerp(26, 9, drift);
      const cz = lerp(48, 26, drift);
      camera.position.set(cx, groundY(cx, cz) + lerp(2.6, 3.5, drift), cz);
      _look.set(lerp(0, -2, drift), 4.4, lerp(0, -6, drift));
      camera.lookAt(_look);
      camera.fov = lerp(64, 48, drift);
      shake = (1 - seg(t, T.mars1, T.colony0 + 1.4)) * 0.5;
    } else {
      const k = easeInOut(seg(t, T.title0, T.title1));
      const cx = lerp(9, 4.5, k);
      const cz = lerp(26, 19, k);
      camera.position.set(cx, groundY(cx, cz) + lerp(3.5, 3.1, k), cz);
      _look.set(-1, 5.2, -4);
      camera.lookAt(_look);
      camera.fov = lerp(48, 40, k);
    }

    camera.updateProjectionMatrix();
    if (shake > 0.001) {
      camera.position.x += (Math.sin(t * 61.3) * 0.42 + Math.sin(t * 27.1) * 0.22) * shake;
      camera.position.y += Math.sin(t * 53.7 + 1.2) * 0.36 * shake;
      camera.position.z += Math.cos(t * 47.9) * 0.3 * shake;
      camera.rotation.z += Math.sin(t * 41) * 0.012 * shake;
    }
  }

  /* ── per-beat scene animation ── */
  const CLIMB_A = 4.6;   // m/s² once the hold-down clamps release
  const HOLD_DOWN = 1.5;

  function updatePad(dt) {
    const t = elapsed;
    // Past the dip the two departed ships are above the shot; only M3 stays in frame.
    const departed = t >= DIP.mid;

    let loudest = 0;
    for (let i = 0; i < mounts.length; i++) {
      const mt = mounts[i];
      const r = mt.rocket;

      const pre = r.tig ? clamp01(seg(t, r.tig - 2.4, r.tig - 0.4)) : 0;
      for (const arm of mt.tower.arms) arm.rotation.y = -pre * 1.3;

      const ign = r.tig ? clamp01(seg(t, r.tig, r.tig + 0.8)) : 0;
      const hover = r.tig ? t - r.tig - HOLD_DOWN : -1;
      const rise = hover > 0 ? 0.5 * CLIMB_A * hover * hover : 0;
      const shudder = rise <= 0 ? Math.sin(t * 43 + i * 2.2) * 0.05 * ign : 0;

      r.group.position.set(r.home.x + shudder, r.home.y + rise, r.home.z);
      r.group.rotation.z = shudder * 0.14;
      r.group.visible = !(departed && r.launched);
      r.thrust = ign * (1 - seg(t, DIP.in0, DIP.mid) * 0.9);
      r.nozzleGlow.material.opacity = r.thrust * 0.92;
      r.nozzleGlow.scale.setScalar(3 + r.thrust * 9);
      loudest = Math.max(loudest, r.thrust);

      if (r.thrust > 0.02) {
        const b = r.group.position;
        for (let k = 0; k < 16; k++) {
          plume.emit(
            b.x + (Math.random() - 0.5) * 1.3,
            b.y - 1.0 - Math.random() * 0.7,
            b.z + (Math.random() - 0.5) * 1.3,
            (Math.random() - 0.5) * 5,
            -20 - Math.random() * 16,
            (Math.random() - 0.5) * 5,
            1,
          );
        }
        const near = 1 - clamp01(rise / 26);
        if (near > 0) {
          const px = r.home.x;
          const pz = r.home.z;
          const py = groundY(px, pz);
          for (let k = 0; k < 14 * near; k++) {
            const a = Math.random() * Math.PI * 2;
            const sp = 12 + Math.random() * 22;
            kick.emit(px + Math.cos(a) * 3.2, py + 0.4 + Math.random() * 1.4, pz + Math.sin(a) * 3.2,
              Math.cos(a) * sp, 1.2 + Math.random() * 3.4, Math.sin(a) * sp, 1.6);
          }
          if (Math.random() < 0.9) {
            smoke.emit(
              b.x + (Math.random() - 0.5) * 6,
              b.y - 1.8 - Math.random() * 2,
              b.z + (Math.random() - 0.5) * 6,
              (Math.random() - 0.5) * 9,
              -1.2 - Math.random() * 2.4,
              (Math.random() - 0.5) * 9,
              2.2,
            );
          }
        }
        mt.mount.burn.material.opacity = Math.min(0.8, mt.mount.burn.material.opacity + dt * 0.8);
      }
    }
    plume.mat.uniforms.uAlpha.value = loudest * 0.95;
    plume.step(dt);
    smoke.step(dt);
    kick.step(dt);

    plainDust.step(dt, 5.2 + Math.sin(t * 0.5) * 1.6);
    plainDust.points.position.set(camera.position.x, 0, camera.position.z);
    padSunDisc.material.opacity = 0.6 - loudest * 0.22;
    padFlood.intensity = 3 + Math.sin(t * 1.7) * 0.6;
    for (const m of facility.glowMats) m.emissiveIntensity = 1.2 + Math.sin(t * 2.3) * 0.2;
    for (const m of farColony.glowMats) m.emissiveIntensity = 1.1 + Math.sin(t * 1.9) * 0.25;
  }

  function updateSpace(dt) {
    const t = elapsed;
    earth.rotation.y += dt * 0.024;
    clouds.rotation.y += dt * 0.034;
    mars.rotation.y += dt * 0.006;

    const push = seg(t, DIP.mid, DIP2.in0);
    const flow = lerp(120, 26, seg(t, DIP.mid, DIP2.in0));
    streaks.mat.opacity = 0.5 * seg(t, DIP.mid, DIP.mid + 0.6) * (1 - seg(t, DIP2.in0, DIP2.mid));
    streaks.step(dt, flow, lerp(26, 8, push));

    // Two ships, two lanes: separated laterally and tinted, so they never read as one.
    for (let i = 0; i < ships.length; i++) {
      const s = ships[i];
      const lane = i === 0 ? -1 : 1;
      s.group.position.set(
        lane * (15 + Math.sin(t * 0.5 + i) * 1.6),
        lane * -6 + push * 15 + Math.cos(t * 0.6 + i * 2) * 1.1,
        lerp(56, -196, push) + lane * 22,
      );
      s.group.rotation.z = Math.sin(t * 0.9 + i) * 0.05;
      s.group.rotation.y = lane * 0.07;
      const fade = seg(t, DIP.mid + 0.3, DIP.mid + 1.1) * (1 - seg(t, DIP2.in0 - 0.4, DIP2.in0));
      s.flare.material.opacity = 0.9 * fade;
      s.flare.scale.setScalar(3.6 + Math.sin(t * 18 + i) * 0.7);
      if (s.plate) s.plate.material.opacity = 0.92 * fade;
      if (fade > 0.05) {
        for (let j = 0; j < 5; j++) {
          driveFlame.emit(
            s.group.position.x + (Math.random() - 0.5) * 0.5,
            s.group.position.y + (Math.random() - 0.5) * 0.5,
            s.group.position.z + 2.6,
            (Math.random() - 0.5) * 2,
            (Math.random() - 0.5) * 2,
            60 + Math.random() * 46,
            1,
          );
        }
      }
    }
    driveFlame.step(dt);
    earthHalo.material.opacity = 0.26 + push * 0.12;
    marsHalo.material.opacity = 0.26 * (1 - push * 0.4);
  }

  function updateSurface(dt) {
    const t = elapsed;
    /* Sun drops toward the horizon across the colony beat: the ring lights take over. */
    const day = 1 - seg(t, T.colony0 + 2, T.title0 + 1.4);
    const az = -2.4;
    const elev = lerp(11, -2, 1 - day);
    // The key light must stay above the horizon even after the visible sun disc has set.
    sunLight.position.set(Math.cos(az) * 130, Math.max(3, elev) * 10, Math.sin(az) * 130);
    // The title card sits over this frame, so pull the whole exposure down as it arrives.
    const tdim = 1 - 0.66 * seg(t, T.title0 - 0.8, T.title0 + 1.4);
    sunLight.intensity = lerp(0.5, 1.85, seg(t, T.colony0, T.colony0 + 1.2)) * lerp(0.35, 1, day) * tdim;
    sunLight.color.setHex(day > 0.4 ? 0xffd0a2 : 0xff8f5c);
    sunDisc.position.set(Math.cos(az) * 172, elev * 11 + 3, Math.sin(az) * 172);
    sunDisc.material.opacity = lerp(0.1, 0.8, day) * seg(t, T.mars1, T.colony0 + 1.2);
    sunDisc.scale.setScalar(lerp(46, 78, 1 - day));

    dome.mat.uniforms.top.value.setHex(0x190e0b).lerp(_cTop, day * 0.6);
    dome.mat.uniforms.bottom.value.setHex(0x2a1712).lerp(_cBottom, day);
    skyLight.intensity = lerp(0.16, 0.8, day) * tdim;

    const glow = lerp(0.6, 2.2, 1 - day) * tdim;
    for (const m of structures.glowMats) m.emissiveIntensity = glow;
    siteLight.intensity = 1.4 + glow * 2.4;

    const wind = lerp(3.4, 8.6, 1 - seg(t, T.colony0, T.colony1)) + Math.sin(t * 0.6) * 1.2;
    dust.step(dt, wind);
    dust.points.position.set(camera.position.x, 0, camera.position.z);

    for (const c of crew) {
      const sway = Math.sin(t * 1.15 + c.phase) * 0.022;
      c.group.position.y = c.baseY + Math.abs(Math.sin(t * 0.8 + c.phase)) * 0.02;
      c.helmet.position.y = 1.66 + sway * 0.7;
      c.group.rotation.z = sway * 0.55;
    }
  }

  /* ── DOM layer ── */
  let lastCaption = -1;
  let lastTeleChars = -1;
  let lastSeq = '';

  function beatLabel(t) {
    if (t < T.wide1) return '01';
    if (t < T.dolly1) return '02';
    if (t < T.tig1) return '03';
    if (t < T.tig2) return '04';
    if (t < DIP.mid) return '05';
    if (t < DIP2.mid) return '06';
    if (t < FLASH.mid) return '07';
    if (t < T.colony1) return '08';
    return '09';
  }

  function updateDom() {
    const t = elapsed;

    let fade = 1 - seg(t, 0, 1.2);
    fade = Math.max(fade, tri(t, DIP.in0, DIP.mid, DIP.out1));
    fade = Math.max(fade, tri(t, DIP2.in0, DIP2.mid, DIP2.out1));
    fade = Math.max(fade, seg(t, TOTAL - 1.6, TOTAL));
    fadeEl.style.opacity = clamp01(fade).toFixed(3);

    const flash = tri(t, FLASH.in0, FLASH.mid, FLASH.out1) * 0.94 + (1 - seg(t, 0.4, 2.8)) * 0.14;
    flashEl.style.opacity = clamp01(flash).toFixed(3);

    const inSpace = t >= DIP.mid && t < DIP2.mid;
    stars.visible = inSpace;
    starMat.uniforms.uAlpha.value = inSpace ? 1 : 0;
    if (inSpace) stars.position.copy(camera.position);
    scanEl.style.opacity = lerp(0.5, 0.22, seg(t, T.colony0, T.title0)).toFixed(2);

    let idx = -1;
    for (let i = 0; i < CAPTIONS.length; i++) {
      if (t >= CAPTIONS[i][0] && t <= CAPTIONS[i][1]) {
        idx = i;
        break;
      }
    }
    if (idx >= 0) {
      const cap = CAPTIONS[idx];
      const op = clamp01(Math.min(seg(t, cap[0], cap[0] + 0.8), 1 - seg(t, cap[1] - 0.8, cap[1])));
      if (idx !== lastCaption) {
        captionEl.textContent = cap[2];
        lastCaption = idx;
      }
      captionEl.style.opacity = op.toFixed(3);
      captionEl.style.transform = `translateX(-50%) translateY(${((1 - op) * 10).toFixed(2)}px)`;
    } else {
      captionEl.style.opacity = '0';
    }

    teleEl.style.opacity = clamp01(seg(t, TELE_START - 0.4, TELE_START + 0.3) * (1 - seg(t, FLASH.in0, FLASH.in0 + 0.6))).toFixed(3);
    if (t > TELE_START && t < FLASH.in0 + 0.6) {
      const n = Math.max(0, Math.min(TELE_TEXT.length, Math.floor((t - TELE_START) * TELE_RATE)));
      if (n !== lastTeleChars) {
        teleBody.textContent = TELE_TEXT.slice(0, n);
        if (n > lastTeleChars && n % 4 === 0) audio.blip(980 + Math.random() * 540);
        lastTeleChars = n;
      }
    }

    const titleOn = t > T.title0 - 0.6;
    titleEl.style.opacity = titleOn ? (1 - seg(t, TOTAL - 1.4, TOTAL)).toFixed(3) : '0';
    if (titleOn) {
      const a = easeOut(seg(t, T.title0 - 0.5, T.title0 + 1.5));
      const b = easeOut(seg(t, T.title0 + 0.3, T.title0 + 2.1));
      const c = easeOut(seg(t, T.title0 + 1, T.title0 + 2.7));
      const d = easeOut(seg(t, T.title0 + 1.6, T.title0 + 3.2));
      const e = easeOut(seg(t, T.title0 + 2.3, T.title0 + 3.7));
      ttMain.style.opacity = a.toFixed(3);
      ttMain.style.letterSpacing = `${lerp(26, 6, a).toFixed(2)}px`;
      ttSub.style.opacity = b.toFixed(3);
      ttSub.style.letterSpacing = `${lerp(18, 12, b).toFixed(2)}px`;
      ttTag.style.opacity = c.toFixed(3);
      ttTag.style.letterSpacing = `${lerp(14, 6, c).toFixed(2)}px`;
      ttTag.style.transform = `translateY(${((1 - c) * 12).toFixed(2)}px)`;
      ttBrief.style.opacity = (d * 0.92).toFixed(3);
      ttObj.style.opacity = e.toFixed(3);
      ttObj.style.transform = `translateY(${((1 - e) * 10).toFixed(2)}px)`;
    }

    tcEl.textContent = `T+${t.toFixed(1).padStart(5, '0')}`;
    const seq = beatLabel(t);
    if (seq !== lastSeq) {
      seqEl.textContent = seq;
      lastSeq = seq;
    }
  }

  /* ── audio marks and continuous bed ── */
  const marks = [
    [T.tig1 - 0.2, () => audio.blip(1320)],
    [T.tig2 - 0.2, () => audio.blip(1180)],
    [DIP.in0, () => audio.whoosh(1.2)],
    [DIP2.in0, () => audio.whoosh(0.8)],
    [FLASH.in0, () => audio.whoosh(2.1)],
    [T.title0, () => audio.chord()],
  ];
  let markIdx = 0;

  function updateAudio() {
    const t = elapsed;
    while (markIdx < marks.length && t >= marks[markIdx][0]) {
      marks[markIdx][1]();
      markIdx++;
    }
    let level = 0.05;
    let cutoff = 240;
    let rumble = 0;
    if (t < T.tig1) {
      level = 0.06;
      cutoff = 250;
    } else if (t < T.tig2) {
      level = 0.17;
      cutoff = 470;
      rumble = 0.85 * seg(t, T.tig1, T.tig1 + 0.8) * (1 - seg(t, T.tig1 + 3.4, T.tig2) * 0.7);
    } else if (t < DIP.mid) {
      level = 0.14;
      cutoff = 420;
      rumble = 0.8 * seg(t, T.tig2, T.tig2 + 0.8) * (1 - seg(t, T.tig2 + 2.6, DIP.in0));
    } else if (t < DIP2.mid) {
      level = 0.1;
      cutoff = 540;
      rumble = 0.05;
    } else if (t < FLASH.mid) {
      level = 0.07;
      cutoff = 280;
      rumble = 0.02;
    } else if (t < T.colony1) {
      level = 0.09;
      cutoff = 380;
      rumble = 0.14 * (1 - seg(t, T.colony0, T.colony0 + 3));
    } else {
      level = 0.16;
      cutoff = 900;
      rumble = 0.03;
    }
    audio.setBed(level, cutoff, rumble);
  }

  /* ── loop ── */
  let elapsed = 0;
  let raf = 0;
  let last = performance.now();
  let finished = false;

  function frame() {
    if (finished) return;
    raf = requestAnimationFrame(frame);
    // Wall clock only: rAF timestamps can lag performance.now(), which would run the timeline backwards.
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    elapsed += dt;
    if (elapsed >= TOTAL) {
      finish();
      return;
    }

    const onPad = elapsed < DIP.mid || (elapsed >= DIP2.mid && elapsed < FLASH.mid);
    pad.visible = onPad;
    transit.visible = !onPad && elapsed < FLASH.mid;
    surface.visible = elapsed >= FLASH.mid;
    scene.fog = onPad ? padFog : null;

    cameraTrack(elapsed);
    if (pad.visible) updatePad(dt);
    if (transit.visible) updateSpace(dt);
    if (surface.visible) updateSurface(dt);
    updateDom();
    updateAudio();

    renderer.render(scene, camera);
  }

  function onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
  }

  function onKey(ev) {
    if (ev.code === 'Escape' || ev.code === 'Space') {
      ev.preventDefault();
      ev.stopPropagation();
      finish();
    } else if (ev.code === 'KeyM') {
      ev.preventDefault();
      flipMute();
    }
  }

  function flipMute() {
    const muted = audio.toggleMute();
    music.setMuted(muted);
    muteBtn.innerHTML = `${muted ? 'SOUND OFF' : 'SOUND ON'}<kbd>M</kbd>`;
    muteBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
  }

  function finish() {
    if (finished) return;
    finished = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    activeFinish = null;

    window.removeEventListener('resize', onResize);
    window.removeEventListener('keydown', onKey, true);
    audio.dispose();
    music.popScene();

    scene.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      const material = obj.material;
      if (!material) return;
      const list = Array.isArray(material) ? material : [material];
      for (const mat of list) {
        if (mat.map) mat.map.dispose();
        mat.dispose();
      }
    });
    for (const tex of textures) tex.dispose();

    try {
      renderer.dispose();
    } catch (err) {
      /* ignore */
    }
    try {
      renderer.forceContextLoss();
    } catch (err) {
      /* ignore */
    }

    if (root.parentNode) root.parentNode.removeChild(root);
    if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);

    if (typeof onDone === 'function') {
      try {
        onDone();
      } catch (err) {
        console.error('[intro] onDone threw', err);
      }
    }
  }

  skipBtn.addEventListener('click', finish);
  muteBtn.addEventListener('click', flipMute);
  window.addEventListener('resize', onResize);
  window.addEventListener('keydown', onKey, true);
  audio.resume();

  const api = { skip: () => finish(), isRunning: () => !finished, timeTotal: TOTAL };
  activeFinish = finish;
  raf = requestAnimationFrame(frame);
  return api;
}
