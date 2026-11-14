/**
 * js/industry.js — procedural models and per-frame visual sync for the endgame
 * systems: the FUEL-PROCESSOR (methane/LOX propellant plant), the return rocket
 * on its launch site and the four crew berths inside the HAB.
 *
 * Contract for js/colony.js:
 *   build*(group, facility)      adds meshes, allocates every geometry and
 *                                material, and stores its animated handles on
 *                                facility.fuelParts / rocketParts / bunkParts.
 *   update*(facility, sim, time) mutates transforms, visibility, colours and
 *                                material.emissiveIntensity only. Never
 *                                allocates, never throws — while a save is being
 *                                migrated whole branches of the state may be
 *                                missing, so every read is guarded.
 *
 * Nothing but config constants is imported: THREE is the vendored r128 global
 * that index.html loads before any module runs.
 */

import { FUEL } from './config.js';

const PAL = {
  rust: 0xc96a3c,
  sand: 0xe7c9a9,
  basalt: 0x120c0a,
  cyan: 0x6fe3d4,
  amber: 0xf2b661,
  green: 0x8fd06a,
  red: 0xef6a5a,
  steel: 0x9aa0a6,
  dusty: 0x9a7256,
  graphite: 0x2b2622,
  cryo: 0xbfdfe6,
  violet: 0xdccfff,
};

/* ───────────────────────────── shared idioms ───────────────────────────── */

function mat(color, o = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.25, ...o });
}

function emiss(color, intensity = 1, o = {}) {
  return new THREE.MeshStandardMaterial({
    color: PAL.basalt, emissive: color, emissiveIntensity: intensity, roughness: 0.6, ...o,
  });
}

function add(parent, geometry, material, x = 0, y = 0, z = 0, shadow = true) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  m.castShadow = shadow;
  m.receiveShadow = shadow;
  parent.add(m);
  return m;
}

function rotate(mesh, x = 0, y = 0, z = 0) {
  mesh.rotation.set(x, y, z);
  return mesh;
}

/**
 * Bar with its origin at one end so a single scale write is a fill level:
 * axis 'y' grows up from the anchor, axis 'x' grows toward +x.
 */
function fillBar(parent, material, w, h, d, x, y, z, axis = 'y') {
  const geo = new THREE.BoxGeometry(w, h, d);
  if (axis === 'x') geo.translate(w / 2, 0, 0);
  else geo.translate(0, h / 2, 0);
  return add(parent, geo, material, x, y, z, false);
}

/** Straight pipe between two local points, used for the runs between vessels. */
function pipeBetween(parent, material, ax, ay, az, bx, by, bz, r = 0.13) {
  const dir = new THREE.Vector3(bx - ax, by - ay, bz - az);
  const len = dir.length() || 0.001;
  const mesh = add(parent, new THREE.CylinderGeometry(r, r, len, 8), material,
    (ax + bx) / 2, (ay + by) / 2, (az + bz) / 2, false);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return mesh;
}

/** One LineSegments object carries every guy-wire of a structure. */
function guyWires(parent, origin, anchors, height) {
  const pts = [];
  for (const [dx, dz] of anchors) pts.push(0, height, 0, dx, 0.4, dz);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: PAL.dusty, transparent: true, opacity: 0.5 }));
  lines.position.set(origin[0], origin[1], origin[2]);
  parent.add(lines);
  return lines;
}

function canvasTexture(width, height, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  draw(ctx, canvas);
  const texture = new THREE.CanvasTexture(canvas);
  // r128 has no ColorManagement/outputColorSpace; canvas art needs the sRGB hint.
  texture.encoding = THREE.sRGBEncoding;
  return texture;
}

function screenMaterial(texture, color) {
  return new THREE.MeshStandardMaterial({
    color: PAL.basalt, map: texture, emissive: color, emissiveMap: texture,
    emissiveIntensity: 1, roughness: 0.55, metalness: 0,
  });
}

/** 0..100 sim field → 0..1; a missing or non-numeric field reads as empty. */
function lvl(v) {
  return Number.isFinite(v) ? THREE.MathUtils.clamp(v, 0, 100) / 100 : 0;
}

/** Kilograms of a raw feedstock → how full that vessel looks, against its store. */
function storeLvl(kg, kind) {
  const cap = FUEL.store[kind] || 100;
  return Number.isFinite(kg) ? THREE.MathUtils.clamp(kg / cap, 0, 1) : 0;
}

function clock(t) {
  return Number.isFinite(t) ? t : 0;
}

/* ───────────────────────────── FUEL-PROCESSOR ───────────────────────────── */

/**
 * Industrial plant on a ~14 m footprint. In this project a facility group's
 * local +Z faces the colony centre, so the console and the service catwalk are
 * built to read from that side and the propellant transfer line leaves off the
 * -X edge, which is where the launch pad sits.
 */
export function buildFuelProcessor(group, facility) {
  const steel = mat(PAL.steel, { roughness: 0.55, metalness: 0.72 });
  const rust = mat(PAL.dusty, { roughness: 0.95, metalness: 0.3 });
  const dark = mat(0x241d18, { roughness: 0.9, metalness: 0.4 });
  const concrete = mat(0x4f4038, { roughness: 1 });
  const pipeMat = mat(0x8d97a0, { roughness: 0.5, metalness: 0.75 });
  const FLOOR = 1.0;

  add(group, new THREE.CylinderGeometry(6.2, 6.7, 0.55, 8), concrete, 0, 0.58, 0);

  /* Sabatier column — update* vibrates this group while the line runs. */
  const column = new THREE.Group();
  column.position.set(-1.5, FLOOR, -0.4);
  group.add(column);
  add(column, new THREE.CylinderGeometry(1.7, 1.9, 1.5, 18), dark, 0, 0.75, 0);
  add(column, new THREE.CylinderGeometry(1.36, 1.46, 2.2, 18), steel, 0, 2.6, 0);
  add(column, new THREE.CylinderGeometry(1.1, 1.16, 1.9, 18), steel, 0, 4.65, 0);
  add(column, new THREE.SphereGeometry(1.1, 18, 9, 0, Math.PI * 2, 0, Math.PI / 2), rust, 0, 5.6, 0);
  rotate(add(column, new THREE.TorusGeometry(1.4, 0.09, 6, 20), rust, 0, 1.55, 0), -Math.PI / 2);
  const throatMat = emiss(PAL.amber, 0.2);
  add(column, new THREE.CylinderGeometry(1.2, 1.2, 0.42, 18), throatMat, 0, 3.15, 0, false);

  // tripod restraint; three struts read as a frame where six would read as a cage
  const strutGeo = new THREE.CylinderGeometry(0.12, 0.14, 5.4, 6);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.5;
    const strut = add(group, strutGeo, steel,
      column.position.x + Math.cos(a) * 2.5, FLOOR + 2.5, column.position.z + Math.sin(a) * 2.5);
    strut.rotation.set(Math.sin(a) * 0.42, 0, -Math.cos(a) * 0.42);
  }

  /* LOX: tall slender cryo cylinder, gauge strip on the shell. */
  const loxMat = mat(PAL.cryo, { roughness: 0.32, metalness: 0.6 });
  const lox = new THREE.Group();
  lox.position.set(3.7, FLOOR, -2.7);
  group.add(lox);
  add(lox, new THREE.CylinderGeometry(1.45, 1.6, 0.5, 18), dark, 0, 0.25, 0);
  add(lox, new THREE.CylinderGeometry(1.18, 1.18, 3.5, 18), loxMat, 0, 2.3, 0);
  add(lox, new THREE.SphereGeometry(1.18, 18, 9, 0, Math.PI * 2, 0, Math.PI / 2), loxMat, 0, 4.05, 0);
  rotate(add(lox, new THREE.TorusGeometry(1.22, 0.08, 6, 18), steel, 0, 1.3, 0), -Math.PI / 2);
  const o2LevelMat = emiss(PAL.cyan, 0.6);
  const o2Gauge = fillBar(lox, o2LevelMat, 0.34, 3.3, 0.1, 0, 0.7, 1.22);

  /* Carbon: graphite sphere with a level ring climbing its equator. */
  const carbonMat = mat(PAL.graphite, { roughness: 0.7, metalness: 0.55 });
  const carbon = new THREE.Group();
  carbon.position.set(-4.4, FLOOR, 2.3);
  group.add(carbon);
  add(carbon, new THREE.BoxGeometry(3.0, 0.24, 3.0), dark, 0, 0.12, 0);
  const legGeo = new THREE.CylinderGeometry(0.11, 0.13, 1.5, 6);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    add(carbon, legGeo, steel, Math.cos(a) * 1.2, 0.85, Math.sin(a) * 1.2);
  }
  add(carbon, new THREE.SphereGeometry(1.55, 18, 12), carbonMat, 0, 2.45, 0);
  const cRingMat = emiss(PAL.amber, 0.8);
  const cBand = rotate(add(carbon, new THREE.TorusGeometry(1.62, 0.1, 6, 20), cRingMat, 0, 1.1, 0, false), -Math.PI / 2);

  /* Hydrogen: pale violet twin spheres on a common rack, own level ring. */
  const h2Mat = mat(PAL.violet, { roughness: 0.42, metalness: 0.42 });
  const hydrogen = new THREE.Group();
  hydrogen.position.set(4.3, FLOOR, 1.9);
  group.add(hydrogen);
  add(hydrogen, new THREE.BoxGeometry(3.2, 0.3, 1.8), dark, 0, 0.15, 0);
  add(hydrogen, new THREE.SphereGeometry(1.05, 16, 12), h2Mat, -0.95, 2.1, 0);
  add(hydrogen, new THREE.SphereGeometry(0.85, 16, 12), h2Mat, 1.0, 1.9, 0.2);
  const hRingMat = emiss(PAL.violet, 0.85);
  const hBand = rotate(add(hydrogen, new THREE.TorusGeometry(1.12, 0.09, 6, 18), hRingMat, -0.95, 1.4, 0, false), -Math.PI / 2);
  const hGauge = fillBar(hydrogen, hRingMat, 0.26, 1.5, 0.08, 1.0, 0.35, 1.12);

  /* Manufactured propellant: the big horizontal tank the line fills. */
  const tankMat = mat(0xa8b2ba, { roughness: 0.45, metalness: 0.7 });
  const tank = new THREE.Group();
  tank.position.set(0.4, FLOOR + 1.3, 2.9);
  group.add(tank);
  rotate(add(tank, new THREE.CylinderGeometry(1.3, 1.3, 4.8, 20), tankMat, 0, 0, 0), 0, 0, Math.PI / 2);
  const capGeo = new THREE.SphereGeometry(1.3, 16, 10);
  for (const x of [-2.4, 2.4]) add(tank, capGeo, tankMat, x, 0, 0).scale.set(0.45, 1, 1);
  add(tank, new THREE.BoxGeometry(0.3, 1.5, 1.6), dark, -1.5, -1.15, 0);
  const tankLevelMat = emiss(PAL.green, 0.7);
  const tankGauge = fillBar(tank, tankLevelMat, 4.4, 0.34, 0.1, -2.2, 0.1, 1.36, 'x');

  /* Flare / vent stack. */
  const flareMat = emiss(PAL.rust, 0.15);
  add(group, new THREE.CylinderGeometry(0.34, 0.42, 4.4, 12), rust, -5.1, FLOOR + 2.2, -1.9);
  add(group, new THREE.ConeGeometry(0.62, 0.85, 12), flareMat, -5.1, FLOOR + 4.7, -1.9);
  const plumeMat = emiss(PAL.amber, 1.1, { transparent: true, opacity: 0.72 });
  const flarePlume = add(group, new THREE.ConeGeometry(0.4, 1.6, 10), plumeMat, -5.1, FLOOR + 5.7, -1.9, false);
  flarePlume.visible = false;

  /* Service catwalk behind the column, with railings and a short stair. */
  add(group, new THREE.BoxGeometry(5.8, 0.16, 1.6), rust, -1.7, 2.35, -3.5);
  const railMat = mat(PAL.rust, { roughness: 0.8, metalness: 0.45 });
  const railGeo = new THREE.BoxGeometry(5.8, 0.09, 0.09);
  add(group, railGeo, railMat, -1.7, 3.28, -4.25, false);
  add(group, railGeo, railMat, -1.7, 3.28, -2.75, false);
  const postGeo = new THREE.BoxGeometry(0.09, 0.95, 0.09);
  for (const x of [-4.4, 0.6]) add(group, postGeo, railMat, x, 2.85, -4.25, false);
  const stepGeo = new THREE.BoxGeometry(1.4, 0.12, 0.42);
  for (let i = 0; i < 2; i++) add(group, stepGeo, rust, 2.3, 2.05 - i * 0.5, -3.3 + i * 0.5);

  /* Cable trays: one along the catwalk, one dropping to the vessel farm. */
  add(group, new THREE.BoxGeometry(6.4, 0.14, 0.5), dark, -1.5, 2.05, -1.4, false);
  add(group, new THREE.BoxGeometry(0.5, 0.14, 4.6), dark, 3.2, 2.05, 0.2, false);

  /* Process pipework; the two emissive runs pulse with the line. */
  const lineMat = emiss(PAL.cyan, 0.15);
  const lineMat2 = emiss(PAL.amber, 0.15);
  pipeBetween(group, lineMat, 2.6, FLOOR + 1.0, -2.7, -1.5, FLOOR + 1.0, -0.4);
  pipeBetween(group, lineMat2, -3.1, FLOOR + 1.5, 2.3, -1.5, FLOOR + 1.5, 0.3);
  pipeBetween(group, pipeMat, 3.3, FLOOR + 2.6, 1.9, 0.9, FLOOR + 1.3, 2.9, 0.15);
  pipeBetween(group, pipeMat, -5.1, FLOOR + 0.6, -1.9, -1.5, FLOOR + 0.6, -0.4, 0.16);

  /* Propellant transfer line out to the launch pad. config.js parks
   * FUEL-PROCESSOR at angle 90 / orbit 60 and LAUNCH-SITE at bearing 355 /
   * 132 m, so under colony.js's atan2(-x, -z) facing the pad sits ~30° off this
   * group's local -X — the only edge of the plant that is free of vessels. */
  const transferMat = emiss(PAL.green, 0.9);
  rotate(add(group, new THREE.CylinderGeometry(0.17, 0.17, 5.6, 8), pipeMat, -6.0, FLOOR + 0.35, 0.15, false), 0, 0, Math.PI / 2);
  add(group, new THREE.BoxGeometry(0.7, 0.7, 0.7), dark, -3.4, FLOOR + 0.35, 0.15);
  add(group, new THREE.CylinderGeometry(0.13, 0.16, 1.2, 6), steel, -8.0, FLOOR - 0.35, 0.15);
  const beadGeo = new THREE.SphereGeometry(0.22, 10, 8);
  const beads = [];
  for (let i = 0; i < 3; i++) beads.push(add(group, beadGeo, transferMat, -3.6, FLOOR + 0.35, 0.15, false));

  /* Console: schematic screen, amber NO LICENSE board, two strobes. */
  add(group, new THREE.BoxGeometry(1.9, 0.9, 0.8), mat(0x7d848a, { roughness: 0.5, metalness: 0.6 }), -3.2, FLOOR + 0.45, 4.6);
  rotate(add(group, new THREE.BoxGeometry(1.9, 1.2, 0.24), dark, -3.2, FLOOR + 1.45, 4.6), -0.32);

  const screenTex = canvasTexture(512, 256, (ctx, cv) => {
    ctx.fillStyle = '#0d1a19';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.strokeStyle = '#2f6f68';
    ctx.lineWidth = 3;
    ctx.strokeRect(12, 12, cv.width - 24, cv.height - 24);
    ctx.fillStyle = '#6fe3d4';
    ctx.font = '600 42px ui-monospace, Consolas, monospace';
    ctx.fillText('FUEL LINE', 34, 82);
    ctx.font = '600 28px ui-monospace, Consolas, monospace';
    ctx.fillStyle = '#f2b661';
    ctx.fillText('SABATIER  CH4 / LOX', 34, 138);
    ctx.fillStyle = '#2b7d74';
    for (let i = 0; i < 9; i++) ctx.fillRect(34 + i * 48, 172, 34, 22);
  });
  const screenMat = screenMaterial(screenTex, PAL.cyan);
  const screen = rotate(add(group, new THREE.PlaneGeometry(1.6, 0.8), screenMat, -3.2, FLOOR + 1.52, 4.84, false), -0.32);

  const deadTex = canvasTexture(512, 256, (ctx, cv) => {
    ctx.fillStyle = '#150d07';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.strokeStyle = '#7a4a1d';
    ctx.lineWidth = 8;
    ctx.strokeRect(16, 16, cv.width - 32, cv.height - 32);
    ctx.fillStyle = '#f2b661';
    ctx.font = '700 60px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('NO LICENSE', cv.width / 2, cv.height / 2 + 4);
  });
  const deadMat = screenMaterial(deadTex, PAL.amber);
  const deadBoard = rotate(add(group, new THREE.PlaneGeometry(1.6, 0.8), deadMat, -3.2, FLOOR + 1.52, 4.84, false), -0.32);

  const warnMat = emiss(PAL.red, 0.05);
  const unpowerMat = emiss(PAL.amber, 0.05);
  add(group, new THREE.SphereGeometry(0.17, 10, 8), warnMat, -3.9, FLOOR + 2.25, 4.5, false);
  add(group, new THREE.SphereGeometry(0.17, 10, 8), unpowerMat, -2.5, FLOOR + 2.25, 4.5, false);

  const lamp = new THREE.PointLight(PAL.cyan, 0.45, 14, 2);
  lamp.position.set(-2.0, FLOOR + 2.9, 3.8);
  group.add(lamp);
  const flareLight = new THREE.PointLight(PAL.amber, 0, 20, 2);
  flareLight.position.set(-5.1, FLOOR + 5.4, -1.9);
  group.add(flareLight);
  const vesselLight = new THREE.PointLight(PAL.amber, 0.25, 12, 2);
  vesselLight.position.set(0.4, FLOOR + 2.8, 2.9);
  group.add(vesselLight);

  guyWires(group, [-5.1, FLOOR, -1.9], [[-1.4, -2.6], [1.9, -3.0], [-0.6, 2.7]], 4.4);

  facility.fuelParts = {
    column,
    columnBaseY: FLOOR,
    throatMat,
    // order is the fuel state it mirrors: carbon, oxygen, hydrogen
    vessels: [
      { mat: cRingMat, band: cBand, gauge: null, baseY: 0.9, span: 3.1 },
      { mat: o2LevelMat, band: null, gauge: o2Gauge, baseY: 0, span: 0 },
      { mat: hRingMat, band: hBand, gauge: hGauge, baseY: 1.1, span: 2.0 },
    ],
    tankGauge,
    tankLevelMat,
    lineMat,
    lineMat2,
    flareMat,
    flarePlume,
    plumeMat,
    flareLight,
    lamp,
    vesselLight,
    screen,
    screenMat,
    deadBoard,
    deadMat,
    warnMat,
    unpowerMat,
    transferMat,
    beads,
  };
}

export function updateFuelProcessor(facility, sim, time) {
  const p = facility?.fuelParts;
  // skip a facility whose parts were never attached (or only half-migrated)
  if (!p || !p.column || !p.vessels || !p.tankGauge || !p.beads || !p.screen) return;

  const state = sim?.state ?? {};
  const fuel = state.fuel ?? {};
  const rocket = state.rocket ?? {};
  const t = clock(time);

  const licensed = fuel.unlocked !== false && sim?.derived?.fuelLicensed !== false;
  const unpowered = sim?.derived?.powered?.fuel === false || fuel.powered === false;
  const requested = !!fuel.making;
  const running = requested && licensed && !unpowered;

  const levels = [storeLvl(fuel.carbon, 'carbon'), storeLvl(fuel.oxygen, 'oxygen'), storeLvl(fuel.hydrogen, 'hydrogen')];
  p.vessels.forEach((v, i) => {
    if (!v || !v.mat) return;
    const f = levels[i];
    if (v.gauge) v.gauge.scale.y = Math.max(0.02, f);
    if (v.band) {
      v.band.position.y = v.baseY + f * v.span;
      // a ring hugging a sphere is widest at the equator, so it follows the chord
      const profile = Math.max(0.2, Math.sqrt(Math.max(0.04, 1 - (2 * f - 1) ** 2)));
      v.band.scale.set(profile, profile, 1);
      v.band.visible = f > 0.02;
    }
    v.mat.emissiveIntensity = f > 0.02 ? (running ? 0.55 + Math.sin(t * 2.2 + i * 2.1) * 0.2 : 0.3) : 0.05;
  });

  const percent = lvl(fuel.percent);
  p.tankGauge.scale.x = Math.max(0.02, percent);
  p.tankLevelMat.emissiveIntensity = percent > 0.02 ? (running ? 0.7 + Math.sin(t * 1.7) * 0.2 : 0.45) : 0.04;

  p.throatMat.emissiveIntensity = running ? 0.7 + Math.sin(t * 6.2) * 0.3 : licensed ? 0.08 : 0.02;
  p.lineMat.emissiveIntensity = running ? 0.4 + Math.sin(t * 3.1) * 0.25 : 0.03;
  p.lineMat2.emissiveIntensity = running ? 0.4 + Math.sin(t * 3.1 + 1.6) * 0.25 : 0.03;

  p.column.position.y = p.columnBaseY + (running ? Math.sin(t * 21) * 0.014 : 0);
  p.column.rotation.z = running ? Math.sin(t * 13.7) * 0.005 : 0;

  p.flareMat.emissiveIntensity = running ? 0.6 + Math.sin(t * 8.3) * 0.3 : 0.05;
  p.flarePlume.visible = running;
  if (running) {
    const s = 0.8 + Math.sin(t * 5.5) * 0.16;
    p.flarePlume.scale.set(s, 0.9 + Math.sin(t * 3.3) * 0.2, s);
    p.plumeMat.emissiveIntensity = 1.1 + Math.sin(t * 9.1) * 0.35;
  }
  p.flareLight.intensity = running ? 0.9 + Math.sin(t * 7.4) * 0.25 : 0;

  // research gates production: an unlicensed plant is dead steel plus a warning board
  p.screen.visible = licensed;
  p.deadBoard.visible = !licensed;
  p.screenMat.emissiveIntensity = licensed ? (running ? 1.1 + Math.sin(t * 2.6) * 0.25 : 0.6) : 0;
  if (!licensed) p.deadMat.emissiveIntensity = 0.7 + Math.sin(t * 2.8) * 0.3;
  p.lamp.intensity = licensed ? 0.45 : 0.05;
  p.lamp.color.setHex(licensed ? PAL.cyan : PAL.amber);
  p.vesselLight.intensity = running ? 0.5 : 0.16;

  const starved = requested && (levels[0] <= 0.001 || levels[1] <= 0.001 || levels[2] <= 0.001);
  p.warnMat.emissiveIntensity = starved ? 0.4 + Math.abs(Math.sin(t * 6.5)) * 1.7 : 0.04;
  p.unpowerMat.emissiveIntensity = unpowered ? 0.4 + Math.abs(Math.sin(t * 4.2)) * 1.5 : 0.04;

  const transferring = !!rocket.transferring && licensed;
  p.transferMat.emissiveIntensity = transferring ? 1.0 : 0.06;
  for (let i = 0; i < p.beads.length; i++) {
    const bead = p.beads[i];
    bead.visible = transferring;
    if (transferring) bead.position.x = -3.6 - ((t * 2.4 + i * 1.75) % 4.6);
  }
}

/* ───────────────────────────── LAUNCH SITE ───────────────────────────── */

/** Pad apron ~26 m across, rocket ~22 m tall, service gantry on the -X side. */
export function buildLaunchSite(group, facility) {
  const concrete = mat(0x55483f, { roughness: 1 });
  const steel = mat(PAL.steel, { roughness: 0.55, metalness: 0.72 });
  const rust = mat(PAL.dusty, { roughness: 0.95, metalness: 0.3 });
  const dark = mat(0x1d1713, { roughness: 0.9, metalness: 0.4 });
  const hull = mat(0xd7d9da, { roughness: 0.42, metalness: 0.5 });
  const engineMat = mat(0x2a2420, { roughness: 0.65, metalness: 0.7, emissive: PAL.basalt, emissiveIntensity: 0 });
  const FLOOR = 2.1;

  add(group, new THREE.CylinderGeometry(12.4, 12.8, 0.3, 24), concrete, 0, 0.15, 0);

  /* Flame trench under the disc, drained through a grate. */
  add(group, new THREE.CylinderGeometry(3.1, 3.3, 0.7, 14), dark, 1.2, 0.5, 0);
  const grateGeo = new THREE.BoxGeometry(5.8, 0.14, 0.36);
  for (let i = 0; i < 2; i++) add(group, grateGeo, steel, 1.2, 0.85, -2.1 + i * 4.2, false);
  add(group, new THREE.BoxGeometry(1.3, 1.3, 7.6), rust, 1.2, FLOOR - 0.75, 0);
  add(group, new THREE.BoxGeometry(7.6, 1.3, 1.3), rust, 1.2, FLOOR - 0.75, 0);
  add(group, new THREE.CylinderGeometry(5.2, 5.5, 0.8, 22), concrete, 1.2, FLOOR - 0.4, 0);
  rotate(add(group, new THREE.TorusGeometry(5.1, 0.16, 6, 34), emiss(PAL.rust, 0.35), 1.2, FLOOR, 0, false), -Math.PI / 2);
  rotate(add(group, new THREE.TorusGeometry(7.0, 0.2, 6, 28), steel, 1.2, 0.6, 0, false), -Math.PI / 2);

  const mastGeo = new THREE.CylinderGeometry(0.11, 0.13, 3.4, 6);
  const lampGeo = new THREE.SphereGeometry(0.2, 10, 8);
  const mastMat = emiss(PAL.cyan, 1.0);
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i / 4) * Math.PI * 2;
    const x = Math.cos(a) * 9.0;
    const z = Math.sin(a) * 9.0;
    add(group, mastGeo, rust, x, 1.9, z);
    add(group, lampGeo, mastMat, x, 3.75, z, false);
  }

  /* Ground support equipment + the umbilical latch where the arm meets the vehicle. */
  add(group, new THREE.BoxGeometry(3.2, 1.6, 1.8), steel, -8.8, 1.1, 6.6);
  add(group, new THREE.CylinderGeometry(1.2, 1.2, 2.0, 14), mat(PAL.sand, { roughness: 0.8 }), 7.2, 1.3, -5.8);
  const umbGlowMat = emiss(PAL.cyan, 0.2);
  add(group, new THREE.BoxGeometry(0.6, 0.6, 0.6), umbGlowMat, -0.5, FLOOR + 9.4, 0, false);

  /* Vertical propellant status column: bottom segments red, top ones green. */
  const status = new THREE.Group();
  status.position.set(8.4, 0, 4.0);
  status.rotation.y = -0.55;
  group.add(status);
  add(status, new THREE.BoxGeometry(0.7, 4.6, 0.4), dark, 0, 2.5, 0);
  const segColors = [PAL.red, PAL.amber, PAL.green, PAL.green];
  const statusSegs = [];
  for (let i = 0; i < segColors.length; i++) {
    const m = emiss(segColors[i], 0.05);
    fillBar(status, m, 0.46, 0.72, 0.12, 0, 0.8 + i * 0.86, 0.24);
    statusSegs.push({ mat: m });
  }
  const padLight = new THREE.PointLight(PAL.green, 0.3, 20, 2);
  padLight.position.set(8.4, 4.8, 4.0);
  group.add(padLight);

  /* Loading line arriving from the plant side (local +Z). */
  const flowMat = emiss(PAL.green, 0.9);
  rotate(add(group, new THREE.CylinderGeometry(0.18, 0.18, 9.6, 8), steel, 3.6, 0.75, 6.8, false), Math.PI / 2);
  add(group, new THREE.BoxGeometry(0.8, 0.8, 0.8), rust, 3.6, 0.75, 9.4);
  const beadGeo = new THREE.SphereGeometry(0.24, 10, 8);
  const flowBeads = [];
  for (let i = 0; i < 3; i++) flowBeads.push(add(group, beadGeo, flowMat, 3.6, 0.75, 2.4, false));

  /* The return rocket. */
  const rocket = new THREE.Group();
  rocket.position.set(1.2, FLOOR, 0);
  group.add(rocket);
  add(rocket, new THREE.CylinderGeometry(0.55, 1.45, 2.1, 16, 1, true), engineMat, 0, 1.05, 0);
  add(rocket, new THREE.CylinderGeometry(1.62, 1.62, 8.2, 20), hull, 0, 6.2, 0);
  add(rocket, new THREE.CylinderGeometry(1.7, 1.7, 1.7, 20), mat(0x8f9296, { roughness: 0.6, metalness: 0.6 }), 0, 11.15, 0);
  add(rocket, new THREE.CylinderGeometry(1.42, 1.42, 4.6, 20), hull, 0, 14.3, 0);
  const windowMat = emiss(0x8fd8ff, 0.4);
  add(rocket, new THREE.CylinderGeometry(1.47, 1.47, 0.8, 20), windowMat, 0, 14.55, 0, false);
  add(rocket, new THREE.CylinderGeometry(1.42, 1.0, 1.9, 20), hull, 0, 17.55, 0);
  add(rocket, new THREE.ConeGeometry(1.0, 1.7, 18), hull, 0, 19.35, 0);
  const finGeo = new THREE.BoxGeometry(0.16, 3.0, 1.7);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.6;
    const fin = add(rocket, finGeo, rust, Math.cos(a) * 1.78, 3.6, Math.sin(a) * 1.78);
    fin.rotation.set(0, -a, -0.18); // thin axis points radially, tips rake outward
  }
  const markTex = canvasTexture(512, 128, (ctx, cv) => {
    // rust lettering on the pale hull reads at pad scale, sand-on-white does not
    ctx.font = '700 74px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 10;
    ctx.strokeStyle = '#120c0a';
    ctx.strokeText('M3 — HOME', cv.width / 2, cv.height / 2);
    ctx.fillStyle = '#c96a3c';
    ctx.fillText('M3 — HOME', cv.width / 2, cv.height / 2);
  });
  add(rocket, new THREE.PlaneGeometry(2.9, 0.72), new THREE.MeshStandardMaterial({
    map: markTex, transparent: true, roughness: 0.7, alphaTest: 0.4,
  }), 0, 8.0, 1.66, false);

  const plumeMat = emiss(PAL.amber, 1.4, { transparent: true, opacity: 0.8 });
  const plume = add(rocket, new THREE.ConeGeometry(1.35, 7.5, 14, 1, true), plumeMat, 0, -3.0, 0, false);
  plume.visible = false;
  const plumeLight = new THREE.PointLight(0xffb066, 0, 44, 2);
  plumeLight.position.set(0, -1.2, 0);
  rocket.add(plumeLight);

  /* Retractable service gantry: update* swings this group about its base. */
  const gantry = new THREE.Group();
  gantry.position.set(-5.6, FLOOR, 0);
  group.add(gantry);
  add(gantry, new THREE.BoxGeometry(1.4, 15.0, 1.4), rust, 0, 7.5, 0);
  add(gantry, new THREE.BoxGeometry(2.2, 0.2, 0.2), steel, 0.7, 4.4, 0, false);
  add(gantry, new THREE.BoxGeometry(4.6, 0.34, 0.6), steel, 3.0, 9.4, 0);
  add(gantry, new THREE.BoxGeometry(0.4, 3.0, 0.4), steel, 4.9, 8.0, 0);
  add(gantry, new THREE.BoxGeometry(1.6, 1.2, 1.6), dark, 0.3, 5.6, 1.5);
  const chaseMats = [];
  const chaseGeo = new THREE.SphereGeometry(0.18, 10, 8);
  for (let i = 0; i < 2; i++) {
    const m = emiss(PAL.cyan, 0.3);
    add(gantry, chaseGeo, m, 1.6 + i * 1.5, 9.8, 0, false);
    chaseMats.push(m);
  }
  const beaconMat = emiss(PAL.red, 0.9);
  add(gantry, new THREE.SphereGeometry(0.22, 10, 8), beaconMat, 0, 15.3, 0, false);
  const beaconLight = new THREE.PointLight(PAL.red, 0.4, 26, 2);
  beaconLight.position.set(-5.6, FLOOR + 15.3, 0);
  group.add(beaconLight);

  guyWires(gantry, [-1.3, FLOOR, 0], [[-2.4, -2.6], [-2.4, 2.6], [-4.8, 0]], 13.6);

  facility.rocketParts = {
    rocket,
    rocketBaseY: FLOOR,
    gantry,
    plume,
    plumeMat,
    plumeLight,
    engineMat,
    windowMat,
    umbGlowMat,
    mastMat,
    statusSegs,
    padLight,
    flowMat,
    flowBeads,
    chaseMats,
    beaconMat,
    beaconLight,
    launchAt: -1,
    launchSeq: false,
  };
}

export function updateLaunchSite(facility, sim, time) {
  const p = facility?.rocketParts;
  if (!p || !p.rocket || !p.gantry || !p.plume || !p.padLight || !p.engineMat || !p.statusSegs || !p.flowBeads || !p.chaseMats) return;

  const state = sim?.state ?? {};
  const rocket = state.rocket ?? {};
  const t = clock(time);
  const percent = lvl(rocket.percent);
  const ready = !!rocket.ready;
  const transferring = !!rocket.transferring;
  const launched = !!rocket.launched;

  const segs = p.statusSegs ?? [];
  const n = segs.length || 1;
  for (let i = 0; i < segs.length; i++) {
    const lit = percent > (i + 0.15) / n;
    segs[i].mat.emissiveIntensity = lit && i === n - 1 && percent < 0.999 ? 0.7 : lit ? 1.15 : 0.05;
  }
  p.padLight.color.setRGB(1 - percent * 0.45, 0.4 + percent * 0.5, 0.28 + percent * 0.18);
  p.padLight.intensity = 0.25 + percent * 0.4;

  p.mastMat.emissiveIntensity = 0.7 + Math.sin(t * 1.9) * 0.2;
  p.windowMat.emissiveIntensity = ready ? 0.85 + Math.sin(t * 2.4) * 0.15 : 0.25;
  p.umbGlowMat.emissiveIntensity = ready ? 1.2 : 0.15;

  for (let i = 0; i < p.chaseMats.length; i++) {
    p.chaseMats[i].emissive.setHex(ready ? PAL.green : PAL.cyan);
    p.chaseMats[i].emissiveIntensity = ready ? 0.9 + Math.max(0, Math.sin(t * 3.4 - i * 1.1)) * 1.5 : 0.25;
  }
  p.beaconMat.emissiveIntensity = launched ? 1.6 : 0.5 + Math.max(0, Math.sin(t * 2.2)) * 0.7;
  p.beaconLight.intensity = launched ? 1.4 : 0.4;

  p.flowMat.emissiveIntensity = transferring ? 1.0 : 0.06;
  for (let i = 0; i < p.flowBeads.length; i++) {
    const bead = p.flowBeads[i];
    bead.visible = transferring;
    if (transferring) bead.position.z = 11.4 - ((t * 2.6 + i * 3.1) % 9.2);
  }

  if (launched) {
    // purely visual sequence: it starts the first frame launched reads true
    if (p.launchAt < 0) p.launchAt = t;
    p.launchSeq = true;
    const e = Math.max(0, t - p.launchAt);
    const lift = e < 1.4 ? 0 : (e - 1.4) * (e - 1.4) * 0.72;
    p.rocket.position.y = p.rocketBaseY + lift;
    p.rocket.rotation.z = Math.sin(e * 0.7) * 0.008 * Math.min(1, e);

    const hot = Math.min(1, e / 0.5) * Math.max(0, 1 - Math.max(0, e - 3.4) / 3.8);
    p.plume.visible = hot > 0.01 && e < 8;
    if (p.plume.visible) {
      const s = 0.8 + hot * 0.5;
      p.plume.scale.set(s, 0.5 + Math.min(1.4, e * 0.4), s);
      p.plumeMat.emissiveIntensity = 0.6 + hot * 1.7;
    }
    p.plumeLight.intensity = hot * 6;
    p.engineMat.emissive.setHex(PAL.amber);
    p.engineMat.emissiveIntensity = hot * 1.3;

    // clamps release, then the tower swings clear of the vehicle
    p.gantry.rotation.z = THREE.MathUtils.clamp((e - 1.0) * 0.2, 0, 0.6);
    p.umbGlowMat.emissiveIntensity = e < 1.0 ? 1.2 : 0.05;
    if (e > 16) p.rocket.visible = false;
  }
  else if (p.launchSeq) {
    // launched flipped back to false (restored save): snap every launch visual home
    p.launchSeq = false;
    p.launchAt = -1;
    p.rocket.position.y = p.rocketBaseY;
    p.rocket.rotation.z = 0;
    p.rocket.visible = true;
    p.plume.visible = false;
    p.plumeLight.intensity = 0;
    p.engineMat.emissiveIntensity = 0;
    p.gantry.rotation.z = 0;
  }
}

/* ───────────────────────────── CREW BUNKS ───────────────────────────── */

function firstName(full) {
  const name = typeof full === 'string' ? full.trim() : '';
  return name ? name.split(/\s+/)[0].toUpperCase() : 'CREW';
}

/**
 * Four berths under the HAB window band, at the same bearings as the habitat
 * windows in js/colony.js so the berth glow reads from outside. Names are taken
 * from an optional sim (or facility.crew) once, at build time — the plate is a
 * canvas texture, so it cannot be re-rendered per frame.
 */
export function buildCrewBunks(group, facility, sim) {
  const crew = sim?.crewRoster?.() ?? sim?.state?.crew ?? facility?.crew ?? null;
  const frame = mat(0xc3ccd1, { roughness: 0.55, metalness: 0.4 });
  const foam = mat(0x6f5a48, { roughness: 1 });
  const quilt = mat(PAL.sand, { roughness: 0.95 });
  const berths = [];

  for (let i = 0; i < 4; i++) {
    const berth = new THREE.Group();
    const a = -0.9 + i * 0.6;
    berth.position.set(Math.sin(a) * 3.45, 0.3, Math.cos(a) * 3.45);
    berth.rotation.y = a + Math.PI; // face the HAB centre
    group.add(berth);

    add(berth, new THREE.BoxGeometry(1.9, 0.16, 0.92), frame, 0, 0.42, 0);
    add(berth, new THREE.BoxGeometry(1.9, 0.55, 0.1), frame, 0, 0.62, -0.44);
    add(berth, new THREE.BoxGeometry(1.78, 0.22, 0.84), foam, 0, 0.75, 0);
    add(berth, new THREE.BoxGeometry(0.44, 0.16, 0.72), quilt, -0.62, 0.94, 0);
    // blanket bar across the mattress: the readable "someone is in bed" cue
    const blanket = add(berth, new THREE.BoxGeometry(0.9, 0.18, 0.9), quilt, 0.4, 0.92, 0, false);
    // shutter hangs from a header rail, so its origin is the top and scale.y is the drop
    const shutterGeo = new THREE.BoxGeometry(1.84, 1.34, 0.06);
    shutterGeo.translate(0, -1.34 / 2, 0);
    const shutter = add(berth, shutterGeo, mat(0x8b7461, { roughness: 1 }), 0, 2.0, 0.42);
    const lampMat = emiss(PAL.amber, 0.1);
    add(berth, new THREE.SphereGeometry(0.1, 10, 8), lampMat, -0.78, 1.38, 0.28, false);
    const glowMat = emiss(PAL.cyan, 0.06);
    add(berth, new THREE.BoxGeometry(1.5, 0.07, 0.05), glowMat, 0, 1.16, 0.46, false);

    const plateTex = canvasTexture(256, 96, (ctx, cv) => {
      ctx.fillStyle = '#1a120e';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.strokeStyle = '#c96a3c';
      ctx.lineWidth = 5;
      ctx.strokeRect(6, 6, cv.width - 12, cv.height - 12);
      ctx.fillStyle = '#e7c9a9';
      ctx.font = '700 40px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(firstName(crew?.[i]?.name), cv.width / 2, cv.height / 2 + 2);
    });
    add(berth, new THREE.PlaneGeometry(0.62, 0.24), new THREE.MeshStandardMaterial({
      map: plateTex, roughness: 0.6, emissive: 0xffffff, emissiveMap: plateTex, emissiveIntensity: 0.4,
    }), -0.16, 1.54, 0.5, false);

    berths.push({ group: berth, shutter, blanket, lampMat, glowMat });
  }

  // shared overhead feed conduit tying the four berths together
  add(group, new THREE.CylinderGeometry(0.08, 0.08, 3.0, 8), frame, 0, 2.3, 0).rotation.z = Math.PI / 2;

  facility.bunkParts = { berths };
}

export function updateCrewBunks(facility, sim, time) {
  const berths = facility?.bunkParts?.berths;
  if (!Array.isArray(berths)) return;

  const crew = sim?.crewRoster?.() ?? sim?.state?.crew;
  const t = clock(time);

  for (let i = 0; i < berths.length; i++) {
    const b = berths[i];
    if (!b || !b.shutter || !b.blanket || !b.lampMat || !b.glowMat) continue;
    const status = crew?.[i]?.status ?? '';
    const sleeping = status === 'Sleeping';
    // Exhausted parks a crew member on the nearest bunk, so it reads like rest
    const resting = status === 'Resting' || status === 'Exhausted';
    const occupied = sleeping || resting;

    b.shutter.scale.y = sleeping ? 1 : resting ? 0.45 : 0.05;
    b.blanket.visible = sleeping;
    b.lampMat.emissive.setHex(sleeping ? PAL.cyan : resting ? PAL.amber : PAL.basalt);
    b.lampMat.emissiveIntensity = sleeping ? 1.1 + Math.sin(t * 1.3 + i) * 0.15 : resting ? 0.7 : 0.05;
    b.glowMat.emissive.setHex(sleeping ? PAL.cyan : resting ? PAL.amber : PAL.basalt);
    b.glowMat.emissiveIntensity = occupied ? 0.55 + Math.sin(t * 1.1 + i * 1.4) * 0.1 : 0.04;
  }
}
