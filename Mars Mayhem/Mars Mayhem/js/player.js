import { PLAYER, SHIFT_LOCK, WORLD } from './config.js';
import { createAstronaut } from './astronaut.js';

/** Third-person astronaut controller: camera-relative movement, terrain follow, repairs. */
export class Player {
  constructor(world, colony) {
    this.world = world;
    this.colony = colony;
    this.rig = createAstronaut({ accent: 0x6fe3d4 });
    this.position = new THREE.Vector3(0, 0, 9);
    this.position.y = world.heightAt(0, 9);
    this.heading = Math.PI;
    this.speed = 0;
    this.walkPhase = 0;

    this.repair = null;
    this.rest = null;
    this.lying = 0;
    this.cleanCooldown = 0;
    this.stepAccumulator = 0;
    this.onFootstep = null;

    world.scene.add(this.rig.group);
    this.syncTransform();
  }

  get focus() {
    return new THREE.Vector3(this.position.x, this.position.y + 1.5, this.position.z);
  }

  nearestFacility() {
    return this.colony.nearest(this.position);
  }

  /** The console the commander is standing at — the sim pays for holding a post open. */
  coveringPost() {
    return this.nearestFacility()?.id ?? null;
  }

  /**
   * Begin a walk-up repair. `target.mode` selects which simulation action the
   * repair finishes with: a facility, the rover wherever it happens to be
   * (`anchor` tracks the actor's live position), or an external seal.
   */
  startRepair(target) {
    if (!target || this.repair) return false;
    this.repair = {
      id: target.id,
      mode: target.mode ?? 'facility',
      anchor: target.anchor ?? null,
      seconds: target.seconds ?? PLAYER.repairSeconds,
      progress: 0,
    };
    return true;
  }

  cancelRepair() {
    this.repair = null;
  }

  cleanPanels() {
    this.cleanCooldown = PLAYER.cleanCooldown;
  }

  /**
   * Lie down on a HAB berth. The caller owns the camera while the commander is
   * asleep; the rig simply stops accepting input and reclines.
   */
  beginRest(berth) {
    if (this.rest) return false;
    this.cancelRepair();
    this.rest = berth
      ? { ...berth, bunk: true }
      : {
        x: this.position.x,
        y: this.position.y + 1.02,
        z: this.position.z,
        heading: this.heading,
      };
    this.lying = 0;
    return true;
  }

  /**
   * Wake up standing. Three things have to be undone that lying down did: the
   * recline (which lives on the rig's own rotation.x, not on any pose the limb
   * animator knows about), the velocity the rest branch parked in `speed`, and
   * the position — a berth point is *inside* the mattress, so the commander is
   * stepped back into the HAB aisle before he is dropped onto the floor.
   *
   * `lying` is deliberately left non-zero: update() blends it down to a stand-up
   * animation. Zeroing it here is what used to leave the astronaut face-down in
   * his bunk with the controls already handed back.
   */
  endRest() {
    const berth = this.rest;
    this.rest = null;
    this.speed = 0;
    this.walkPhase = 0;
    this.stepAccumulator = 0;

    if (berth?.bunk) {
      const hab = this.colony.get('hab');
      if (hab) {
        const dx = this.position.x - hab.position.x;
        const dz = this.position.z - hab.position.z;
        const r = Math.hypot(dx, dz) || 1;
        const aisle = Math.max(0.8, r - 1.6);
        this.position.x = hab.position.x + (dx / r) * aisle;
        this.position.z = hab.position.z + (dz / r) * aisle;
      }
    }
    this.position.y = this.world.heightAt(this.position.x, this.position.z);
    this.rig.group.position.copy(this.position);
    this.rig.group.rotation.y = this.heading;
  }

  update(dt, time, input, yaw, cameraLocked = false) {
    if (this.cleanCooldown > 0) this.cleanCooldown = Math.max(0, this.cleanCooldown - dt);

    if (this.rest) {
      this.lying = Math.min(1, this.lying + dt * 1.6);
      this.speed = 0;
      this.position.set(this.rest.x, this.rest.y, this.rest.z);
      this.heading = lerpAngle(this.heading, this.rest.heading, Math.min(1, dt * 4));
      this.rig.group.position.copy(this.position);
      this.rig.group.rotation.y = this.heading;
      this.rig.group.rotation.x = (-Math.PI / 2 + 0.06) * this.lying;
      this.rig.update(dt, 0, time, 0);
      return;
    }
    if (this.lying > 0) {
      // Standing back up: the same recline, run in reverse, while the legs are
      // already free to walk.
      this.lying = Math.max(0, this.lying - dt * 2.8);
      this.rig.group.rotation.x = (-Math.PI / 2 + 0.06) * this.lying;
      if (this.lying === 0) this.rig.group.rotation.x = 0;
    }

    const fwd = new THREE.Vector2(-Math.sin(yaw), -Math.cos(yaw));
    const right = new THREE.Vector2(-fwd.y, fwd.x);

    const move = new THREE.Vector2(0, 0);
    if (input.forward) move.y += 1;
    if (input.back) move.y -= 1;
    if (input.right) move.x += 1;
    if (input.left) move.x -= 1;

    const repairing = Boolean(this.repair);
    const moving = move.lengthSq() > 0 && !repairing;

    if (moving) {
      move.normalize();
      const dirX = fwd.x * move.y + right.x * move.x;
      const dirZ = fwd.y * move.y + right.y * move.x;
      const speed = input.sprint ? PLAYER.sprintSpeed : PLAYER.walkSpeed;
      this.position.x += dirX * speed * dt;
      this.position.z += dirZ * speed * dt;
      this.speed = speed;

      const target = Math.atan2(dirX, dirZ);
      let delta = target - this.heading;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      this.heading += delta * Math.min(1, dt * PLAYER.turnLerp);
    } else {
      this.speed = 0;
      // Shift Lock is a aiming rig, not an orbit: standing still, the commander
      // faces where the camera looks, exactly as he does while walking forward.
      if (cameraLocked && !repairing) {
        this.heading = lerpAngle(
          this.heading,
          yaw + Math.PI,
          Math.min(1, dt * SHIFT_LOCK.idleFaceLerp),
        );
      }
    }

    this.colony.collision?.resolve(this.position);

    const limit = WORLD.playableRadius;
    const dist = Math.hypot(this.position.x, this.position.z);
    if (dist > limit) {
      this.position.x = (this.position.x / dist) * limit;
      this.position.z = (this.position.z / dist) * limit;
    }
    this.position.y = this.world.heightAt(this.position.x, this.position.z);

    if (this.speed > 0) {
      this.stepAccumulator += this.speed * dt;
      if (this.stepAccumulator > 2.1) {
        this.stepAccumulator = 0;
        if (this.onFootstep) this.onFootstep();
      }
    }

    if (this.repair) {
      if (this.inRepairRange()) {
        this.repair.outOfRange = 0;
        this.repair.progress += dt / this.repair.seconds;
        if (this.repair.progress >= 1) this.repair.done = true;
      } else {
        this.repair.progress = Math.max(0, this.repair.progress - dt * 0.35);
        // The anchor can move or be fixed by someone else. Never leave the
        // commander frozen in a repair loop that can no longer complete.
        this.repair.outOfRange = (this.repair.outOfRange ?? 0) + dt;
        if (this.repair.outOfRange >= 1.2 || this.repair.progress <= 0) this.cancelRepair();
      }
    }

    this.rig.update(dt, this.speed, time);
    this.syncTransform();
  }

  /** Whether the astronaut is standing at the thing they said they were fixing. */
  inRepairRange() {
    if (!this.repair) return false;
    const anchor = this.repair.anchor;
    if (anchor) {
      return Math.hypot(this.position.x - anchor.x, this.position.z - anchor.z) < PLAYER.interactRadius + 2.5;
    }
    const near = this.nearestFacility();
    return Boolean(near && near.id === this.repair.id);
  }

  syncTransform() {
    this.rig.group.position.copy(this.position);
    this.rig.group.rotation.y = this.heading;
  }
}

function lerpAngle(a, b, t) {
  let delta = b - a;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * t;
}
