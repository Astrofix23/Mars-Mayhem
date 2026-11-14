import { ROVER, facilityXZ, roverRoute, pathPoint } from './config.js';

/** Bay crate + drill colour per material. */
const CARGO_TINT = { ice: 0x9fdcff, carbon: 0x54463c, oxygen: 0xdff6ef, hydrogen: 0xffd79a };

/* ───────────────────────── rover model (primitives) ─────────────────────────
 * The rover used to be a static prop inside the ROVER-01 facility pad. It now
 * lives here as a physically mobile actor. colony.js keeps only the charging
 * dock so the two never draw a second rover on the pad. */
function buildRoverModel() {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xd9d4c6, roughness: 0.5, metalness: 0.35 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.95 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x9fb6c4, roughness: 0.3, metalness: 0.5 });
  const panelMat = new THREE.MeshStandardMaterial({ color: 0x2b4b6d, roughness: 0.4, metalness: 0.6 });
  const accentMat = new THREE.MeshStandardMaterial({ color: 0x6fe3d4, emissive: 0x1f6f7a, emissiveIntensity: 0.5, roughness: 0.4 });

  const chassis = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.5, 2.0), darkMat);
  chassis.position.y = 0.72;
  chassis.castShadow = true;
  group.add(chassis);

  const body = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.85, 1.8), bodyMat);
  body.position.y = 1.32;
  body.castShadow = true;
  group.add(body);

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.8, 1.5), glassMat);
  cabin.position.set(0.9, 2.0, 0);
  cabin.castShadow = true;
  group.add(cabin);

  const deck = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.08, 1.6), panelMat);
  deck.position.set(-0.4, 1.79, 0);
  deck.rotation.x = -0.18;
  group.add(deck);

  // mast + sensor head + antenna so it reads as autonomous
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.0, 6), darkMat);
  mast.position.set(0.4, 2.5, 0.7);
  group.add(mast);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.26, 0.28), bodyMat);
  head.position.set(0.4, 3.0, 0.7);
  group.add(head);
  group.add(new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), accentMat).translateX(0.4).translateY(3.0).translateZ(0.85));
  const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.9, 4), darkMat);
  ant.position.set(-1.4, 2.3, -0.7);
  group.add(ant);

  // cargo container — hidden until the rover is carrying ice home
  const cargo = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.7, 1.2), new THREE.MeshStandardMaterial({
    color: 0x9fdcff, emissive: 0x2c6f8f, emissiveIntensity: 0.4, roughness: 0.5, transparent: true, opacity: 0.92,
  }));
  cargo.position.set(-0.5, 2.15, 0);
  cargo.visible = false;
  group.add(cargo);

  // ice drill glow, used during the collecting animation
  const drill = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.7, 10), new THREE.MeshStandardMaterial({
    color: 0x63c7ff, emissive: 0x63c7ff, emissiveIntensity: 0.8, roughness: 0.4,
  }));
  drill.position.set(-0.6, 0.55, 0);
  drill.visible = false;
  group.add(drill);

  // six wheels on spin pivots (axle along X, roll about X)
  const wheels = [];
  for (const x of [-1.4, 0, 1.4]) {
    for (const z of [-0.95, 0.95]) {
      const pivot = new THREE.Object3D();
      pivot.position.set(x, 0.55, z);
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(ROVER.wheelRadius, ROVER.wheelRadius, 0.34, 14), darkMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.castShadow = true;
      pivot.add(wheel);
      group.add(pivot);
      wheels.push(pivot);
    }
  }

  group.userData.wheels = wheels;
  group.userData.cargo = cargo;
  group.userData.drill = drill;
  return group;
}

function lerpAngle(a, b, t) {
  let delta = b - a;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * t;
}

const last = (pts) => pts[pts.length - 1];

/**
 * Autonomous ice-hauling rover. Position is a deterministic function of the
 * simulation's rover phase + progress, so pausing, 2×/4× speed and save/load
 * all keep the vehicle exactly where the sim says it should be. The player
 * stays the astronaut; this is the secondary vehicle.
 */
export class RoverActor {
  constructor(world, colony, sim) {
    this.world = world;
    this.colony = colony;
    this.sim = sim;
    this.group = buildRoverModel();
    this.wheels = this.group.userData.wheels;
    this.cargo = this.group.userData.cargo;
    this.drill = this.group.userData.drill;

    const pad = facilityXZ('rover');
    this.pad = pad;
    this.position = new THREE.Vector3(pad.x, world.heightAt(pad.x, pad.z), pad.z);
    this.prevPosition = this.position.clone();
    this.yaw = Math.atan2(-pad.x, -pad.z);
    this.collectSpin = 0;
    this.cargoKind = null;
    this.group.position.copy(this.position);
    this.group.rotation.y = this.yaw;
    world.scene.add(this.group);
  }

  /** Where the astronaut can find the rover right now (for walk-up repairs). */
  get worldPosition() {
    return this.position;
  }

  update(simDt, realDt, time) {
    const r = this.sim.state.rover;
    const target = this.resolveTarget(r);

    // snap position to the sim-derived point, then derive visual speed from the delta
    this.position.set(target.x, this.world.heightAt(target.x, target.z), target.z);
    const moved = Math.hypot(this.position.x - this.prevPosition.x, this.position.z - this.prevPosition.z);

    if (moved > 0.02 && target.hasHeading) {
      const want = Math.atan2(target.dx, target.dz);
      this.yaw = lerpAngle(this.yaw, want, Math.min(1, simDt * ROVER.turnLerp));
    }
    this.group.rotation.y = this.yaw;
    // a little suspension bob while driving
    this.group.position.set(this.position.x, this.position.y + (moved > 0.02 ? Math.sin(time * 14) * 0.02 : 0), this.position.z);

    const spin = (moved / ROVER.wheelRadius);
    for (const w of this.wheels) w.rotation.x -= spin;

    // The bay crate shows the load; before it is won, the mission kind still
    // colours the drill, so an outbound run reads as what it is looking for.
    const tintKind = r.cargo?.kind ?? r.mission ?? null;
    if (tintKind !== this.cargoKind) {
      this.cargoKind = tintKind;
      const tint = CARGO_TINT[tintKind] ?? CARGO_TINT.ice;
      this.cargo.material.color.setHex(tint);
      this.cargo.material.emissive.setHex(tint);
      this.drill.material.color.setHex(tint);
      this.drill.material.emissive.setHex(tint);
    }
    this.cargo.visible = !!r.cargo;
    const collecting = r.phase === 'collecting' && !r.malfunction;
    this.drill.visible = collecting;
    if (collecting) {
      this.collectSpin += simDt * 8;
      this.drill.rotation.y = this.collectSpin;
      this.drill.position.y = 0.55 + Math.abs(Math.sin(this.collectSpin)) * 0.08;
    }

    this.prevPosition.copy(this.position);
  }

  resolveTarget(r) {
    if (r.malfunction) {
      return { x: this.position.x, z: this.position.z, dx: 0, dz: 0, hasHeading: false };
    }

    const survey = Math.max(0, r.survey);
    const route = roverRoute(survey);
    const progress = this.sim.roverProgress();

    switch (r.phase) {
      case 'outbound': {
        const p = pathPoint(route.out, progress);
        return { x: p.x, z: p.z, dx: p.dx, dz: p.dz, hasHeading: true };
      }
      case 'collecting': {
        const at = last(route.out);
        return { x: at.x, z: at.z, hasHeading: false };
      }
      case 'returning': {
        const p = pathPoint(route.back, progress);
        return { x: p.x, z: p.z, dx: p.dx, dz: p.dz, hasHeading: true };
      }
      case 'unloading': {
        const at = last(route.back);
        return { x: at.x, z: at.z, hasHeading: false };
      }
      case 'standby': {
        const p = pathPoint(route.toPad, progress);
        return { x: p.x, z: p.z, dx: p.dx, dz: p.dz, hasHeading: true };
      }
      default: {
        return { x: this.pad.x, z: this.pad.z, hasHeading: false };
      }
    }
  }

  /** Snap the visual to where the (possibly restored) sim expects it to be. */
  sync() {
    const r = this.sim.state.rover;
    if (r.phase === 'idle' || r.phase === 'cooldown') {
      this.position.set(this.pad.x, this.world.heightAt(this.pad.x, this.pad.z), this.pad.z);
    }
    this.prevPosition.copy(this.position);
  }
}

/** Small static gantry the rover docks on — replaces the old full rover prop. */
export function buildRoverDock(group, facility) {
  const ramp = new THREE.Mesh(
    new THREE.BoxGeometry(4.2, 0.25, 3.0),
    new THREE.MeshStandardMaterial({ color: 0x6b5a48, roughness: 0.9 }),
  );
  ramp.position.set(0, 0.5, 2.9);
  ramp.rotation.x = -0.22;
  ramp.castShadow = true;
  group.add(ramp);

  const dockPostMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.6, metalness: 0.5 });
  for (const x of [-2.4, 2.4]) {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 2.2, 8), dockPostMat);
    p.position.set(x, 1.4, -2.5);
    group.add(p);
  }
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 5.0, 8), dockPostMat);
  arm.rotation.z = Math.PI / 2;
  arm.position.set(0, 2.5, -2.5);
  group.add(arm);

  const dropper = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.0, 6), dockPostMat);
  dropper.position.set(0, 2.0, -2.5);
  group.add(dropper);

  const lamp = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0x111111, emissive: facility.color, emissiveIntensity: 0.9 }),
  );
  lamp.position.set(0, 2.5, -2.5);
  group.add(lamp);
}
