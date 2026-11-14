import { CHOICES, EVENTS, FACILITIES, SOL_SECONDS } from './config.js';

/** Which facilities each event family is allowed to hit. Never the habitat core. */
const SEAL_TARGETS = ['aqua', 'o2', 'solar', 'shelter', 'sci'];
const METEOR_TARGETS = ['solar', 'aqua', 'o2'];
const QUAKE_TARGETS = ['solar', 'aqua', 'o2', 'sci'];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * The random-event director. Pure simulation logic (no THREE): it rolls the
 * event calendar every sim tick, drives the multi-phase events (meteorite,
 * radiation) and keeps the "active events" ledger that the consoles and the
 * renderer read. All persistent state lives on sim.state.events / sim.state
 * so autosave keeps working mid-event.
 */
export class EventDirector {
  constructor(sim) {
    this.sim = sim;
  }

  update(dt) {
    const s = this.sim.state;
    const ev = s.events;

    this.#tickRadiation(dt);
    this.#tickActives(dt);

    // quiet opening phase — Sols 1–2 are for learning the colony
    if (s.elapsed < SOL_SECONDS * EVENTS.firstSolQuiet) return;

    ev.nextRoll -= dt;
    if (ev.nextRoll > 0) return;
    ev.nextRoll = EVENTS.rollEvery * (0.7 + Math.random() * 0.6);
    this.#roll();
  }

  /**
   * Manual trigger for the Cheat Code Mode showcase. Clears whatever would make
   * #start bail (an active storm, an existing fault of the same kind, a stale
   * ledger entry) and then runs the exact same event implementation the random
   * director uses — same logs, same emissions, same gameplay consequences.
   * Cooldowns and the quiet phase only gate #roll, so they never block a demo.
   */
  forceTrigger(kindId) {
    const kind = EVENTS.kinds.find((k) => k.id === kindId);
    if (!kind) return false;
    const sim = this.sim;
    const s = sim.state;

    switch (kindId) {
      case 'dust_devil':
        s.fx.devil = 0;
        break;
      case 'dust_storm':
        if (s.storm.active) {
          s.storm.active = false;
          s.storm.timeLeft = 0;
          sim.emit({ type: 'storm-end' });
        }
        break;
      case 'greenhouse':
        if (s.failures.bio) sim.repairFacility('bio');
        break;
      case 'rover_breakdown':
        if (s.rover.malfunction) sim.repairRover();
        break;
      case 'marsquake':
        s.fx.quake = 0;
        break;
      case 'seal':
        if (s.seal.active) sim.repairSeal();
        break;
      case 'radiation':
        if (s.radiation.phase !== 'none') {
          s.radiation.phase = 'none';
          s.radiation.timeLeft = 0;
          s.fx.rad = 0;
          if (s.crewSheltered) sim.setCrewSheltered(false);
        }
        break;
      default:
        break;
    }
    // Re-triggering the same demo replaces its ledger entry rather than stacking.
    s.events.active = s.events.active.filter((e) => e.kind !== kindId);
    this.#start(kind);
    return true;
  }

  #roll() {
    const sim = this.sim;
    const s = sim.state;
    const ev = s.events;
    const solIdx = Math.min(EVENTS.phaseCurve.length, s.sol) - 1;
    const curve = EVENTS.phaseCurve[solIdx];
    const diffScale = sim.difficulty.hazardChance / 0.14;
    const severeActive = ev.active.some((a) => this.#severe(a.kind));
    const busy = s.elapsed < ev.busyUntil;

    const pool = EVENTS.kinds
      .filter((k) => s.sol >= k.minSol)
      .filter((k) => (ev.cooldowns[k.id] ?? 0) <= s.elapsed)
      .filter((k) => !(busy && k.severe))
      .filter((k) => !(severeActive && k.severe))
      .filter((k) => ev.active.length < EVENTS.maxConcurrent || !k.severe)
      .sort(() => Math.random() - 0.5);

    for (const kind of pool) {
      if (Math.random() < kind.base * curve * diffScale) {
        this.#start(kind);
        return;
      }
    }
  }

  #severe(kindId) {
    return EVENTS.kinds.find((k) => k.id === kindId)?.severe ?? false;
  }

  #start(kind) {
    const sim = this.sim;
    const s = sim.state;
    const ev = s.events;
    ev.encountered += 1;
    s.stats.events += 1;

    const entry = { kind: kind.id, severe: kind.severe, timeLeft: 0, total: 0, data: null };

    switch (kind.id) {
      case 'dust_devil': {
        entry.total = 14 + Math.random() * 8;
        entry.timeLeft = entry.total;
        sim.startDustDevil(entry.total);
        sim.pushLog('Dust devil crossing the array field — short visibility drop, dust on the panels.', 'warn');
        break;
      }
      case 'dust_storm': {
        entry.timeLeft = 1;
        sim.triggerStorm(Math.round(CHOICES.storm.duration * stormLengthScale(s.sol)));
        break;
      }
      case 'greenhouse': {
        entry.timeLeft = 1;
        const kinds = ['irrigation', 'temperature', 'lighting'];
        const fault = pick(kinds);
        const ok = sim.causeEquipmentFailure('bio', `greenhouse ${fault} fault`);
        if (!ok) return;
        entry.data = { fault };
        break;
      }
      case 'rover_breakdown': {
        entry.timeLeft = 1;
        if (!sim.triggerRoverFault()) return;
        break;
      }
      case 'marsquake': {
        entry.total = 8;
        entry.timeLeft = entry.total;
        sim.startMarsquake();
        if (Math.random() < 0.55) {
          const candidates = QUAKE_TARGETS.filter((id) => !s.failures[id]);
          if (candidates.length) {
            sim.causeEquipmentFailure(pick(candidates), 'marsquake stress');
          }
        } else {
          sim.triggerSensorGlitch(90);
          sim.pushLog('Marsquake knocked the science sensors out of calibration — research halved until they re-zero.', 'warn');
        }
        break;
      }
      case 'seal': {
        entry.timeLeft = 1;
        const candidates = SEAL_TARGETS.filter((id) => !s.failures[id] && !(s.seal.active && s.seal.facilityId === id));
        if (!candidates.length) return;
        const targetId = pick(candidates);
        const label = FACILITIES.find((f) => f.id === targetId)?.code ?? targetId;
        sim.triggerSeal(targetId, label);
        break;
      }
      case 'radiation': {
        entry.timeLeft = 1;
        if (!sim.beginRadiation(42)) return;
        break;
      }
      case 'meteorite': {
        entry.total = 16;
        entry.timeLeft = entry.total;
        const angle = Math.random() * Math.PI * 2;
        const dist = 55 + Math.random() * 120;
        const candidates = METEOR_TARGETS.filter((id) => !s.failures[id]);
        entry.data = {
          x: Math.cos(angle) * dist,
          z: Math.sin(angle) * dist,
          target: candidates.length && Math.random() < 0.8 ? pick(candidates) : null,
        };
        const bearing = ((angle * 180) / Math.PI).toFixed(0);
        sim.pushLog(`TRACK: small body entering the atmosphere, expected impact bearing ${bearing}° in ${entry.total} s.`, 'warn');
        break;
      }
      default:
        return;
    }

    ev.cooldowns[kind.id] = s.elapsed + cooldownFor(kind.id, s.sol);
    ev.active.push(entry);
    sim.emit({ type: 'event-start', kind: kind.id, severe: kind.severe });
  }

  #tickActives(dt) {
    const sim = this.sim;
    const s = sim.state;
    const ev = s.events;
    const keep = [];

    for (const entry of ev.active) {
      entry.timeLeft = Math.max(0, entry.timeLeft - dt);

      switch (entry.kind) {
        case 'dust_devil':
          s.fx.devil = entry.timeLeft;
          if (entry.timeLeft <= 0) {
            s.fx.devil = 0;
            sim.pushLog('Dust devil has passed. The arrays could use a wipe.', 'info');
          } else {
            keep.push(entry);
          }
          break;

        case 'dust_storm':
          if (s.storm.active) keep.push(entry);
          else this.#close(entry);
          break;

        case 'greenhouse':
          if (s.failures.bio) keep.push(entry);
          else this.#close(entry);
          break;

        case 'rover_breakdown':
          if (s.rover.malfunction) keep.push(entry);
          else this.#close(entry);
          break;

        case 'marsquake':
          if (entry.timeLeft > 0) keep.push(entry);
          else this.#close(entry);
          break;

        case 'seal':
          if (s.seal.active) keep.push(entry);
          else this.#close(entry);
          break;

        case 'radiation':
          // the radiation state machine lives in sim.state.radiation; drop the
          // ledger entry once the event has fully cleared.
          if (s.radiation.phase !== 'none') keep.push(entry);
          else this.#close(entry);
          break;

        case 'meteorite':
          if (entry.timeLeft > 0) keep.push(entry);
          else {
            sim.meteorImpact(entry.data.x, entry.data.z, entry.data.target);
            this.#close(entry);
          }
          break;

        default:
          break;
      }
    }

    ev.active = keep;
  }

  /** A finished event leaves the ledger; severe events make the colony "busy" for a while. */
  #close(entry) {
    if (entry.severe) {
      const s = this.sim.state;
      s.events.busyUntil = s.elapsed + EVENTS.severeLockout;
    }
  }

  #tickRadiation(dt) {
    const sim = this.sim;
    const s = sim.state;
    const rad = s.radiation;
    if (rad.phase === 'none') return;

    rad.timeLeft -= dt;

    if (rad.phase === 'warning') {
      s.fx.rad = 0.45;
      if (rad.timeLeft <= 0) {
        rad.phase = 'peak';
        rad.timeLeft = 22;
        s.fx.rad = 1;
        sim.pushLog(
          s.crewSheltered
            ? 'Radiation peak — crew is down in the bunker, suits are not.'
            : 'RADIATION PEAK — the crew is still exposed!',
          s.crewSheltered ? 'info' : 'bad',
        );
        sim.emit({ type: 'radiation-peak' });
      }
      return;
    }

    if (rad.phase === 'peak' && rad.timeLeft <= 0) {
      if (!s.crewSheltered) {
        s.efficiencyPenalty = 75;
        sim.pushLog('The crew absorbed the particle dose — efficiency down for the next stretch. Next time: shelter them.', 'bad');
      } else {
        sim.pushLog('Radiation event passed. The crew is safe.', 'good');
      }
      s.fx.rad = 0;
      rad.phase = 'none';
      rad.timeLeft = 0;
      if (s.crewSheltered) sim.setCrewSheltered(false);
      sim.emit({ type: 'radiation-end' });
    }
  }
}

/** Storms stay survivable early, bite harder later. */
function stormLengthScale(sol) {
  return Math.min(1.5, 0.75 + sol * 0.07);
}

function cooldownFor(kindId, sol) {
  const base = {
    dust_devil: 110,
    dust_storm: 300,
    greenhouse: 190,
    rover_breakdown: 170,
    marsquake: 210,
    seal: 240,
    radiation: 240,
    meteorite: 280,
  }[kindId] ?? 180;
  // later sols re-roll sooner, but never so soon that the same thing repeats back-to-back
  return Math.max(80, base - (sol - 1) * 12);
}
