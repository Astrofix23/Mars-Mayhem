/** WebAudio sound design generated at runtime — the build ships no audio files. */

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.windGain = null;
    this.muted = false;
  }

  /** Must be called from a user gesture (click / key press). */
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(this.ctx.destination);
    this.#startWind();
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : 0.55;
  }

  #startWind() {
    const ctx = this.ctx;
    const seconds = 3;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      last = last * 0.96 + white * 0.04;
      data[i] = last * 3.2;
    }

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    filter.Q.value = 0.6;

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 160;
    lfo.connect(lfoGain).connect(filter.frequency);
    lfo.start();

    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.16;

    src.connect(filter).connect(this.windGain).connect(this.master);
    src.start();
    this.windFilter = filter;
  }

  #blip({ freq = 440, freq2 = null, dur = 0.12, type = 'sine', gain = 0.18, delay = 0 }) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (freq2) osc.frequency.exponentialRampToValueAtTime(freq2, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  ui() {
    this.#blip({ freq: 720, freq2: 880, dur: 0.07, type: 'triangle', gain: 0.1 });
  }

  open() {
    this.#blip({ freq: 320, freq2: 520, dur: 0.14, type: 'sine', gain: 0.12 });
  }

  warn() {
    this.#blip({ freq: 300, freq2: 220, dur: 0.22, type: 'square', gain: 0.09 });
    this.#blip({ freq: 300, freq2: 220, dur: 0.22, type: 'square', gain: 0.07, delay: 0.28 });
  }

  good() {
    this.#blip({ freq: 520, dur: 0.12, type: 'sine', gain: 0.12 });
    this.#blip({ freq: 660, dur: 0.14, type: 'sine', gain: 0.11, delay: 0.1 });
    this.#blip({ freq: 880, dur: 0.2, type: 'sine', gain: 0.1, delay: 0.2 });
  }

  step() {
    this.#blip({ freq: 95, freq2: 55, dur: 0.09, type: 'sine', gain: 0.06 });
  }

  storm() {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    if (this.windFilter) {
      this.windFilter.frequency.cancelScheduledValues(t);
      this.windFilter.frequency.linearRampToValueAtTime(1100, t + 2.5);
      this.windFilter.frequency.linearRampToValueAtTime(420, t + 9);
    }
    this.warn();
  }

  setStorm(active) {
    if (!this.windGain) return;
    const target = active ? 0.32 : 0.16;
    this.windGain.gain.linearRampToValueAtTime(target, this.ctx.currentTime + 1.5);
  }
}
