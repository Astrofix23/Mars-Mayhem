import { WORLD, CAMERA, SHIFT_LOCK, FACILITIES, facilityXZ } from './config.js';
import { fbm, ridged, mulberry32 } from './noise.js';

const DAY_COLOR = new THREE.Color(0xc07f52);
const NIGHT_COLOR = new THREE.Color(0x1b1118);
const RAD_COLOR = new THREE.Color(0xb04a2a);
const RIM_START = WORLD.playableRadius * 0.78;
const RIM_RISE = 150;

/**
 * Owns the renderer, scene, camera, lighting, terrain and the ambient dust.
 * Everything is procedurally generated, so the build runs with zero network access.
 */
export class World {
  constructor(container) {
    this.container = container;
    this.clock = 0;
    this.craters = this.#makeCraters();
    this.levelPads = this.#makeLevelPads();

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0xb0714e, 0.0032);

    this.camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 1600);
    this.camera.position.set(0, 14, 26);

    this.#buildSky();
    this.#buildLights();
    this.#buildTerrain();
    this.#scatterRocks();
    this.#buildDust();
    this.devil = this.#buildDevil();
    this.meteors = [];
  }

  /* ───────────────────────────── public API ───────────────────────────── */

  heightAt(x, z) {
    const h = this.#baseHeight(x, z);
    if (!this.levelPads) return h;
    let out = h;
    for (const p of this.levelPads) {
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < p.r * 1.35) out += (p.y - out) * (1 - smoothstep(p.r * 0.62, p.r * 1.35, d));
    }
    return out;
  }

  #baseHeight(x, z) {
    const dist = Math.hypot(x, z);

    // Broad rolling dunes plus a ridged wall towards the map edges.
    let h = (fbm(x * 0.0075, z * 0.0075, 4, WORLD.seed) - 0.5) * 15;
    h += (fbm(x * 0.028, z * 0.028, 3, WORLD.seed + 11) - 0.5) * 2.4;

    // Mid-field hills so the expanded map has relief between the colony and the rim.
    h += smoothstep(55, 240, dist) * (fbm(x * 0.013, z * 0.013, 3, WORLD.seed + 23) - 0.5) * 30;

    const edge = Math.max(0, (dist - RIM_START) / RIM_RISE);
    h += edge * edge * ridged(x * 0.014, z * 0.014, 4) * 62;

    for (const c of this.craters) {
      const d = Math.hypot(x - c.x, z - c.z);
      if (d < c.r * 1.6) {
        if (d < c.r) {
          h -= c.depth * (1 - (d / c.r) ** 2);
        }
        const rim = Math.exp(-(((d - c.r) / (c.r * 0.22)) ** 2));
        h += c.depth * 0.42 * rim;
      }
    }

    // Flatten the colony plateau and blend it smoothly into the dunes.
    const blend = smoothstep(WORLD.colonyRadius * 0.75, WORLD.colonyRadius * 2.4, dist);
    const plateau = (fbm(x * 0.06, z * 0.06, 2, WORLD.seed + 5) - 0.5) * 0.14;
    return plateau * (1 - blend) + h * blend;
  }

  /** Sunlight strength 0..1 for a given hour of the sol. */
  static daylight(hour) {
    return Math.max(0, Math.sin((Math.PI * (hour - 6)) / 12));
  }

  update(dt, { hour, storm = 0, devil = 0, devilPos = null, radiation = 0, simDt = dt } = {}) {
    this.clock += dt;

    const day = World.daylight(hour);
    const t = (hour - 6) / 12;
    const sunX = Math.cos(Math.PI * t) * 190;
    const sunY = Math.max(day * 165, -50);

    // The shadow volume follows the astronaut, so distant survey drives keep
    // crisp shadows instead of dropping them outside a fixed box at the origin.
    const fx = this.follow ? this.follow.x : 0;
    const fz = this.follow ? this.follow.z : 0;
    this.sun.position.set(fx + sunX, sunY, fz + 95);
    if (this.sun.target) {
      this.sun.target.position.set(fx, this.follow ? this.follow.y : 0, fz);
      this.sun.target.updateMatrixWorld();
    }
    this.sun.intensity = 0.12 + day * 1.25 * (1 - storm * 0.7);
    this.hemi.intensity = 0.1 + day * 0.28;
    this.sun.color.setHex(day > 0.35 ? 0xffe0bd : 0xff9a63);

    const haze = NIGHT_COLOR.clone().lerp(DAY_COLOR, Math.min(1, day * 1.35));
    if (radiation > 0) haze.lerp(RAD_COLOR, Math.min(0.55, radiation * 0.45));
    if (devil > 0) haze.lerp(new THREE.Color(0x8a5334), Math.min(0.4, devil * 0.35));
    this.skyMat.uniforms.top.value.copy(haze).multiplyScalar(0.55);
    this.skyMat.uniforms.bottom.value.copy(haze).lerp(new THREE.Color(0x2a1a15), storm * 0.55 + (1 - day) * 0.5);
    this.scene.fog.color.copy(haze).lerp(new THREE.Color(0x6b3f2c), storm * 0.5);
    this.scene.fog.density = 0.0026 + storm * 0.009 + devil * 0.004 + radiation * 0.002;

    this.#updateDust(dt);
    this.#updateDevil(simDt, devil, devilPos);
    this.#updateMeteors(simDt);
  }

  /** Spawn a falling meteor. Falls for `duration` real seconds, then onImpact(x, z). */
  spawnMeteor(x, z, onImpact, duration = 1.1) {
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.7, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xffd9a0 }),
    );
    const trail = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.5, 26, 8, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xff9a5c, transparent: true, opacity: 0.5, depthWrite: false }),
    );
    trail.rotation.x = Math.PI / 2;
    head.add(trail);

    const startY = this.heightAt(x, z) + 260;
    head.position.set(x + 90, startY, z + 60);
    this.scene.add(head);
    const fall = Math.max(0.4, duration);
    this.meteors.push({
      head,
      from: head.position.clone(),
      to: new THREE.Vector3(x, this.heightAt(x, z), z),
      t: 0,
      fall,
      onImpact,
    });
  }

  #updateMeteors(dt) {
    for (let i = this.meteors.length - 1; i >= 0; i--) {
      const m = this.meteors[i];
      m.t += dt / m.fall;
      if (m.t >= 1) {
        this.scene.remove(m.head);
        disposeTree(m.head);
        this.meteors.splice(i, 1);
        m.onImpact?.(m.to.x, m.to.z);
        continue;
      }
      m.head.position.lerpVectors(m.from, m.to, m.t * m.t);
    }
  }

  #updateDevil(dt, strength, pos) {
    const on = strength > 0 && pos;
    this.devil.visible = on;
    if (!on) return;
    // the cone wanders across the array field rather than sitting still
    const x = pos.x + Math.sin(this.clock * 0.55) * 11;
    const z = pos.z + Math.cos(this.clock * 0.41) * 9;
    this.devil.position.set(x, this.heightAt(x, z), z);
    this.devil.rotation.y += dt * 7;
    const s = 0.6 + Math.min(1, strength) * 0.9;
    this.devil.scale.set(s, s, s);
    const opacity = 0.18 + Math.min(0.3, strength * 0.22);
    for (const child of this.devil.children) child.material.opacity = opacity;
  }

  #buildDevil() {
    const geo = new THREE.ConeGeometry(4.2, 22, 18, 1, true);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xc98a5c,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const cone = new THREE.Mesh(geo, mat);
    cone.position.y = 11;
    const group = new THREE.Group();
    group.add(cone);
    // a wider skirt of dust at ground level
    const skirt = new THREE.Mesh(
      new THREE.ConeGeometry(7, 6, 20, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xb0714e, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide }),
    );
    skirt.position.y = 3;
    group.add(skirt);
    group.visible = false;
    group.frustumCulled = false;
    this.scene.add(group);
    return group;
  }

  setCameraTarget(pos) {
    this.follow = pos;
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  /* ───────────────────────────── internals ───────────────────────────── */

  #makeCraters() {
    const rand = mulberry32(WORLD.seed + 3);
    const craters = [];
    for (let i = 0; i < 16; i++) {
      const angle = rand() * Math.PI * 2;
      const dist = 58 + rand() * (WORLD.playableRadius - 40);
      craters.push({
        x: Math.cos(angle) * dist,
        z: Math.sin(angle) * dist,
        r: 12 + rand() * 26,
        depth: 3 + rand() * 7,
      });
    }
    return craters;
  }

  /**
   * Off-ring structures (propellant plant, launch site) need level ground. Each
   * pad is graded to its own centre height and blended into the dunes at the
   * edge, so a 26 m concrete apron never intersects a hillside.
   */
  #makeLevelPads() {
    return FACILITIES.filter((f) => f.orbit).map((f) => {
      const p = facilityXZ(f.id);
      const r = (f.padRadius ?? 9) + 7;
      return { ...p, r, y: this.#baseHeight(p.x, p.z) };
    });
  }

  #buildSky() {
    const geo = new THREE.SphereGeometry(WORLD.size * 1.35, 32, 18);
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x241310) },
        bottom: { value: new THREE.Color(0x5a3324) },
      },
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
          vec3 c = mix(bottom, top, smoothstep(0.42, 0.95, h));
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.scene.add(new THREE.Mesh(geo, this.skyMat));
  }

  #buildLights() {
    this.hemi = new THREE.HemisphereLight(0xd9a184, 0x3d2418, 0.6);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xffe0bd, 1.5);
    this.sun.position.set(120, 150, 90);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -80;
    this.sun.shadow.camera.right = 80;
    this.sun.shadow.camera.top = 80;
    this.sun.shadow.camera.bottom = -80;
    this.sun.shadow.camera.near = 20;
    this.sun.shadow.camera.far = 420;
    this.sun.shadow.bias = -0.0009;
    this.sun.shadow.normalBias = 0.05;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
  }

  #buildTerrain() {
    const { size, segments } = WORLD;
    const geo = new THREE.PlaneGeometry(size, size, segments, segments);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const low = new THREE.Color(0x3f2218);
    const mid = new THREE.Color(0x7a3d23);
    const high = new THREE.Color(0xa8633a);
    const tmp = new THREE.Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = this.heightAt(x, z);
      pos.setY(i, y);

      const tint = fbm(x * 0.09, z * 0.09, 2, WORLD.seed + 41);
      const slap = THREE.MathUtils.clamp(y / 45 + 0.35, 0, 1);
      tmp.copy(low).lerp(mid, THREE.MathUtils.clamp(tint * 1.35, 0, 1));
      tmp.lerp(high, slap * 0.55);
      tmp.convertSRGBToLinear();
      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }

    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.98,
      metalness: 0.02,
    });
    this.terrain = new THREE.Mesh(geo, mat);
    this.terrain.receiveShadow = true;
    this.scene.add(this.terrain);
  }

  #scatterRocks() {
    const rand = mulberry32(WORLD.seed + 77);
    const geo = new THREE.DodecahedronGeometry(1, 0);
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0x6d4230).convertSRGBToLinear(),
      roughness: 1,
      flatShading: true,
    });

    const place = (count, minDist, maxDist, minScale, maxScale) => {
      const mesh = new THREE.InstancedMesh(geo, mat, count);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const dummy = new THREE.Object3D();
      let placed = 0;
      let guard = 0;
      while (placed < count && guard++ < count * 40) {
        const a = rand() * Math.PI * 2;
        const d = minDist + rand() * (maxDist - minDist);
        const x = Math.cos(a) * d;
        const z = Math.sin(a) * d;
        if (Math.hypot(x, z) < WORLD.colonyRadius + 9) continue;
        if (this.levelPads.some((p) => Math.hypot(x - p.x, z - p.z) < p.r * 0.92)) continue;
        const s = minScale + rand() * (maxScale - minScale);
        dummy.position.set(x, this.heightAt(x, z) - s * 0.32, z);
        dummy.rotation.set(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI);
        dummy.scale.set(s, s * (0.6 + rand() * 0.7), s * (0.8 + rand() * 0.5));
        dummy.updateMatrix();
        mesh.setMatrixAt(placed++, dummy.matrix);
      }
      mesh.count = placed;
      mesh.instanceMatrix.needsUpdate = true;
      this.scene.add(mesh);
    };

    place(340, 20, WORLD.playableRadius + 40, 0.35, 1.5);
    place(120, 70, WORLD.playableRadius + 70, 1.6, 5.2);
  }

  #buildDust() {
    const count = 1100;
    const positions = new Float32Array(count * 3);
    const rand = mulberry32(WORLD.seed + 991);
    this.dustSpan = 150;
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (rand() - 0.5) * this.dustSpan;
      positions[i * 3 + 1] = rand() * 26;
      positions[i * 3 + 2] = (rand() - 0.5) * this.dustSpan;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xd8a37a,
      size: 0.34,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.dust = new THREE.Points(geo, mat);
    this.dust.frustumCulled = false;
    this.scene.add(this.dust);
  }

  #updateDust(dt) {
    if (!this.follow) return;
    const pos = this.dust.geometry.attributes.position;
    const arr = pos.array;
    const drift = 3.2 * dt;
    for (let i = 0; i < arr.length; i += 3) {
      arr[i] += drift;
      arr[i + 1] -= dt * 0.35;
      if (arr[i] > this.dustSpan / 2) arr[i] -= this.dustSpan;
      if (arr[i + 1] < 0) arr[i + 1] += 26;
    }
    pos.needsUpdate = true;
    this.dust.position.set(this.follow.x, 0, this.follow.z);
  }
}

function smoothstep(edge0, edge1, x) {
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Free a small one-off object graph (meteor streaks) so long runs do not leak GPU memory. */
function disposeTree(root) {
  root.traverse((obj) => {
    obj.geometry?.dispose?.();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
      else obj.material.dispose();
    }
  });
}

/**
 * Third person camera with two modes.
 *
 * `orbit` (the default) drags freely around the commander. `lock` is Shift Lock:
 * a fixed rig over the right shoulder that only turns, never orbits or zooms, so
 * the reticle stays centre-screen and the astronaut always faces where you look.
 */
export class OrbitFollow {
  constructor(camera, world) {
    this.camera = camera;
    this.world = world;
    this.yaw = 0;
    this.pitch = CAMERA.pitch;
    this.distance = CAMERA.distance;
    this.target = new THREE.Vector3(0, 0, 0);
    this.locked = false;
    this.orbitPitch = CAMERA.pitch;
    this._desired = new THREE.Vector3();
    this._lookTarget = new THREE.Vector3();
    this._blend = 0;
  }

  rotate(dx, dy) {
    if (this.locked) return this.look(dx, dy);
    this.yaw -= dx * 0.0045;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.0035, CAMERA.minPitch, CAMERA.maxPitch);
  }

  /** Shift Lock mouse look: yaw is free, pitch is a short nod around level. */
  look(dx, dy) {
    this.yaw -= dx * SHIFT_LOCK.yawSpeed;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch + dy * SHIFT_LOCK.pitchSpeed,
      SHIFT_LOCK.minPitch,
      SHIFT_LOCK.maxPitch,
    );
  }

  zoom(delta) {
    if (this.locked) return;
    this.distance = THREE.MathUtils.clamp(
      this.distance + delta * 0.012,
      CAMERA.minDistance,
      CAMERA.maxDistance,
    );
  }

  setLock(on) {
    if (on === this.locked) return this.locked;
    if (on) {
      this.orbitPitch = this.pitch;
      this.pitch = THREE.MathUtils.clamp(this.pitch, SHIFT_LOCK.minPitch, SHIFT_LOCK.maxPitch);
    } else {
      this.pitch = this.orbitPitch;
    }
    this.locked = on;
    // Blend the rig across the change instead of cutting, so neither toggle pops.
    this._blend = 1;
    return this.locked;
  }

  update(dt, focus) {
    if (this.locked) {
      this.#updateLocked(dt, focus);
      return;
    }

    this.target.lerp(focus, Math.min(1, dt * 9));
    const px = this.target.x + Math.sin(this.yaw) * Math.cos(this.pitch) * this.distance;
    const pz = this.target.z + Math.cos(this.yaw) * Math.cos(this.pitch) * this.distance;
    const py = this.target.y + Math.sin(this.pitch) * this.distance + 1.2;

    const floor = this.world.heightAt(px, pz) + 1.4;
    this.#place(px, Math.max(py, floor), pz, dt);
    this.camera.lookAt(this.target);
  }

  #updateLocked(dt, focus) {
    const c = SHIFT_LOCK;
    this.target.lerp(focus, Math.min(1, dt * c.followLerp));

    // Same convention the player controller uses: forward is (-sin yaw, -cos yaw).
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const rx = -fz;
    const rz = fx;
    const cosP = Math.cos(this.pitch);
    const sinP = Math.sin(this.pitch);

    const px = this.target.x + rx * c.lateral - fx * c.distance * cosP;
    const pz = this.target.z + rz * c.lateral - fz * c.distance * cosP;
    const py = this.target.y + c.eyeLift + sinP * c.distance;

    const floor = this.world.heightAt(px, pz) + 0.85;
    this.#place(px, Math.max(py, floor), pz, dt);

    // Aim just off the shoulder rather than at the head, which keeps the suit
    // near the centre of frame while still reading as an over-the-shoulder view.
    this._lookTarget.set(
      this.target.x + fx * c.lookAhead + rx * c.lateral * c.shoulderBias,
      this.target.y + sinP * 0.5,
      this.target.z + fz * c.lookAhead + rz * c.lateral * c.shoulderBias,
    );
    this.camera.lookAt(this._lookTarget);
  }

  #place(x, y, z, dt) {
    this._desired.set(x, y, z);
    if (this._blend > 0) {
      this._blend = Math.max(0, this._blend - dt / SHIFT_LOCK.blendSeconds);
      this.camera.position.lerp(this._desired, Math.min(1, dt * SHIFT_LOCK.positionLerp));
    } else {
      this.camera.position.copy(this._desired);
    }
  }
}
