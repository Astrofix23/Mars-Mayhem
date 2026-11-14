/**
 * Hand-authored footprints so the commander cannot walk through a building.
 *
 * Three primitives are enough for the whole colony: a circle, an oriented box
 * and a wall ring with a doorway. Resolution is one push-out per shape, which
 * costs a couple of dozen hypots per frame and can never desync from the meshes
 * the way a physics engine would.
 *
 * The BIO-DOME is deliberately absent — the agriculture shell stays
 * pass-through so the crops stay readable. The HAB is a ring with a doorway
 * under the airlock porch, because its crew bunks now live inside it.
 */

/** The astronaut's own body radius, so he stops at the wall instead of in it. */
const BODY = 0.5;

/**
 * Shapes are given in each facility's local frame, where +z is the side that
 * faces the colony centre — the same frame the builders in js/colony.js use.
 */
const FOOTPRINTS = {
  hab: [
    { kind: 'shell', r: 4.4, thickness: 0.35, doorX: -1.2, doorWidth: 3.2 },
  ],
  solar: [
    { kind: 'box', hx: 1.6, hz: 1.0, x: -4.2, z: -3.2 },
    { kind: 'box', hx: 1.6, hz: 1.0, x: 0, z: -3.6 },
    { kind: 'box', hx: 1.6, hz: 1.0, x: 4.2, z: -3.2 },
    { kind: 'box', hx: 1.6, hz: 1.0, x: -2.2, z: 2.6 },
    { kind: 'box', hx: 1.6, hz: 1.0, x: 2.2, z: 2.6 },
  ],
  bat: [
    { kind: 'box', hx: 3.2, hz: 2.2, x: 0, z: 0 },
  ],
  aqua: [
    { kind: 'circle', r: 1.6, x: -2.4, z: 0 },
    { kind: 'circle', r: 1.6, x: 2.4, z: 0 },
    { kind: 'box', hx: 1.2, hz: 1.1, x: 0, z: 2.6 },
  ],
  o2: [
    { kind: 'box', hx: 2.3, hz: 1.5, x: 0, z: 0 },
  ],
  sci: [
    { kind: 'box', hx: 2.8, hz: 2.1, x: 0, z: 0 },
  ],
  comms: [
    { kind: 'circle', r: 1.1, x: 0, z: 0 },
    { kind: 'box', hx: 1.6, hz: 1.3, x: -3.4, z: 1.2 },
  ],
  shelter: [
    { kind: 'box', hx: 4.6, hz: 3.6, x: 0, z: 0 },
  ],
  fuel: [
    { kind: 'circle', r: 2.0, x: -1.5, z: -0.4 },
    { kind: 'circle', r: 1.7, x: 3.7, z: -2.7 },
    { kind: 'box', hx: 1.5, hz: 1.5, x: -4.4, z: 2.3 },
    { kind: 'box', hx: 1.8, hz: 1.1, x: 4.3, z: 1.9 },
    { kind: 'box', hx: 2.8, hz: 1.4, x: 0.4, z: 2.9 },
  ],
  pad: [
    { kind: 'circle', r: 2.0, x: 1.2, z: 0 },
    { kind: 'box', hx: 0.9, hz: 0.9, x: -5.6, z: 0 },
    { kind: 'box', hx: 1.7, hz: 1.0, x: -8.8, z: 6.6 },
    { kind: 'circle', r: 1.3, x: 7.2, z: -5.8 },
  ],
};

export class ColonyCollision {
  constructor(colony) {
    this.solids = [];

    for (const [id, shapes] of Object.entries(FOOTPRINTS)) {
      const facility = colony.get(id);
      if (!facility) continue;
      const rot = facility.group.rotation.y;
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const centre = facility.position;

      for (const shape of shapes) {
        if (shape.kind === 'shell') {
          // The doorway sits on the centre-facing wall, so its bearing is the
          // angle from the building centre out to the door.
          const dx = shape.doorX * cos + shape.r * sin;
          const dz = -shape.doorX * sin + shape.r * cos;
          const d = Math.hypot(dx, dz) || 1;
          this.solids.push({
            type: 'shell',
            x: centre.x,
            z: centre.z,
            r: shape.r,
            band: shape.thickness + BODY,
            wall: shape.thickness,
            doorAngle: Math.atan2(dz, dx),
            doorHalf: Math.asin(Math.min(0.95, shape.doorWidth / 2 / shape.r)),
            inner: shape.r - 1.4,
            approach: {
              x: centre.x + (dx / d) * (shape.r + 1.6),
              z: centre.z + (dz / d) * (shape.r + 1.6),
            },
          });
          continue;
        }

        const x = centre.x + shape.x * cos + shape.z * sin;
        const z = centre.z - shape.x * sin + shape.z * cos;
        if (shape.kind === 'circle') {
          this.solids.push({ type: 'circle', x, z, r: shape.r });
        } else {
          this.solids.push({ type: 'box', x, z, hx: shape.hx, hz: shape.hz, cos, sin });
        }
      }
    }
  }

  /** Slide a world position out of every building it is standing inside. */
  resolve(position) {
    for (let pass = 0; pass < 3; pass++) {
      let hit = false;
      for (const shape of this.solids) {
        if (shape.type === 'circle') hit = this.#circle(position, shape) || hit;
        else if (shape.type === 'box') hit = this.#box(position, shape) || hit;
        else hit = this.#shell(position, shape) || hit;
      }
      if (!hit) break;
    }

    // The fuel plant's vessels sit closer together than the astronaut is wide,
    // so a walker dropped into that seam has no legal square to stand in.
    // Slide them straight out along the bearing from the thing they are in.
    for (let guard = 0; guard < 3; guard++) {
      const wedged = this.#inside(position);
      if (!wedged) return;
      const dx = position.x - wedged.x;
      const dz = position.z - wedged.z;
      const d = Math.hypot(dx, dz) || 1;
      for (let step = 1; step < 24 && this.#inside(position); step++) {
        const k = d + step * 0.6;
        position.x = wedged.x + (dx / d) * k;
        position.z = wedged.z + (dz / d) * k;
      }
    }
  }

  /** Which solid mesh this point is standing inside of, or null. */
  #inside(position) {
    for (const s of this.solids) {
      const dx = position.x - s.x;
      const dz = position.z - s.z;
      if (s.type === 'circle') {
        if (Math.hypot(dx, dz) < s.r) return s;
      } else if (s.type === 'box') {
        const lx = dx * s.cos - dz * s.sin;
        const lz = dx * s.sin + dz * s.cos;
        if (Math.abs(lx) < s.hx && Math.abs(lz) < s.hz) return s;
      } else if (Math.abs(Math.hypot(dx, dz) - s.r) < s.wall) {
        let delta = Math.atan2(dz, dx) - s.doorAngle;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        if (Math.abs(delta) > s.doorHalf) return s;
      }
    }
    return null;
  }

  /**
   * Waypoints that carry a walker between the airlock of the building a point is
   * inside and a spot out on the road, hugging the shell rather than cutting a
   * chord straight through it. Empty when the point is not inside a walled
   * building — crew routing splices the result in either direction.
   */
  doorwayPath(inside, outside) {
    const shell = this.#shellAt(inside.x, inside.z);
    if (!shell) return [];
    const rho = shell.r + 1.6;
    let delta = Math.atan2(outside.z - shell.z, outside.x - shell.x) - shell.doorAngle;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    const steps = Math.max(1, Math.ceil(Math.abs(delta) / 0.7));
    // Step out along the door radius first, then hug the shell: the bunks are
    // spread wider than the doorway, so a straight berth-to-door line grazes it.
    const points = [
      { x: shell.x + Math.cos(shell.doorAngle) * shell.inner, z: shell.z + Math.sin(shell.doorAngle) * shell.inner },
      { x: shell.approach.x, z: shell.approach.z },
    ];
    for (let i = 1; i < steps; i++) {
      const a = shell.doorAngle + (delta * i) / steps;
      points.push({ x: shell.x + Math.cos(a) * rho, z: shell.z + Math.sin(a) * rho });
    }
    return points;
  }

  #shellAt(x, z) {
    for (const shape of this.solids) {
      if (shape.type === 'shell' && Math.hypot(x - shape.x, z - shape.z) < shape.r) return shape;
    }
    return null;
  }

  #circle(position, s) {
    const dx = position.x - s.x;
    const dz = position.z - s.z;
    const limit = s.r + BODY;
    const d = Math.hypot(dx, dz);
    if (d >= limit) return false;
    if (d < 1e-4) {
      position.x = s.x + limit;
      return true;
    }
    const k = limit / d;
    position.x = s.x + dx * k;
    position.z = s.z + dz * k;
    return true;
  }

  #box(position, s) {
    const ox = position.x - s.x;
    const oz = position.z - s.z;
    const lx = ox * s.cos - oz * s.sin;
    const lz = ox * s.sin + oz * s.cos;
    const px = s.hx + BODY - Math.abs(lx);
    const pz = s.hz + BODY - Math.abs(lz);
    if (px <= 0 || pz <= 0) return false;

    // Leave through whichever face is nearest; that is what keeps corners smooth.
    if (px < pz) {
      const out = (Math.sign(lx) || 1) * (s.hx + BODY);
      position.x = s.x + out * s.cos + lz * s.sin;
      position.z = s.z - out * s.sin + lz * s.cos;
    } else {
      const out = (Math.sign(lz) || 1) * (s.hz + BODY);
      position.x = s.x + lx * s.cos + out * s.sin;
      position.z = s.z - lx * s.sin + out * s.cos;
    }
    return true;
  }

  #shell(position, s) {
    const dx = position.x - s.x;
    const dz = position.z - s.z;
    const d = Math.hypot(dx, dz);
    const inner = s.r - s.band;
    const outer = s.r + s.band;
    if (d < 1e-4 || d < inner || d > outer) return false;

    let delta = Math.atan2(dz, dx) - s.doorAngle;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    if (Math.abs(delta) < s.doorHalf) return false;

    const target = d < s.r ? inner : outer;
    const k = target / d;
    position.x = s.x + dx * k;
    position.z = s.z + dz * k;
    return true;
  }
}
