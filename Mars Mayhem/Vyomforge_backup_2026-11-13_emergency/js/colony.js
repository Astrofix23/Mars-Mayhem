import { FACILITIES, SITES, WORLD } from './config.js';
import { buildRoverDock } from './rover.js';
import { ColonyCollision } from './collision.js';
import {
  buildFuelProcessor, updateFuelProcessor,
  buildLaunchSite, updateLaunchSite,
  buildCrewBunks, updateCrewBunks,
} from './industry.js';

const STATUS = {
  ok: 0x6fe3a0,
  warn: 0xf2b661,
  bad: 0xef6a5a,
  idle: 0x8b9aa6,
};

/** Per-material site colours, so the map reads without opening a panel. */
const SITE_STYLE = {
  ice: { tint: 0x63c7ff, lens: 0xbfeeff, unit: 'kg ice' },
  carbon: { tint: 0xd8b48a, lens: 0x4a3b30, unit: 'kg carbon' },
  oxygen: { tint: 0x7ef0d0, lens: 0xd7fff4, unit: 'kg oxygen' },
  hydrogen: { tint: 0xf2b661, lens: 0xffe0a8, unit: 'kg hydrogen' },
};

/**
 * Builds the ten colony sites out of primitives and keeps their visuals in sync
 * with the simulation (status beacons, panel dust, crop growth, rover wheels).
 */
export class Colony {
  constructor(world) {
    this.world = world;
    this.scene = world.scene;
    this.facilities = new Map();
    this.craters = [];

    this.#buildGroundwork();

    for (const def of FACILITIES) {
      const angle = THREE.MathUtils.degToRad(def.angle);
      const orbit = def.orbit ?? WORLD.ringRadius;
      const radius = def.padRadius ?? 8.5;
      const x = Math.cos(angle) * orbit;
      const z = Math.sin(angle) * orbit;
      const facility = {
        ...def,
        position: new THREE.Vector3(x, 0, z),
        radius,
      };
      const group = new THREE.Group();
      group.position.set(x, world.heightAt(x, z), z);
      group.rotation.y = Math.atan2(-x, -z);
      this.scene.add(group);
      facility.group = group;

      // Off-ring structures grade their own apron; the ring pads share the shim.
      if (!def.padRadius) this.#buildPad(group, def.color);
      this.#dispatchBuilder(def.id, group, facility);

      facility.beacon = this.#buildBeacon(group, def.height, radius);
      facility.label = this.#buildLabel(group, def.code, def.height + 2.6);
      this.facilities.set(def.id, facility);
    }

    this.#buildLandingPad();
    this.#buildResourceSites();

    // Footprints come last: they read the finished facility transforms.
    this.collision = new ColonyCollision(this);
  }

  /** World-space sleeping berths inside the HAB, in crew order. */
  get bunks() {
    const hab = this.get('hab');
    if (!hab?.berthPoints || !hab.group) return [];
    return hab.berthPoints;
  }

  get(id) {
    return this.facilities.get(id);
  }

  list() {
    return [...this.facilities.values()];
  }

  /** Nearest facility to a world position, within its interaction radius. */
  nearest(position, extra = 3.5) {
    let best = null;
    let bestDist = Infinity;
    for (const f of this.facilities.values()) {
      const d = Math.hypot(position.x - f.position.x, position.z - f.position.z);
      if (d < f.radius + extra && d < bestDist) {
        best = f;
        bestDist = d;
      }
    }
    return best;
  }

  update(dt, sim, time, focus = null) {
    for (const f of this.facilities.values()) {
      const status = sim.facilityStatus(f.id);
      const color = STATUS[status] ?? STATUS.idle;
      f.beacon.mesh.material.emissive.setHex(color);
      f.beacon.light.color.setHex(color);
      f.beacon.light.intensity = 0.55 + Math.sin(time * 2.4 + f.angle) * 0.12;
    }

    // Solar panels visibly soil with dust.
    const solar = this.get('solar');
    if (solar?.panels) {
      const dust = THREE.MathUtils.clamp(sim.state.dust, 0, 1);
      solar.panels.color.copy(solar.cleanColor).lerp(solar.dustColor, dust);
      solar.panels.emissiveIntensity = (1 - dust) * 0.12;
    }

    // Crops scale with their growth value.
    const bio = this.get('bio');
    if (bio?.plots) {
      bio.plots.forEach((plot, i) => {
        const crop = sim.state.plots[i];
        if (!crop) return;
        const g = crop.growth;
        plot.scale.setScalar(0.35 + g * 1.15);
        plot.visible = g > 0.02;
        plot.material.color.setHex(crop.mature ? 0xa8e06b : 0x6bbf5a);
      });
    }

    // Oxygen plant stack pulses while it is producing.
    const o2 = this.get('o2');
    if (o2?.stack) {
      o2.stack.material.emissiveIntensity = sim.derived.powered.oxygen ? 0.5 + Math.sin(time * 3) * 0.25 : 0.05;
    }

    this.#fadeHabShell(dt, focus);

    const rover = this.get('rover');
    if (rover?.dockLamp) {
      // The dock lamp tracks the rover's charge state rather than driving wheels
      // that now belong to the RoverActor.
      const charging = sim.state.rover.phase === 'cooldown' || sim.state.rover.phase === 'idle';
      rover.dockLamp.material.emissiveIntensity = charging ? 1.2 + Math.sin(time * 4) * 0.3 : 0.25;
    }

    // The active site pulses so the player can see where the rover is headed.
    this.#updateSites(sim, time);

    this.#updateIndustry(sim, time);

    this.#updateCraters(dt);

    const comms = this.get('comms');
    if (comms?.dish) comms.dish.rotation.y = Math.sin(time * 0.4) * 0.5;

    const shelter = this.get('shelter');
    if (shelter?.rtg) {
      const on = sim.state.backup.active;
      shelter.rtg.material.emissive.setHex(on ? 0x6fe3d4 : 0x2a2320);
      shelter.rtg.material.emissiveIntensity = on ? 0.9 : 0.15;
    }
  }

  /**
   * The four bunks live inside HAB-Alpha, so the shell has to stop being a wall
   * at the moment it gets between the camera and the commander. Outside the
   * habitat it is opaque metal; from the doorway inward it turns to glass.
   */
  #fadeHabShell(dt, focus) {
    const hab = this.get('hab');
    const shell = hab?.shellMat;
    if (!shell) return;
    const r = 4.4;
    const cam = this.world.camera.position;
    const inHab = (p) => Boolean(p) && Math.hypot(p.x - hab.position.x, p.z - hab.position.z) < r;
    // The shoulder rig sits outside the shell whenever the commander is inside,
    // which would otherwise frame nothing but the back of the wall.
    const clear = inHab(cam) || inHab(focus);
    const want = clear ? 0.16 : 1;
    shell.opacity += (want - shell.opacity) * Math.min(1, dt * 6);
    shell.depthWrite = shell.opacity > 0.85;
  }

  /* ───────────────────────────── ground work ───────────────────────────── */

  #buildGroundwork() {
    const padMat = new THREE.MeshStandardMaterial({ color: 0x4b3126, roughness: 1 });
    const road = new THREE.Mesh(
      new THREE.RingGeometry(WORLD.ringRadius - 2.1, WORLD.ringRadius + 2.1, 108),
      padMat,
    );
    road.rotation.x = -Math.PI / 2;
    road.position.y = 0.06;
    road.receiveShadow = true;
    this.scene.add(road);

    for (const def of FACILITIES) {
      if (def.orbit) continue; // off-ring sites get a graded lane instead (below)
      const angle = THREE.MathUtils.degToRad(def.angle);
      const spoke = new THREE.Mesh(new THREE.PlaneGeometry(2.2, WORLD.ringRadius - 4), padMat);
      spoke.rotation.x = -Math.PI / 2;
      spoke.rotation.z = -angle + Math.PI / 2;
      spoke.position.set(
        (Math.cos(angle) * (WORLD.ringRadius - 4)) / 2,
        0.05,
        (Math.sin(angle) * (WORLD.ringRadius - 4)) / 2,
      );
      spoke.receiveShadow = true;
      this.scene.add(spoke);
    }

    this.#buildAccessLanes(padMat);
  }

  /**
   * Trodden regolith lanes out to the propellant plant and the launch site. The
   * tiles follow the terrain so the far pads look reached rather than dropped.
   */
  #buildAccessLanes(padMat) {
    const offRing = FACILITIES.filter((f) => f.orbit);
    if (!offRing.length) return;
    const tiles = [];
    for (const def of offRing) {
      const a = THREE.MathUtils.degToRad(def.angle);
      const from = WORLD.roadRadius + 3;
      const to = def.orbit - (def.padRadius ?? 9) * 0.75;
      for (let d = from; d <= to; d += 5) {
        tiles.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, a });
      }
    }
    const geo = new THREE.PlaneGeometry(3.1, 5.4);
    geo.rotateX(-Math.PI / 2);
    const lane = new THREE.InstancedMesh(geo, padMat, tiles.length);
    lane.receiveShadow = true;
    const dummy = new THREE.Object3D();
    tiles.forEach((t, i) => {
      dummy.position.set(t.x, this.world.heightAt(t.x, t.z) + 0.04, t.z);
      dummy.rotation.set(0, -t.a + Math.PI / 2, 0);
      dummy.updateMatrix();
      lane.setMatrixAt(i, dummy.matrix);
    });
    lane.instanceMatrix.needsUpdate = true;
    this.scene.add(lane);
  }

  #buildPad(group, color) {
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(7.2, 7.6, 0.35, 32),
      new THREE.MeshStandardMaterial({ color: 0x3a2820, roughness: 0.95 }),
    );
    pad.position.y = 0.1;
    pad.receiveShadow = true;
    group.add(pad);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(7.0, 0.09, 6, 48),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, roughness: 0.6 }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.3;
    group.add(ring);
  }

  #buildBeacon(group, height, padRadius = 8.5) {
    const bx = padRadius * 0.78;
    const bz = padRadius * 0.35;
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, height * 0.55, 6),
      new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.8 }),
    );
    pole.position.set(bx, height * 0.27, bz);
    group.add(pole);

    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.32, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0x111111, emissive: STATUS.ok, emissiveIntensity: 1 }),
    );
    mesh.position.set(bx, height * 0.55, bz);
    group.add(mesh);

    const light = new THREE.PointLight(STATUS.ok, 0.6, 16, 2);
    light.position.copy(mesh.position);
    group.add(light);

    return { mesh, light };
  }

  #buildLabel(group, text, height, { width = 8.5, font = 52 } = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 160;
    const ctx = canvas.getContext('2d');
    const box = { x: 14, y: 34, w: canvas.width - 28, h: 92 };
    ctx.fillStyle = 'rgba(12, 8, 6, 0.55)';
    roundRect(ctx, box.x, box.y, box.w, box.h, 22);
    ctx.fill();

    let size = font;
    ctx.font = `600 ${size}px ui-monospace, Consolas, monospace`;
    while (ctx.measureText(text).width > box.w - 40 && size > 18) {
      size -= 2;
      ctx.font = `600 ${size}px ui-monospace, Consolas, monospace`;
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffd7b0';
    ctx.fillText(text, canvas.width / 2, box.y + box.h / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.encoding = THREE.sRGBEncoding;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, opacity: 0.92 }),
    );
    sprite.scale.set(width, (width * canvas.height) / canvas.width, 1);
    sprite.position.set(0, height, 0);
    group.add(sprite);
    return sprite;
  }

  #buildLandingPad() {
    const group = new THREE.Group();
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(7, 7.2, 0.22, 36),
      new THREE.MeshStandardMaterial({ color: 0x3d2b22, roughness: 1 }),
    );
    disc.position.y = 0.08;
    disc.receiveShadow = true;
    group.add(disc);

    const cross = new THREE.Mesh(
      new THREE.TorusGeometry(4.4, 0.14, 6, 40),
      new THREE.MeshStandardMaterial({ color: 0xc96a3c, emissive: 0x8a3f1d, emissiveIntensity: 0.5 }),
    );
    cross.rotation.x = -Math.PI / 2;
    cross.position.y = 0.22;
    group.add(cross);

    for (let i = 0; i < 4; i++) {
      const mast = new THREE.Mesh(
        new THREE.CylinderGeometry(0.09, 0.09, 2.6, 6),
        new THREE.MeshStandardMaterial({ color: 0x2b211b }),
      );
      const a = (i / 4) * Math.PI * 2;
      mast.position.set(Math.cos(a) * 6.4, 1.3, Math.sin(a) * 6.4);
      group.add(mast);
      const lamp = new THREE.Mesh(
        new THREE.SphereGeometry(0.2, 10, 8),
        new THREE.MeshStandardMaterial({ emissive: 0x6fe3d4, emissiveIntensity: 1.1 }),
      );
      lamp.position.set(mast.position.x, 2.7, mast.position.z);
      group.add(lamp);
    }
    this.scene.add(group);
    this.landingPad = group;
  }

  /* ───────────────────────────── facility builders ───────────────────────────── */

  #dispatchBuilder(id, group, facility) {
    switch (id) {
      case 'hab':
        this.#build_hab(group, facility);
        break;
      case 'bio':
        this.#build_bio(group, facility);
        break;
      case 'solar':
        this.#build_solar(group, facility);
        break;
      case 'bat':
        this.#build_bat(group, facility);
        break;
      case 'aqua':
        this.#build_aqua(group, facility);
        break;
      case 'o2':
        this.#build_o2(group, facility);
        break;
      case 'sci':
        this.#build_sci(group, facility);
        break;
      case 'comms':
        this.#build_comms(group, facility);
        break;
      case 'shelter':
        this.#build_shelter(group, facility);
        break;
      case 'rover':
        this.#build_rover(group, facility);
        break;
      case 'fuel':
        buildFuelProcessor(group, facility);
        break;
      case 'pad':
        buildLaunchSite(group, facility);
        break;
      default:
        break;
    }
  }

  #build_hab(group, f) {
    // Transparent from the start: the opacity is animated, and flipping
    // `transparent` at runtime would force a shader rebuild on every crossing.
    const shell = new THREE.MeshStandardMaterial({
      color: 0xd9dde0, roughness: 0.55, metalness: 0.35, transparent: true, opacity: 1,
    });
    f.shellMat = shell;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(4.4, 4.4, 3.2, 26), shell);
    body.position.y = 1.8;
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    const dome = new THREE.Mesh(new THREE.SphereGeometry(4.4, 26, 14, 0, Math.PI * 2, 0, Math.PI / 2), shell);
    dome.position.y = 3.4;
    dome.castShadow = true;
    group.add(dome);

    const windowMat = new THREE.MeshStandardMaterial({
      color: 0x8fd8ff, emissive: 0x6fc7ff, emissiveIntensity: 0.6, roughness: 0.2,
    });
    for (let i = 0; i < 4; i++) {
      const win = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.8, 0.18), windowMat);
      const a = -0.9 + i * 0.6;
      win.position.set(Math.sin(a) * 4.25, 2.1, Math.cos(a) * 4.25);
      win.rotation.y = a;
      group.add(win);
    }

    const airlock = new THREE.Mesh(
      new THREE.CylinderGeometry(1.5, 1.5, 3.2, 16),
      new THREE.MeshStandardMaterial({ color: 0xb9c0c6, roughness: 0.6, metalness: 0.3 }),
    );
    airlock.rotation.z = Math.PI / 2;
    airlock.position.set(-1.2, 1.4, 4.6);
    group.add(airlock);
  }

  #build_bio(group, f) {
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(5.6, 5.9, 1.0, 26),
      new THREE.MeshStandardMaterial({ color: 0x6b6152, roughness: 1 }),
    );
    base.position.y = 0.6;
    base.receiveShadow = true;
    group.add(base);

    const glass = new THREE.Mesh(
      new THREE.SphereGeometry(5.6, 26, 16, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshStandardMaterial({
        color: 0xa9f08a, transparent: true, opacity: 0.26, roughness: 0.15,
        metalness: 0.1, emissive: 0x2f5a1f, emissiveIntensity: 0.35, side: THREE.DoubleSide,
      }),
    );
    glass.position.y = 1.0;
    group.add(glass);

    const bedMat = new THREE.MeshStandardMaterial({ color: 0x4a3326, roughness: 1 });
    f.plots = [];
    const positions = [
      [-2.1, -1.5], [2.1, -1.5], [-2.1, 1.7], [2.1, 1.7],
    ];
    for (const [x, z] of positions) {
      const bed = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.5, 2.2), bedMat);
      bed.position.set(x, 1.35, z);
      bed.receiveShadow = true;
      group.add(bed);

      const crop = new THREE.Mesh(
        new THREE.ConeGeometry(0.75, 1.5, 7),
        new THREE.MeshStandardMaterial({ color: 0x6bbf5a, roughness: 0.85, emissive: 0x1f3a14, emissiveIntensity: 0.3 }),
      );
      crop.position.set(x, 2.0, z);
      crop.castShadow = true;
      group.add(crop);
      f.plots.push(crop);
    }

    for (let i = 0; i < 3; i++) {
      const lamp = new THREE.PointLight(0xc4ff8a, 0.5, 12, 2);
      lamp.position.set(0, 3.4, 0);
      group.add(lamp);
      if (i === 0) f.growLight = lamp;
    }
  }

  #build_solar(group, f) {
    const panelMat = new THREE.MeshStandardMaterial({
      color: 0x24405f, roughness: 0.45, metalness: 0.55, emissive: 0x0d2237, emissiveIntensity: 0.35,
    });
    f.panels = panelMat;
    f.cleanColor = new THREE.Color(0x24405f);
    f.dustColor = new THREE.Color(0x9a7256);

    const postMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.6, metalness: 0.5 });
    const layout = [
      [-4.2, -3.2], [0, -3.6], [4.2, -3.2], [-2.2, 2.6], [2.2, 2.6],
    ];
    layout.forEach(([x, z], i) => {
      const tilt = new THREE.Group();
      tilt.position.set(x, 0, z);
      tilt.rotation.y = (i % 2 === 0 ? 1 : -1) * 0.18;

      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 1.8, 8), postMat);
      post.position.y = 0.9;
      post.castShadow = true;
      tilt.add(post);

      const panel = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.12, 2.0), panelMat);
      panel.position.y = 1.9;
      panel.rotation.x = -0.42;
      panel.castShadow = true;
      tilt.add(panel);
      group.add(tilt);
    });
  }

  #build_bat(group) {
    const shell = new THREE.MeshStandardMaterial({ color: 0xc9c2b3, roughness: 0.6, metalness: 0.3 });
    const box = new THREE.Mesh(new THREE.BoxGeometry(6.4, 2.6, 4.4), shell);
    box.position.y = 1.5;
    box.castShadow = true;
    box.receiveShadow = true;
    group.add(box);

    for (let i = 0; i < 3; i++) {
      const vent = new THREE.Mesh(
        new THREE.CylinderGeometry(0.5, 0.5, 1.4, 12),
        new THREE.MeshStandardMaterial({ color: 0x8b9096, roughness: 0.8 }),
      );
      vent.position.set(-1.8 + i * 1.8, 3.1, 0);
      group.add(vent);
    }

    const core = new THREE.Mesh(
      new THREE.CylinderGeometry(0.7, 0.7, 0.5, 16),
      new THREE.MeshStandardMaterial({ color: 0xf6e05e, emissive: 0xf6e05e, emissiveIntensity: 0.7 }),
    );
    core.position.set(0, 3.3, 0);
    group.add(core);
  }

  #build_aqua(group) {
    const tankMat = new THREE.MeshStandardMaterial({ color: 0xbfd8e0, roughness: 0.35, metalness: 0.45 });
    for (const x of [-2.4, 2.4]) {
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 4.0, 18), tankMat);
      tank.position.set(x, 2.3, 0);
      tank.castShadow = true;
      group.add(tank);

      const cap = new THREE.Mesh(new THREE.SphereGeometry(1.5, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), tankMat);
      cap.position.set(x, 4.3, 0);
      group.add(cap);
    }

    const pump = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, 1.4, 2.0),
      new THREE.MeshStandardMaterial({ color: 0x8b8b82, roughness: 0.8 }),
    );
    pump.position.set(0, 0.9, 2.6);
    pump.castShadow = true;
    group.add(pump);

    const pipeMat = new THREE.MeshStandardMaterial({ color: 0x63c7ff, emissive: 0x1f6f9a, emissiveIntensity: 0.4, roughness: 0.5 });
    for (const x of [-2.4, 2.4]) {
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 3.2, 8), pipeMat);
      pipe.rotation.z = Math.PI / 2;
      pipe.position.set(x, 1.2, 1.6);
      group.add(pipe);
    }
  }

  #build_o2(group, f) {
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(4.6, 2.4, 3.0),
      new THREE.MeshStandardMaterial({ color: 0xd5d9d2, roughness: 0.6, metalness: 0.3 }),
    );
    body.position.y = 1.4;
    body.castShadow = true;
    group.add(body);

    const stackMat = new THREE.MeshStandardMaterial({
      color: 0x7ef0d0, emissive: 0x2c8f7c, emissiveIntensity: 0.5, roughness: 0.4,
    });
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 1.0, 3.4, 14), stackMat);
    stack.position.set(1.2, 4.3, 0);
    stack.castShadow = true;
    group.add(stack);
    f.stack = stack;

    const intake = new THREE.Mesh(
      new THREE.CylinderGeometry(1.6, 1.6, 0.8, 18),
      new THREE.MeshStandardMaterial({ color: 0x6f7a76, roughness: 0.9 }),
    );
    intake.position.set(-1.6, 3.0, 0);
    intake.rotation.x = Math.PI / 2;
    group.add(intake);
  }

  #build_sci(group, f) {
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(5.6, 2.8, 4.2),
      new THREE.MeshStandardMaterial({ color: 0xd8d3de, roughness: 0.55, metalness: 0.3 }),
    );
    body.position.y = 1.6;
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    const dish = new THREE.Mesh(
      new THREE.SphereGeometry(1.5, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2.4),
      new THREE.MeshStandardMaterial({ color: 0xc98cff, emissive: 0x5b2c7a, emissiveIntensity: 0.35, side: THREE.DoubleSide, roughness: 0.4 }),
    );
    dish.rotation.x = -0.9;
    dish.position.set(0, 3.6, 0.6);
    dish.castShadow = true;
    group.add(dish);
    f.dish = dish;

    const light = new THREE.PointLight(0xc98cff, 0.5, 14, 2);
    light.position.set(0, 3.0, 0);
    group.add(light);
  }

  #build_comms(group, f) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xa8b0b6, roughness: 0.5, metalness: 0.6 });
    for (let i = 0; i < 3; i++) {
      const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.7 - i * 0.16, 0.85 - i * 0.16, 2.4, 8, 1, true), mat);
      seg.position.y = 1.6 + i * 2.3;
      seg.castShadow = true;
      group.add(seg);
    }

    const dish = new THREE.Mesh(
      new THREE.SphereGeometry(1.4, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2.6),
      new THREE.MeshStandardMaterial({ color: 0xff9f7a, emissive: 0x6b2c16, emissiveIntensity: 0.4, side: THREE.DoubleSide, roughness: 0.4 }),
    );
    dish.position.set(0, 8.2, 0);
    dish.rotation.x = -0.7;
    group.add(dish);
    f.dish = dish;

    const shack = new THREE.Mesh(
      new THREE.BoxGeometry(3.0, 1.6, 2.4),
      new THREE.MeshStandardMaterial({ color: 0x8f8478, roughness: 0.9 }),
    );
    shack.position.set(-3.4, 0.9, 1.2);
    shack.castShadow = true;
    group.add(shack);
  }

  #build_shelter(group, f) {
    const shell = new THREE.Mesh(
      new THREE.CylinderGeometry(4.6, 4.6, 7.0, 20, 1, false, 0, Math.PI),
      new THREE.MeshStandardMaterial({ color: 0xa88a6a, roughness: 1, side: THREE.DoubleSide }),
    );
    shell.rotation.z = Math.PI / 2;
    shell.rotation.y = Math.PI / 2;
    shell.position.y = 0.35;
    shell.castShadow = true;
    shell.receiveShadow = true;
    group.add(shell);

    const door = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 2.2, 0.25),
      new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.9 }),
    );
    door.position.set(0, 1.2, 4.5);
    group.add(door);

    const rtg = new THREE.Mesh(
      new THREE.CylinderGeometry(0.9, 0.9, 2.0, 14),
      new THREE.MeshStandardMaterial({ color: 0x30302c, emissive: 0x2a2320, emissiveIntensity: 0.2, roughness: 0.7 }),
    );
    rtg.position.set(-4.6, 1.2, 2.6);
    rtg.castShadow = true;
    group.add(rtg);
    f.rtg = rtg;

    const fins = new THREE.Mesh(
      new THREE.CylinderGeometry(1.5, 1.5, 0.2, 14),
      new THREE.MeshStandardMaterial({ color: 0x8d8d85, roughness: 0.9 }),
    );
    fins.position.set(-4.6, 2.4, 2.6);
    group.add(fins);
  }

  #build_rover(group, f) {
    // The vehicle itself is a RoverActor (js/rover.js) that drives around the
    // map; the pad only keeps the charging gantry so nothing is ever drawn twice.
    buildRoverDock(group, f);
    f.dockLamp = group.children[group.children.length - 1];
  }

  /* ───────────────────────────── resource sites ───────────────────────────── */

  /**
   * The finite deposits ROVER-01 drives out to. Each site is styled by material
   * and shrinks visually as the simulation works it out, so depletion is
   * legible from the ridge without reading a panel.
   */
  #buildResourceSites() {
    this.sites = [];
    for (const s of SITES) {
      const style = SITE_STYLE[s.kind] ?? SITE_STYLE.ice;
      const group = new THREE.Group();
      group.position.set(s.x, this.world.heightAt(s.x, s.z), s.z);
      this.scene.add(group);

      const disc = new THREE.Mesh(
        new THREE.CylinderGeometry(6.2, 6.6, 0.2, 26),
        new THREE.MeshStandardMaterial({ color: style.lens, roughness: 0.8, transparent: true, opacity: 0.45 }),
      );
      disc.position.y = 0.1;
      group.add(disc);

      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(6.4, 0.1, 6, 40),
        new THREE.MeshStandardMaterial({ color: style.tint, emissive: style.tint, emissiveIntensity: 0.8, roughness: 0.5 }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.22;
      group.add(ring);

      // the deposit itself — ice lenses, carbon lenses, oxidiser crust, H₂ veins
      const lensMat = new THREE.MeshStandardMaterial({
        color: style.lens, emissive: style.tint, emissiveIntensity: 0.45,
        roughness: 0.3, transparent: true, opacity: 0.88,
      });
      const lenses = [];
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + s.bearing;
        const r = 1.6 + (i % 3) * 1.1;
        const h = 1.0 + (i % 4) * 0.5;
        const lens = new THREE.Mesh(new THREE.ConeGeometry(0.5, h, 5), lensMat);
        lens.position.set(Math.cos(a) * r, h / 2, Math.sin(a) * r);
        lens.rotation.set(0.1 * Math.cos(a), a, 0.14 * Math.sin(a));
        lens.castShadow = true;
        group.add(lens);
        lenses.push(lens);
      }

      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.08, 5.2, 6),
        new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.8 }),
      );
      pole.position.set(0, 2.6, 0);
      group.add(pole);

      const beacon = new THREE.Mesh(
        new THREE.SphereGeometry(0.3, 10, 8),
        new THREE.MeshStandardMaterial({ color: 0x111111, emissive: style.tint, emissiveIntensity: 1.2 }),
      );
      beacon.position.set(0, 5.2, 0);
      group.add(beacon);

      const light = new THREE.PointLight(style.tint, 0.7, 22, 2);
      light.position.set(0, 5.0, 0);
      group.add(light);

      const label = this.#buildLabel(group, `${s.name} · ${s.dist} m · ${s.capacity} ${style.unit}`, 6.8, { width: 12 });

      this.sites.push({ def: s, group, lenses, lensMat, beacon, light, label, style, worked: false });
    }
  }

  /** Pulse the site the rover is driving to and show how much has been worked out. */
  #updateSites(sim, time) {
    const active = sim.state.rover.survey;
    const flying = sim.roverStatus() !== 'Idle';
    for (let i = 0; i < this.sites.length; i++) {
      const m = this.sites[i];
      const deposit = sim.state.sites[i];
      const frac = deposit ? Math.max(0, Math.min(1, deposit.remaining / m.def.capacity)) : 1;
      const live = frac > 0.005;

      if (live) {
        // lenses recede as the deposit is drained
        const scale = 0.25 + Math.sqrt(frac) * 0.75;
        for (const lens of m.lenses) lens.scale.setScalar(scale);
        m.lensMat.opacity = 0.35 + frac * 0.55;
      } else {
        for (const lens of m.lenses) lens.scale.setScalar(0.001);
        m.lensMat.opacity = 0.12;
      }

      const on = i === active && flying;
      m.beacon.material.emissive.setHex(live ? m.style.tint : 0x6b625c);
      m.beacon.material.emissiveIntensity = on ? 1.4 + Math.sin(time * 5) * 0.6 : live ? 0.9 : 0.18;
      m.light.intensity = on ? 1.3 : live ? 0.6 : 0.05;
      if (!live && !m.worked) {
        m.worked = true;
        m.label.visible = false;
        this.#buildLabel(m.group, `${m.def.name} · DEPLETED`, 6.8, { width: 12 });
      }
    }
  }

  /* ───────────────────────────── endgame systems ───────────────────────────── */

  /**
   * Propellant plant, return rocket and the HAB berths. The berths are built on
   * the first frame a sim exists because their name plates read the crew roster.
   */
  #updateIndustry(sim, time) {
    const fuel = this.get('fuel');
    if (fuel) updateFuelProcessor(fuel, sim, time);

    const pad = this.get('pad');
    if (pad) updateLaunchSite(pad, sim, time);

    const hab = this.get('hab');
    if (!hab) return;
    if (!hab.bunkParts) {
      buildCrewBunks(hab.group, hab, sim);
      hab.berthPoints = this.#berthPoints(hab);
    }
    updateCrewBunks(hab, sim, time);
  }

  /**
   * World-space lying points for the four berths, head-first toward the pillow,
   * so js/crew.js can walk a sleeper to a bed instead of leaving it standing.
   */
  #berthPoints(hab) {
    hab.group.updateMatrixWorld(true);
    return (hab.bunkParts?.berths ?? []).map((b) => {
      const feet = b.group.localToWorld(new THREE.Vector3(0.66, 0.98, 0));
      const head = b.group.localToWorld(new THREE.Vector3(-0.74, 0.98, 0));
      return {
        x: feet.x,
        y: feet.y,
        z: feet.z,
        heading: Math.atan2(-(head.x - feet.x), -(head.z - feet.z)),
      };
    });
  }

  /* ───────────────────────────── impact craters ───────────────────────────── */

  /** Scorch ring + ejecta where a meteorite lands. Purely cosmetic. */
  spawnCrater(x, z) {
    const group = new THREE.Group();
    const y = this.world.heightAt(x, z);
    group.position.set(x, y, z);

    const scorch = new THREE.Mesh(
      new THREE.CircleGeometry(6.5, 24),
      new THREE.MeshStandardMaterial({ color: 0x1d1210, roughness: 1, transparent: true, opacity: 0.85 }),
    );
    scorch.rotation.x = -Math.PI / 2;
    scorch.position.y = 0.08;
    group.add(scorch);

    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(6.2, 0.45, 6, 26),
      new THREE.MeshStandardMaterial({ color: 0x7a4a33, roughness: 1, flatShading: true }),
    );
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = 0.25;
    rim.castShadow = true;
    group.add(rim);

    const chunkMat = new THREE.MeshStandardMaterial({
      color: 0x5a3a2a, roughness: 1, flatShading: true, emissive: 0x2a0d05, emissiveIntensity: 0.5,
    });
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + x;
      const d = 7 + (i % 3) * 2.2;
      const s = 0.5 + (i % 4) * 0.35;
      const chunk = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), chunkMat);
      chunk.position.set(Math.cos(a) * d, s * 0.6, Math.sin(a) * d);
      chunk.rotation.set(a, a * 2, a * 0.5);
      chunk.castShadow = true;
      group.add(chunk);
    }

    const ember = new THREE.PointLight(0xff7a3c, 2.4, 26, 2);
    ember.position.y = 1.2;
    group.add(ember);

    this.scene.add(group);
    this.craters.push({ group, ember, life: 14 });
  }

  #updateCraters(dt) {
    for (let i = this.craters.length - 1; i >= 0; i--) {
      const c = this.craters[i];
      c.life -= dt;
      c.ember.intensity = Math.max(0, c.life / 14) * 2.4;
      if (c.life <= 0) {
        this.craters.splice(i, 1);
      }
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
