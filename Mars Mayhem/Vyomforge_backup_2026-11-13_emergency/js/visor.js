/**
 * Mirrored EVA visor material.
 *
 * A metal needs something to reflect and the game ships no HDR assets, so the
 * environment is painted once into an equirectangular canvas: a dark silver sky,
 * a warm dusty horizon, basalt ground and one hot sun. The renderer turns it into
 * a PMREM cube map, which keeps the reflections seamless across the whole dome.
 * One texture is shared by the player, the posted crew and both cinematics, and
 * its strength follows daylight so the visor never glows at night.
 */

const ENV_WIDTH = 1024;
const ENV_HEIGHT = 512;
const TAU = Math.PI * 2;

/** Dark steel with a warm cast: the tint the mirror itself carries. */
const VISOR_TINT = 0xa8a094;

let sharedEnvironment = null;
const materials = new Set();

export function getVisorEnvironment() {
  if (sharedEnvironment) return sharedEnvironment;

  sharedEnvironment = new THREE.CanvasTexture(paintEnvironment());
  sharedEnvironment.mapping = THREE.EquirectangularReflectionMapping;
  sharedEnvironment.encoding = THREE.sRGBEncoding;
  sharedEnvironment.needsUpdate = true;
  return sharedEnvironment;
}

/**
 * Each visor gets its own material instance so the intro and outro can dispose
 * their scenes without touching the materials still used in the live outpost.
 */
export function createVisorMaterial() {
  const material = new THREE.MeshPhysicalMaterial({
    color: VISOR_TINT,
    metalness: 1,
    roughness: 0.06,
    envMap: getVisorEnvironment(),
    envMapIntensity: 1.15,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    emissive: 0x0b0c0e,
    emissiveIntensity: 0.14,
    side: THREE.FrontSide,
  });
  materials.add(material);
  return material;
}

/** Dim the mirror after sunset instead of rebuilding the environment. */
export function setVisorLight(day) {
  const d = Math.max(0, Math.min(1, day));
  const intensity = 0.32 + d * 0.83;
  const glow = 0.03 + d * 0.11;
  for (const material of materials) {
    material.envMapIntensity = intensity;
    material.emissiveIntensity = glow;
  }
}

/** 3D-consistent paint: every face of the environment samples the same sky. */
function paintEnvironment() {
  const canvas = document.createElement('canvas');
  canvas.width = ENV_WIDTH;
  canvas.height = ENV_HEIGHT;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(ENV_WIDTH, ENV_HEIGHT);
  const data = image.data;

  const top = hex('#6a645b');
  const mid = hex('#a89d8c');
  const horizon = hex('#e2d3b3');
  const groundNear = hex('#7d6950');
  const groundFar = hex('#3a2c20');
  const hazeColor = [242, 230, 203];

  const sun = normalize([-0.3, 0.42, 0.86]);
  let p = 0;

  for (let y = 0; y < ENV_HEIGHT; y++) {
    const v = 1 - (y + 0.5) / ENV_HEIGHT;
    const lat = (v - 0.5) * Math.PI;
    const dy = Math.sin(lat);
    const ring = Math.cos(lat);

    for (let x = 0; x < ENV_WIDTH; x++) {
      const lon = ((x + 0.5) / ENV_WIDTH - 0.5) * TAU;
      const dx = ring * Math.cos(lon);
      const dz = ring * Math.sin(lon);

      let color;
      if (dy >= 0) {
        const t = Math.pow(dy, 0.7);
        color = t < 0.45 ? mix(horizon, mid, t / 0.45) : mix(mid, top, (t - 0.45) / 0.55);
      } else {
        const t = Math.pow(-dy, 0.5);
        color = mix(groundNear, groundFar, Math.min(1, t * 1.05));
      }

      const haze = Math.exp(-Math.pow(dy / 0.08, 2));
      color = mix(color, hazeColor, haze * 0.6);

      const sunDot = dx * sun[0] + dy * sun[1] + dz * sun[2];
      if (sunDot > 0.5) {
        color = mix(color, [255, 238, 208], Math.pow((sunDot - 0.5) / 0.5, 2) * 0.4);
      }
      if (sunDot > 0.88) {
        color = mix(color, [255, 252, 244], Math.pow((sunDot - 0.88) / 0.12, 3));
      }

      const grain = (Math.random() - 0.5) * 3;
      data[p++] = color[0] + grain;
      data[p++] = color[1] + grain;
      data[p++] = color[2] + grain;
      data[p++] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);
  return canvas;
}

function hex(value) {
  return [
    parseInt(value.slice(1, 3), 16),
    parseInt(value.slice(3, 5), 16),
    parseInt(value.slice(5, 7), 16),
  ];
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function normalize(vector) {
  const length = Math.hypot(...vector);
  return vector.map((value) => value / length);
}
