import {
  BROWNOUT_ORDER,
  CHOICES,
  CPMS,
  CREW,
  DIFFICULTIES,
  FATIGUE,
  FUEL,
  MISSIONS,
  MATERIAL_LABEL,
  PLAYER,
  POSTS,
  POWER,
  PRESSURE,
  PROSPECT_CHANCE,
  ROCKET,
  ROVER,
  RATES,
  RESEARCH,
  SITES,
  SLEEP,
  SOL_SECONDS,
  START_HOUR,
  WATER,
  facilityXZ,
  roverRoute,
} from './config.js';
import { EventDirector } from './events.js';

const clamp01 = (v) => Math.min(100, Math.max(0, v));
const clampTo = (v, max) => Math.min(max, Math.max(0, v));

/** Sim seconds per simulated hour — one Sol is 24 sim hours whatever the speed. */
const SECONDS_PER_HOUR = SOL_SECONDS / FATIGUE.hoursPerSol;

/** Human-readable rover status for the HUD. */
export const ROVER_STATUS = {
  idle: 'Idle',
  outbound: 'Travelling',
  collecting: 'Drilling',
  returning: 'Travelling',
  unloading: 'Unloading',
  standby: 'Returning',
  cooldown: 'Recharging',
  malfunction: 'Malfunction',
};

/**
 * The colony simulation. Every system is coupled: power gates oxygen and water
 * production, water gates crops, crops gate food, research gates efficiency and
 * crew assignment sets the multipliers on all of it.
 */
export class Simulation {
  constructor(difficultyId = 'cadet') {
    this.difficulty = DIFFICULTIES[difficultyId] ?? DIFFICULTIES.cadet;
    this.listeners = new Set();
    this.cheatMode = false;
    this.derived = this.#emptyDerived();
    this.state = this.#initialState();
    this.events = new EventDirector(this);
    this.derived.daylight = Math.max(0, Math.sin((Math.PI * (this.state.hour - 6)) / 12));
    this.#recompute();
  }

  /** Restore a snapshot produced by the save layer, keeping new fields at defaults. */
  restoreState(state) {
    if (!state) return false;
    this.difficulty = DIFFICULTIES[state.difficulty] ?? this.difficulty;
    const fresh = this.#initialState();
    this.state = { ...fresh, ...state };
    this.state.rover = { ...fresh.rover, ...(state.rover ?? {}) };
    this.state.rover.autoRepair = { ...fresh.rover.autoRepair, ...(state.rover?.autoRepair ?? {}) };
    this.state.cpms = { ...fresh.cpms, ...(state.cpms ?? {}) };
    this.state.events = { ...fresh.events, ...(state.events ?? {}) };
    if (!Array.isArray(this.state.events.pending)) this.state.events.pending = [];
    this.state.events.cooldowns = { ...(this.state.events.cooldowns ?? {}) };
    this.state.seal = { ...fresh.seal, ...(state.seal ?? {}) };
    this.state.radiation = { ...fresh.radiation, ...(state.radiation ?? {}) };
    this.state.spaceWeather = { ...fresh.spaceWeather, ...(state.spaceWeather ?? {}) };
    this.state.fx = { ...fresh.fx, ...(state.fx ?? {}) };
    this.state.stats = { ...fresh.stats, ...(state.stats ?? {}) };
    this.state.stats.materialsDelivered = {
      ...fresh.stats.materialsDelivered,
      ...(this.state.stats.materialsDelivered ?? {}),
    };
    this.state.stats.collected = {
      ...fresh.stats.collected,
      ...(this.state.stats.collected ?? {}),
    };
    this.state.flags = { ...fresh.flags, ...(state.flags ?? {}) };
    this.state.fuel = { ...fresh.fuel, ...(state.fuel ?? {}) };
    this.state.rocket = { ...fresh.rocket, ...(state.rocket ?? {}) };
    this.state.player = { ...fresh.player, ...(state.player ?? {}) };
    this.state.systems = { ...fresh.systems, ...(state.systems ?? {}) };
    this.state.failures = { ...fresh.failures, ...(state.failures ?? {}) };
    this.state.repair = { ...fresh.repair, ...(state.repair ?? {}) };

    this.state.topics = fresh.topics.map((template) => {
      const saved = (state.topics ?? []).find((t) => t.id === template.id);
      return saved ? { ...template, ...saved } : template;
    });
    // An older save has no fatigue columns; rebuild each person from the
    // current template and carry over whatever the snapshot actually stored.
    this.state.crew = fresh.crew.map((template) => {
      const saved = (state.crew ?? []).find((c) => c.id === template.id);
      return saved ? { ...template, ...saved } : template;
    });
    // Deposits are finite and defined by id, so a save from an earlier layout
    // is re-seeded rather than trusted with stale quantities.
    this.state.sites = fresh.sites.map((site) => {
      const saved = (state.sites ?? []).find((s) => s.id === site.id);
      return saved ? { ...site, remaining: clampTo(saved.remaining, site.remaining) } : site;
    });
    this.state.ice = Math.max(0, Number(state.ice ?? fresh.ice) || 0);

    this.events = new EventDirector(this);
    this.derived.daylight = Math.max(0, Math.sin((Math.PI * (this.state.hour - 6)) / 12));
    this.#recompute();
    this.emit({ type: 'restore' });
    return true;
  }

  /* ─────────────────────────── setup ─────────────────────────── */

  #initialState() {
    const start = this.difficulty.start;
    const crew = CREW.map((c) => ({
      id: c.id,
      name: c.name,
      role: c.role,
      roleId: c.roleId,
      color: c.color,
      line: c.line,
      postId: c.roleId === 'eng' ? 'solar' : c.roleId,
      fatigue: 8 + Math.random() * 6,
      health: 100,
      status: 'Working',
      sleeping: false,
      wakePost: null,
      sleptHours: 0,
      shift: SLEEP.shifts[c.id] ?? 4,
      mistake: 0,
      moving: false,
      alive: true,
    }));

    return {
      difficulty: this.difficulty.id,
      elapsed: 0,
      sol: 1,
      hour: START_HOUR,
      speed: 1,
      paused: false,
      battery: start.battery,
      oxygen: start.oxygen,
      water: start.water,
      food: start.food,
      ice: start.ice ?? 240,          // kg of ice at AQUA-Core — the only water source
      dust: 0.14,
      researchPoints: 0,
      topics: RESEARCH.map((r) => ({ ...r, progress: 0, done: false })),
      activeTopic: null,
      crew,
      player: {
        id: 'player',
        name: 'Commander',
        role: 'Ground crew',
        color: 0x6fe3d4,
        fatigue: 12,
        health: 100,
        status: 'Working',
        sleeping: false,
        moving: false,
        sleptHours: 0,
        shift: SLEEP.playerShift,
        wakeAt: 0,
        wakePost: null,
        restSol: 0,
        cover: null,
        alive: true,
      },
      systems: { oxygen: true, water: true, grow: true, research: true, rover: true, fuel: true },
      fuel: { carbon: 0, oxygen: 0, hydrogen: 0, percent: 0, making: false, interrupted: 0, made: 0 },
      rocket: { percent: 0, transferring: false, transferLeft: 0, ready: false, launched: false },
      nightRationing: true,
      plots: [0, 1, 2, 3].map(() => ({ growth: 0.35, mature: false })),
      failures: { aqua: false, o2: false, solar: false, bio: false, fuel: false },
      repair: { aqua: 0, o2: 0, solar: 0, bio: 0, fuel: 0 },
      backup: { charges: POWER.backupCharges, active: false, timeLeft: 0 },
      storm: { active: false, timeLeft: 0, fired: false },
      rover: {
        phase: 'idle',
        timeLeft: 0,
        phaseTotal: 0,
        survey: -1,
        trips: 0,
        carrying: false,
        cargo: null,        // { kind, kg } while the bay is loaded
        result: null,       // last roll, readable before the cargo is unloaded
        iceCollected: 0,
        malfunction: false,
        repairProgress: 0,
        forcedOutcome: null,   // cheat mode: 'success' | 'dry' for the next prospect roll
        // The engineer's trip out to a mid-mission fault. Saved with the rover
        // so a reload resumes the same stage instead of losing the dispatch.
        autoRepair: {
          active: false,
          crewId: null,
          stage: 'none',     // travel | repair | returning
          progress: 0,
          timer: 0,
          returnPost: null,
        },
      },
      sites: SITES.map((s) => ({ id: s.id, kind: s.kind, remaining: s.capacity })),
      seal: { active: false, facilityId: null, label: '', progress: 0 },
      radiation: { phase: 'none', timeLeft: 0, sheltered: false },
      // A game-side advisory derived from live DONKI records. It never changes
      // the simulation on its own; it drives the banner, log and bunker highlight.
      spaceWeather: {
        level: 'green',
        levelNote: '',
        eventId: null,
        kind: null,
        facility: null,
        title: '',
        banner: '',
        advisory: '',
        eventTime: null,
        source: 'none',
        issuedAt: 0,
        updatedAt: 0,
        deliveryPending: false,   // received while CPMS was offline, not yet announced
      },
      // Colony Predictive Monitoring System: the delivery layer between every
      // announcement source (DONKI, forecast, warnings) and the crew HUD.
      cpms: {
        online: true,
        repairing: false,
        repairProgress: 0,
        offlineAt: 0,
        restoredAt: 0,
        failures: 0,
      },
      crewSheltered: false,
      efficiencyPenalty: 0,
      sensorGlitch: 0,
      events: {
        active: [],
        pending: [],        // forecasted hazards waiting on their countdown
        encountered: 0,
        nextRoll: 40,
        busyUntil: 0,
        cooldowns: {},
        forecastSeq: 0,
        maintenanceWarnedAt: 0,
      },
      fx: { devil: 0, devilX: 0, devilZ: 0, quake: 0, rad: 0, flash: 0 },
      resupply: { used: false },
      flags: {
        complete: false,
        failed: false,
        failureReason: '',
        solTenNotice: false,
        restWarned: {},
        fuelWarned: {},
      },
      stats: {
        harvests: 0,
        repairs: 0,
        cleans: 0,
        topics: 0,
        breakdowns: 0,
        events: 0,
        iceDelivered: 0,
        materialsDelivered: { carbon: 0, oxygen: 0, hydrogen: 0 },
        collected: { carbon: 0, oxygen: 0, hydrogen: 0 },   // hauls + atmospheric intake
        dryTrips: 0,
        missedRest: 0,
      },
      log: [],
      nextFailureCheck: CHOICES.failureWindow.from,
    };
  }

  #emptyDerived() {
    return {
      daylight: 0,
      solar: 0,
      demand: 0,
      net: 0,
      powered: { oxygen: true, water: true, grow: true, research: true, rover: true, fuel: true },
      shed: [],
      factor: { sci: 0, bio: 0, aqua: 0, o2: 0, solar: 0, hab: 0, rover: 0, fuel: 0 },
      mult: { oxygen: 1, water: 1, cropGrowth: 1, cropYield: 1, solar: 1 },
      oxygenProduction: 0,
      waterProduction: 0,
      iceRate: 0,
      fuelRate: 0,
      fuelLicensed: false,
      flow: { oxygen: 0, water: 0, food: 0 },
      starving: false,
      stormActive: false,
      totalStaffed: 0,
      efficiency: 1,
      pressure: 1,
      roverDriving: false,
      roverStatus: 'Idle',
    };
  }

  /* ─────────────────────────── events ─────────────────────────── */

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event) {
    for (const fn of this.listeners) fn(event, this);
  }

  pushLog(text, kind = 'info') {
    this.state.log.unshift({ text, kind, sol: this.state.sol, hour: this.state.hour });
    if (this.state.log.length > 40) this.state.log.pop();
    this.emit({ type: 'log', text, kind });
  }

  pushAnnouncement(text, kind = 'info') {
    if (this.cpmsOnline()) this.pushLog(text, kind);
  }

  /* ─────────────────────────── queries ─────────────────────────── */

  crewAt(postId) {
    const auto = this.state.rover?.autoRepair;
    return this.state.crew.find(
      (c) => c.postId === postId && !c.sleeping && c.alive
        && !(auto?.active && auto.crewId === c.id),
    ) ?? null;
  }

  crewFactor(postId) {
    const member = this.crewAt(postId);
    if (this.state.crewSheltered && postId !== 'hab') return 0;
    if (!member) return this.#playerCovers(postId);
    const skill = this.#isSpecialist(member, postId) ? 1 : 0.45;
    return skill * this.derived.efficiency * this.fatigueFactor(member);
  }

  /** Record which console the commander is standing at, so they can hold a post open. */
  setPlayerCover(postId) {
    const next = postId ?? null;
    if (this.state.player.cover === next) return false;
    this.state.player.cover = next;
    return true;
  }

  /** The commander on shift at an unmanned console — weaker than a specialist, better than nobody. */
  #playerCovers(postId) {
    const p = this.state.player;
    if (!p.alive || p.sleeping || p.cover !== postId) return 0;
    return PLAYER.coverFactor * this.derived.efficiency * this.fatigueFactor(p);
  }

  #isSpecialist(member, postId) {
    if (member.roleId === 'eng') return ['solar', 'aqua', 'o2', 'fuel'].includes(postId);
    return member.roleId === postId;
  }

  isSpecialist(member) {
    return this.#isSpecialist(member, member.postId);
  }

  /** How much of their strength a tired crew member still has. */
  fatigueFactor(member) {
    if (member.sleeping) return 0;
    if (!member.alive) return 0;
    const f = member.fatigue;
    if (f >= FATIGUE.exhausted) return 0;
    if (f >= FATIGUE.severe) return FATIGUE.efficiency.severe;
    if (f >= FATIGUE.moderate) return FATIGUE.efficiency.moderate;
    return FATIGUE.efficiency.normal;
  }

  /** Simulated hours since the current Sol began — the rest rule is clock-based, not wall-based. */
  solHour() {
    const s = this.state;
    const withinSol = s.elapsed - (s.sol - 1) * SOL_SECONDS;
    return withinSol / SECONDS_PER_HOUR;
  }

  completedTopics() {
    return this.state.topics.filter((t) => t.done).length;
  }

  topicDone(id) {
    return this.state.topics.find((t) => t.id === id)?.done ?? false;
  }

  /** The one compulsory topic the whole storyline hangs on. */
  fuelLicensed() {
    return this.topicDone('fuel');
  }

  /** Everyone under the rest system: the three specialists plus the player. */
  crewRoster() {
    return [...this.state.crew, this.state.player];
  }

  /**
   * The ten victory conditions, in story order. The launch console and the HUD
   * both read this, so the rules live in exactly one place.
   */
  missionReadiness() {
    const s = this.state;
    const alive = this.crewRoster().filter((c) => c.alive).length;
    const need = {
      carbon: FUEL.recipe.carbon * ROCKET.capacity,
      oxygen: FUEL.recipe.oxygen * ROCKET.capacity,
      hydrogen: FUEL.recipe.hydrogen * ROCKET.capacity,
    };
    const got = s.stats.collected;
    return [
      { id: 'sols', label: `Survive ${CHOICES.successSol} Sols`, done: s.elapsed >= CHOICES.successSol * SOL_SECONDS, detail: `Sol ${s.sol}` },
      { id: 'crew', label: 'All four astronauts alive', done: alive >= 4, detail: `${alive} of 4` },
      { id: 'fueltech', label: 'Martian Fuel Production Technology', done: this.fuelLicensed(), detail: this.fuelLicensed() ? 'licensed' : 'compulsory' },
      { id: 'research', label: `${CHOICES.successResearch} research topics complete`, done: this.completedTopics() >= CHOICES.successResearch, detail: `${this.completedTopics()}/${CHOICES.successResearch}` },
      { id: 'carbon', label: 'Collect return carbon', done: got.carbon >= need.carbon * 0.999, detail: `${Math.round(got.carbon)}/${Math.round(need.carbon)} kg` },
      { id: 'oxygen', label: 'Collect oxidiser oxygen', done: got.oxygen >= need.oxygen * 0.999, detail: `${Math.round(got.oxygen)}/${Math.round(need.oxygen)} kg` },
      { id: 'hydrogen', label: 'Collect hydrogen', done: got.hydrogen >= need.hydrogen * 0.999, detail: `${Math.round(got.hydrogen)}/${Math.round(need.hydrogen)} kg` },
      // Cumulative production, not the plant tank: transferring in parts must not
      // reset the crew's claim on a finished propellant load.
      { id: 'manufacture', label: 'Manufacture the propellant load', done: s.fuel.made >= ROCKET.capacity - 0.05, detail: `${s.fuel.made.toFixed(0)}% made` },
      { id: 'load', label: 'Load the return rocket', done: s.rocket.percent >= ROCKET.capacity - 0.05, detail: `${s.rocket.percent.toFixed(0)}%` },
      { id: 'launch', label: 'Launch for Earth', done: s.rocket.launched, detail: s.rocket.launched ? 'away' : 'awaiting go' },
    ];
  }

  /** Every condition except the launch itself — the gate on the launch console. */
  launchReady() {
    return this.missionReadiness().slice(0, -1).every((c) => c.done);
  }

  facilityStatus(id) {
    const s = this.state;
    if (s.failures[id]) return 'bad';
    if (id === 'rover' && s.rover.malfunction) return 'bad';
    if (id === 'comms') {
      if (s.cpms?.online === false) return s.cpms.repairing ? 'warn' : 'bad';
      return 'ok';
    }
    if (s.seal.active && s.seal.facilityId === id) return 'bad';
    if (this.cpmsOnline() && s.spaceWeather?.level && s.spaceWeather.level !== 'green' && s.spaceWeather.facility === id) {
      return s.spaceWeather.level === 'red' ? 'bad' : 'warn';
    }
    if (id === 'solar' && s.storm.active) return 'warn';
    if (id === 'solar' && s.fx.devil > 0) return 'warn';
    if (id === 'bat' && s.battery < 15) return 'warn';
    if (id === 'o2' && (!this.derived.powered.oxygen || s.oxygen < 25)) return 'warn';
    if (id === 'aqua' && (!this.derived.powered.water || s.water < 20)) return 'warn';
    if (id === 'bio' && (!this.derived.powered.grow || s.water < 15)) return 'warn';
    if (id === 'sci' && (!this.derived.powered.research || s.sensorGlitch > 0)) return 'warn';
    if (id === 'hab' && s.oxygen < 40) return 'warn';
    if (id === 'shelter' && (s.storm.active || s.radiation.phase !== 'none')) return 'warn';
    if (id === 'fuel') {
      if (!this.fuelLicensed()) return 'warn';
      if (!this.derived.powered.fuel) return 'warn';
      if (s.fuel.making && this.#fuelShort()) return 'warn';
    }
    if (id === 'pad') {
      if (s.rocket.launched || s.rocket.percent >= ROCKET.capacity) return 'ok';
      return s.fuel.percent >= ROCKET.capacity ? 'warn' : 'ok';
    }
    return 'ok';
  }

  /* ─────────────────────────── CPMS delivery layer ─────────────────────────── */

  /** True when the colony can still hear its announcements. */
  cpmsOnline() {
    return this.state.cpms?.online !== false;
  }

  /** ONLINE / REPAIR REQUIRED / RESTORING — the compact HUD states. */
  cpmsStatus() {
    const c = this.state.cpms;
    if (!c || c.online !== false) return 'ONLINE';
    if (c.repairing) return 'RESTORING';
    return 'REPAIR REQUIRED';
  }

  /** The CPMS failure event's entry point — deliveries stop, the sim does not. */
  triggerCpmsFailure() {
    const s = this.state;
    if (!s.cpms) {
      s.cpms = { online: true, repairing: false, repairProgress: 0, offlineAt: 0, restoredAt: 0, failures: 0 };
    }
    if (s.cpms.online === false) return false;
    s.cpms.online = false;
    s.cpms.repairing = false;
    s.cpms.repairProgress = 0;
    s.cpms.offlineAt = s.elapsed;
    s.cpms.failures = (s.cpms.failures ?? 0) + 1;
    this.pushLog('COMS OFF!REPAIR FOR UPCOMING ANOUNCEMENTS AND EVENTS', 'bad');
    this.emit({ type: 'cpms-failure' });
    return true;
  }

  /** Start the repair at COMMS-TOWER; the sim owns the timer so it survives panels. */
  beginCpmsRepair() {
    const c = this.state.cpms;
    if (!c || c.online !== false || c.repairing) return false;
    c.repairing = true;
    c.repairProgress = 0;
    this.pushLog('COMS repair started at COMMS-TOWER — relinking the colony relay.', 'info');
    this.emit({ type: 'cpms-repair-start' });
    return true;
  }

  /**
   * Restore delivery. Pending forecasts keep their original due times, so the
   * countdowns carry on instead of resetting, and only forecasts that were
   * never announced while offline are delivered now.
   */
  restoreCpms(byPlayer = false, silent = false) {
    const s = this.state;
    const c = s.cpms;
    if (!c || c.online !== false) return false;
    this.emit({ type: 'cpms-restoring' });
    c.online = true;
    c.repairing = false;
    c.repairProgress = 0;
    c.restoredAt = s.elapsed;
    s.events.active = (s.events.active ?? []).filter((e) => e.kind !== 'cpms_failure');
    this.events.resumeDelivery?.();
    this.#deliverPendingSpaceWeather();
    this.#recompute();
    if (!silent) this.pushLog('COMS ONLINE — COMMUNICATIONS RESTORED.', 'good');
    this.emit({ type: 'cpms-restored', byPlayer });
    return true;
  }

  /** Announce a DONKI advisory that arrived while the CPMS was down. */
  #deliverPendingSpaceWeather() {
    const sw = this.state.spaceWeather;
    if (!sw?.deliveryPending) return;
    sw.deliveryPending = false;
    if (sw.level === 'green') {
      this.pushAnnouncement('NASA DONKI // Space-weather advisory cleared for the retrieved window.', 'good');
      this.emit({ type: 'space-weather-cleared' });
      return;
    }
    this.pushAnnouncement(sw.pendingLog || `NASA DONKI // ${sw.title}.`, sw.pendingLogKind ?? 'warn');
    this.emit({ type: 'space-weather-alert', advisory: sw });
  }

  #updateCpms(dt) {
    const c = this.state.cpms;
    if (!c || c.online !== false || !c.repairing) return;
    c.repairProgress = Math.min(1, c.repairProgress + dt / CPMS.repairSeconds);
    if (c.repairProgress >= 1) this.restoreCpms(false);
  }

  /* ─────────────────────────── event triggers (called by events.js) ─────────────────────────── */

  startDustDevil(duration) {
    const fx = this.state.fx;
    if (fx.devil > 0) return false;
    fx.devil = duration;
    // visible near the arrays, where a devil actually costs you power
    const solar = facilityXZ('solar');
    fx.devilX = solar.x + (Math.random() - 0.5) * 26;
    fx.devilZ = solar.z + (Math.random() - 0.5) * 26;
    return true;
  }

  startMarsquake() {
    this.state.fx.quake = Math.max(this.state.fx.quake, 0.9);
    this.pushAnnouncement('Marsquake — mild seismic tremor across the outpost.', 'warn');
    return true;
  }

  triggerSensorGlitch(seconds) {
    this.state.sensorGlitch = seconds;
  }

  triggerRoverFault() {
    const r = this.state.rover;
    if (r.malfunction) return false;
    const onMission = ['outbound', 'collecting', 'returning', 'unloading', 'standby'].includes(r.phase);
    if (!onMission) {
      r.phase = 'idle';
      r.timeLeft = 0;
      r.phaseTotal = 0;
    }
    r.malfunction = true;
    r.repairProgress = 0;
    this.state.stats.breakdowns += 1;
    const engineer = onMission ? this.#dispatchRoverEngineer() : null;
    if (engineer) {
      this.pushAnnouncement('ENGINEER DISPATCHED — ROVER-01 REPAIR IN PROGRESS.', 'warn');
    } else {
      this.pushAnnouncement('ROVER-01 fault reported — the rover has stopped. Repair it at its parking bay.', 'bad');
    }
    this.emit({ type: 'rover-fault', auto: Boolean(engineer) });
    return true;
  }

  /**
   * Send the engineer out to a rover that broke mid-mission. The sim records
   * the trip and keeps the previous assignment, while crew.js walks the actor
   * to the rover and signals arrival.
   */
  #dispatchRoverEngineer() {
    const r = this.state.rover;
    const alive = this.state.crew.filter((c) => c.alive);
    // The engineer answers even off-shift: a rover broken mid-mission is an
    // emergency recall, not a job for whoever happens to be awake.
    const member = alive.find((c) => c.roleId === 'eng')
      ?? alive.find((c) => !c.sleeping)
      ?? alive[0];
    if (!member) {
      r.autoRepair = { active: false, crewId: null, stage: 'none', progress: 0, timer: 0, returnPost: null };
      return null;
    }
    const returnPost = member.sleeping ? (member.wakePost ?? member.postId ?? 'solar') : (member.postId ?? 'solar');
    if (member.sleeping) {
      // A broken rover mid-mission is an emergency recall; the rest clock keeps running.
      member.sleeping = false;
      member.wakeAt = 0;
      member.wakePost = null;
    }
    r.autoRepair = {
      active: true,
      crewId: member.id,
      stage: 'travel',
      progress: 0,
      timer: 0,
      returnPost,
    };
    member.status = 'En route to ROVER-01';
    this.emit({ type: 'rover-auto-repair', stage: 'dispatched', crewId: member.id });
    return member;
  }

  /** Called by crew.js when the dispatched engineer reaches the rover. */
  signalRoverEngineerArrived() {
    const r = this.state.rover;
    const auto = r.autoRepair;
    if (!auto?.active || auto.stage !== 'travel' || !r.malfunction) return false;
    auto.stage = 'repair';
    auto.timer = 0;
    auto.progress = 0;
    r.repairProgress = 0;
    const member = this.state.crew.find((c) => c.id === auto.crewId);
    if (member && member.alive) member.status = 'Repairing ROVER-01';
    this.emit({ type: 'rover-auto-repair', stage: 'repair', crewId: auto.crewId });
    return true;
  }

  /** Called by crew.js when the engineer is back at their old post. */
  signalRoverEngineerReturned() {
    const r = this.state.rover;
    const auto = r.autoRepair;
    if (!auto?.active || auto.stage !== 'returning') return false;
    this.#finishRoverEngineer(auto);
    return true;
  }

  #finishRoverEngineer(auto) {
    const member = this.state.crew.find((c) => c.id === auto.crewId);
    if (member && member.alive) {
      if (auto.returnPost) member.postId = auto.returnPost;
      member.status = 'Working';
    }
    auto.active = false;
    auto.crewId = null;
    auto.stage = 'none';
    auto.progress = 0;
    auto.timer = 0;
    auto.returnPost = null;
    this.#recompute();
    this.emit({ type: 'rover-auto-repair', stage: 'returned' });
  }

  triggerSeal(facilityId, label) {
    const seal = this.state.seal;
    if (seal.active) return false;
    seal.active = true;
    seal.facilityId = facilityId;
    seal.label = label;
    seal.progress = 0;
    this.state.stats.breakdowns += 1;
    this.pushAnnouncement(`External seal malfunction at ${label}. O₂ is bleeding off slowly — inspect and repair.`, 'bad');
    this.emit({ type: 'seal-fault', facilityId });
    return true;
  }

  beginRadiation(warningSeconds) {
    const rad = this.state.radiation;
    if (rad.phase !== 'none') return false;
    rad.phase = 'warning';
    rad.timeLeft = warningSeconds;
    this.pushAnnouncement('COMMS telemetry: solar particle event inbound. Shelter the crew before it peaks.', 'warn');
    this.emit({ type: 'radiation-warning', seconds: warningSeconds });
    return true;
  }

  /**
   * Hand the live DONKI assessment to the game. The advisory is presentation and
   * guidance only: it does not start a radiation event, invent a dose or change
   * any survival rate. Identical event+level pairs are ignored, so refreshing the
   * NASA feed never repeats the same alert.
   */
  applySpaceWeatherAdvisory(next) {
    const s = this.state;
    const prev = s.spaceWeather ?? { level: 'green' };
    const level = next?.level ?? 'green';
    const online = this.cpmsOnline();

    if (level === 'green') {
      if (prev.level === 'green') return false;
      s.spaceWeather = {
        level: 'green',
        levelNote: '',
        eventId: null,
        kind: null,
        facility: null,
        title: '',
        banner: '',
        advisory: '',
        eventTime: null,
        source: 'none',
        issuedAt: 0,
        updatedAt: Date.now(),
        deliveryPending: !online,
      };
      if (online) {
        this.pushAnnouncement('NASA DONKI // Space-weather advisory cleared for the retrieved window.', 'good');
        this.emit({ type: 'space-weather-cleared' });
      }
      return true;
    }

    const changed = prev.eventId !== next.eventId || prev.level !== level;
    s.spaceWeather = {
      ...(s.spaceWeather ?? {}),
      ...next,
      level,
      issuedAt: changed ? s.elapsed : (prev.issuedAt ?? s.elapsed),
      updatedAt: Date.now(),
      deliveryPending: changed ? !online : (prev.deliveryPending ?? false),
      pendingLog: next.log ?? null,
      pendingLogKind: next.logKind ?? 'warn',
    };
    if (!changed) return false;

    if (online) {
      this.pushAnnouncement(next.log || `NASA DONKI // ${next.title}.`, next.logKind ?? 'warn');
      this.emit({ type: 'space-weather-alert', advisory: s.spaceWeather });
    }
    return true;
  }

  /** Called by events.js when a meteorite warning matures into the impact itself. */
  meteorImpact(x, z, damageFacilityId) {
    const s = this.state;
    s.fx.flash = 1.2;
    this.emit({ type: 'meteor-impact', x, z });
    if (damageFacilityId) {
      const label = this.causeEquipmentFailure(damageFacilityId, 'meteorite strike');
      if (!label) {
        // every candidate already broken — the shockwave still kicks up dust
        s.dust = Math.min(1, s.dust + 0.15);
        this.pushAnnouncement('Meteorite shockwave — dust blanketed the arrays.', 'warn');
      }
    } else {
      this.pushAnnouncement('Meteorite impact away from the colony — no systems damaged.', 'info');
    }
  }

  /** One-line explanation of the top risk, used by the HUD warning banner. */
  warnings() {
    const s = this.state;
    const d = this.derived;
    const out = [];

    // Every HUD warning is delivered through the CPMS. While the console is
    // down the only thing it can say is that it cannot say anything.
    if (!this.cpmsOnline()) {
      return [{ level: 'bad', cpms: true, text: 'COMS OFF!REPAIR FOR UPCOMING ANOUNCEMENTS AND EVENTS' }];
    }

    const sw = s.spaceWeather;
    const swWarning = sw && sw.level && sw.level !== 'green' && sw.banner
      ? {
        level: sw.level === 'red' ? 'bad' : sw.level === 'orange' ? 'storm' : 'warn',
        text: sw.banner,
        spaceWeather: true,
        tone: sw.level,
      }
      : null;
    // A live radiation alert outranks a yellow "monitor conditions" notice.
    if (swWarning && sw.level !== 'yellow') out.push(swWarning);

    if (s.radiation.phase === 'warning') {
      out.push({ level: 'storm', text: `Radiation spike inbound in ${Math.ceil(s.radiation.timeLeft)} s — shelter the crew at SHELTER-Bunker.` });
    } else if (s.radiation.phase === 'peak') {
      out.push({ level: 'bad', text: 'SOLAR RADIATION EVENT — crew sheltering. Avoid EVA work.' });
    }
    if (swWarning && sw.level === 'yellow') out.push(swWarning);
    if (s.failures.solar) out.push({ level: 'bad', text: 'SOLAR-GRID offline — arrays damaged. Repair at the array field.' });
    if (s.failures.aqua) out.push({ level: 'bad', text: 'AQUA-Core offline — water production stopped. Repair required.' });
    if (s.failures.o2) out.push({ level: 'bad', text: 'O2-MOXIE offline — oxygen production stopped. Repair required.' });
    if (s.failures.bio) out.push({ level: 'bad', text: `BIO-Dome ${s.failures.bio ? 'fault — crops stalling. The botanist can fix it.' : ''}` });
    if (s.seal.active) out.push({ level: 'bad', text: `Seal leak at ${s.seal.label || s.seal.facilityId} — O₂ bleeding off. Inspect and repair.` });
    if (s.rover.malfunction) {
      const auto = s.rover.autoRepair;
      if (auto?.active && auto.stage === 'travel') {
        out.push({ level: 'warn', text: 'ENGINEER DISPATCHED — ROVER-01 REPAIR IN PROGRESS.' });
      } else if (auto?.active && auto.stage === 'repair') {
        out.push({ level: 'warn', text: `ROVER-01 repair in progress — engineer on site (${Math.round(s.rover.repairProgress * 100)}%).` });
      } else {
        out.push({ level: 'warn', text: 'ROVER-01 malfunctioned — repair it at the rover to resume the mission.' });
      }
    }
    if (s.efficiencyPenalty > 0) out.push({ level: 'warn', text: 'Crew fatigued by unshielded radiation — output reduced.' });
    if (s.sensorGlitch > 0) out.push({ level: 'warn', text: 'Sensor calibration off — research throughput −50%.' });
    if (s.oxygen < 25) out.push({ level: 'bad', text: `Oxygen reserve ${s.oxygen.toFixed(0)}% — see O2-MOXIE or the command panel.` });
    if (s.water < 20) out.push({ level: 'warn', text: `Water reserve ${s.water.toFixed(0)}% — crops will fail before the crew does.` });
    if (s.food < 20) out.push({ level: 'warn', text: `Food reserve ${s.food.toFixed(0)}% — harvest the BIO-Dome.` });
    if (s.battery < 12 && !s.backup.active) out.push({ level: 'warn', text: 'Battery below 12% — shed loads or start the backup RTG.' });
    if (s.storm.active) out.push({ level: 'storm', text: `DUST STORM — solar output reduced for ${Math.ceil(s.storm.timeLeft)} s. Start the backup RTG, ration loads and keep the crew inside.` });
    if (s.fx.devil > 0) out.push({ level: 'warn', text: 'Dust devil crossing the array field — panels soiling faster.' });
    if (s.oxygen <= 0) out.push({ level: 'bad', text: 'Life support depleted.' });
    if (s.ice < 40) {
      out.push({ level: s.ice < 12 ? 'bad' : 'warn', text: `Only ${s.ice.toFixed(0)} kg of ice in the AQUA hopper — water is finite. Send ROVER-01 out.` });
    }
    if (s.failures.fuel) out.push({ level: 'bad', text: 'FUEL-PROCESSOR damaged — the propellant line is down. Repair it.' });
    if (!this.fuelLicensed()) {
      out.push({ level: 'warn', text: 'NO FUEL LICENCE — Martian Fuel Production Technology is compulsory for the return window.' });
    } else if (s.fuel.interrupted > 0 && !s.fuel.making && s.fuel.percent < ROCKET.capacity) {
      out.push({ level: 'warn', text: 'Fuel production interrupted — the plant is short of a feedstock.' });
    }
    for (const kind of ['carbon', 'oxygen', 'hydrogen']) {
      if (s.fuel[kind] < FUEL.recipe[kind] && s.fuel.percent < ROCKET.capacity) {
        const article = /^[aeiou]/i.test(kind) ? 'an' : 'a';
        out.push({ level: 'warn', text: `${kind.toUpperCase()} store nearly empty — send ROVER-01 on ${article} ${kind} run, or let the stripper fill it.` });
      }
    }
    const tired = this.crewRoster().filter((c) => c.alive && c.fatigue >= FATIGUE.severe);
    if (tired.length) {
      out.push({ level: 'warn', text: `${tired.map((c) => c.name).join(', ')} exhausted — rest is overdue and work is slipping.` });
    }
    if (s.player.sleeping) out.push({ level: 'warn', text: 'You are on the bunk. The overview cam is live — press E to get up.' });
    if (s.rocket.percent >= ROCKET.capacity && !s.rocket.launched) {
      out.push({ level: 'storm', text: this.launchReady() ? 'M3 FUELLED — launch console is live at the LAUNCH-SITE.' : 'M3 fuelled, but objectives are still outstanding.' });
    }

    // Lowest-priority banner slot: a real hazard or repair advisory always wins,
    // but a quiet colony still gets the advance notice on screen.
    const forecast = this.environmentForecast();
    if (forecast.status === 'forecast') {
      const seconds = Math.max(1, Math.ceil(forecast.dueIn));
      out.push({
        level: 'forecast',
        forecast: true,
        code: forecast.code,
        severity: forecast.severity,
        text: `ENVIRONMENTAL FORECAST — ${forecast.code} · ${forecast.severity} · impact in ${seconds} s. ${forecast.action}`,
      });
    }

    return out;
  }

  /**
   * The Mars environmental forecast, taken from pending events in the event
   * director. This is simulation data, generated offline, and is deliberately
   * separate from the optional NASA DONKI advisory in state.spaceWeather.
   */
  environmentForecast() {
    const forecast = this.events.pendingForecast();
    if (forecast) return { status: 'forecast', ...forecast };

    const active = this.events.activeHazards();
    if (active.length) return { status: 'active', active };
    return { status: 'clear', active: [] };
  }

  roverStatus() {
    const r = this.state.rover;
    if (r.malfunction) return ROVER_STATUS.malfunction;
    return ROVER_STATUS[r.phase] ?? 'Idle';
  }

  /** True while a mission is running and not stuck in repair. */
  roverActive() {
    const r = this.state.rover;
    return !r.malfunction && r.phase !== 'idle';
  }

  /* ─────────────────────────── player / crew actions ─────────────────────────── */

  setSystem(id, on) {
    if (!(id in this.state.systems)) return;
    this.state.systems[id] = Boolean(on);
    this.#recompute();
  }

  toggleSystem(id) {
    this.setSystem(id, !this.state.systems[id]);
  }

  setNightRationing(on) {
    this.state.nightRationing = Boolean(on);
    this.#recompute();
  }

  assignCrew(crewId, postId) {
    const crew = this.state.crew.find((c) => c.id === crewId);
    if (!crew) return false;
    if (!crew.alive) {
      this.pushLog(`${crew.name} is not fit for duty.`, 'warn');
      return false;
    }
    if (crew.sleeping) {
      this.pushLog(`${crew.name} is in the bunk — let them finish their rest.`, 'warn');
      return false;
    }
    if (crew.postId === postId) return false;
    const occupant = this.crewAt(postId);
    if (occupant && occupant.id !== crew.id) {
      occupant.postId = crew.postId;   // swap into the vacated post rather than stack two bodies
    }
    crew.postId = postId;
    const post = POSTS.find((p) => p.id === postId);
    this.pushLog(`${crew.name} reassigned to ${post ? post.label : postId}.`, 'info');
    this.emit({ type: 'crew', crewId, postId });
    this.#recompute();
    return true;
  }

  /** Move a rest window on the crew-management console. */
  setRestShift(crewId, hour) {
    const crew = this.state.crew.find((c) => c.id === crewId);
    if (!crew) return false;
    const next = Math.max(0, Math.min(FATIGUE.hoursPerSol - SLEEP.hours, Math.round(hour)));
    crew.shift = next;
    this.pushLog(`${crew.name} rest window moved to Sol hour ${next}.`, 'info');
    this.emit({ type: 'schedule', crewId, hour: next });
    return true;
  }

  /** Take a crew member off rotation until they are recalled. */
  standCrewDown(crewId, on) {
    const crew = this.state.crew.find((c) => c.id === crewId);
    if (!crew) return false;
    if (on) {
      if (crew.sleeping) return false;
      crew.wakePost = crew.postId;
      this.#sendToBed(crew, SLEEP.hours);
      return true;
    }
    if (!crew.sleeping) return false;
    this.#wake(crew);
    return true;
  }

  startResearch(topicId) {
    const topic = this.state.topics.find((t) => t.id === topicId);
    if (!topic || topic.done) return false;
    if (!this.state.systems.research) {
      this.pushLog('Research power is switched off. Enable it in telemetry first.', 'warn');
      return false;
    }
    this.state.activeTopic = topic.id;
    this.pushLog(`Research started: ${topic.name}.`, 'info');
    this.emit({ type: 'research', topicId });
    return true;
  }

  repairFacility(id, byPlayer = false) {
    if (!this.state.failures[id]) return false;
    this.state.failures[id] = false;
    this.state.repair[id] = 0;
    this.state.stats.repairs += 1;
    this.pushLog(`${id.toUpperCase()} repaired${byPlayer ? ' by the astronaut' : ' by the crew'}.`, 'good');
    this.emit({ type: 'repair', id });
    return true;
  }

  cleanPanels() {
    const before = this.state.dust;
    this.state.dust = 0;
    this.state.stats.cleans += 1;
    if (before > 0.05) this.pushLog('Solar panels cleaned — output restored.', 'good');
    this.emit({ type: 'clean' });
  }

  applyCrewCleaning(dt, factor) {
    if (factor <= 0) return;
    this.state.dust = Math.max(0, this.state.dust - RATES.dustCleanRate * factor * dt);
  }

  harvest(index, silent = false) {
    const plot = this.state.plots[index];
    if (!plot || !plot.mature) return false;
    const yieldAmount = RATES.cropYield + this.derived.mult.cropYield;
    this.state.food = clamp01(this.state.food + yieldAmount);
    plot.growth = 0;
    plot.mature = false;
    this.state.stats.harvests += 1;
    if (!silent) this.pushLog(`Harvest complete — ${yieldAmount} food stockpiled.`, 'good');
    this.emit({ type: 'harvest', index });
    return yieldAmount;
  }

  /**
   * Send ROVER-01 to one of the mapped resource sites. The site decides the
   * mission type and where the cargo is unloaded; fuel materials always go to
   * the FUEL-PROCESSOR, never into the water reserve.
   */
  dispatchRover(siteIndex = 0) {
    const r = this.state.rover;
    const s = this.state;
    if (this.roverActive()) {
      this.pushLog('ROVER-01 is already on a survey run.', 'warn');
      return false;
    }
    if (r.malfunction) {
      this.pushLog('ROVER-01 is malfunctioning — repair it before dispatch.', 'warn');
      return false;
    }
    if (!s.systems.rover) {
      this.pushLog('Rover charging is switched off in telemetry.', 'warn');
      return false;
    }
    const idx = Math.max(0, Math.min(SITES.length - 1, siteIndex | 0));
    const site = SITES[idx];
    const deposit = s.sites[idx];
    if (deposit.remaining <= 0) {
      this.pushLog(`${site.name} is worked out — find another ${site.kind} deposit.`, 'warn');
      return false;
    }
    const route = roverRoute(idx);
    r.phase = 'outbound';
    r.survey = idx;
    r.mission = site.kind;
    r.carrying = false;
    r.cargo = null;
    r.result = null;
    r.timeLeft = route.seconds.outbound;
    r.phaseTotal = route.seconds.outbound;
    this.#recompute();
    this.pushLog(
      `ROVER-01 rolling out to ${site.name} — ${site.kind} run, ${(route.dist.out / 1000).toFixed(2)} km drive.`,
      'info',
    );
    this.emit({ type: 'rover-phase', phase: 'outbound', survey: idx });
    return true;
  }

  /** Pick the best available site for a mission kind, for one-button dispatch. */
  bestSiteFor(kind) {
    let best = -1;
    let bestScore = -Infinity;
    SITES.forEach((site, i) => {
      if (site.kind !== kind) return;
      const remaining = this.state.sites[i]?.remaining ?? 0;
      if (remaining <= 0) return;
      // richer and closer wins; the remaining quantity dominates so the player
      // is pushed toward fresh deposits as the old ones drain.
      const score = remaining * 0.01 - site.dist * 0.01;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
    return best;
  }

  /** 0..1 progress through the current mission phase (drives the rover visuals). */
  roverProgress() {
    const r = this.state.rover;
    if (r.malfunction || r.phaseTotal <= 0) return 0;
    return Math.min(1, Math.max(0, 1 - r.timeLeft / r.phaseTotal));
  }

  repairRover(byPlayer = false, mode = 'crew') {
    const r = this.state.rover;
    if (!r.malfunction) return false;
    const auto = r.autoRepair;
    const autoFinish = mode === 'auto' || Boolean(auto?.active && auto.stage === 'repair');
    r.malfunction = false;
    r.repairProgress = 0;
    this.state.stats.repairs += 1;
    if (auto?.active) {
      // The engineer is still on site: send them home before closing the job.
      auto.stage = 'returning';
      auto.progress = 0;
      auto.timer = 0;
    }
    if (autoFinish) {
      this.pushLog('ROVER-01 REPAIRED — MISSION RESUMED.', 'good');
    } else {
      const resume = r.phase !== 'idle' ? ', resuming its survey' : '';
      this.pushLog(`ROVER-01 repaired${resume}${byPlayer ? ' by the astronaut' : ' by the crew'}.`, 'good');
    }
    this.emit({ type: 'rover-repaired' });
    return true;
  }

  repairSeal(byPlayer = false) {
    const s = this.state;
    if (!s.seal.active) return false;
    const where = s.seal.label || s.seal.facilityId;
    s.seal.active = false;
    s.seal.facilityId = null;
    s.seal.progress = 0;
    s.stats.repairs += 1;
    this.pushLog(`External seal at ${where} re-pressed${byPlayer ? ' by the astronaut' : ' by the crew'}.`, 'good');
    this.emit({ type: 'seal-repaired' });
    return true;
  }

  setCrewSheltered(on) {
    const s = this.state;
    const next = Boolean(on);
    if (s.crewSheltered === next) return false;
    s.crewSheltered = next;
    s.radiation.sheltered = next;
    this.pushLog(
      next
        ? 'Crew moving into SHELTER-Bunker. All outdoor posts unmanned while they shelter.'
        : 'Crew recalled to their posts.',
      'info',
    );
    this.#recompute();
    this.emit({ type: 'crew-shelter', sheltered: next });
    return true;
  }

  requestResupply() {
    const s = this.state;
    if (s.resupply.used) return false;
    if (s.researchPoints < CHOICES.resupplyCost) {
      this.pushLog(`Resupply denied — needs ${CHOICES.resupplyCost} research points.`, 'warn');
      return false;
    }
    s.researchPoints -= CHOICES.resupplyCost;
    s.oxygen = clamp01(s.oxygen + CHOICES.resupplyGain.oxygen);
    s.water = clamp01(s.water + CHOICES.resupplyGain.water);
    s.food = clamp01(s.food + CHOICES.resupplyGain.food);
    s.resupply.used = true;
    this.pushLog('Emergency resupply inbound — O₂, water and food topped up.', 'good');
    this.emit({ type: 'resupply' });
    return true;
  }

  activateBackup() {
    const b = this.state.backup;
    if (b.active || b.charges <= 0) return false;
    b.charges -= 1;
    b.active = true;
    b.timeLeft = POWER.backupDuration;
    this.pushLog(`Backup RTG online for ${POWER.backupDuration} s (+${POWER.backupUnits} power).`, 'good');
    return true;
  }

  cycleSpeed() {
    const options = [1, 2, 4];
    const i = options.indexOf(this.state.speed);
    this.state.speed = options[(i + 1) % options.length];
    return this.state.speed;
  }

  /* ─────────────────────────── cheat code mode ───────────────────────────
   * Showcase shortcuts for the CHEAT CODE MODE console only. Normal play never
   * calls these; each routes through the same private machinery the tick uses
   * so the world reacts exactly as it always would. */

  /** Finish a research topic now, applying its real licence/multiplier effects. */
  completeTopic(id) {
    const topic = this.state.topics.find((t) => t.id === id);
    if (!topic || topic.done) return false;
    topic.progress = topic.cost;
    topic.done = true;
    this.state.stats.topics += 1;
    if (this.state.activeTopic === id) this.state.activeTopic = null;
    this.#applyResearch(topic);
    this.pushLog(`Research complete: ${topic.name}.`, 'good');
    this.emit({ type: 'research-complete', topic });
    this.#recompute();
    return true;
  }

  /** Run the rover's real phase machine to the end of the current trip, instantly. */
  completeRoverTrip() {
    const r = this.state.rover;
    if (r.malfunction || r.phase === 'idle') return false;
    let guard = 0;
    while (r.phase !== 'idle' && guard++ < 12) {
      r.timeLeft = 0;
      this.#updateRover(0.0001);
    }
    this.#recompute();
    return true;
  }

  /** Heal, rest and wake the whole roster — health and fatigue back to a fresh Sol. */
  restoreCrew() {
    for (const member of this.crewRoster()) {
      member.alive = true;
      member.health = 100;
      member.fatigue = 0;
      member.sleptHours = Math.max(member.sleptHours, FATIGUE.requiredRestHours);
      member.status = 'Working';
      if (member.sleeping) {
        member.sleeping = false;
        member.wakeAt = 0;
        if (member.id !== 'player') member.postId = member.wakePost ?? member.postId;
        member.wakePost = null;
      }
      if (member.id !== 'player') member.restSol = this.state.sol;
    }
    this.state.efficiencyPenalty = 0;
    if (this.state.flags.failed) {
      this.state.flags.failed = false;
      this.state.flags.failureReason = '';
    }
    this.#recompute();
    this.pushLog('Cheat code: crew restored — full health, full rest, back on their posts.', 'good');
    this.emit({ type: 'crew-restored' });
    return true;
  }

  /** Jump the mission clock to the start of a Sol (showcase time control). */
  setSol(sol) {
    const s = this.state;
    const next = Math.max(1, Math.min(CHOICES.successSol, Math.round(sol)));
    s.elapsed = (next - 1) * SOL_SECONDS;
    s.sol = next;
    s.hour = START_HOUR;
    this.derived.daylight = Math.max(0, Math.sin((Math.PI * (s.hour - 6)) / 12));
    for (const member of this.crewRoster()) member.restSol = 0;
    this.#recompute();
    this.pushLog(`Cheat code: mission clock set to Sol ${next}.`, 'info');
    this.emit({ type: 'sol-set', sol: next });
    return true;
  }

  /** Tick off every outstanding mission objective except the launch itself. */
  completeMissionObjectives() {
    const s = this.state;
    s.elapsed = Math.max(s.elapsed, CHOICES.successSol * SOL_SECONDS);
    s.sol = Math.max(s.sol, CHOICES.successSol);
    this.restoreCrew();
    for (const topic of s.topics) if (!topic.done) this.completeTopic(topic.id);
    const need = {
      carbon: FUEL.recipe.carbon * ROCKET.capacity,
      oxygen: FUEL.recipe.oxygen * ROCKET.capacity,
      hydrogen: FUEL.recipe.hydrogen * ROCKET.capacity,
    };
    for (const kind of ['carbon', 'oxygen', 'hydrogen']) {
      s.stats.collected[kind] = Math.max(s.stats.collected[kind], need[kind]);
    }
    s.fuel.made = Math.max(s.fuel.made, ROCKET.capacity);
    s.fuel.making = false;
    s.rocket.transferring = false;
    s.rocket.transferLeft = 0;
    s.rocket.percent = ROCKET.capacity;
    s.rocket.ready = true;
    this.#recompute();
    this.pushLog('Cheat code: every mission objective ticked off — the M3 is GO for launch.', 'good');
    this.emit({ type: 'mission-demo-complete' });
    return true;
  }

  /* ─────────────────────────── propellant + launch ─────────────────────────── */

  /** Shortage test: does the plant have at least `percent` of a load available? */
  #fuelShort(percent = 1) {
    const f = this.state.fuel;
    return (
      f.carbon < FUEL.recipe.carbon * percent ||
      f.oxygen < FUEL.recipe.oxygen * percent ||
      f.hydrogen < FUEL.recipe.hydrogen * percent
    );
  }

  fuelCanMake() {
    return this.fuelLicensed() && this.derived.powered.fuel && !this.state.failures.fuel && !this.#fuelShort();
  }

  startFuelProduction() {
    const s = this.state;
    if (s.fuel.percent >= ROCKET.capacity) {
      this.pushLog('Propellant plant tank is already full.', 'info');
      return false;
    }
    if (!this.fuelLicensed()) {
      this.pushLog('NO LICENCE: complete Martian Fuel Production Technology at the SCI-Lab first.', 'warn');
      return false;
    }
    if (!s.systems.fuel) {
      this.pushLog('The FUEL-PROCESSOR load is switched off in telemetry.', 'warn');
      return false;
    }
    if (this.#fuelShort()) {
      this.pushLog('Not enough feedstock — the line needs carbon, oxygen and hydrogen in the mix.', 'warn');
      return false;
    }
    s.fuel.making = true;
    s.fuel.interrupted = 0;
    this.pushLog('Propellant line started — Sabatier reactor warming up.', 'good');
    this.emit({ type: 'fuel-start' });
    return true;
  }

  stopFuelProduction(reason = 'by the crew') {
    const s = this.state;
    if (!s.fuel.making) return false;
    s.fuel.making = false;
    this.pushLog(`Propellant line stopped ${reason}.`, 'warn');
    this.emit({ type: 'fuel-stop' });
    return true;
  }

  /** Move the plant's finished propellant into the rocket's tanks. */
  transferFuel() {
    const s = this.state;
    if (s.rocket.transferring) return false;
    if (s.rocket.percent >= ROCKET.capacity) {
      this.pushLog('The return rocket is already full.', 'info');
      return false;
    }
    if (s.fuel.percent <= 0) {
      this.pushLog('Nothing to transfer — the plant tank is empty.', 'warn');
      return false;
    }
    if (s.fuel.making) {
      this.pushLog('Shut the propellant line down before you open the transfer line.', 'warn');
      return false;
    }
    s.rocket.transferring = true;
    s.rocket.transferLeft = FUEL.transferSeconds;
    this.pushLog(`Cryo transfer line opened — ${FUEL.transferSeconds} s to fill the M3 tanks.`, 'good');
    this.emit({ type: 'rocket-transfer' });
    return true;
  }

  /**
   * The only route to victory. Re-checked against the full condition list here
   * rather than trusting whatever state the console was drawn in.
   */
  launchRocket() {
    const s = this.state;
    if (s.rocket.launched || s.flags.complete || s.flags.failed) return false;
    if (!this.launchReady()) {
      const missing = this.missionReadiness().filter((c) => !c.done && c.id !== 'launch');
      this.pushLog(
        `LAUNCH SCRUBBED — ${missing.length} objective${missing.length === 1 ? '' : 's'} outstanding: ` +
          missing.map((c) => c.label).join(', '),
        'warn',
      );
      return false;
    }
    s.rocket.launched = true;
    s.flags.complete = true;
    s.fuel.making = false;
    this.pushLog('M3 AWAY. Four souls on board, Earth on the horizon.', 'good');
    this.emit({ type: 'launch' });
    return true;
  }

  /* ─────────────────────────── rest + fatigue ─────────────────────────── */

  beginPlayerRest() {
    const p = this.state.player;
    if (p.sleeping || !p.alive) return false;
    p.sleeping = true;
    p.status = 'Sleeping';
    this.pushLog('You are on the bunk. The colony keeps running — take the overview cam and watch it work.', 'info');
    this.emit({ type: 'player-rest', on: true });
    return true;
  }

  endPlayerRest() {
    const p = this.state.player;
    if (!p.sleeping) return false;
    p.sleeping = false;
    p.status = 'Resting';
    this.pushLog('Back on duty.', 'info');
    this.emit({ type: 'player-rest', on: false });
    return true;
  }

  togglePlayerRest() {
    return this.state.player.sleeping ? this.endPlayerRest() : this.beginPlayerRest();
  }

  /* ─────────────────────────── tick ─────────────────────────── */

  update(dt) {
    const s = this.state;
    if (s.flags.complete || s.flags.failed) return;

    this.#advanceClock(dt);
    this.#recompute();
    this.#updateHazards(dt);
    this.events.update(dt);
    this.#recompute();
    this.integrateBattery(dt);

    const diff = this.difficulty;
    const d = this.derived;

    // sol-scaled drain: 1.0 until PRESSURE.fromSol, then a gentle climb
    const pressure = d.pressure;

    // ── oxygen ────────────────────────────────────────────────────────────
    const habFactor = d.factor.hab;
    const sealLeak = s.seal.active ? 0.02 : 0;
    const crewO2 = RATES.oxygenUsePerCrew * RATES.crewCount * (1 - 0.08 * habFactor) * diff.consumption * pressure;
    const o2Delta = (d.oxygenProduction - crewO2 - sealLeak * diff.consumption) * dt;
    s.oxygen = clamp01(s.oxygen + o2Delta);

    // ── water: what the ice hopper holds, and nothing more ────────────────
    const growing = s.plots.filter((p) => !p.mature && d.powered.grow).length;
    const cropWater = RATES.cropWaterPerPlot * growing;
    const waterUsed = (RATES.waterUsePerCrew * RATES.crewCount + cropWater) * diff.consumption * pressure * dt;
    // The plant stops drawing ice once the reserve is full; otherwise the finite
    // field is burned melting water the colony has no room to keep.
    const headroomKg = (100 - s.water) / (WATER.iceToWater * d.mult.water);
    const melted = Math.min(s.ice, d.iceRate * dt, headroomKg);
    s.ice = Math.max(0, s.ice - melted);
    const madeWater = melted * WATER.iceToWater * d.mult.water;
    const recycled = waterUsed * WATER.recycle * (d.powered.water ? 1 : 0.5);
    const waterDelta = madeWater + recycled - waterUsed;
    s.water = clamp01(s.water + waterDelta);
    d.waterProduction = dt > 0 ? madeWater / dt : 0;

    // ── food ──────────────────────────────────────────────────────────────
    const foodDelta = -RATES.foodUsePerCrew * RATES.crewCount * diff.consumption * pressure * dt;
    s.food = clamp01(s.food + foodDelta);
    d.starving = s.food <= 0.01;
    d.flow = { oxygen: o2Delta / dt, water: waterDelta / dt, food: foodDelta / dt };

    // ── crops ─────────────────────────────────────────────────────────────
    const canGrow = s.water > 4 && d.powered.grow;
    let ripened = 0;
    for (const plot of s.plots) {
      if (plot.mature) continue;
      if (canGrow) {
        plot.growth = Math.min(1, plot.growth + RATES.cropGrowth * d.mult.cropGrowth * dt);
        if (plot.growth >= 1) {
          plot.mature = true;
          ripened += 1;
        }
      }
    }
    // Harvest is state-based, not edge-based: a bed that ripened while the
    // botanist was asleep or sheltering must still get cut when they are back.
    if (s.plots.some((p) => p.mature)) {
      if (this.crewAt('bio')) this.#autoHarvest();
      else if (ripened) {
        this.pushLog(ripened > 1
          ? `${ripened} crops are ready in the BIO-Dome — harvest them there.`
          : 'A crop is ready in the BIO-Dome — harvest it there.', 'good');
      }
    }

    // ── research ──────────────────────────────────────────────────────────
    if (s.activeTopic && d.powered.research) {
      const topic = s.topics.find((t) => t.id === s.activeTopic);
      if (topic && !topic.done) {
        const glitch = s.sensorGlitch > 0 ? 0.5 : 1;
        const rate = RATES.researchRate * (1 + 1.0 * d.factor.sci) * glitch;
        topic.progress = Math.min(topic.cost, topic.progress + rate * dt);
        s.researchPoints += rate * dt;
        if (topic.progress >= topic.cost) {
          topic.done = true;
          s.stats.topics += 1;
          s.activeTopic = null;
          this.#applyResearch(topic);
          this.pushLog(`Research complete: ${topic.name}.`, 'good');
          this.emit({ type: 'research-complete', topic });
        }
      }
    }

    // ── dust, backup RTG, rover mission ────────────────────────────────────
    s.dust = Math.min(1, s.dust + RATES.dustGain * dt * (s.storm.active ? 2.4 : 1) * (s.fx.devil > 0 ? 2 : 1));
    if (d.factor.solar > 0) this.applyCrewCleaning(dt, d.factor.solar);

    if (s.backup.active) {
      s.backup.timeLeft -= dt;
      if (s.backup.timeLeft <= 0) {
        s.backup.active = false;
        s.backup.timeLeft = 0;
        this.pushLog('Backup RTG exhausted.', 'warn');
      }
    }

    this.#updateRover(dt);
    this.#updateCpms(dt);
    this.#updateFaultTimers(dt);
    this.#updateCrew(dt);
    this.#updateFuel(dt);
    this.#updateRocket(dt);

    // ── crew repairs ──────────────────────────────────────────────────────
    for (const id of ['aqua', 'o2', 'solar', 'bio', 'fuel']) {
      if (!s.failures[id]) continue;
      const worker = this.crewAt(id);
      if (!worker) continue;
      const skill = this.#isSpecialist(worker, id) ? 1 : 0.45;
      s.repair[id] += (dt / 20) * skill * this.fatigueFactor(worker);
      if (s.repair[id] >= 1) this.repairFacility(id, false);
    }

    // a crew member posted at the broken facility can chase a seal leak too
    if (s.seal.active) {
      const worker = this.crewAt(s.seal.facilityId);
      if (worker) {
        s.seal.progress += (dt / 24) * this.fatigueFactor(worker);
        if (s.seal.progress >= 1) this.repairSeal(false);
      }
    }

    this.#updateHealth(dt);

    // ── win / fail ────────────────────────────────────────────────────────
    // Surviving ten Sols is no longer a win. The only victory is the launch,
    // and the launch is gated inside launchRocket().
    if (s.oxygen <= 0) {
      this.#fail('Oxygen exhausted. The crew did not survive the outpost.');
    } else if (!this.crewRoster().every((c) => c.alive)) {
      const lost = this.crewRoster().filter((c) => !c.alive).map((c) => c.name);
      this.#fail(`MISSION FAILED — THE CREW DID NOT SURVIVE. ${lost.join(' and ')} did not make it.`);
    } else if (s.elapsed >= CHOICES.successSol * SOL_SECONDS && !s.flags.solTenNotice) {
      s.flags.solTenNotice = true;
      const outstanding = this.missionReadiness().filter((c) => !c.done && c.id !== 'launch');
      this.pushLog(
        outstanding.length
          ? `Sol ${CHOICES.successSol} survived — but the return window needs ${outstanding
              .map((c) => c.label.toLowerCase())
              .join(', ')}.`
          : `Sol ${CHOICES.successSol} survived. The M3 is ready — get to the launch site.`,
        outstanding.length ? 'warn' : 'good',
      );
    }
  }

  #fail(reason) {
    const s = this.state;
    if (s.flags.failed || s.flags.complete) return;
    s.flags.failed = true;
    s.flags.failureReason = reason;
    this.pushLog(`CATASTROPHIC: ${reason}`, 'bad');
    this.emit({ type: 'failed' });
  }

  /* ─────────────────────────── crew rest + fatigue ─────────────────────────── */

  #updateCrew(dt) {
    const s = this.state;
    const hours = dt / SECONDS_PER_HOUR;
    const solHour = this.solHour();

    for (const member of this.crewRoster()) {
      if (!member.alive) {
        member.status = 'Lost';
        continue;
      }

      if (member.sleeping) {
        member.fatigue = Math.max(0, member.fatigue - FATIGUE.restorePerHour * hours);
        member.sleptHours += hours;
        member.status = 'Sleeping';
        if (member.id !== 'player' && s.elapsed >= (member.wakeAt ?? 0)) this.#wake(member);
        continue;
      }

      // The rotational schedule is what keeps one specialist offline at a time.
      // It is checked before sheltering, because a radiation event landing on top
      // of a rest window must not cost the crew their sleep for the Sol.
      const onRoverCall = Boolean(s.rover.autoRepair?.active && s.rover.autoRepair.crewId === member.id);
      if (!onRoverCall && member.id !== 'player' && member.restSol !== s.sol && solHour >= member.shift) {
        this.#sendToBed(member, SLEEP.hours);
        continue;
      }

      // Sheltering in the bunker is half a bunk: the body is off its feet.
      if (s.crewSheltered) {
        member.fatigue = Math.max(0, member.fatigue - FATIGUE.restorePerHour * 0.6 * hours);
        member.sleptHours += hours * 0.6;
        member.status = 'Sheltering';
        continue;
      }

      const onPost = member.id === 'player' ? Boolean(member.cover) : member.postId !== 'hab';
      member.fatigue = Math.min(100, member.fatigue + (onPost ? FATIGUE.gainPerHour : FATIGUE.gainStanding) * hours);
      member.status = member.fatigue >= FATIGUE.exhausted ? 'Exhausted' : member.moving ? 'Walking' : 'Working';
      const auto = s.rover.autoRepair;
      if (auto?.active && auto.crewId === member.id) {
        member.status = auto.stage === 'travel'
          ? 'En route to ROVER-01'
          : auto.stage === 'repair'
            ? 'Repairing ROVER-01'
            : 'Returning to post';
      }
    }
  }

  #sendToBed(member, hours) {
    if (member.sleeping) return false;
    member.wakePost = member.postId ?? 'hab';
    member.sleeping = true;
    member.status = 'Sleeping';
    member.wakeAt = this.state.elapsed + hours * SECONDS_PER_HOUR;
    member.restSol = this.state.sol;
    this.pushLog(`${member.name} is off rotation — walking to a bunk at HAB-Alpha for ${hours} h.`, 'info');
    this.emit({ type: 'crew-sleep', crewId: member.id, sleeping: true });
    this.#recompute();
    return true;
  }

  #wake(member) {
    member.sleeping = false;
    member.status = 'Working';
    member.wakeAt = 0;
    if (member.id !== 'player') member.postId = member.wakePost ?? member.postId;
    member.wakePost = null;
    this.pushLog(`${member.name} is rested and back on rotation.`, 'good');
    this.emit({ type: 'crew-sleep', crewId: member.id, sleeping: false });
    this.#recompute();
    return true;
  }

  /**
   * Sol rollover bookkeeping: the four-hour rule is enforced here, and severe
   * fatigue gets one mistake roll per Sol per person.
   */
  #endOfSolAudit(sol) {
    const s = this.state;
    for (const member of this.crewRoster()) {
      if (!member.alive) continue;
      if (member.sleptHours < FATIGUE.requiredRestHours) {
        const short = FATIGUE.requiredRestHours - member.sleptHours;
        member.fatigue = Math.min(100, member.fatigue + 18);
        member.health = Math.max(0, member.health - 6);
        s.stats.missedRest += 1;
        this.pushLog(
          `${member.name} missed rest by ${short.toFixed(1)} h on Sol ${sol - 1}. Efficiency and health are paying for it.`,
          'bad',
        );
      } else if (member.fatigue >= FATIGUE.moderate) {
        this.pushLog(`${member.name} clocked ${member.sleptHours.toFixed(1)} h of rest — back to full strength.`, 'good');
      }

      if (member.fatigue >= FATIGUE.severe && Math.random() < FATIGUE.mistakeChance) {
        const worker = member.id === 'player' ? null : this.crewAt(member.postId);
        if (worker) {
          const post = POSTS.find((p) => p.id === worker.postId);
          this.pushLog(`Fatigue mistake: ${member.name} mis-set a valve at ${post ? post.label : worker.postId}.`, 'bad');
          s.efficiencyPenalty = 18;
          if (Math.random() < 0.5) this.causeEquipmentFailure(worker.postId, 'crew error');
        } else {
          s.sensorGlitch = Math.max(s.sensorGlitch, 25);
          this.pushLog(`${member.name} is running on no sleep — telemetry is unreliable.`, 'warn');
        }
      }
      member.sleptHours = 0;
    }
  }

  /* ─────────────────────────── propellant line ─────────────────────────── */

  #updateFuel(dt) {
    const s = this.state;
    const f = s.fuel;
    const d = this.derived;
    const licensed = this.fuelLicensed();
    const powered = d.powered.fuel && !s.failures.fuel;

    if (powered && licensed) {
      const staff = FUEL.unstaffed + (1 - FUEL.unstaffed) * d.factor.fuel;
      // Carbon and oxygen come out of the atmosphere; hydrogen is electrolysed
      // out of the water reserve, which is exactly why it competes with drinking.
      const cRoom = FUEL.store.carbon - f.carbon;
      const cGot = Math.min(FUEL.intake.carbon * staff * dt, cRoom);
      if (cGot > 0) {
        f.carbon += cGot;
        s.stats.collected.carbon += cGot;
      }
      const oRoom = FUEL.store.oxygen - f.oxygen;
      const oGot = Math.min(FUEL.intake.oxygen * staff * dt, oRoom);
      if (oGot > 0) {
        f.oxygen += oGot;
        s.stats.collected.oxygen += oGot;
      }
      if (s.water > 8) {
        const hRoom = FUEL.store.hydrogen - f.hydrogen;
        const hGot = Math.min(FUEL.electrolysis.hydrogen * staff * dt, hRoom);
        if (hGot > 0) {
          f.hydrogen += hGot;
          s.stats.collected.hydrogen += hGot;
          s.water = clamp01(s.water - FUEL.electrolysis.water * staff * dt);
        }
      }
    }

    if (!f.making) return;

    if (!licensed || !powered) {
      this.stopFuelProduction(powered ? '— the fuel licence is not in force' : '— the plant lost served power');
      return;
    }

    const want = Math.min(FUEL.rate * dt, ROCKET.capacity - f.percent);
    const need = {
      carbon: FUEL.recipe.carbon * want,
      oxygen: FUEL.recipe.oxygen * want,
      hydrogen: FUEL.recipe.hydrogen * want,
    };
    if (f.carbon < need.carbon || f.oxygen < need.oxygen || f.hydrogen < need.hydrogen) {
      f.interrupted += dt;
      this.stopFuelProduction('— a feedstock store ran dry');
      return;
    }

    f.carbon -= need.carbon;
    f.oxygen -= need.oxygen;
    f.hydrogen -= need.hydrogen;
    f.percent = Math.min(ROCKET.capacity, f.percent + want);
    // Cumulative output is what the launch board checks: a player who tops the
    // M3 up in parts has still manufactured the whole load.
    f.made += want;
    f.interrupted = 0;
    if (f.percent >= ROCKET.capacity) {
      f.making = false;
      this.pushLog('Plant tank full — propellant load complete. Transfer it to the M3.', 'good');
      this.emit({ type: 'fuel-full' });
    }
  }

  #updateRocket(dt) {
    const rk = this.state.rocket;
    if (!rk.transferring) return;
    const step = Math.min((ROCKET.capacity / FUEL.transferSeconds) * dt, rk.transferLeft > 0 ? ROCKET.capacity : 0);
    const move = Math.max(0, Math.min(step, this.state.fuel.percent, ROCKET.capacity - rk.percent));
    rk.percent = Math.min(ROCKET.capacity, rk.percent + move);
    this.state.fuel.percent -= move;
    rk.transferLeft = Math.max(0, rk.transferLeft - dt);
    if (rk.transferLeft <= 0 || this.state.fuel.percent <= 0 || rk.percent >= ROCKET.capacity) {
      rk.transferring = false;
      rk.ready = rk.percent >= ROCKET.capacity - 0.05;
      this.pushLog(
        rk.ready
          ? 'M3 TANKS FULL. The return rocket is fuelled — launch console is live.'
          : 'Transfer ended — the plant tank ran dry. Make more propellant and top the M3 up.',
        rk.ready ? 'good' : 'warn',
      );
      this.emit({ type: 'rocket-transfer-end', ready: rk.ready });
    }
  }

  /* ─────────────────────────── crew health ─────────────────────────── */

  #updateHealth(dt) {
    const s = this.state;
    const hours = dt / SECONDS_PER_HOUR;
    const exposed = s.radiation.phase === 'peak' && !s.crewSheltered;

    for (const member of this.crewRoster()) {
      if (!member.alive) continue;
      let drain = 0;
      if (s.oxygen < 12) drain += 9;
      if (s.food <= 0.01) drain += 3.5;
      if (s.water <= 0.01) drain += 3;
      if (member.fatigue >= 100) drain += FATIGUE.healthDrain;
      if (exposed && !member.sleeping) drain += 12;

      if (drain > 0) {
        member.health = Math.max(0, member.health - drain * hours);
        if (member.health <= 0) {
          member.alive = false;
          member.status = 'Lost';
          member.sleeping = false;
          this.pushLog(`${member.name} has died. The outpost is short one astronaut.`, 'bad');
          this.emit({ type: 'crew-lost', crewId: member.id });
        }
      } else if (s.food > 8 && s.water > 8 && s.oxygen > 25 && member.health < 100) {
        member.health = Math.min(100, member.health + (member.sleeping ? 5 : 1.5) * hours);
      }
    }
  }

  /* ─────────────────────────── rover phase machine ─────────────────────────── */

  #updateRover(dt) {
    const s = this.state;
    const r = s.rover;
    const d = this.derived;
    d.roverStatus = this.roverStatus();
    d.roverDriving = false;

    if (r.malfunction) {
      const auto = r.autoRepair;
      // A rover that breaks mid-mission gets a physical repair: no remote
      // console progress. While the engineer is walking the fault simply waits.
      if (!auto?.active) return;
      if (auto.stage === 'travel') {
        auto.timer += dt;
        auto.progress = Math.min(1, auto.timer / ROVER.autoRepairFallback);
        if (auto.timer >= ROVER.autoRepairFallback) this.signalRoverEngineerArrived();
        return;
      }
      if (auto.stage === 'repair') {
        r.repairProgress = Math.min(1, r.repairProgress + dt / ROVER.autoRepairSeconds);
        auto.progress = r.repairProgress;
        if (r.repairProgress >= 1) this.repairRover(false, 'auto');
        return;
      }
      return;
    }

    // The repaired rover resumes its phase machine at once; the engineer's walk
    // back runs alongside it and is cleared on arrival (or by the fallback below).
    const auto = r.autoRepair;
    if (auto?.active && auto.stage === 'returning') {
      auto.timer += dt;
      if (auto.timer >= ROVER.autoRepairFallback) this.signalRoverEngineerReturned();
    }

    if (r.phase === 'idle') return;

    const roverPowered = s.systems.rover && d.powered.rover;
    const driving = r.phase === 'outbound' || r.phase === 'returning' || r.phase === 'standby';
    if (driving) {
      // a rover with no served power sits still mid-mission until the load returns
      if (!roverPowered) return;
      d.roverDriving = true;
    } else if (r.phase === 'collecting' && !roverPowered) {
      return; // the drill draws from the rover bus too
    }

    r.timeLeft -= dt;
    if (r.timeLeft > 0) return;

    const route = roverRoute(Math.max(0, r.survey));
    switch (r.phase) {
      case 'outbound':
        this.#roverPhase('collecting', ROVER.collectSeconds);
        this.pushLog(`ROVER-01 on station at ${SITES[r.survey]?.name ?? 'the site'} — drill and scan under way.`, 'info');
        break;
      case 'collecting': {
        this.#resolveProspect();
        const found = r.cargo !== null;
        this.#roverPhase('returning', route.seconds.returning);
        if (found) {
          this.pushLog(
            `ROVER-01 loaded with ${r.cargo.kg} kg of ${r.cargo.kind} — hauling to ${
              route.target === 'fuel' ? 'the FUEL-PROCESSOR' : 'AQUA-Core'
            }.`,
            'info',
          );
        }
        break;
      }
      case 'returning':
        this.#roverPhase('unloading', ROVER.unloadSeconds);
        break;
      case 'unloading': {
        // Storage only changes here, once, and the cargo is cleared in the same
        // breath — a re-entered phase can never pay out the same haul twice.
        this.#deliverCargo();
        this.#roverPhase('standby', route.seconds.standby);
        break;
      }
      case 'standby':
        r.trips += 1;
        this.#roverPhase('cooldown', ROVER.cooldownSeconds);
        this.pushLog(`ROVER-01 complete — trip ${r.trips} logged. Docking to recharge.`, 'good');
        break;
      case 'cooldown':
        r.phase = 'idle';
        r.survey = -1;
        r.mission = null;
        r.timeLeft = 0;
        r.phaseTotal = 0;
        this.emit({ type: 'rover-phase', phase: 'idle' });
        break;
      default:
        break;
    }
  }

  /**
   * The roll that decides a run. Water sites are proven ground and always yield
   * up to what is left in the deposit; the three fuel materials are prospected
   * at PROSPECT_CHANCE and a dry run genuinely carries nothing home.
   */
  #resolveProspect() {
    const s = this.state;
    const r = s.rover;
    const idx = r.survey;
    const site = SITES[idx];
    const deposit = s.sites[idx];
    if (!site || !deposit) return;

    const label = MATERIAL_LABEL[site.kind] ?? site.kind.toUpperCase();
    r.result = { kind: site.kind, site: site.name, success: false, kg: 0, sol: s.sol };

    // Cheat showcase can force the next roll; normal play leaves this null and
    // the prospect odds are exactly what they always were.
    const forced = r.forcedOutcome;
    r.forcedOutcome = null;

    if (site.kind === 'ice') {
      const kg = forced === 'dry' ? 0 : Math.round(Math.min(ROVER.iceLoadKg * site.richness, deposit.remaining));
      if (kg > 0) {
        deposit.remaining -= kg;
        r.cargo = { kind: 'ice', kg };
        r.carrying = true;
        r.result = { kind: 'ice', site: site.name, success: true, kg, sol: s.sol };
        this.pushLog(`ROVER-01 REPORT: WATER ICE SECURED. ${kg} KG IN THE HOPPER.`, 'good');
        this.emit({ type: 'rover-result', result: r.result });
        return;
      }
      this.pushLog(`ROVER-01 REPORT: ${site.name} IS EXHAUSTED. RETURNING EMPTY.`, 'warn');
      s.stats.dryTrips += 1;
      this.emit({ type: 'rover-result', result: r.result });
      return;
    }

    const hit = forced === 'success' ? true : forced === 'dry' ? false : Math.random() < PROSPECT_CHANCE;
    if (hit) {
      const kg = Math.round(ROVER.load[site.kind] * site.richness);
      deposit.remaining = Math.max(0, deposit.remaining - kg);
      r.cargo = { kind: site.kind, kg };
      r.carrying = true;
      r.result = { kind: site.kind, site: site.name, success: true, kg, sol: s.sol };
      this.pushLog(`ROVER-01 REPORT: ${label} DEPOSIT FOUND. MATERIAL SECURED.`, 'good');
    } else {
      const spent = Math.round(ROVER.load[site.kind] * 0.35);
      deposit.remaining = Math.max(0, deposit.remaining - spent);
      r.cargo = null;
      r.carrying = false;
      s.stats.dryTrips += 1;
      this.pushLog(`ROVER-01 REPORT: NO USABLE ${label} DEPOSIT FOUND. RETURNING EMPTY.`, 'warn');
    }
    this.emit({ type: 'rover-result', result: r.result });
  }

  /** Pay the cargo out into the right store — ice to AQUA, fuel stock to the plant. */
  #deliverCargo() {
    const s = this.state;
    const r = s.rover;
    const cargo = r.cargo;
    r.carrying = false;
    r.cargo = null;
    if (!cargo) return;

    if (cargo.kind === 'ice') {
      s.ice += cargo.kg;
      r.iceCollected += cargo.kg;
      s.stats.iceDelivered += cargo.kg;
      this.pushLog(`AQUA-Core took in ${cargo.kg} kg of ice for processing.`, 'good');
      this.emit({ type: 'rover-delivery', kind: 'ice', kg: cargo.kg });
      return;
    }

    const cap = FUEL.store[cargo.kind] ?? 100;
    const room = cap - s.fuel[cargo.kind];
    const stored = Math.max(0, Math.min(cargo.kg, room));
    s.fuel[cargo.kind] = clampTo(s.fuel[cargo.kind] + stored, cap);
    s.stats.materialsDelivered[cargo.kind] += cargo.kg;
    s.stats.collected[cargo.kind] += stored;
    if (stored < cargo.kg) {
      this.pushLog(
        `${cargo.kind.toUpperCase()} store is full — the FUEL-PROCESSOR could only take ${stored} of ${cargo.kg} kg.`,
        'warn',
      );
    } else {
      this.pushLog(`FUEL-PROCESSOR raw store: +${stored} kg ${cargo.kind}.`, 'good');
    }
    this.emit({ type: 'rover-delivery', kind: cargo.kind, kg: stored });
  }

  #roverPhase(phase, seconds) {
    const r = this.state.rover;
    r.phase = phase;
    r.timeLeft = seconds;
    r.phaseTotal = seconds;
    this.emit({ type: 'rover-phase', phase });
  }

  #updateFaultTimers(dt) {
    const s = this.state;
    const fx = s.fx;
    if (s.efficiencyPenalty > 0) s.efficiencyPenalty = Math.max(0, s.efficiencyPenalty - dt);
    if (s.sensorGlitch > 0) s.sensorGlitch = Math.max(0, s.sensorGlitch - dt);
    if (fx.flash > 0) fx.flash = Math.max(0, fx.flash - dt * 1.8);
    if (fx.quake > 0) fx.quake = Math.max(0, fx.quake - dt * 0.14);
  }

  #autoHarvest() {
    let beds = 0;
    let gathered = 0;
    for (let i = 0; i < this.state.plots.length; i++) {
      if (!this.state.plots[i].mature) continue;
      const amount = this.harvest(i, true);
      if (amount) {
        beds += 1;
        gathered += amount;
      }
    }
    if (beds) {
      this.pushLog(`Botanist harvested ${beds} bed${beds > 1 ? 's' : ''} — ${gathered} food stockpiled.`, 'good');
    }
  }

  #advanceClock(dt) {
    const s = this.state;
    s.elapsed += dt;
    const solIndex = Math.floor(s.elapsed / SOL_SECONDS);
    if (solIndex + 1 !== s.sol) this.#endOfSolAudit(solIndex + 1);
    s.sol = solIndex + 1;
    const withinSol = s.elapsed - solIndex * SOL_SECONDS;
    s.hour = (START_HOUR + (withinSol / SOL_SECONDS) * 24) % 24;
    this.derived.daylight = Math.max(0, Math.sin((Math.PI * (s.hour - 6)) / 12));
  }

  #updateHazards(dt) {
    const s = this.state;
    const diff = this.difficulty;

    // scripted dust storm (first one, always) — recurring storms come from events.js
    if (!s.storm.fired && s.elapsed >= CHOICES.storm.startAt) {
      s.storm.fired = true;
      this.triggerStorm(CHOICES.storm.duration);
    }
    if (s.storm.active) {
      s.storm.timeLeft -= dt;
      if (s.storm.timeLeft <= 0) {
        s.storm.active = false;
        s.storm.timeLeft = 0;
        this.pushAnnouncement('Storm has passed. Panels need cleaning.', 'good');
        this.emit({ type: 'storm-end' });
      }
    }

    // baseline random equipment failures (unchanged behaviour, routed through the shared funnel)
    if (s.elapsed >= s.nextFailureCheck) {
      s.nextFailureCheck += CHOICES.failureWindow.every;
      const candidates = ['aqua', 'o2', 'solar'].filter((id) => !s.failures[id]);
      if (candidates.length && Math.random() < diff.hazardChance) {
        const id = candidates[Math.floor(Math.random() * candidates.length)];
        this.causeEquipmentFailure(id, 'wear');
      }
    }
  }

  /** Start a dust storm of the given duration (used by the opening event and events.js). */
  triggerStorm(duration) {
    const s = this.state;
    if (s.storm.active) return false;
    s.storm.active = true;
    s.storm.timeLeft = duration;
    this.pushAnnouncement('DUST STORM inbound — solar output falling, dust build-up accelerated. Use backup power, ration loads and protect the crew.', 'warn');
    this.emit({ type: 'storm-start' });
    return true;
  }

  #applyResearch(topic) {
    if (topic.id === 'fuel') {
      this.pushLog('FUEL LICENCE GRANTED — the FUEL-PROCESSOR may now build the return propellant.', 'good');
      this.emit({ type: 'fuel-licensed' });
    }
    this.emit({ type: 'research-applied', topic });
  }

  /* ─────────────────────────── power & multipliers ─────────────────────────── */

  #recompute() {
    const s = this.state;
    const d = this.derived;

    d.efficiency = s.efficiencyPenalty > 0 ? 0.6 : 1;
    d.pressure = this.#pressureScale();

    // crew factors per post
    d.factor = { sci: 0, bio: 0, aqua: 0, o2: 0, solar: 0, hab: 0, rover: 0, fuel: 0 };
    for (const member of s.crew) {
      if (member.postId in d.factor) d.factor[member.postId] = this.crewFactor(member.postId);
    }

    const done = (id) => s.topics.find((t) => t.id === id)?.done ?? false;
    d.fuelLicensed = done('fuel');
    d.mult.solar = done('solar') ? 1.18 : 1;
    d.mult.water = done('ice') ? 1.3 : 1;
    d.mult.oxygen = done('o2') ? 1.25 : 1;
    d.mult.cropGrowth = (done('soil') ? 1.25 : 1) * (1 + 0.6 * d.factor.bio) * (s.failures.bio ? 0.3 : 1);
    d.mult.cropYield = done('crop') ? 8 : 0;

    const stormShield = done('shield') ? 0.5 : 1;
    d.stormActive = s.storm.active;
    const stormFactor = s.storm.active
      ? 1 - (this.difficulty.stormStrength * stormShield) * (s.storm.timeLeft > 8 ? 1 : s.storm.timeLeft / 8)
      : 1;

    // generation
    const solarBase = POWER.solarPeak * d.daylight * (1 - s.dust * 0.55) * d.mult.solar;
    const solarCrew = 8 * d.factor.solar;
    d.solar = (s.failures.solar ? 0 : solarBase + solarCrew) * stormFactor;
    const backup = s.backup.active ? POWER.backupUnits : 0;

    // loads the player has switched on
    // The plant only draws its stripper load once the licence is in force —
    // a cold reactor should not tax the colony's night budget.
    const requested = {
      oxygen: s.systems.oxygen,
      water: s.systems.water,
      grow: s.systems.grow,
      research: s.systems.research,
      rover: s.systems.rover,
      fuel: s.systems.fuel && done('fuel'),
    };

    // night rationing sheds non-essential loads after dark. The rover keeps its
    // power: a run stopped mid-Sol costs the colony the water it was hauling.
    const night = d.daylight <= 0.02;
    if (s.nightRationing && night) {
      requested.research = false;
      requested.grow = false;
      requested.fuel = false;
    }

    const roverDriving = !s.rover.malfunction && ['outbound', 'collecting', 'returning'].includes(s.rover.phase);
    const cost = {
      oxygen: POWER.oxygen,
      water: POWER.water,
      grow: POWER.grow,
      research: POWER.research,
      rover: POWER.rover + (roverDriving ? ROVER.travelDemand : 0),
      fuel: s.fuel.making ? POWER.fuelPlant : POWER.fuel,
    };

    let available = d.solar + backup;
    let demand = POWER.habitat;
    for (const id of Object.keys(cost)) if (requested[id]) demand += cost[id];

    const shed = [];
    if (s.battery <= 0 && demand > available) {
      for (const id of BROWNOUT_ORDER) {
        if (demand <= available) break;
        if (!requested[id]) continue;
        requested[id] = false;
        demand -= cost[id];
        shed.push(id);
      }
    }

    d.demand = demand;
    d.net = d.solar + backup - demand;
    d.shed = shed;
    d.powered = requested;

    d.oxygenProduction =
      s.systems.oxygen && d.powered.oxygen && !s.failures.o2
        ? RATES.oxygenProduction * (1 + 0.4 * d.factor.o2) * d.mult.oxygen
        : 0;
    // AQUA-Core only makes water out of ice it has been given. No hopper, no drink.
    d.iceRate =
      s.systems.water && d.powered.water && !s.failures.aqua && s.ice > WATER.minStock
        ? WATER.processingRate * (WATER.unstaffed + (1 - WATER.unstaffed) * d.factor.aqua)
        : 0;
    d.waterProduction = d.iceRate * WATER.iceToWater * d.mult.water;
    d.fuelRate = s.fuel.making ? FUEL.rate : 0;

    // starvation erodes crew effectiveness
    if (d.starving) {
      for (const key of Object.keys(d.factor)) d.factor[key] *= 0.5;
    }

    d.totalStaffed = s.crew.filter((c) => c.postId !== 'hab').length;
  }

  /** Consumption pressure that climbs through the back half of the mission. */
  #pressureScale() {
    const sol = this.state.sol;
    if (sol <= PRESSURE.fromSol) return 1;
    return Math.min(PRESSURE.max, 1 + (sol - PRESSURE.fromSol) * PRESSURE.perSol);
  }

  /* ─────────────────────────── shared failure entry ─────────────────────────── */

  /** Single funnel so every breakdown is counted, logged and de-duplicated. */
  causeEquipmentFailure(id, source) {
    const s = this.state;
    if (s.failures[id]) return false;
    s.failures[id] = true;
    s.repair[id] = 0;
    s.stats.breakdowns += 1;
    this.pushAnnouncement(`${id.toUpperCase()} failure${source ? ` — ${source}` : ''}. Assign the engineer or repair it yourself.`, 'bad');
    this.emit({ type: 'failure', id, source });
    return true;
  }

  /** Integrates the battery; kept separate so the HUD can show pre-tick numbers. */
  integrateBattery(dt) {
    const s = this.state;
    const d = this.derived;
    s.battery = Math.min(100, Math.max(0, s.battery + d.net * RATES.batteryRate * dt));
    if (s.battery <= 0.01) s.battery = 0;
  }
}
