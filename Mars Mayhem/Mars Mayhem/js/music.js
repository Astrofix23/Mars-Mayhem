/**
 * Emergency background soundtrack.
 *
 * One music bus for the whole session, but the track only sounds during a
 * survival emergency in gameplay. The opening/ending cinematics keep their own
 * procedural score, and the pause screen, mute control and results screen all
 * steer this bus instead of starting new copies. The MP3 is decoded once,
 * trimmed of encoder silence and crossfaded tail-to-head so the loop has no
 * audible seam.
 */

const TRACK_URL = 'assets/audio/tensions-run-high.mp3';

// Cinematics and results stay at zero: they own their audio. Gameplay is the
// only scene whose level can be heard, and only when a reserve is critical.
const SCENE_LEVEL = {
  intro: 0,
  gameplay: 0.72,
  ending: 0,
  results: 0,
};

/**
 * Critical survival thresholds. These mirror the HUD's `bad` levels in
 * js/hud.js (battery 15, water 20, O2 25, food 20), which are themselves in
 * line with the warning thresholds in simulation.js. Recovery needs a
 * five-point buffer so a resource hovering on the line cannot machine-gun the
 * track on and off.
 */
const EMERGENCY = {
  battery: { on: 15, off: 20 },
  water: { on: 20, off: 25 },
  oxygen: { on: 25, off: 30 },
  food: { on: 20, off: 25 },
};
const CRITICAL_KEYS = Object.keys(EMERGENCY);

const FADE = {
  start: 3.0,
  scene: 1.6,
  pause: 0.55,
  resume: 1.0,
  mute: 0.35,
};

const LOOP_CROSSFADE_SECONDS = 1.8;
const SILENCE_THRESHOLD = 0.006;
const TARGET_RMS = 0.085;

class MusicBed {
  constructor() {
    this.ctx = null;
    this.gain = null;
    this.source = null;
    this.buffer = null;
    this.scene = 'gameplay';
    this.sceneStack = [];
    this.paused = false;
    this.muted = false;
    this.emergency = false;
    this.criticalResources = [];
    this.criticalLatch = Object.fromEntries(CRITICAL_KEYS.map((key) => [key, false]));
    this.ready = false;
    this.failed = false;
    this.loading = null;
    this.baseGain = 0.5;
    this.stopTimer = 0;
    this.unlockBound = false;
  }

  /** Attach to the document. Safe to call repeatedly; keep calling it from gestures. */
  ensure() {
    if (this.failed) return;
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) {
        this.failed = true;
        return;
      }
      this.ctx = new Ctx();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0;
      this.gain.connect(this.ctx.destination);
      this.#bindUnlock();
      this.loading = this.#load();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  setScene(scene) {
    if (!Object.prototype.hasOwnProperty.call(SCENE_LEVEL, scene)) return;
    if (this.scene === scene) return;
    this.scene = scene;
    this.#applyGain(FADE.scene);
  }

  /** A cinematic layers over whatever scene is running and hands it back on exit. */
  pushScene(scene) {
    this.sceneStack.push(this.scene);
    this.scene = scene;
    this.#applyGain(FADE.scene);
  }

  popScene() {
    const previous = this.sceneStack.pop();
    this.scene = previous ?? 'gameplay';
    this.#applyGain(FADE.scene);
  }

  setPaused(paused) {
    const next = Boolean(paused);
    if (this.paused === next) return;
    this.paused = next;
    this.#applyGain(next ? FADE.pause : FADE.resume);
  }

  setMuted(muted) {
    const next = Boolean(muted);
    if (this.muted === next) return;
    this.muted = next;
    this.#applyGain(FADE.mute);
  }

  /**
   * Latch the four survival reserves against their critical thresholds. Called
   * every frame with the live simulation state; only a transition touches the
   * mix, so a critical resource never restarts the loop. Returns the keys that
   * are currently critical (for the HUD alert).
   */
  updateEmergency(state) {
    const critical = [];
    for (const key of CRITICAL_KEYS) {
      const rule = EMERGENCY[key];
      const was = this.criticalLatch[key];
      // Once latched, hold until the reserve clears the recovery buffer.
      const next = was ? state[key] <= rule.off : state[key] <= rule.on;
      this.criticalLatch[key] = next;
      if (next) critical.push(key);
    }
    this.criticalResources = critical;
    this.setEmergency(critical.length > 0);
    return critical;
  }

  /** Start/fade the one track while any reserve is critical; stop it on recovery. */
  setEmergency(active) {
    const next = Boolean(active);
    if (this.emergency === next) return;
    this.emergency = next;
    if (next) {
      this.#cancelStop();
      this.ensure();
      this.#startSource(FADE.scene);
    } else {
      this.#scheduleStop();
    }
    this.#applyGain(FADE.scene);
  }

  #targetGain() {
    if (this.failed || this.muted) return 0;
    const level = SCENE_LEVEL[this.scene] ?? 0;
    // Title, cinematics and results keep their own audio; only gameplay can
    // carry the emergency score, and only while a reserve is critical. With no
    // source (still decoding, or faded out) there is nothing to ramp yet.
    if (level <= 0 || !this.emergency || !this.source) return 0;
    if (this.paused) return 0;
    return this.baseGain * level;
  }

  #applyGain(seconds) {
    if (!this.gain || !this.ctx) return;
    const now = this.ctx.currentTime;
    const param = this.gain.gain;
    const target = this.#targetGain();
    try {
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(target, now + Math.max(0.05, seconds));
    } catch (err) {
      /* a closed or suspended context is not fatal */
    }
  }

  async #load() {
    try {
      const response = await fetch(TRACK_URL);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      const decoded = await new Promise((resolve, reject) => {
        // Old Safari only supports the callback form; Chrome resolves both.
        const maybe = this.ctx.decodeAudioData(bytes, resolve, reject);
        if (maybe && typeof maybe.then === 'function') maybe.then(resolve, reject);
      });
      const looped = buildSeamlessLoop(this.ctx, decoded);
      this.buffer = looped.buffer;
      this.baseGain = looped.baseGain;
      this.ready = true;
      if (this.emergency) this.#startSource(FADE.start);
    } catch (err) {
      this.failed = true;
      console.warn('[music] soundtrack unavailable:', err);
    }
  }

  #startSource(fadeSeconds = FADE.start) {
    if (!this.buffer || this.source || this.failed) return;
    const source = this.ctx.createBufferSource();
    source.buffer = this.buffer;
    source.loop = true;
    source.loopStart = 0;
    source.loopEnd = this.buffer.duration;
    source.connect(this.gain);
    try {
      source.start();
    } catch (err) {
      this.failed = true;
      return;
    }
    this.source = source;
    this.#applyGain(fadeSeconds);
  }

  #cancelStop() {
    if (!this.stopTimer) return;
    clearTimeout(this.stopTimer);
    this.stopTimer = 0;
  }

  /** Let the fade land before releasing the source; a re-trigger cancels it. */
  #scheduleStop() {
    this.#cancelStop();
    this.stopTimer = setTimeout(() => {
      this.stopTimer = 0;
      if (this.emergency || this.failed || !this.source) return;
      try {
        this.source.stop();
      } catch (err) {
        /* already stopped */
      }
      this.source.disconnect();
      this.source = null;
    }, (FADE.scene + 0.25) * 1000);
  }

  #bindUnlock() {
    if (this.unlockBound) return;
    this.unlockBound = true;
    const retry = () => {
      if (!this.ctx) return;
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      } else {
        window.removeEventListener('pointerdown', retry);
        window.removeEventListener('keydown', retry);
      }
    };
    window.addEventListener('pointerdown', retry);
    window.addEventListener('keydown', retry);
  }
}

/**
 * Trim silence and overlap the tail over the head. The resulting loop length is
 * (trimmed duration − crossfade), so sample 0 continues exactly where the last
 * sample left off and the MP3's encoder padding never surfaces.
 */
function buildSeamlessLoop(ctx, decoded) {
  const channels = decoded.numberOfChannels;
  const sampleRate = decoded.sampleRate;
  const total = decoded.length;
  const data = [];
  for (let c = 0; c < channels; c++) data.push(decoded.getChannelData(c));

  const loudEnough = (index) => {
    for (let c = 0; c < channels; c++) {
      if (Math.abs(data[c][index]) > SILENCE_THRESHOLD) return true;
    }
    return false;
  };

  let start = 0;
  while (start < total && !loudEnough(start)) start++;
  let end = total - 1;
  while (end > start && !loudEnough(end)) end--;
  if (end - start < sampleRate) {
    start = 0;
    end = total - 1;
  } else {
    end += 1;
  }

  const span = end - start;
  const crossfade = Math.min(
    Math.floor(sampleRate * LOOP_CROSSFADE_SECONDS),
    Math.floor(span * 0.18),
  );
  const loopLength = Math.max(1, span - crossfade);
  const buffer = ctx.createBuffer(channels, loopLength, sampleRate);

  let energy = 0;
  let peak = 0;
  for (let c = 0; c < channels; c++) {
    const src = data[c];
    const dst = buffer.getChannelData(c);
    dst.set(src.subarray(start, start + loopLength));
    for (let i = 0; i < crossfade; i++) {
      const f = crossfade > 1 ? i / (crossfade - 1) : 1;
      const head = Math.sin(f * Math.PI * 0.5);
      const tail = Math.cos(f * Math.PI * 0.5);
      dst[i] = src[start + i] * head + src[end - crossfade + i] * tail;
    }
    for (let i = 0; i < loopLength; i++) {
      const v = dst[i];
      energy += v * v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
  }

  const rms = Math.sqrt(energy / (loopLength * channels)) || 0.001;
  let baseGain = TARGET_RMS / rms;
  if (peak > 0) baseGain = Math.min(baseGain, 0.92 / peak);
  baseGain = Math.min(1.1, Math.max(0.16, baseGain));

  return { buffer, baseGain };
}

export const music = new MusicBed();
