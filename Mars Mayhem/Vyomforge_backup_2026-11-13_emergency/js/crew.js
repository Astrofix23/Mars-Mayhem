import { createAstronaut } from './astronaut.js';
import { POSTS, WORLD, arcPoints, pathLen, pathPoint } from './config.js';

const WALK_SPEED = 3.4;
const SAFE_POST = 'hab';
const LYING = -Math.PI / 2 + 0.06; // almost flat, a touch propped on the pillow

/**
 * Visual actors for Maya, Alex and Sam. They walk the ring road to whichever
 * post the player assigns them to, which is how crew assignments become legible
 * in the world: nobody ever teleports, and every body is somewhere for a reason.
 */
export class CrewActors {
  constructor(world, colony, sim) {
    this.world = world;
    this.colony = colony;
    this.sim = sim;
    this.actors = new Map();

    sim.state.crew.forEach((member, index) => {
      const rig = createAstronaut({ suit: 0xd7dde2, accent: member.color });

      const badge = this.#buildBadge(member);
      badge.sprite.position.set(0, 2.42, 0);
      rig.group.add(badge.sprite);

      const marker = new THREE.Mesh(
        new THREE.TorusGeometry(0.8, 0.055, 6, 22),
        new THREE.MeshStandardMaterial({
          color: 0x101010, emissive: member.color, emissiveIntensity: 0.7, roughness: 0.6,
        }),
      );
      marker.rotation.x = -Math.PI / 2;
      marker.position.y = 0.06;
      rig.group.add(marker);

      world.scene.add(rig.group);

      // Everyone starts the sol in the habitat, so their first walk to their
      // posts is something the player actually sees happen.
      const start = this.#standoff(SAFE_POST, index);
      start.y = world.heightAt(start.x, start.z);
      rig.group.position.copy(start);

      this.actors.set(member.id, {
        member,
        index,
        rig,
        badge,
        marker,
        position: start.clone(),
        heading: 0,
        speed: 0,
        route: [{ x: start.x, z: start.z }],
        routeLen: 0,
        u: 1,
        targetPost: null,
        berth: null,
        lying: 0,
      });
    });

    this.refreshTargets(false);
  }

  /** Recompute walk targets after a crew reassignment or a shelter order. */
  refreshTargets(snap = false) {
    for (const actor of this.actors.values()) {
      const member = actor.member;
      const berth = member.sleeping ? this.#berthFor(actor.index) : null;
      const postId = berth ? SAFE_POST : this.postFor(member);
      const target = berth ?? this.#standoff(postId, actor.index);
      const key = berth ? `bunk${actor.index}` : postId;
      if (key === actor.targetPost && !snap) continue;
      actor.targetPost = key;
      actor.berth = berth;
      actor.badge.setPost(berth ? 'Sleeping' : this.#labelFor(postId));

      actor.route = this.#routeTo(actor.position, target);
      actor.routeLen = pathLen(actor.route);
      actor.u = 0;

      if (snap) {
        actor.position.set(target.x, this.world.heightAt(target.x, target.z), target.z);
        actor.rig.group.position.copy(actor.position);
        actor.route = [actor.position.clone()];
        actor.routeLen = 0;
        actor.u = 1;
      }
    }
  }

  /** simDt is scaled by the speed control and is 0 while paused, so the crew
   *  freeze with the rest of the simulation instead of strolling on regardless. */
  update(simDt, time) {
    this.refreshTargets();
    for (const actor of this.actors.values()) {
      const member = actor.member;
      const at = this.#advance(actor, simDt);
      const inBunk = Boolean(actor.berth) && actor.u >= 1 && member.sleeping;
      const working = simDt > 0 && actor.u >= 1 && !inBunk && !this.sim.state.crewSheltered
        && this.sim.crewAt(actor.member.postId) != null;

      // The simulation reads this flag to tell walking from standing duty.
      member.moving = at.moving;
      actor.speed = at.moving ? WALK_SPEED : 0;

      if (inBunk) {
        actor.position.set(actor.berth.x, actor.berth.y, actor.berth.z);
        actor.heading = lerpAngle(actor.heading, actor.berth.heading, Math.min(1, simDt * 4));
        actor.lying = Math.min(1, actor.lying + simDt * 1.6);
      } else {
        if (at.moving) {
          actor.heading = lerpAngle(actor.heading, Math.atan2(at.dx, at.dz), Math.min(1, simDt * 8));
        } else {
          const facility = this.colony.get(actor.member.postId);
          if (facility) {
            const h = Math.atan2(facility.position.x - actor.position.x, facility.position.z - actor.position.z);
            actor.heading = lerpAngle(actor.heading, h, Math.min(1, simDt * 3));
          }
        }
        actor.position.set(at.x, this.world.heightAt(at.x, at.z), at.z);
        actor.lying = Math.max(0, actor.lying - simDt * 2.2);
      }

      actor.rig.group.position.copy(actor.position);
      actor.rig.group.rotation.y = actor.heading;
      actor.rig.group.rotation.x = LYING * actor.lying;
      actor.rig.update(simDt, actor.lying > 0.5 ? 0 : actor.speed, time + actor.index, working ? 1 : 0);

      const glow = working ? 1.1 + Math.sin(time * 3 + actor.index) * 0.35 : at.moving ? 0.55 : 0.3;
      actor.marker.material.emissiveIntensity = inBunk ? 0 : glow;
      actor.marker.rotation.z += (working ? simDt * 1.6 : 0);
      actor.badge.sprite.visible = !inBunk;
    }
  }

  /** Snap everyone to their posts without walking — used for restored saves. */
  sync() {
    this.refreshTargets(true);
  }

  /* ───────────────────────────── internals ───────────────────────────── */

  #advance(actor, simDt) {
    if (actor.u >= 1 || actor.routeLen <= 0 || simDt <= 0) {
      return { x: actor.position.x, z: actor.position.z, dx: 0, dz: 0, moving: false };
    }
    actor.u = Math.min(1, actor.u + (WALK_SPEED * simDt) / actor.routeLen);
    const p = pathPoint(actor.route, actor.u);
    return { x: p.x, z: p.z, dx: p.dx, dz: p.dz, moving: true };
  }

  /** Which facility this body should be standing at right now. */
  postFor(member) {
    if (this.sim.state.crewSheltered) return 'shelter';
    return member.postId || SAFE_POST;
  }

  /** The HAB berth a sleeping crew member walks to, or null when on duty. */
  #berthFor(index) {
    const bunks = this.colony.bunks;
    return bunks?.[index] ?? bunks?.[0] ?? null;
  }

  #labelFor(postId) {
    if (postId === 'shelter') return 'Sheltering';
    const post = POSTS.find((p) => p.id === postId);
    return post ? post.label : 'Unassigned';
  }

  /** Standing point at the road side of a facility pad, offset per crew index. */
  #standoff(postId, index) {
    const facility = this.colony.get(postId) ?? this.colony.get(SAFE_POST);
    const a = Math.atan2(facility.position.z, facility.position.x);
    const orbit = Math.hypot(facility.position.x, facility.position.z);
    // Off-ring structures stand further out; the ring facilities are unchanged.
    const lane = orbit + (facility.radius ?? 8.5) - 0.3;
    const jitter = (index - 1) * 2.1;
    return new THREE.Vector3(
      Math.cos(a) * lane - Math.sin(a) * jitter,
      0,
      Math.sin(a) * lane + Math.cos(a) * jitter,
    );
  }

  /** Out along the ring road, around it, then in — so crew never clip through buildings. */
  #routeTo(from, to) {
    const fromA = Math.atan2(from.z, from.x);
    const toA = Math.atan2(to.z, to.x);
    const toR = Math.hypot(to.x, to.z);
    const lane = (angle, radius) => ({
      x: Math.cos(angle) * radius,
      z: Math.sin(angle) * radius,
    });
    // Off-ring posts get a radial lane; the ring road is only used to reach it.
    const mid = toR > WORLD.roadRadius ? [lane(toA, toR - 2)] : [];
    // Bunks are inside the HAB shell, so sleepers go in and out through the airlock.
    const collision = this.colony.collision;
    const leave = collision ? collision.doorwayPath(from, lane(fromA, WORLD.roadRadius)) : [];
    const arrive = collision ? collision.doorwayPath(to, lane(toA, WORLD.roadRadius)).reverse() : [];
    return [
      { x: from.x, z: from.z },
      ...leave,
      lane(fromA, WORLD.roadRadius),
      ...arcPoints(fromA, toA, WORLD.roadRadius, 0.45),
      lane(toA, WORLD.roadRadius),
      ...mid,
      ...arrive,
      { x: to.x, z: to.z },
    ];
  }

  #buildBadge(member) {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 96;
    const ctx = canvas.getContext('2d');
    const texture = new THREE.CanvasTexture(canvas);
    texture.encoding = THREE.sRGBEncoding;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false }),
    );
    sprite.scale.set(3.4, 1.02, 1);

    let post = 'Unassigned';
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = 'rgba(10, 7, 5, 0.62)';
      roundRect(ctx, 6, 10, canvas.width - 12, 76, 18);
      ctx.fill();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '700 34px ui-monospace, Consolas, monospace';
      ctx.fillStyle = `#${member.color.toString(16).padStart(6, '0')}`;
      ctx.fillText(member.name.toUpperCase(), canvas.width / 2, 34);
      ctx.font = '600 26px ui-monospace, Consolas, monospace';
      ctx.fillStyle = '#ffd7b0';
      ctx.fillText(post.toUpperCase(), canvas.width / 2, 66);
      texture.needsUpdate = true;
    };
    draw();

    return { sprite, setPost(next) { post = next; draw(); } };
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

function lerpAngle(a, b, t) {
  let delta = b - a;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * t;
}
