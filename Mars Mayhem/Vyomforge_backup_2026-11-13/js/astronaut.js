/**
 * Procedural EVA astronaut rig. No external models: a suit, helmet with a
 * reflective visor, life-support backpack and four articulated limbs that
 * swing while walking. The rig's origin sits at the astronaut's feet.
 */
export function createAstronaut({ suit = 0xe3e8ea, accent = 0x6fe3d4 } = {}) {
  const group = new THREE.Group();

  const suitMat = new THREE.MeshStandardMaterial({ color: suit, roughness: 0.62, metalness: 0.18 });
  const softMat = new THREE.MeshStandardMaterial({ color: 0x9aa3a8, roughness: 0.95 });
  const accentMat = new THREE.MeshStandardMaterial({
    color: accent, emissive: accent, emissiveIntensity: 0.35, roughness: 0.4,
  });
  const visorMat = new THREE.MeshStandardMaterial({
    color: 0x0d1a26, roughness: 0.08, metalness: 0.95, emissive: 0x14324a, emissiveIntensity: 0.35,
  });

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.74, 0.38), suitMat);
  torso.position.y = 1.16;
  torso.castShadow = true;
  group.add(torso);

  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.18, 0.06), accentMat);
  chest.position.set(0, 1.3, 0.21);
  group.add(chest);

  const hips = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.26, 0.36), suitMat);
  hips.position.y = 0.76;
  hips.castShadow = true;
  group.add(hips);

  // helmet + visor
  const helmet = new THREE.Mesh(
    new THREE.SphereGeometry(0.33, 20, 16),
    new THREE.MeshStandardMaterial({ color: 0xdfe6ea, roughness: 0.35, metalness: 0.2 }),
  );
  helmet.position.y = 1.76;
  helmet.castShadow = true;
  group.add(helmet);

  const visor = new THREE.Mesh(new THREE.SphereGeometry(0.3, 20, 16, -0.9, 1.8, 0.55, 1.3), visorMat);
  visor.position.set(0, 1.77, 0.06);
  visor.rotation.x = -0.12;
  group.add(visor);

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 0.12, 12), softMat);
  neck.position.y = 1.5;
  group.add(neck);

  // life-support backpack
  const pack = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.62, 0.24), suitMat);
  pack.position.set(0, 1.2, -0.32);
  pack.castShadow = true;
  group.add(pack);

  const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.5, 10), accentMat);
  tank.position.set(0.17, 1.22, -0.46);
  group.add(tank);

  const limb = (side, y, len, width) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.37, y, 0);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, len, width), suitMat);
    mesh.position.y = -len / 2;
    mesh.castShadow = true;
    pivot.add(mesh);
    group.add(pivot);
    return pivot;
  };

  const armL = limb(-1, 1.44, 0.58, 0.17);
  const armR = limb(1, 1.44, 0.58, 0.17);

  const legPivot = (side) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.15, 0.72, 0);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.7, 0.2), suitMat);
    mesh.position.y = -0.35;
    mesh.castShadow = true;
    pivot.add(mesh);
    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.14, 0.38), softMat);
    boot.position.set(0, -0.72, 0.06);
    pivot.add(boot);
    group.add(pivot);
    return pivot;
  };

  const legL = legPivot(-1);
  const legR = legPivot(1);

  // glove accents
  for (const pivot of [armL, armR]) {
    const glove = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.14, 0.2), accentMat);
    glove.position.y = -0.6;
    pivot.add(glove);
  }

  let phase = 0;

  return {
    group,
    parts: { torso, helmet, visor, pack, armL, armR, legL, legR },
    /**
     * speed is metres per second; idle sway is applied when standing still.
     * `work` (0..1) drives the at-the-console animation used by posted crew.
     */
    update(dt, speed, time, work = 0) {
      const moving = speed > 0.15;
      if (moving) phase += dt * (3.4 + speed * 0.9);
      const swing = moving ? Math.min(1, speed / 5) : 0;
      const s = Math.sin(phase);

      legL.rotation.x = s * 0.75 * swing;
      legR.rotation.x = -s * 0.75 * swing;
      armL.rotation.x = -s * 0.6 * swing;
      armR.rotation.x = s * 0.6 * swing;

      const breathe = Math.sin(time * 1.6) * 0.012;
      torso.position.y = 1.16 + breathe;
      helmet.position.y = 1.76 + breathe * 1.2;
      visor.position.y = 1.77 + breathe * 1.2;
      group.rotation.z = moving ? Math.sin(phase * 2) * 0.02 * swing : 0;

      if (!moving && work > 0) {
        // leaning into a console: arms raised, periodic reach, slight bow
        const tool = Math.sin(time * 3.1);
        armL.rotation.x = -1.15 - tool * 0.35;
        armR.rotation.x = -1.05 + tool * 0.45;
        torso.rotation.x = 0.14;
        torso.position.y = 1.16 + breathe + Math.abs(tool) * 0.015;
        helmet.rotation.x = 0.16 + tool * 0.04;
      } else {
        torso.rotation.x = 0;
        helmet.rotation.x = 0;
      }
    },
  };
}
