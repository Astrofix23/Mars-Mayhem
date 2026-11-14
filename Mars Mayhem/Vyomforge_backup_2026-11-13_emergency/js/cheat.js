import { DIFFICULTIES, FUEL, MISSIONS, ROCKET, SITES } from './config.js';
import { ROVER_STATUS } from './simulation.js';
import { playIntro } from './intro.js';
import { playOutro } from './outro.js';

/**
 * CHEAT CODE MODE — the mission-control override console.
 *
 * A permanently visible, non-modal dock: the simulation keeps running while it
 * is open, so triggered events, rover runs and the propellant chain can be
 * watched live. Every button routes into the existing simulation / event
 * director / cinematic APIs — nothing here duplicates a game system, and the
 * mode never writes a save (see save.js and main.js).
 */

const EVENT_INFO = [
  { id: 'dust_devil', name: 'Dust Devil', desc: 'A spinning column crosses the array field — visibility drops and the panels soil fast.' },
  { id: 'dust_storm', name: 'Dust Storm', desc: 'Colony-wide storm. Solar output collapses and the battery carries the load.' },
  { id: 'greenhouse', name: 'Greenhouse Fault', desc: 'BIO-Dome irrigation, temperature or lighting fails — crop growth crawls.' },
  { id: 'rover_breakdown', name: 'Rover Breakdown', desc: 'ROVER-01 faults and stops dead. Repair it here, or walk over with the EVA kit.' },
  { id: 'marsquake', name: 'Marsquake', desc: 'A seismic tremor shakes the ground — it may break a facility or glitch the sensors.' },
  { id: 'seal', name: 'Seal Malfunction', desc: 'An external seal bleeds oxygen until a crew member or you re-press it.' },
  { id: 'radiation', name: 'Solar Radiation', desc: 'Warning phase, then a particle peak. Shelter the crew or they take the dose.' },
  { id: 'meteorite', name: 'Meteorite Impact', desc: 'A tracked body falls for 16 s, then craters the surface — facilities can be hit.' },
  { id: 'equipment', name: 'Random Equipment Failure', desc: 'Wear-and-tear breakdown on AQUA-Core, O2-MOXIE or the SOLAR-Grid.' },
];

const TABS = [
  { id: 'home', label: 'HOME' },
  { id: 'events', label: 'EVENTS' },
  { id: 'films', label: 'FILMS' },
  { id: 'survive', label: 'SURVIVAL' },
  { id: 'rover', label: 'ROVER' },
  { id: 'rocket', label: 'ROCKET' },
  { id: 'time', label: 'TIME' },
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const pad2 = (n) => String(n).padStart(2, '0');
const fmtClock = (hour) => `${pad2(Math.floor(hour))}:${pad2(Math.floor((hour % 1) * 60))}`;

export class CheatConsole {
  constructor(hooks) {
    this.hooks = hooks;
    this.sim = hooks.sim;
    this.audio = hooks.audio;
    this.hud = hooks.hud;
    this.tab = 'home';
    this.pins = { life: false, power: false, research: false };
    this.film = null;
    this.filmHandle = null;
    this.filmStart = 0;
    this.playedIntro = false;
    this.playedOutro = false;
    this.refreshTimer = 0;

    this.root = document.getElementById('cheat-dock');
    this.root.innerHTML = this.#shell();
    this.body = this.root.querySelector('#cheat-body');
    this.root.addEventListener('click', (event) => this.#onClick(event));
  }

  /** Show the dock on a tab. Entering via the Survival Sandbox option pins reserves on. */
  open(tab = 'home', { sandbox = false } = {}) {
    if (sandbox) this.pins = { life: true, power: true, research: true };
    this.root.classList.remove('is-hidden');
    this.setTab(tab);
  }

  setTab(tab) {
    this.tab = TABS.some((t) => t.id === tab) ? tab : 'home';
    for (const btn of this.root.querySelectorAll('[data-tab]')) {
      btn.classList.toggle('on', btn.dataset.tab === this.tab && btn.classList.contains('cheat-tab'));
    }
    this.body.innerHTML = this.#renderTab();
    this.body.scrollTop = 0;
    this.applyLive();
  }

  /** Called every frame by the main loop: survival pins + a 5 Hz live refresh. */
  update(dt) {
    const s = this.sim.state;
    if (this.pins.life) { s.oxygen = 100; s.water = 100; s.food = 100; }
    if (this.pins.power) s.battery = 100;
    if (this.pins.research) s.researchPoints = Math.max(s.researchPoints, 9999);
    this.refreshTimer += dt;
    if (this.refreshTimer >= 0.2) {
      this.refreshTimer = 0;
      this.applyLive();
    }
  }

  /* ─────────────────────────────── shell ─────────────────────────────── */

  #shell() {
    return `
      <div class="cheat-head">
        <div class="cheat-title-row">
          <svg class="cheat-logo" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="2" y="4" width="20" height="16" rx="3" stroke="currentColor" stroke-width="1.6"/>
            <path d="M6 9l3 3-3 3M11 15h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M17 2l-2 4h3l-2 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <div class="cheat-title-block">
            <div class="cheat-title">CHEAT CODE MODE</div>
            <div class="cheat-sub"><span data-live="h-state">SANDBOX LIVE</span> · <span data-live="h-sol">SOL 1</span> · <span data-live="h-clock">08:00</span></div>
          </div>
          <button class="cheat-icon-btn" data-cheat-action="collapse" title="Collapse / expand the console">–</button>
        </div>
        <div class="cheat-controls">
          <button class="cheat-ctl" data-cheat-action="pause"><span data-live="pause-label">PAUSE</span></button>
          <button class="cheat-ctl" data-cheat-action="speed" title="Cycle simulation speed"><span data-live="speed-label">1×</span></button>
          <button class="cheat-ctl" data-cheat-action="mute"><span data-live="sound-label">SOUND ON</span></button>
          <button class="cheat-ctl danger" data-cheat-action="exit" title="Back to difficulty selection">EXIT</button>
        </div>
      </div>
      <nav class="cheat-tabs">
        ${TABS.map((t) => `<button class="cheat-tab" data-tab="${t.id}">${t.label}</button>`).join('')}
      </nav>
      <div class="cheat-body" id="cheat-body"></div>
      <div class="cheat-foot">SAVING DISABLED · NORMAL OUTPOST UNTOUCHED</div>
    `;
  }

  #onClick(event) {
    const tabBtn = event.target.closest('[data-tab]');
    if (tabBtn && this.root.contains(tabBtn)) {
      this.setTab(tabBtn.dataset.tab);
      this.audio.ui();
      tabBtn.blur();
      return;
    }
    const btn = event.target.closest('[data-cheat-action]');
    if (!btn || btn.disabled || !this.root.contains(btn)) return;
    this.#action(btn.dataset.cheatAction, btn);
    btn.blur();
  }

  /* ─────────────────────────────── actions ─────────────────────────────── */

  #action(action, el) {
    const sim = this.sim;
    const s = sim.state;
    switch (action) {
      case 'collapse': {
        const collapsed = this.root.classList.toggle('collapsed');
        el.textContent = collapsed ? '+' : '–';
        break;
      }
      case 'pause': this.hooks.onTogglePause(); break;
      case 'speed': this.hooks.onSpeed(); break;
      case 'mute': this.hooks.onMute(); break;
      case 'exit': this.hooks.onExit(); break;

      case 'event': this.#triggerEvent(el.dataset.kind); break;
      case 'random-event': this.#triggerEvent(pick(EVENT_INFO).id); break;

      case 'play-film': this.#playFilm(el.dataset.film); break;
      case 'skip-film': this.filmHandle?.skip(); break;
      case 'return-film': this.#closeFilm(); break;
      case 'replay-ending': this.#playFilm('outro'); break;

      case 'toggle-pin': {
        const key = el.dataset.pin;
        this.pins[key] = !this.pins[key];
        sim.pushLog(`Cheat code: ${{ life: 'life-support reserves', power: 'unlimited power', research: 'unlimited research points' }[key]} ${this.pins[key] ? 'ON' : 'OFF'}.`, 'info');
        break;
      }
      case 'unlock-all': for (const t of s.topics) sim.completeTopic(t.id); break;
      case 'licence': sim.completeTopic('fuel'); break;
      case 'restore-crew': sim.restoreCrew(); break;

      case 'dispatch': {
        const idx = sim.bestSiteFor(el.dataset.kind);
        if (idx >= 0) sim.dispatchRover(idx);
        else sim.pushLog('No workable deposit left for that mission — top the stores up from the Rocket showcase.', 'warn');
        break;
      }
      case 'force-success':
        s.rover.forcedOutcome = 'success';
        sim.pushLog('Cheat code: the next prospect roll will strike a deposit.', 'info');
        break;
      case 'force-dry':
        s.rover.forcedOutcome = 'dry';
        sim.pushLog('Cheat code: the next prospect roll comes back empty.', 'info');
        break;
      case 'breakdown': sim.triggerRoverFault(); break;
      case 'repair-rover': sim.repairRover(); break;
      case 'complete-trip': sim.completeRoverTrip(); break;

      case 'fill-stores':
        for (const kind of ['carbon', 'oxygen', 'hydrogen']) s.fuel[kind] = FUEL.store[kind];
        sim.pushLog('Cheat code: carbon, oxygen and hydrogen stores filled to capacity.', 'good');
        break;
      case 'manufacture': sim.startFuelProduction(); break;
      case 'fill-plant':
        s.fuel.making = false;
        s.fuel.percent = ROCKET.capacity;
        s.fuel.made = Math.max(s.fuel.made, ROCKET.capacity);
        sim.pushLog('Cheat code: the propellant plant tank is full — a complete M3 load.', 'good');
        break;
      case 'transfer': sim.transferFuel(); break;
      case 'load-m3':
        s.rocket.transferring = false;
        s.rocket.transferLeft = 0;
        s.rocket.percent = ROCKET.capacity;
        s.rocket.ready = true;
        sim.pushLog('Cheat code: M3 tanks loaded to 100%.', 'good');
        break;
      case 'complete-objectives': sim.completeMissionObjectives(); break;
      case 'launch': sim.launchRocket(); break;

      case 'sol-set': sim.setSol(Number(el.dataset.sol)); break;
      case 'speed-set': s.speed = Number(el.dataset.speed); this.hud.render(); break;
      case 'difficulty':
        sim.difficulty = DIFFICULTIES[el.dataset.diff];
        s.difficulty = el.dataset.diff;
        sim.pushLog(`Cheat code: event difficulty switched to ${sim.difficulty.label}.`, 'info');
        break;
      case 'clear-skies': this.#clearSkies(); break;
      default: break;
    }
    this.audio.ui();
    this.applyLive();
  }

  /** The ninth showcase event is the sim's wear-and-tear failure path, not a director kind. */
  #triggerEvent(kind) {
    const sim = this.sim;
    const s = sim.state;
    if (kind === 'equipment') {
      let candidates = ['aqua', 'o2', 'solar'].filter((id) => !s.failures[id]);
      if (!candidates.length) {
        sim.repairFacility('aqua');
        candidates = ['o2', 'solar'];
      }
      sim.causeEquipmentFailure(pick(candidates), 'wear');
      return;
    }
    sim.events.forceTrigger(kind);
  }

  #clearSkies() {
    const sim = this.sim;
    const s = sim.state;
    if (s.storm.active) {
      s.storm.active = false;
      s.storm.timeLeft = 0;
      sim.emit({ type: 'storm-end' });
    }
    s.fx.devil = 0;
    s.fx.quake = 0;
    s.events.active = s.events.active.filter((e) => !['dust_devil', 'dust_storm', 'marsquake'].includes(e.kind));
    sim.pushLog('Cheat code: skies cleared — storm, dust devil and tremor effects ended.', 'info');
  }

  /* ─────────────────────────────── cinematics ─────────────────────────────── */

  #playFilm(kind) {
    this.#closeFilm();
    this.setTab('films');
    this.film = kind;
    this.filmStart = performance.now();
    if (kind === 'intro') this.playedIntro = true;
    else this.playedOutro = true;
    this.hooks.onCinematic(true);
    this.root.classList.add('film-live');
    const onDone = () => {
      this.film = null;
      this.filmHandle = null;
      this.root.classList.remove('film-live');
      this.hooks.onCinematic(false);
      this.applyLive();
    };
    // The ending preview reads a summary only — it never touches mission flags.
    this.filmHandle = kind === 'intro'
      ? playIntro({ onDone })
      : playOutro({ summary: this.hooks.getSummary(), onDone });
    this.applyLive();
  }

  #closeFilm() {
    const handle = this.filmHandle;
    if (!handle) return;
    this.filmHandle = null;
    if (typeof handle.close === 'function') handle.close();
    else handle.skip();
  }

  #outroInReport() {
    const report = document.getElementById('o-report');
    return Boolean(report && !report.hidden);
  }

  /* ─────────────────────────────── tab markup ─────────────────────────────── */

  #renderTab() {
    switch (this.tab) {
      case 'events': return this.#renderEvents();
      case 'films': return this.#renderFilms();
      case 'survive': return this.#renderSurvive();
      case 'rover': return this.#renderRover();
      case 'rocket': return this.#renderRocket();
      case 'time': return this.#renderTime();
      default: return this.#renderHome();
    }
  }

  #renderHome() {
    const stats = [
      ['MISSION CLOCK', 'home-sol'], ['EVENTS FACED', 'home-events'], ['ROVER-01', 'home-rover'],
      ['M3 TANKS', 'home-rocket'], ['RESEARCH', 'home-research'], ['CREW ALIVE', 'home-crew'],
    ];
    const jumps = [
      ['events', 'EVENT SHOWCASE', 'all nine events on demand'],
      ['films', 'CINEMATIC SHOWCASE', 'opening + journey home'],
      ['survive', 'SURVIVAL SANDBOX', 'infinite reserves, rested crew'],
      ['rover', 'ROVER SHOWCASE', 'four missions, forced outcomes'],
      ['rocket', 'MISSION & ROCKET', 'feedstock to liftoff'],
      ['time', 'TIME & ENVIRONMENT', 'sols, speed, weather'],
    ];
    return `
      <div class="cheat-hero">
        <div class="cheat-hero-title">MISSION CONTROL OVERRIDE</div>
        <div class="cheat-hero-sub">Every system below is live. Trigger it, watch it, break it, fix it — Mars answers to you.</div>
      </div>
      <div class="stat-grid">
        ${stats.map(([k, key]) => `<div class="stat"><div class="k">${k}</div><div class="v" data-live="${key}">—</div></div>`).join('')}
      </div>
      <div class="section-title">Showcases</div>
      <div class="cheat-jumps">
        ${jumps.map(([tab, name, sub]) => `<button class="cheat-jump" data-tab="${tab}"><span>${name}</span><small>${sub}</small></button>`).join('')}
      </div>
      <div class="section-title">Active across the outpost</div>
      <div class="cheat-active" data-live="home-active">All quiet.</div>
      <div class="note">Cheats apply to this sandbox only. <strong>Saving is disabled</strong> — your Cadet / Commander outpost is exactly where you left it.</div>
    `;
  }

  #renderEvents() {
    return `
      <div class="section-title">Event showcase</div>
      <p class="cheat-lede">Each button fires the real event implementation — same warnings, same visuals, same gameplay consequences. Trigger again to replay.</p>
      <button class="action primary cheat-wide" data-cheat-action="random-event">RANDOM EVENT<small>roll one of the nine</small></button>
      <div class="cheat-cards">
        ${EVENT_INFO.map((e) => `
          <div class="cheat-card">
            <div class="cheat-card-top">
              <span class="cheat-card-name">${e.name}</span>
              <span class="cheat-chip" data-live="ev-${e.id}" data-tone="ev-${e.id}">READY</span>
            </div>
            <div class="cheat-card-desc">${e.desc}</div>
            <div class="meter"><i data-bar="ev-bar-${e.id}"></i></div>
            <div class="action-row"><button class="action" data-cheat-action="event" data-kind="${e.id}">TRIGGER</button></div>
          </div>
        `).join('')}
      </div>
    `;
  }

  #renderFilms() {
    const card = (kind, name, desc) => `
      <div class="cheat-card">
        <div class="cheat-card-top">
          <span class="cheat-card-name">${name}</span>
          <span class="cheat-chip" data-live="${kind}-status">READY</span>
        </div>
        <div class="cheat-card-desc">${desc}</div>
        <div class="action-row">
          <button class="action primary" data-cheat-action="play-film" data-film="${kind}" data-show="${kind}-play"><span data-live="${kind}-play-label">PLAY</span></button>
          <button class="action" data-cheat-action="skip-film" data-show="${kind}-skip" hidden>SKIP</button>
          <button class="action" data-cheat-action="return-film" data-show="${kind}-return" hidden>RETURN TO SHOWCASE</button>
        </div>
        ${kind === 'outro' ? '<div class="cheat-report-note" data-show="outro-report-note" hidden>Mission report on screen — RETURN closes it and resumes the sandbox.</div>' : ''}
      </div>
    `;
    return `
      <div class="section-title">Cinematic showcase</div>
      <p class="cheat-lede">The real sequences, replayable any time. The console stays live over the picture — collapse it with “–” to watch unobstructed.</p>
      ${card('intro', 'OPENING — “ARRIVAL”', 'Earth departure, the fleet in transit, Mars approach and the landing that starts it all.')}
      ${card('outro', 'ENDING — “THE JOURNEY HOME”', 'The fuelled M3, countdown, ignition, liftoff and the long coast back to Earth.')}
      <div class="note">The ending here is a <strong>preview</strong>: it does not complete mission objectives and never touches a save. For the real launch, use the <strong>Rocket</strong> showcase.</div>
    `;
  }

  #renderSurvive() {
    const toggles = [
      ['life', 'LIFE-SUPPORT RESERVES', 'oxygen, water and food held at 100%'],
      ['power', 'UNLIMITED POWER', 'battery pinned — no brownouts, ever'],
      ['research', 'UNLIMITED RESEARCH POINTS', 'a 9,999 RP floor for the lab and resupply'],
    ];
    const resources = [
      ['OXYGEN', 'res-oxygen', 'res-oxygen'], ['WATER', 'res-water', 'res-water'],
      ['FOOD', 'res-food', 'res-food'], ['BATTERY', 'res-battery', 'res-battery'],
    ];
    return `
      <div class="section-title">Survival sandbox</div>
      <div class="toggle-list">
        ${toggles.map(([key, label, sub]) => `
          <div class="toggle-row">
            <div><div class="t-label">${label}</div><div class="t-sub">${sub}</div></div>
            <button class="switch" data-cheat-action="toggle-pin" data-pin="${key}" data-tone="pin-${key}" aria-label="${label}"></button>
          </div>
        `).join('')}
      </div>
      <div class="stat-grid cheat-stats">
        ${resources.map(([k, key, bar]) => `
          <div class="stat"><div class="k">${k}</div><div class="v" data-live="${key}">—</div><div class="meter"><i data-bar="${bar}"></i></div></div>
        `).join('')}
        <div class="stat"><div class="k">RESEARCH POINTS</div><div class="v" data-live="res-research">—</div></div>
      </div>
      <div class="action-row">
        <button class="action primary" data-cheat-action="unlock-all" data-disabled="unlock-all">UNLOCK ALL RESEARCH<small>every topic, real effects</small></button>
        <button class="action" data-cheat-action="licence" data-disabled="licence">FUEL LICENCE<small>the compulsory tech</small></button>
        <button class="action" data-cheat-action="restore-crew">RESTORE CREW<small>health · fatigue · 4 h rest · wake all</small></button>
      </div>
      <div class="section-title">Research topics</div>
      ${this.sim.state.topics.map((t) => `
        <div class="status-line"><span class="label">${t.name}</span><span class="tag" data-live="topic-${t.id}" data-tone="topic-${t.id}">OPEN</span></div>
      `).join('')}
      <div class="section-title">Crew roster</div>
      ${this.sim.crewRoster().map((c) => `
        <div class="cheat-card crew-mini">
          <div class="cheat-card-top"><span class="cheat-card-name">${c.name}</span><span class="cheat-chip" data-live="crew-status-${c.id}">${c.status}</span></div>
          <div class="crew-meters">
            <div><span>HP</span><div class="meter"><i data-bar="crew-health-${c.id}"></i></div></div>
            <div><span>FATIGUE</span><div class="meter"><i data-bar="crew-fatigue-${c.id}"></i></div></div>
          </div>
        </div>
      `).join('')}
    `;
  }

  #renderRover() {
    return `
      <div class="section-title">ROVER-01 — live telemetry</div>
      <div class="cheat-card">
        <div class="status-line"><span class="label">Phase</span><span class="value" data-live="rover-phase">Idle</span></div>
        <div class="status-line"><span class="label">Site</span><span class="value" data-live="rover-site">—</span></div>
        <div class="status-line"><span class="label">Cargo</span><span class="value" data-live="rover-cargo">Empty bay</span></div>
        <div class="status-line"><span class="label">Trips logged</span><span class="value" data-live="rover-trips">0</span></div>
        <div class="status-line"><span class="label">Last result</span><span class="value" data-live="rover-result">No runs yet</span></div>
        <div class="meter"><i data-bar="rover-progress"></i></div>
        <div class="cheat-armed" data-live="rover-armed">NEXT ROLL: NORMAL ODDS</div>
      </div>
      <div class="section-title">Missions</div>
      ${MISSIONS.map((m) => `
        <div class="cheat-card">
          <div class="cheat-card-top"><span class="cheat-card-name">${m.label}</span><span class="cheat-chip">${m.unit}</span></div>
          <div class="action-row"><button class="action" data-cheat-action="dispatch" data-kind="${m.kind}" data-disabled="dispatch-${m.kind}">DISPATCH ROVER</button></div>
        </div>
      `).join('')}
      <div class="section-title">Override controls</div>
      <div class="cheat-grid-2">
        <button class="action" data-cheat-action="force-success">FORCE SUCCESS<small>next roll strikes ore</small></button>
        <button class="action" data-cheat-action="force-dry">FORCE DRY RUN<small>next roll comes back empty</small></button>
        <button class="action" data-cheat-action="breakdown" data-disabled="breakdown">TRIGGER BREAKDOWN</button>
        <button class="action" data-cheat-action="repair-rover" data-disabled="repair-rover">REPAIR ROVER</button>
        <button class="action primary cheat-span-2" data-cheat-action="complete-trip" data-disabled="complete-trip">COMPLETE CURRENT TRIP INSTANTLY</button>
      </div>
      <div class="note">Forced outcomes arm the <strong>next</strong> prospect roll, then clear. The rover still drives, drills and unloads through its real phase machine — watch it on the surface.</div>
    `;
  }

  #renderRocket() {
    const feeds = [['carbon', 'CARBON'], ['oxygen', 'OXYGEN'], ['hydrogen', 'HYDROGEN']];
    return `
      <div class="section-title">Propellant chain</div>
      <div class="cheat-card">
        <div class="status-line"><span class="label">Fuel production licence</span><span class="value" data-live="licence-state">LOCKED</span></div>
        <div class="action-row"><button class="action" data-cheat-action="licence" data-disabled="licence">UNLOCK FUEL PRODUCTION</button></div>
      </div>
      <div class="cheat-card">
        ${feeds.map(([kind, label]) => `
          <div class="status-line"><span class="label">${label}</span><span class="value" data-live="fuel-${kind}">0 kg</span></div>
          <div class="meter"><i data-bar="fuel-${kind}"></i></div>
        `).join('')}
        <div class="action-row"><button class="action" data-cheat-action="fill-stores">FILL ALL STORES</button></div>
      </div>
      <div class="cheat-card">
        <div class="status-line"><span class="label">Plant tank</span><span class="value" data-live="plant-tank">0%</span></div>
        <div class="meter"><i data-bar="plant-tank"></i></div>
        <div class="status-line"><span class="label">Line</span><span class="value" data-live="plant-state">IDLE</span></div>
        <div class="action-row">
          <button class="action" data-cheat-action="manufacture" data-disabled="manufacture">MANUFACTURE PROPELLANT</button>
          <button class="action" data-cheat-action="fill-plant" data-disabled="fill-plant">FILL PLANT TANK</button>
        </div>
      </div>
      <div class="cheat-card">
        <div class="status-line"><span class="label">M3 return rocket</span><span class="value" data-live="rocket-tank">0%</span></div>
        <div class="meter"><i data-bar="rocket-tank"></i></div>
        <div class="status-line"><span class="label">Status</span><span class="value" data-live="rocket-state">AWAITING FUEL</span></div>
        <div class="action-row">
          <button class="action" data-cheat-action="transfer" data-disabled="transfer">TRANSFER TO M3</button>
          <button class="action" data-cheat-action="load-m3" data-disabled="load-m3">LOAD M3 TO 100%</button>
        </div>
      </div>
      <div class="section-title">Mission objectives</div>
      <button class="action primary cheat-wide" data-cheat-action="complete-objectives" data-disabled="complete-objectives">COMPLETE ALL OBJECTIVES<small>every condition except the launch itself</small></button>
      <div class="cheat-card">
        ${this.sim.missionReadiness().map((c) => `
          <div class="ready-row" data-tone="ready-${c.id}"><span class="ready-label">${c.label}</span><span class="ready-state" data-live="ready-${c.id}">PENDING</span></div>
        `).join('')}
      </div>
      <div class="action-row">
        <button class="action primary" data-cheat-action="launch" data-disabled="launch">LAUNCH M3<small>real gate · real ending</small></button>
        <button class="action" data-cheat-action="replay-ending">REPLAY ENDING<small>preview only</small></button>
      </div>
      <div class="cheat-launch-note" data-live="launch-note">—</div>
    `;
  }

  #renderTime() {
    return `
      <div class="section-title">Mission clock</div>
      <div class="cheat-picks">
        ${[1, 2, 5, 10].map((n) => `<button class="cheat-pick" data-cheat-action="sol-set" data-sol="${n}" data-tone="sol-${n}">SOL ${n}</button>`).join('')}
      </div>
      <div class="section-title">Simulation speed</div>
      <div class="cheat-picks">
        ${[1, 2, 4].map((n) => `<button class="cheat-pick" data-cheat-action="speed-set" data-speed="${n}" data-tone="speed-${n}">${n}×</button>`).join('')}
        <button class="cheat-pick" data-cheat-action="pause"><span data-live="pause-label">PAUSE</span></button>
      </div>
      <div class="section-title">Event difficulty</div>
      <div class="cheat-picks">
        ${Object.values(DIFFICULTIES).map((d) => `<button class="cheat-pick" data-cheat-action="difficulty" data-diff="${d.id}" data-tone="diff-${d.id}">${d.label.toUpperCase()}</button>`).join('')}
      </div>
      <div class="note">Switches event frequency and storm strength for testing — starting reserves stay as they were.</div>
      <div class="section-title">Environment</div>
      <div class="cheat-grid-2">
        <button class="action" data-cheat-action="event" data-kind="dust_devil">DUST DEVIL</button>
        <button class="action" data-cheat-action="event" data-kind="dust_storm">DUST STORM</button>
        <button class="action" data-cheat-action="event" data-kind="marsquake">MARSQUAKE</button>
        <button class="action" data-cheat-action="event" data-kind="meteorite">METEORITE</button>
        <button class="action cheat-span-2" data-cheat-action="clear-skies">CLEAR SKIES — END WEATHER EFFECTS</button>
      </div>
      <div class="cheat-time-status" data-live="time-status">—</div>
    `;
  }

  /* ─────────────────────────────── live fields ─────────────────────────────── */

  applyLive() {
    for (const el of this.root.querySelectorAll('[data-live]')) {
      const text = this.#liveText(el.dataset.live);
      if (el.textContent !== text) el.textContent = text;
    }
    for (const el of this.root.querySelectorAll('[data-bar]')) {
      const bar = this.#liveBar(el.dataset.bar);
      el.style.width = `${Math.min(100, Math.max(0, bar.pct))}%`;
      el.parentNode.className = `meter ${bar.tone}`;
    }
    for (const el of this.root.querySelectorAll('[data-tone]')) {
      const tone = this.#liveTone(el.dataset.tone);
      el.classList.toggle('on', tone === 'on');
      el.classList.toggle('warn', tone === 'warn');
      el.classList.toggle('bad', tone === 'bad');
    }
    for (const el of this.root.querySelectorAll('[data-disabled]')) {
      el.disabled = this.#liveDisabled(el.dataset.disabled);
    }
    for (const el of this.root.querySelectorAll('[data-show]')) {
      el.hidden = !this.#liveShow(el.dataset.show);
    }
  }

  #eventState(id) {
    const s = this.sim.state;
    const entry = s.events.active.find((e) => e.kind === id);
    const secs = (v) => `${Math.max(0, Math.ceil(v))}s`;
    switch (id) {
      case 'dust_devil':
        return s.fx.devil > 0
          ? { text: `ACTIVE ${secs(s.fx.devil)}`, tone: 'warn', pct: (entry ? entry.timeLeft / entry.total : 0) * 100 }
          : { text: 'READY', tone: '', pct: 0 };
      case 'dust_storm':
        return s.storm.active
          ? { text: `ACTIVE ${secs(s.storm.timeLeft)}`, tone: 'warn', pct: 100 }
          : { text: 'READY', tone: '', pct: 0 };
      case 'greenhouse':
        return s.failures.bio
          ? { text: 'FAULT ACTIVE', tone: 'bad', pct: s.repair.bio * 100 }
          : { text: 'READY', tone: '', pct: 0 };
      case 'rover_breakdown':
        return s.rover.malfunction
          ? { text: 'ROVER DOWN', tone: 'bad', pct: s.rover.repairProgress * 100 }
          : { text: 'READY', tone: '', pct: 0 };
      case 'marsquake':
        return entry
          ? { text: `SHAKING ${secs(entry.timeLeft)}`, tone: 'warn', pct: (entry.timeLeft / entry.total) * 100 }
          : { text: 'READY', tone: '', pct: 0 };
      case 'seal':
        return s.seal.active
          ? { text: `LEAK @ ${s.seal.label}`, tone: 'bad', pct: s.seal.progress * 100 }
          : { text: 'READY', tone: '', pct: 0 };
      case 'radiation': {
        const rad = s.radiation;
        if (rad.phase === 'warning') return { text: `WARNING ${secs(rad.timeLeft)}`, tone: 'warn', pct: 100 };
        if (rad.phase === 'peak') return { text: `PEAK ${secs(rad.timeLeft)}`, tone: 'bad', pct: 100 };
        return { text: 'READY', tone: '', pct: 0 };
      }
      case 'meteorite':
        return entry
          ? { text: `INBOUND ${secs(entry.timeLeft)}`, tone: 'bad', pct: (1 - entry.timeLeft / entry.total) * 100 }
          : { text: 'READY', tone: '', pct: 0 };
      case 'equipment': {
        const down = ['aqua', 'o2', 'solar'].filter((k) => s.failures[k]);
        return down.length
          ? { text: `${down.map((k) => k.toUpperCase()).join(' + ')} DOWN`, tone: 'bad', pct: Math.max(...down.map((k) => s.repair[k])) * 100 }
          : { text: 'READY', tone: '', pct: 0 };
      }
      default:
        return { text: 'READY', tone: '', pct: 0 };
    }
  }

  #liveText(key) {
    const sim = this.sim;
    const s = sim.state;
    switch (key) {
      case 'h-sol': return `SOL ${s.sol}`;
      case 'h-clock': return fmtClock(s.hour);
      case 'h-state':
        if (this.film) return 'FILM RUNNING';
        if (s.flags.complete) return 'MISSION COMPLETE';
        if (s.flags.failed) return 'MISSION FAILED';
        return this.hooks.isPaused() ? 'PAUSED' : 'SANDBOX LIVE';
      case 'pause-label': return this.hooks.isPaused() ? 'RESUME' : 'PAUSE';
      case 'speed-label': return `${s.speed}×`;
      case 'sound-label': return this.audio.muted ? 'SOUND OFF' : 'SOUND ON';

      case 'home-sol': return `SOL ${s.sol} · ${fmtClock(s.hour)}`;
      case 'home-events': return String(s.events.encountered);
      case 'home-rover': return s.rover.malfunction ? 'Malfunction' : (ROVER_STATUS[s.rover.phase] ?? 'Idle');
      case 'home-rocket': return `${Math.round(s.rocket.percent)}%`;
      case 'home-research': return `${sim.completedTopics()}/${s.topics.length}`;
      case 'home-crew': return `${sim.crewRoster().filter((c) => c.alive).length}/4`;
      case 'home-active': return this.#activeSummary();

      case 'rover-phase': return s.rover.malfunction ? 'Malfunction' : (ROVER_STATUS[s.rover.phase] ?? 'Idle');
      case 'rover-site': return SITES[s.rover.survey]?.name ?? '—';
      case 'rover-cargo': return s.rover.cargo ? `${s.rover.cargo.kg} kg ${s.rover.cargo.kind}` : (s.rover.malfunction ? 'Fault — repair required' : 'Empty bay');
      case 'rover-trips': return String(s.rover.trips);
      case 'rover-result': {
        const r = s.rover.result;
        if (!r) return 'No runs yet';
        return r.success ? `${r.kg} kg ${r.kind} @ ${r.site}` : `DRY RUN @ ${r.site}`;
      }
      case 'rover-armed': return s.rover.forcedOutcome ? `NEXT ROLL: FORCED ${s.rover.forcedOutcome.toUpperCase()}` : 'NEXT ROLL: NORMAL ODDS (40%)';

      case 'licence-state': return sim.fuelLicensed() ? 'LICENSED' : 'LOCKED';
      case 'plant-tank': return `${s.fuel.percent.toFixed(0)}%`;
      case 'plant-state': return s.fuel.making ? 'LINE RUNNING' : (sim.fuelLicensed() ? 'LINE IDLE' : 'NO LICENCE');
      case 'rocket-tank': return `${s.rocket.percent.toFixed(0)}%`;
      case 'rocket-state':
        if (s.rocket.transferring) return `TRANSFERRING ${Math.ceil(s.rocket.transferLeft)}s`;
        return s.rocket.ready ? 'TANKS FULL' : 'AWAITING FUEL';
      case 'launch-note': {
        if (s.rocket.launched) return 'M3 IS AWAY — DEMO COMPLETE';
        const missing = sim.missionReadiness().filter((c) => !c.done && c.id !== 'launch').length;
        return missing ? `${missing} OBJECTIVE${missing === 1 ? '' : 'S'} OUTSTANDING` : 'ALL OBJECTIVES GREEN — GO FOR LAUNCH';
      }

      case 'res-oxygen': return `${Math.round(s.oxygen)}%`;
      case 'res-water': return `${Math.round(s.water)}%`;
      case 'res-food': return `${Math.round(s.food)}%`;
      case 'res-battery': return `${Math.round(s.battery)}%`;
      case 'res-research': return `${Math.floor(s.researchPoints)} RP`;

      case 'time-status': return `SOL ${s.sol} · ${fmtClock(s.hour)} · ${s.speed}× · ${sim.difficulty.label} events`;

      case 'intro-status': return this.#filmStatus('intro');
      case 'outro-status': return this.#filmStatus('outro');
      case 'intro-play-label': return this.playedIntro ? 'REPLAY' : 'PLAY';
      case 'outro-play-label': return this.playedOutro ? 'REPLAY' : 'PLAY';
      default: break;
    }
    if (key.startsWith('ev-')) return this.#eventState(key.slice(3)).text;
    if (key.startsWith('fuel-')) {
      const kind = key.slice(5);
      return `${Math.floor(s.fuel[kind])} / ${FUEL.store[kind]} kg`;
    }
    if (key.startsWith('ready-')) {
      const c = sim.missionReadiness().find((x) => x.id === key.slice(6));
      return c?.done ? 'DONE' : 'PENDING';
    }
    if (key.startsWith('topic-')) {
      const t = s.topics.find((x) => x.id === key.slice(6));
      return t?.done ? 'DONE' : (s.activeTopic === key.slice(6) ? 'ACTIVE' : 'OPEN');
    }
    if (key.startsWith('crew-status-')) {
      const c = sim.crewRoster().find((x) => x.id === key.slice(12));
      return c?.status ?? '—';
    }
    return '—';
  }

  #filmStatus(kind) {
    if (this.film === kind) {
      if (kind === 'outro' && this.#outroInReport()) return 'REPORT ON SCREEN';
      const elapsed = Math.floor((performance.now() - this.filmStart) / 1000);
      const total = Math.round(this.filmHandle?.timeTotal ?? (kind === 'intro' ? 52.5 : 45));
      return `PLAYING · ${elapsed}s / ${total}s`;
    }
    const played = kind === 'intro' ? this.playedIntro : this.playedOutro;
    return played ? 'WATCHED · READY TO REPLAY' : 'READY';
  }

  #activeSummary() {
    const s = this.sim.state;
    const parts = [];
    if (s.storm.active) parts.push('Dust storm');
    if (s.fx.devil > 0) parts.push('Dust devil');
    if (s.fx.quake > 0) parts.push('Marsquake');
    if (s.radiation.phase !== 'none') parts.push(`Radiation ${s.radiation.phase}`);
    if (s.seal.active) parts.push(`Seal leak @ ${s.seal.label}`);
    if (s.rover.malfunction) parts.push('Rover down');
    for (const id of ['aqua', 'o2', 'solar', 'bio', 'fuel']) if (s.failures[id]) parts.push(`${id.toUpperCase()} fault`);
    if (s.events.active.some((e) => e.kind === 'meteorite')) parts.push('Meteorite inbound');
    return parts.length ? parts.join(' · ') : 'All quiet across the outpost.';
  }

  #liveTone(key) {
    const s = this.sim.state;
    if (key.startsWith('ev-')) return this.#eventState(key.slice(3)).tone;
    if (key.startsWith('pin-')) return this.pins[key.slice(4)] ? 'on' : '';
    if (key.startsWith('ready-')) return this.sim.missionReadiness().find((c) => c.id === key.slice(6))?.done ? 'on' : '';
    if (key.startsWith('topic-')) {
      const t = s.topics.find((x) => x.id === key.slice(6));
      return t?.done ? 'on' : (s.activeTopic === t?.id ? 'warn' : '');
    }
    if (key.startsWith('sol-')) return s.sol === Number(key.slice(4)) ? 'on' : '';
    if (key.startsWith('speed-')) return s.speed === Number(key.slice(6)) ? 'on' : '';
    if (key.startsWith('diff-')) return this.sim.difficulty.id === key.slice(5) ? 'on' : '';
    return '';
  }

  #liveBar(key) {
    const s = this.sim.state;
    if (key === 'rover-progress') return { pct: this.sim.roverProgress() * 100, tone: '' };
    if (key === 'rocket-tank') return { pct: s.rocket.percent, tone: s.rocket.percent >= ROCKET.capacity ? 'good' : '' };
    if (key === 'plant-tank') return { pct: s.fuel.percent, tone: s.fuel.percent >= ROCKET.capacity ? 'good' : '' };
    if (key.startsWith('ev-bar-')) return { pct: this.#eventState(key.slice(7)).pct, tone: '' };
    if (key.startsWith('fuel-')) {
      const kind = key.slice(5);
      return { pct: (s.fuel[kind] / FUEL.store[kind]) * 100, tone: '' };
    }
    if (key.startsWith('res-')) {
      const v = s[key.slice(4)];
      return { pct: v, tone: v < 25 ? 'bad' : v < 50 ? 'warn' : '' };
    }
    if (key.startsWith('crew-health-')) {
      const c = this.sim.crewRoster().find((x) => x.id === key.slice(12));
      return { pct: c?.health ?? 0, tone: 'good' };
    }
    if (key.startsWith('crew-fatigue-')) {
      const c = this.sim.crewRoster().find((x) => x.id === key.slice(13));
      const f = c?.fatigue ?? 0;
      return { pct: f, tone: f >= 70 ? 'bad' : f >= 40 ? 'warn' : '' };
    }
    return { pct: 0, tone: '' };
  }

  #liveDisabled(key) {
    const sim = this.sim;
    const s = sim.state;
    if (key.startsWith('dispatch-')) {
      return sim.roverActive() || s.rover.malfunction || !s.systems.rover || sim.bestSiteFor(key.slice(9)) < 0;
    }
    switch (key) {
      case 'breakdown': return s.rover.malfunction;
      case 'repair-rover': return !s.rover.malfunction;
      case 'complete-trip': return s.rover.malfunction || s.rover.phase === 'idle';
      case 'licence': return sim.fuelLicensed();
      case 'unlock-all': return s.topics.every((t) => t.done);
      case 'fill-plant': return s.fuel.percent >= ROCKET.capacity;
      case 'manufacture': return s.fuel.making || s.fuel.percent >= ROCKET.capacity || !sim.fuelCanMake();
      case 'transfer': return s.rocket.transferring || s.fuel.percent <= 0 || s.fuel.making || s.rocket.percent >= ROCKET.capacity;
      case 'load-m3': return s.rocket.percent >= ROCKET.capacity;
      case 'complete-objectives': return sim.launchReady();
      case 'launch': return s.rocket.launched || s.flags.complete;
      default: return false;
    }
  }

  #liveShow(key) {
    switch (key) {
      case 'intro-play': return this.film !== 'intro';
      case 'intro-skip':
      case 'intro-return': return this.film === 'intro';
      case 'outro-play': return this.film !== 'outro';
      case 'outro-skip': return this.film === 'outro' && !this.#outroInReport();
      case 'outro-return': return this.film === 'outro';
      case 'outro-report-note': return this.film === 'outro' && this.#outroInReport();
      default: return true;
    }
  }
}