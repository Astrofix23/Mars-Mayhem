import {
  CHOICES, FATIGUE, FUEL, MATERIAL_LABEL, MISSIONS, ROCKET, SITES, SOL_SECONDS, WATER,
} from './config.js';

const RESOURCE_DEFS = [
  { id: 'power', label: 'Power', get: (s) => s.battery, warn: 30, bad: 15 },
  { id: 'water', label: 'Water', get: (s) => s.water, warn: 35, bad: 20 },
  { id: 'oxygen', label: 'O₂', get: (s) => s.oxygen, warn: 45, bad: 25 },
  { id: 'food', label: 'Food', get: (s) => s.food, warn: 35, bad: 20 },
];

/** kg of each feedstock a full return load needs — the same numbers the sim gates on. */
const materialNeed = () => ({
  carbon: FUEL.recipe.carbon * ROCKET.capacity,
  oxygen: FUEL.recipe.oxygen * ROCKET.capacity,
  hydrogen: FUEL.recipe.hydrogen * ROCKET.capacity,
});

const fmtPct = (v) => `${Math.round(v)}%`;
const fmtRate = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}/s`;
const iceInField = (s) => s.sites.reduce((t, d, i) => t + (SITES[i].kind === 'ice' ? d.remaining : 0), 0);

/** Heads-up display: resources, sol clock, warnings, objectives, log and prompts. */
export class Hud {
  constructor({ sim, player, colony, rover = null, audio, onSpeed, onLock, isLocked }) {
    this.sim = sim;
    this.player = player;
    this.colony = colony;
    this.rover = rover;
    this.audio = audio;
    this.onSpeed = onSpeed;
    this.onLock = onLock;
    this.isLocked = isLocked;
    this.lastLogKey = '';
    this.lastPrompt = '';
    this.lastBannerKey = '';
    this.lastLockShown = null;
    this.lastForecastKey = '';
    this.emergency = false;
    this.emergencyResources = [];

    this.el = {
      hud: document.getElementById('hud'),
      strip: document.getElementById('resource-strip'),
      mission: document.getElementById('mission-strip'),
      sol: document.getElementById('sol-value'),
      clock: document.getElementById('clock-value'),
      daybar: document.getElementById('daybar-fill'),
      speed: document.getElementById('speed-btn'),
      cpms: document.getElementById('cpms-chip'),
      lock: document.getElementById('lock-btn'),
      emergency: document.getElementById('emergency-alert'),
      reticle: document.getElementById('reticle'),
      panelRoot: document.getElementById('panel-root'),
      banner: document.getElementById('warning-banner'),
      objectiveTitle: document.getElementById('objective-title'),
      objectiveList: document.getElementById('objective-list'),
      log: document.getElementById('log-card'),
      interaction: document.getElementById('interaction'),
      interactionLabel: document.getElementById('interaction-label'),
      repair: document.getElementById('repair-strip'),
      repairFill: document.getElementById('repair-fill'),
      repairLabel: document.getElementById('repair-label'),
      roverChip: document.getElementById('rover-chip'),
      roverStatus: document.getElementById('rover-status'),
      results: document.getElementById('results-screen'),
      fc: document.getElementById('env-forecast'),
      fcCpms: document.getElementById('fc-cpms'),
      fcStatus: document.getElementById('fc-status'),
      fcIdle: document.getElementById('fc-idle'),
      fcActive: document.getElementById('fc-active'),
      fcCode: document.getElementById('fc-code'),
      fcSeverity: document.getElementById('fc-severity'),
      fcCountdown: document.getElementById('fc-countdown'),
      fcHeadline: document.getElementById('fc-headline'),
      fcImpact: document.getElementById('fc-impact'),
      fcAction: document.getElementById('fc-action'),
      fcQueue: document.getElementById('fc-queue'),
    };

    this.cards = new Map();
    this.#buildCards();
    this.#buildMissionCards();
    this.el.speed.addEventListener('click', () => this.onSpeed?.());
    this.el.lock?.addEventListener('click', () => this.onLock?.());
  }

  show() {
    this.el.hud.classList.remove('is-hidden');
  }

  #buildCards() {
    for (const def of RESOURCE_DEFS) {
      const card = document.createElement('div');
      card.className = 'res';
      card.innerHTML = `
        <div class="res-label"><span>${def.label}</span><span class="res-value">—</span></div>
        <div class="res-meter"><i></i></div>
        <div class="res-note"></div>`;
      this.el.strip.appendChild(card);
      this.cards.set(def.id, {
        root: card,
        value: card.querySelector('.res-value'),
        fill: card.querySelector('.res-meter > i'),
        note: card.querySelector('.res-note'),
      });
    }

    const research = document.createElement('div');
    research.className = 'res';
    research.innerHTML = `
      <div class="res-label"><span>Research</span><span class="res-value">0/6</span></div>
      <div class="res-meter"><i></i></div>
      <div class="res-note">no active topic</div>`;
    this.el.strip.appendChild(research);
    this.cards.set('research', {
      root: research,
      value: research.querySelector('.res-value'),
      fill: research.querySelector('.res-meter > i'),
      note: research.querySelector('.res-note'),
    });
  }

  /**
   * The journey-home strip: the feedstocks, the propellant line, the rocket and
   * the crew-rest budget. Split from the life-support strip so the two clocks of
   * the mission — stay alive, and get off the planet — read separately.
   */
  #buildMissionCards() {
    const root = this.el.mission;
    if (!root) return;
    this.missionCards = new Map();
    const defs = [
      { id: 'ice', label: 'Ice' },
      { id: 'carbon', label: 'Carbon' },
      { id: 'fuelO2', label: 'O₂ (fuel)' },
      { id: 'hydrogen', label: 'H₂' },
      { id: 'tank', label: 'Plant' },
      { id: 'rocket', label: 'M3' },
      { id: 'rest', label: 'Crew rest' },
    ];
    for (const def of defs) {
      const card = document.createElement('div');
      card.className = 'res res-mission';
      card.innerHTML = `
        <div class="res-label"><span>${def.label}</span><span class="res-value">—</span></div>
        <div class="res-meter"><i></i></div>
        <div class="res-note"></div>`;
      root.appendChild(card);
      this.missionCards.set(def.id, {
        root: card,
        value: card.querySelector('.res-value'),
        fill: card.querySelector('.res-meter > i'),
        note: card.querySelector('.res-note'),
      });
    }
  }

  #renderMission() {
    if (!this.missionCards) return;
    const s = this.sim.state;
    const d = this.sim.derived;
    const need = materialNeed();

    const set = (id, pct, value, note, cls) => {
      const card = this.missionCards.get(id);
      card.value.textContent = value;
      card.fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
      card.note.textContent = note;
      card.root.classList.toggle('warn', cls === 'warn');
      card.root.classList.toggle('bad', cls === 'bad');
    };

    const fieldLeft = iceInField(s);
    set(
      'ice',
      (s.ice / WATER.hopper) * 100,
      `${Math.round(s.ice)} kg`,
      `${fieldLeft.toFixed(0)} kg ice left in the field`,
      s.ice < 12 ? 'bad' : s.ice < 60 ? 'warn' : '',
    );

    const licensed = this.sim.fuelLicensed();
    for (const [id, kind] of [['carbon', 'carbon'], ['fuelO2', 'oxygen'], ['hydrogen', 'hydrogen']]) {
      const have = s.fuel[kind];
      const short = have < FUEL.recipe[kind] * 2;
      set(
        id,
        (have / need[kind]) * 100,
        `${Math.round(have)} kg`,
        `${Math.round((have / need[kind]) * 100)}% of a load · store ${FUEL.store[kind]}`,
        !licensed || short ? (short && licensed ? 'bad' : 'warn') : '',
      );
    }
    set(
      'tank',
      s.fuel.percent,
      fmtPct(s.fuel.percent),
      s.fuel.making
        ? `line running ${d.fuelRate ? d.fuelRate.toFixed(2) : '0.00'}%/s`
        : s.fuel.interrupted > 0
          ? 'interrupted — feedstock short'
          : licensed
            ? 'line idle'
            : 'no fuel licence',
      s.fuel.interrupted > 0 ? 'warn' : '',
    );

    set(
      'rocket',
      s.rocket.percent,
      fmtPct(s.rocket.percent),
      s.rocket.launched
        ? 'M3 away'
        : s.rocket.transferring
          ? `transfer ${Math.ceil(s.rocket.transferLeft)} s`
          : s.rocket.percent >= ROCKET.capacity
            ? 'tanks full'
            : 'not loaded',
      s.rocket.percent >= ROCKET.capacity ? '' : s.rocket.transferring ? 'warn' : '',
    );

    const roster = this.sim.crewRoster().filter((c) => c.alive);
    const rested = roster.filter((c) => c.sleptHours >= FATIGUE.requiredRestHours).length;
    const worst = roster.reduce((m, c) => (m === null || c.fatigue > m.fatigue ? c : m), null);
    set(
      'rest',
      (rested / Math.max(1, this.sim.crewRoster().length)) * 100,
      `${rested}/${this.sim.crewRoster().length}`,
      worst
        ? `${worst.name.split(' ')[0]} ${Math.round(worst.fatigue)}% fatigue · ${FATIGUE.requiredRestHours} h/Sol`
        : 'no crew',
      worst && worst.fatigue >= FATIGUE.severe ? 'bad' : worst && worst.fatigue >= FATIGUE.moderate ? 'warn' : '',
    );
  }

  render() {
    const sim = this.sim;
    const s = sim.state;
    const d = sim.derived;

    for (const def of RESOURCE_DEFS) {
      const card = this.cards.get(def.id);
      const value = def.get(s);
      card.value.textContent = fmtPct(value);
      card.fill.style.width = `${Math.max(0, Math.min(100, value))}%`;
      card.root.classList.toggle('warn', value < def.warn && value >= def.bad);
      card.root.classList.toggle('bad', value < def.bad);
    }

    const power = this.cards.get('power');
    if (d.shed.length) {
      power.note.textContent = `shed: ${d.shed.join(', ')}`;
    } else {
      power.note.textContent = `${d.net >= 0 ? '+' : ''}${d.net.toFixed(0)} net · solar ${d.solar.toFixed(0)}`;
    }

    const water = this.cards.get('water');
    const flow = d.flow ?? { oxygen: 0, water: 0, food: 0 };
    water.note.textContent = `${fmtRate(flow.water)} · melt ${d.waterProduction.toFixed(2)}/s`;

    const oxygen = this.cards.get('oxygen');
    oxygen.note.textContent = `${fmtRate(flow.oxygen)} · ${d.oxygenProduction > 0 ? 'producing' : 'plant idle'}`;

    const food = this.cards.get('food');
    const ready = s.plots.filter((p) => p.mature).length;
    food.note.textContent = `${fmtRate(flow.food)} · ${ready} ready`;

    const research = this.cards.get('research');
    const done = sim.completedTopics();
    research.value.textContent = `${done}/${s.topics.length}`;
    const active = s.topics.find((t) => t.id === s.activeTopic);
    research.fill.style.width = `${active ? (active.progress / active.cost) * 100 : (done / s.topics.length) * 100}%`;
    research.note.textContent = active ? `${active.name} ${Math.round((active.progress / active.cost) * 100)}%` : 'no active topic';
    research.root.classList.toggle('warn', Boolean(s.activeTopic) && !d.powered.research);

    // sol clock
    this.el.sol.textContent = String(s.sol);
    const hh = String(Math.floor(s.hour)).padStart(2, '0');
    const mm = String(Math.floor((s.hour % 1) * 60)).padStart(2, '0');
    const clockText = `${hh}:${mm}`;
    if (this.el.clock.textContent !== clockText) this.el.clock.textContent = clockText;
    this.el.daybar.style.width = `${((s.elapsed % SOL_SECONDS) / SOL_SECONDS) * 100}%`;
    this.el.speed.textContent = `${s.speed}×`;

    this.#renderMission();
    this.#renderCpms();
    this.#renderWarnings();
    this.#renderForecast();
    this.#renderObjectives();
    this.#renderRover();
    this.#renderLog();
    this.#renderPrompt();
    this.#renderRepair();
    this.#renderLock();
    this.#renderEmergency();
  }

  refreshComms() {
    this.lastForecastKey = '';
    this.lastBannerKey = '';
    this.#renderCpms();
    this.#renderWarnings();
    this.#renderForecast();
    this.#renderLog();
  }

  /** Set by the loop from the music latches: a reserve is in the critical band. */
  setEmergency(active, resources = []) {
    this.emergency = Boolean(active);
    this.emergencyResources = resources;
  }

  #renderEmergency() {
    const el = this.el.emergency;
    if (!el) return;
    el.hidden = !this.emergency;
    if (this.emergency) {
      const label = this.emergencyResources
        .map((key) => (key === 'battery' ? 'POWER' : key.toUpperCase()))
        .join(' · ');
      el.title = label ? `Critical survival alert — ${label}` : 'Critical survival alert';
    }
  }

  /** Shift Lock readout: the chip tells you which camera you are driving. */
  #renderLock() {
    const on = Boolean(this.isLocked?.());
    const panelUp = Boolean(this.el.panelRoot) && !this.el.panelRoot.classList.contains('is-hidden');

    if (this.el.reticle) this.el.reticle.hidden = !(on && !panelUp);
    if (on === this.lastLockShown || !this.el.lock) return;
    this.lastLockShown = on;
    this.el.lock.textContent = on ? 'SHIFT LOCK ON' : 'SHIFT LOCK OFF';
    this.el.lock.classList.toggle('is-on', on);
    this.el.lock.setAttribute('aria-pressed', String(on));
  }

  /**
   * ROVER-01 status plus the last prospect report, so the 40% roll is legible
   * from the field rather than only inside the console.
   */
  #renderRover() {
    const chip = this.el.roverChip;
    if (!chip) return;
    const r = this.sim.state.rover;
    const status = this.sim.roverStatus();
    const pct = this.sim.roverActive() ? Math.round(this.sim.roverProgress() * 100) : 0;
    const mission = r.mission ? MISSIONS.find((m) => m.kind === r.mission)?.label ?? MATERIAL_LABEL[r.mission] : '';
    const parts = [];
    if (mission) parts.push(mission);
    parts.push(status);
    if (this.sim.roverActive()) parts.push(`${pct}%`);
    if (r.malfunction && r.autoRepair?.active) {
      parts.push(r.autoRepair.stage === 'repair'
        ? `repair ${Math.round((r.repairProgress ?? 0) * 100)}%`
        : 'engineer en route');
    }
    if (r.cargo) parts.push(`${r.cargo.kg} kg`);
    if (r.result) parts.push(r.result.success ? `${r.result.kg} kg secured` : 'returned empty');
    this.el.roverStatus.textContent = `${parts.join(' · ')} · ${r.trips} trip${r.trips === 1 ? '' : 's'}`;
    chip.hidden = false;
    chip.classList.toggle('bad', r.malfunction);
    chip.classList.toggle('busy', this.sim.roverActive() && !r.malfunction);
  }

  /** The CPMS chip: the one line that tells the crew whether announcements flow. */
  #renderCpms() {
    const el = this.el.cpms;
    if (!el) return;
    const c = this.sim.state.cpms;
    const offline = c?.online === false;
    const status = this.sim.cpmsStatus();
    const text = `COMS // ${status}`;
    if (el.textContent !== text) el.textContent = text;
    el.dataset.state = !offline ? 'online' : c.repairing ? 'restoring' : 'offline';
    el.title = offline
      ? c.repairing
        ? `COMS repair under way at COMMS-TOWER — ${Math.round((c.repairProgress ?? 0) * 100)}%`
        : 'COMS offline — repair at COMMS-TOWER to restore announcements'
      : 'COMS online — NASA DONKI, environmental forecasts and HUD warnings are connected';
  }

  #renderWarnings() {
    const warnings = this.sim.warnings();
    if (!warnings.length) {
      this.el.banner.hidden = true;
      this.el.banner.textContent = '';
      this.lastBannerKey = '';
      return;
    }
    const ordered = [
      ...warnings.filter((w) => w.level === 'bad'),
      ...warnings.filter((w) => w.level === 'storm'),
      ...warnings.filter((w) => w.level === 'warn'),
      ...warnings.filter((w) => w.level === 'forecast'),
    ];
    const top = ordered[0];
    this.el.banner.hidden = false;
    this.el.banner.textContent = top.text;
    this.el.banner.classList.toggle('storm', top.level === 'storm' && !top.spaceWeather);
    this.el.banner.classList.toggle('solar', Boolean(top.spaceWeather));
    this.el.banner.classList.toggle('forecast', top.level === 'forecast');
    this.el.banner.classList.toggle('cpms', Boolean(top.cpms));
    if (top.spaceWeather) this.el.banner.dataset.level = top.tone;
    else if (top.level === 'forecast') this.el.banner.dataset.level = String(top.severity ?? 'low').toLowerCase();
    else delete this.el.banner.dataset.level;

    // Restart the entry flash only when the banner actually changes. The forecast
    // countdown updates every second, so its key tracks the hazard, not the clock.
    const key = top.level === 'forecast'
      ? `forecast|${top.code ?? ''}|${top.severity ?? ''}`
      : `${top.level}|${top.text}`;
    if (key !== this.lastBannerKey) {
      this.lastBannerKey = key;
      this.el.banner.classList.remove('banner-flash');
      void this.el.banner.offsetWidth;
      this.el.banner.classList.add('banner-flash');
    }
  }

  /**
   * The offline environmental forecast panel. The countdown is derived from
   * sim.state.elapsed, so it stops with a pause and runs at the chosen 1×/2×/4×
   * speed without any extra clock of its own.
   */
  #renderForecast() {
    const root = this.el.fc;
    if (!root) return;
    const idle = this.el.fcIdle;
    const active = this.el.fcActive;
    const status = this.el.fcStatus;

    // No CPMS means no delivery: the forecast may still be counting down in the
    // simulation, but the crew cannot hear it.
    if (this.sim.state.cpms?.online === false) {
      const offlineKey = `cpms|${this.sim.cpmsStatus()}`;
      if (offlineKey === this.lastForecastKey) return;
      this.lastForecastKey = offlineKey;
      root.dataset.severity = 'none';
      root.dataset.cpms = 'offline';
      status.textContent = 'COMS // OFFLINE';
      status.dataset.state = 'offline';
      idle.hidden = true;
      active.hidden = true;
      if (this.el.fcCpms) this.el.fcCpms.hidden = false;
      if (this.el.fcQueue) this.el.fcQueue.hidden = true;
      return;
    }

    root.dataset.cpms = 'online';
    if (this.el.fcCpms) this.el.fcCpms.hidden = true;

    const fc = this.sim.environmentForecast?.() ?? { status: 'clear', active: [] };
    const key = fc.status === 'forecast'
      ? `f|${fc.id}|${Math.ceil(fc.dueIn)}|${fc.severity}|${fc.others?.length ?? 0}`
      : fc.status === 'active'
        ? `a|${fc.active.map((a) => a.kind).join(',')}`
        : 'clear';
    if (key === this.lastForecastKey) return;
    this.lastForecastKey = key;

    if (fc.status === 'forecast') {
      const severity = String(fc.severity ?? 'LOW');
      root.dataset.severity = severity.toLowerCase();
      idle.hidden = true;
      active.hidden = false;
      status.textContent = `${severity} RISK`;
      status.dataset.state = severity.toLowerCase();
      this.#setText(this.el.fcCode, fc.code);
      this.#setText(this.el.fcSeverity, `${severity} · ${fc.confidence}`);
      this.#setText(this.el.fcCountdown, `00:${String(Math.max(0, Math.ceil(fc.dueIn))).padStart(2, '0')}`);
      this.#setText(this.el.fcHeadline, fc.headline);
      this.#setText(this.el.fcImpact, fc.systems);
      this.#setText(this.el.fcAction, fc.action);
      const others = fc.others ?? [];
      this.el.fcQueue.hidden = !others.length;
      if (others.length) {
        this.el.fcQueue.textContent = `ALSO TRACKING: ${others
          .map((o) => `${o.code} · ${Math.ceil(o.dueIn)} s`)
          .join(' · ')}`;
      }
      return;
    }

    if (fc.status === 'active') {
      root.dataset.severity = 'active';
      idle.hidden = false;
      active.hidden = true;
      status.textContent = 'HAZARD ACTIVE';
      status.dataset.state = 'active';
      this.#setText(
        idle,
        `EVENT UNDERWAY — ${fc.active.map((a) => a.code).join(' · ')}. Monitor colony telemetry.`,
      );
      return;
    }

    root.dataset.severity = 'none';
    idle.hidden = false;
    active.hidden = true;
    status.textContent = 'MODEL ONLINE';
    status.dataset.state = 'clear';
    this.#setText(idle, 'NO IMMEDIATE ENVIRONMENTAL THREATS DETECTED.');
  }

  #setText(element, value) {
    if (element && element.textContent !== value) element.textContent = value;
  }

  /**
   * The ten conditions live in `sim.missionReadiness()`; the card shows the score
   * and the next things outstanding, newest-priority by story order. Surviving
   * ten Sols is one line of ten, not the win condition.
   */
  #renderObjectives() {
    const board = this.sim.missionReadiness();
    const doneCount = board.filter((c) => c.done).length;
    const outstanding = board.filter((c) => !c.done && c.id !== 'launch');
    const shown = outstanding.slice(0, 4);

    this.el.objectiveTitle.textContent = `Journey home · ${doneCount} of ${board.length}`;

    const s = this.sim.state;
    const oxygenLine = { label: `Keep oxygen above zero · ${Math.round(s.oxygen)}%`, done: false, bad: s.oxygen <= 0 };
    const lines = shown.length
      ? shown.map((c) => ({ label: `${c.label} · ${c.detail}`, done: false }))
      : [{ label: 'All objectives met — get to the LAUNCH-SITE', done: true }];

    const items = [...lines, oxygenLine];
    this.el.objectiveList.innerHTML = items
      .map((item) => `<li class="${item.done ? 'done' : ''}${item.bad ? ' bad' : ''}">${item.label}</li>`)
      .join('');
  }

  #renderLog() {
    const log = this.sim.state.log;
    const offline = !this.sim.cpmsOnline();
    const key = `${offline}:${log.length}:${log[0]?.text ?? ''}`;
    if (key === this.lastLogKey) return;
    this.lastLogKey = key;
    const shown = offline ? [{ kind: 'bad', text: this.sim.warnings()[0].text }] : log;
    this.el.log.innerHTML = shown
      .slice(0, 5)
      .map((entry) => `<div class="log-line ${entry.kind}">${entry.text.replace(/\bCPMS\b/g, 'COMS')}</div>`)
      .join('');
  }

  #renderPrompt() {
    let text = '';
    let key = '';

    // The rover drives away from its pad, so proximity is checked live.
    const r = this.sim.state.rover;
    if (this.rover && r.malfunction) {
      const d = Math.hypot(
        this.player.position.x - this.rover.position.x,
        this.player.position.z - this.rover.position.z,
      );
      if (d < 10) {
        text = 'ROVER-01 disabled here — press E to start the repair';
        key = 'rover-repair';
      }
    }

    if (!text) {
      const nearest = this.player.nearestFacility();
      if (nearest) {
        text = `${nearest.code} — ${nearest.name}`;
        key = `facility:${nearest.id}`;
      }
    }

    if (key === this.lastPrompt) return;
    this.lastPrompt = key;
    if (!text) {
      this.el.interaction.hidden = true;
      return;
    }
    this.el.interaction.hidden = false;
    this.el.interactionLabel.textContent = text;
  }

  #renderRepair() {
    const repair = this.player.repair;
    if (!repair) {
      this.el.repair.hidden = true;
      return;
    }
    this.el.repair.hidden = false;
    this.el.repairFill.style.width = `${Math.min(100, repair.progress * 100)}%`;
    this.el.repairLabel.textContent = `Repairing ${repair.id.toUpperCase()} · ${Math.round(repair.progress * 100)}%`;
  }

  hidePrompt() {
    this.el.interaction.hidden = true;
    this.lastPrompt = '';
  }

  showResults(sim, victory) {
    const s = sim.state;
    const rover = s.rover;
    const solsSurvived = Math.min(CHOICES.successSol, s.elapsed / SOL_SECONDS);
    const board = sim.missionReadiness();
    const doneCount = board.filter((c) => c.done).length;
    const roster = sim.crewRoster();
    const crewAlive = roster.filter((c) => c.alive).length;
    const need = materialNeed();

    document.getElementById('results-eyebrow').textContent = victory
      ? 'MARS MAYHEM · mission report · return window'
      : 'MARS MAYHEM · mission report · outpost lost';
    document.getElementById('results-title').textContent = victory
      ? 'MISSION SUCCESSFUL'
      : 'MISSION FAILED — THE CREW DID NOT SURVIVE.';
    document.getElementById('results-summary').textContent = victory
      ? 'FOUR ASTRONAUTS. ONE COLONY. ONE JOURNEY HOME. M3 left the pad with '
        + `${solsSurvived.toFixed(1)} sols of Mars behind it and ${sim.completedTopics()} research topics in the book. `
        + `ROVER-01 logged ${rover.trips} trip(s) and ${s.stats.dryTrips} came back empty.`
      : `${s.flags.failureReason || 'The outpost could not be sustained.'} `
        + `You made it to sol ${solsSurvived.toFixed(1)} of ${CHOICES.successSol} with ${doneCount}/${board.length} `
        + 'journey-home objectives cleared and the propellant load at '
        + `${s.rocket.percent.toFixed(0)}%.`;

    const stats = [
      ['Sols survived', `${solsSurvived.toFixed(1)} / ${CHOICES.successSol}`],
      ['Crew alive', `${crewAlive} / ${roster.length}`],
      ['Crew status', roster.map((c) => (c.alive ? `${c.name.split(' ')[0]} ${Math.round(c.fatigue)}%` : `${c.name.split(' ')[0]} lost`)).join(' · ')],
      ['Research completed', `${sim.completedTopics()} / ${CHOICES.successResearch} needed`],
      ['Fuel licence', sim.fuelLicensed() ? 'granted' : 'not licensed'],
      ['Propellant made', `${s.fuel.percent.toFixed(0)}% / ${ROCKET.capacity}%`],
      ['Rocket load (M3)', `${s.rocket.percent.toFixed(0)}% / ${ROCKET.capacity}%`],
      ['Carbon collected', `${Math.round(s.stats.collected.carbon)} / ${Math.round(need.carbon)} kg`],
      ['Oxygen collected', `${Math.round(s.stats.collected.oxygen)} / ${Math.round(need.oxygen)} kg`],
      ['Hydrogen collected', `${Math.round(s.stats.collected.hydrogen)} / ${Math.round(need.hydrogen)} kg`],
      ['Ice hauled', `${rover.iceCollected} kg · ${iceInField(s).toFixed(0)} kg left in the field`],
      ['Final oxygen', fmtPct(s.oxygen)],
      ['Final water', fmtPct(s.water)],
      ['Final food', fmtPct(s.food)],
      ['Final power reserve', fmtPct(s.battery)],
      ['Journey-home objectives', `${doneCount} / ${board.length}`],
      ['Events encountered', `${s.events.encountered}`],
      ['Breakdowns', `${s.stats.breakdowns}`],
      ['Repairs made', `${s.stats.repairs}`],
      ['Missed rest windows', `${s.stats.missedRest}`],
      ['Crops harvested', `${s.stats.harvests}`],
      ['Rover trips', `${rover.trips}`],
    ];
    document.getElementById('results-stats').innerHTML = stats
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
      .join('');

    const rating = this.#grade(s, sim, solsSurvived, board);
    const card = document.getElementById('results-grade');
    if (card) {
      card.textContent = rating.grade;
      card.className = `results-grade ${rating.tone}`;
      document.getElementById('results-grade-note').textContent = rating.line;
    }

    this.el.results.classList.add('is-open');
    this.el.hud.classList.add('is-hidden');
  }

  /** A single legible verdict on how the mission went, from the same board the launch console reads. */
  #grade(s, sim, solsSurvived, board) {
    const doneCount = board.filter((c) => c.done).length;
    const score = doneCount / board.length;

    if (s.flags.failed) {
      const lost = sim.crewRoster().filter((c) => !c.alive).map((c) => c.name);
      return {
        grade: 'MISSION FAILED',
        tone: 'bad',
        line: lost.length
          ? `${lost.join(' and ')} did not come home. The colony runs on four people, and life support is the one hard floor.`
          : `Life support failed on sol ${solsSurvived.toFixed(1)}. Oxygen is the only instant loss condition — everything else is a slow squeeze.`,
      };
    }
    if (s.rocket.launched) {
      return {
        grade: 'A · HOME',
        tone: 'good',
        line: 'Ten objectives cleared, M3 fuelled and transferred, and the rocket left the pad with everyone who boarded it. This outpost keeps running without you.',
      };
    }
    if (score >= 0.8) {
      return {
        grade: 'B · SO CLOSE',
        tone: 'warn',
        line: `Eight of the ten journey-home conditions are met. Load the M3 and launch — the return window does not stay open forever.`,
      };
    }
    if (score >= 0.5) {
      return {
        grade: 'C · SURVIVED',
        tone: 'warn',
        line: 'The crew is alive and the science is banked, but the propellant chain is unfinished. Surviving ten Sols was never the way off the planet.',
      };
    }
    return {
      grade: 'D · STRANDED',
      tone: 'warn',
      line: 'The outpost is still standing on reserves alone. Without the fuel licence, the feedstocks and the launch, this run ends in dust.',
    };
  }
}
