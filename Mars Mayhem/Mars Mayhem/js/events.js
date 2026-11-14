import { CHOICES, EVENTS, FACILITIES, FORECAST, FORECAST_SEVERITY, SOL_SECONDS } from './config.js';

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
 *
 * Since the environment forecast was added, a successful roll no longer fires
 * the event immediately. The director schedules a pending hazard, announces it
 * through the offline forecast model, and starts the real event when the
 * countdown expires. Meteorite impacts and radiation keep their original
 * immediate start: they already have their own in-game warnings.
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
    this.#tickPending();
    this.#tickMaintenanceForecast();

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
      case 'cpms_failure':
        // Re-running the demo begins from a working console.
        if (s.cpms && !s.cpms.online) sim.restoreCpms(false, true);
        break;
      default:
        break;
    }
    // Re-triggering the same demo replaces its ledger entry rather than stacking,
    // and any forecast that was counting down to it is resolved by this trigger.
    s.events.active = s.events.active.filter((e) => e.kind !== kindId);
    s.events.pending = (s.events.pending ?? []).filter((p) => p.kind !== kindId && p.kind !== 'equipment');
    this.#start(kind);
    return true;
  }

  /**
   * Cheat-mode helper: schedule a real forecast a short lead before its event,
   * without waiting for the random director. The event still starts through the
   * normal pending-queue path, so the warning clear/confirm behaviour is real.
   */
  forceForecast(kindId, lead = 15) {
    const kind = EVENTS.kinds.find((k) => k.id === kindId);
    const meta = FORECAST.kinds[kindId];
    if (!kind || !meta) return false;
    const s = this.sim.state;
    s.events.pending = (s.events.pending ?? []).filter((p) => p.kind !== kindId);
    this.#pushForecast(kindId, {
      dueAt: s.elapsed + Math.max(4, lead),
      lead: Math.max(4, lead),
      severity: this.#severity(kindId),
      data: this.#preset(kindId),
    });
    return true;
  }

  #roll() {
    const sim = this.sim;
    const s = sim.state;
    const ev = s.events;
    const solIdx = Math.min(EVENTS.phaseCurve.length, s.sol) - 1;
    const curve = EVENTS.phaseCurve[solIdx];
    const diffScale = sim.difficulty.hazardChance / 0.14;
    const severePending = (ev.pending ?? []).some((p) => this.#severe(p.kind));
    const severeActive = severePending || ev.active.some((a) => this.#severe(a.kind));
    const busy = s.elapsed < ev.busyUntil;
    // An offline CPMS is a persistent delivery fault, not a hazard occupying an
    // event slot — life-support events keep rolling while the console is down.
    const hazardActive = ev.active.filter((a) => a.kind !== 'cpms_failure').length;

    const pool = EVENTS.kinds
      .filter((k) => s.sol >= k.minSol)
      .filter((k) => (ev.cooldowns[k.id] ?? 0) <= s.elapsed)
      .filter((k) => !(busy && k.severe))
      .filter((k) => !(severeActive && k.severe))
      .filter((k) => hazardActive < EVENTS.maxConcurrent || !k.severe)
      .sort(() => Math.random() - 0.5);

    for (const kind of pool) {
      if (Math.random() < kind.base * curve * diffScale) {
        this.#announce(kind);
        return;
      }
    }
  }

  /**
   * A successful roll either becomes a pending forecast or, when the forecast
   * model cannot cover it or its queue is full, starts immediately. This keeps
   * the original probabilities and still leaves some events unannounced.
   */
  #announce(kind) {
    const s = this.sim.state;
    const ev = s.events;
    const forecastable = Boolean(FORECAST.kinds[kind.id]);
    const pending = ev.pending ?? (ev.pending = []);

    if (!forecastable || pending.length >= FORECAST.maxPending) {
      this.#start(kind);
      return;
    }

    // One pending forecast per hazard class: a second roll for the same hazard
    // is dropped rather than stacking two identical warnings.
    if (pending.some((p) => p.kind === kind.id)) return;

    const lead = FORECAST.leadMin + Math.random() * (FORECAST.leadMax - FORECAST.leadMin);
    this.#pushForecast(kind.id, {
      dueAt: s.elapsed + lead,
      lead,
      severity: this.#severity(kind.id),
      data: this.#preset(kind.id),
    });
  }

  #severe(kindId) {
    return EVENTS.kinds.find((k) => k.id === kindId)?.severe ?? false;
  }

  /* ───────────────────────── environment forecast ───────────────────────── */

  /** Expected severity for the current Sol — the same band the panel displays. */
  #severity(kindId) {
    return FORECAST_SEVERITY[kindId]?.(this.sim.state.sol) ?? 'MODERATE';
  }

  /**
   * Rolls the details a forecast can announce honestly: how long a storm lasts,
   * which greenhouse line is suspect, which seal is monitored, and whether a
   * marsquake looks likely to damage equipment or only shake the sensors.
   */
  #preset(kindId) {
    const s = this.sim.state;
    switch (kindId) {
      case 'dust_storm':
        return { duration: Math.round(CHOICES.storm.duration * stormLengthScale(s.sol)) };
      case 'dust_devil':
        return { duration: 14 + Math.random() * 8 };
      case 'greenhouse':
        return { fault: pick(['irrigation', 'temperature', 'lighting']) };
      case 'marsquake': {
        const candidates = QUAKE_TARGETS.filter((id) => !s.failures[id]);
        return Math.random() < 0.55 && candidates.length
          ? { effect: 'failure', target: pick(candidates) }
          : { effect: 'glitch' };
      }
      case 'seal': {
        const candidates = SEAL_TARGETS.filter((id) => !s.failures[id] && !(s.seal.active && s.seal.facilityId === id));
        return candidates.length ? { targetId: pick(candidates) } : {};
      }
      default:
        return {};
    }
  }

  #pushForecast(kindId, { dueAt, lead, severity, data = null, baselineFailures = null }) {
    const s = this.sim.state;
    const ev = s.events;
    const meta = FORECAST.kinds[kindId];
    if (!meta) return null;

    ev.forecastSeq = (ev.forecastSeq ?? 0) + 1;
    const online = this.sim.cpmsOnline?.() !== false;
    const entry = {
      id: `fc-${ev.forecastSeq}`,
      kind: kindId,
      dueAt,
      lead: Math.max(1, Math.round(lead)),
      issuedAt: s.elapsed,
      severity,
      data,
      // The countdown exists either way; this only records whether the CPMS
      // actually delivered the notice, so restore never repeats it.
      announced: online,
    };
    if (baselineFailures) entry.baselineFailures = baselineFailures;

    ev.pending = ev.pending ?? [];
    ev.pending.push(entry);

    // CPMS owns delivery. While it is offline the forecast still enters the
    // pending queue (and keeps its countdown) — it just is not announced.
    if (!online) return entry;

    const seconds = Math.max(1, Math.round(dueAt - s.elapsed));
    this.sim.pushAnnouncement(
      `ENVIRONMENTAL FORECAST — ${meta.code} · ${severity} severity in ~${seconds} s. ${meta.action}`,
      severity === 'LOW' ? 'info' : 'warn',
    );
    this.sim.emit({ type: 'forecast-issued', forecast: entry, code: meta.code, severity });
    return entry;
  }

  /**
   * Called when the CPMS comes back. Forecasts that were queued while it was
   * down are announced now, with their remaining countdown untouched. Entries
   * the CPMS already delivered are skipped, so nothing is repeated.
   */
  resumeDelivery() {
    const s = this.sim.state;
    const ev = s.events;
    if (!Array.isArray(ev?.pending) || !ev.pending.length) return 0;
    let delivered = 0;
    for (const pending of ev.pending) {
      if (!pending || pending.announced || pending.dueAt <= s.elapsed) continue;
      const meta = FORECAST.kinds[pending.kind];
      if (!meta) continue;
      pending.announced = true;
      delivered += 1;
      const seconds = Math.max(1, Math.round(pending.dueAt - s.elapsed));
      this.sim.pushAnnouncement(
        `ENVIRONMENTAL FORECAST — ${meta.code} · ${pending.severity} severity in ~${seconds} s. ${meta.action}`,
        pending.severity === 'LOW' ? 'info' : 'warn',
      );
      this.sim.emit({ type: 'forecast-issued', forecast: pending, code: meta.code, severity: pending.severity });
    }
    return delivered;
  }

  /** Runs the pending queue: start due events, delay blocked severe ones, clear dead ones. */
  #tickPending() {
    const sim = this.sim;
    const s = sim.state;
    const ev = s.events;
    if (!Array.isArray(ev.pending)) ev.pending = [];
    const keep = [];

    for (const pending of ev.pending) {
      if (!pending || typeof pending.dueAt !== 'number') continue;
      if (s.elapsed < pending.dueAt) {
        keep.push(pending);
        continue;
      }

      if (pending.kind === 'equipment') {
        this.#resolveEquipmentForecast(pending);
        continue;
      }

      const kind = EVENTS.kinds.find((k) => k.id === pending.kind);
      if (!kind) continue;

      // Never stack two severe hazards. The forecast stays up and updates its
      // countdown instead of silently disappearing.
      if (kind.severe && ev.active.some((a) => this.#severe(a.kind))) {
        pending.dueAt = s.elapsed + 10;
        if (!pending.delayLogged) {
          pending.delayLogged = true;
          if (sim.cpmsOnline?.() !== false) {
            sim.pushAnnouncement(
              `Forecast delayed — ${FORECAST.kinds[pending.kind]?.code ?? kind.label} held back while the colony handles another severe event.`,
              'info',
            );
            sim.emit({ type: 'forecast-delayed', forecast: pending });
          }
        }
        keep.push(pending);
        continue;
      }

      if (this.#start(kind, pending.data)) {
        if (sim.cpmsOnline?.() !== false) sim.emit({ type: 'forecast-confirmed', forecast: pending });
      } else if (sim.cpmsOnline?.() !== false) {
        sim.pushAnnouncement(
          `Environmental forecast cleared — ${FORECAST.kinds[pending.kind]?.code ?? kind.label} is no longer imminent.`,
          'info',
        );
        sim.emit({ type: 'forecast-cleared', forecast: pending });
      }
    }

    ev.pending = keep;
  }

  /**
   * Baseline wear failures are rolled by Simulation.#updateHazards. The forecast
   * only watches the window and says "potential": if the failure lands, the
   * notice is confirmed; if not, it clears. It never influences the roll.
   */
  #tickMaintenanceForecast() {
    const s = this.sim.state;
    const ev = s.events;
    const until = s.nextFailureCheck - s.elapsed;
    if (until <= 0 || until > FORECAST.maintenanceWindow) return;
    if (ev.maintenanceWarnedAt === s.nextFailureCheck) return;

    ev.maintenanceWarnedAt = s.nextFailureCheck;
    if (s.flags.failed || s.flags.complete) return;
    if (Math.random() > FORECAST.maintenanceChance) return;
    if ((ev.pending ?? []).some((p) => p.kind === 'equipment')) return;

    this.#pushForecast('equipment', {
      dueAt: s.nextFailureCheck,
      lead: until,
      severity: this.#severity('equipment'),
      baselineFailures: { ...s.failures },
    });
  }

  #resolveEquipmentForecast(pending) {
    const s = this.sim.state;
    const before = pending.baselineFailures ?? {};
    const ids = ['solar', 'aqua', 'o2'];
    const hit = ids.find((id) => !before[id] && s.failures[id]);

    if (!this.sim.cpmsOnline()) return;
    if (hit) {
      this.sim.pushAnnouncement(
        `Forecast confirmed — ${hit.toUpperCase()} fault detected. The maintenance model called it; keep the engineer on repairs.`,
        'warn',
      );
      this.sim.emit({ type: 'forecast-confirmed', forecast: pending });
    } else {
      this.sim.pushAnnouncement('Maintenance forecast cleared — no equipment fault confirmed in this window.', 'info');
      this.sim.emit({ type: 'forecast-cleared', forecast: pending });
    }
  }

  /** The nearest pending forecast, already joined with its display metadata. */
  pendingForecast() {
    const s = this.sim.state;
    const list = (s.events.pending ?? [])
      .filter((p) => p && typeof p.dueAt === 'number' && p.dueAt > s.elapsed && FORECAST.kinds[p.kind])
      .sort((a, b) => a.dueAt - b.dueAt);
    if (!list.length) return null;

    const pending = list[0];
    const meta = FORECAST.kinds[pending.kind];
    const dueIn = Math.max(0, pending.dueAt - s.elapsed);
    const seconds = Math.max(1, Math.ceil(dueIn));

    return {
      id: pending.id,
      kind: pending.kind,
      code: meta.code,
      headline: meta.headline.replace('{seconds}', String(seconds)),
      systems: meta.systems,
      action: meta.action,
      severity: pending.severity,
      dueIn,
      lead: pending.lead,
      confidence: pending.kind === 'equipment' ? 'POTENTIAL' : 'TRACKED',
      source: 'MARS MAYHEM environmental model',
      others: list.slice(1).map((p) => ({
        code: FORECAST.kinds[p.kind].code,
        severity: p.severity,
        dueIn: Math.max(0, p.dueAt - s.elapsed),
      })),
    };
  }

  /** Hazards already running, so the panel can swap from forecast to live state. */
  activeHazards() {
    return (this.sim.state.events.active ?? []).filter((entry) => entry.kind !== 'cpms_failure').map((entry) => ({
      kind: entry.kind,
      code: FORECAST.kinds[entry.kind]?.code
        ?? EVENTS.kinds.find((k) => k.id === entry.kind)?.label?.toUpperCase()
        ?? entry.kind,
      timeLeft: entry.timeLeft,
    }));
  }

  /**
   * Starts the real event. `preset` carries the details the forecast model
   * already announced (storm length, greenhouse fault, seal target, quake
   * effect) so the event matches its warning wherever that is possible.
   * Returns false when the world already makes the event impossible; the
   * caller then clears the forecast instead of leaving a stale countdown.
   */
  #start(kind, preset = null) {
    const sim = this.sim;
    const s = sim.state;
    const ev = s.events;

    const entry = { kind: kind.id, severe: kind.severe, timeLeft: 0, total: 0, data: null };

    switch (kind.id) {
      case 'dust_devil': {
        entry.total = preset?.duration ?? 14 + Math.random() * 8;
        entry.timeLeft = entry.total;
        if (!sim.startDustDevil(entry.total)) return false;
        sim.pushAnnouncement('Dust devil crossing the array field — short visibility drop, dust on the panels.', 'warn');
        break;
      }
      case 'dust_storm': {
        entry.timeLeft = 1;
        const duration = preset?.duration ?? Math.round(CHOICES.storm.duration * stormLengthScale(s.sol));
        if (!sim.triggerStorm(duration)) return false;
        break;
      }
      case 'greenhouse': {
        entry.timeLeft = 1;
        const kinds = ['irrigation', 'temperature', 'lighting'];
        const fault = preset?.fault ?? pick(kinds);
        if (!sim.causeEquipmentFailure('bio', `greenhouse ${fault} fault`)) return false;
        entry.data = { fault };
        break;
      }
      case 'rover_breakdown': {
        entry.timeLeft = 1;
        if (!sim.triggerRoverFault()) return false;
        break;
      }
      case 'marsquake': {
        entry.total = 8;
        entry.timeLeft = entry.total;
        sim.startMarsquake();
        const plan = preset?.effect ?? (Math.random() < 0.55 ? 'failure' : 'glitch');
        if (plan === 'failure') {
          const candidates = QUAKE_TARGETS.filter((id) => !s.failures[id]);
          if (candidates.length) {
            const target = preset?.target && candidates.includes(preset.target) ? preset.target : pick(candidates);
            sim.causeEquipmentFailure(target, 'marsquake stress');
          } else {
            sim.triggerSensorGlitch(90);
            sim.pushAnnouncement('Marsquake knocked the science sensors out of calibration — research halved until they re-zero.', 'warn');
          }
        } else {
          sim.triggerSensorGlitch(90);
          sim.pushAnnouncement('Marsquake knocked the science sensors out of calibration — research halved until they re-zero.', 'warn');
        }
        break;
      }
      case 'seal': {
        entry.timeLeft = 1;
        const candidates = SEAL_TARGETS.filter((id) => !s.failures[id] && !(s.seal.active && s.seal.facilityId === id));
        if (!candidates.length) return false;
        const targetId = preset?.targetId && candidates.includes(preset.targetId) ? preset.targetId : pick(candidates);
        const label = FACILITIES.find((f) => f.id === targetId)?.code ?? targetId;
        if (!sim.triggerSeal(targetId, label)) return false;
        break;
      }
      case 'radiation': {
        entry.timeLeft = 1;
        if (!sim.beginRadiation(42)) return false;
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
        sim.pushAnnouncement(`TRACK: small body entering the atmosphere, expected impact bearing ${bearing}° in ${entry.total} s.`, 'warn');
        break;
      }
      case 'cpms_failure': {
        entry.timeLeft = 1;
        if (!sim.triggerCpmsFailure()) return false;
        break;
      }
      default:
        return false;
    }

    ev.encountered += 1;
    s.stats.events += 1;
    ev.cooldowns[kind.id] = s.elapsed + cooldownFor(kind.id, s.sol);
    ev.active.push(entry);
    sim.emit({ type: 'event-start', kind: kind.id, severe: kind.severe });
    return true;
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
            sim.pushAnnouncement('Dust devil has passed. The arrays could use a wipe.', 'info');
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

        case 'cpms_failure':
          if (sim.state.cpms && !sim.state.cpms.online) keep.push(entry);
          else this.#close(entry);
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
        sim.pushAnnouncement(
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
        sim.pushAnnouncement('The crew absorbed the particle dose — efficiency down for the next stretch. Next time: shelter them.', 'bad');
      } else {
        sim.pushAnnouncement('Radiation event passed. The crew is safe.', 'good');
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
    cpms_failure: 300,
  }[kindId] ?? 180;
  // later sols re-roll sooner, but never so soon that the same thing repeats back-to-back
  return Math.max(80, base - (sol - 1) * 12);
}
