import {
  CHOICES, FATIGUE, FUEL, LOCK_KEY_OPTIONS, MATERIAL_LABEL, MISSIONS, PLAYER, POSTS, POWER, PROSPECT_CHANCE,
  RATES, ROCKET, ROVER, SITES, SLEEP, SOL_SECONDS, WATER, roverRoute,
} from './config.js';

const esc = (v) =>
  String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const pct = (v) => `${Math.round(v)}%`;
const num = (v) => v.toFixed(1);

const PANEL_KINDS = new Set(['facility', 'crew', 'research', 'telemetry', 'pause']);

const SITE_TINT = { ice: '#63c7ff', carbon: '#d8b48a', oxygen: '#7ef0d0', hydrogen: '#f2b661' };

/** kg of ice still recoverable from the mapped ice deposits. */
const iceRemaining = (s) => s.sites.reduce((t, dep, i) => t + (SITES[i].kind === 'ice' ? dep.remaining : 0), 0);

/**
 * All modal interfaces: facility consoles, crew rosters, research, telemetry and
 * the pause screen. One delegated click handler keeps the markup disposable.
 */
export class Panels {
  constructor({
    sim, player, colony, crewActors, audio, hud,
    onSpeed, onSave, onQuit, onMute, onClose,
    onLock = null, isLocked = null, lockKey = null, onLockKey = null,
  }) {
    this.sim = sim;
    this.player = player;
    this.colony = colony;
    this.crewActors = crewActors;
    this.audio = audio;
    this.hud = hud;
    this.onSpeed = onSpeed;
    this.onSave = onSave;
    this.onQuit = onQuit;
    this.onMute = onMute;
    this.onClose = onClose;
    this.onLock = onLock;
    this.isLocked = isLocked;
    this.lockKey = lockKey;
    this.onLockKey = onLockKey;
    this.rover = null;

    this.root = document.getElementById('panel-root');
    this.kind = null;
    this.facilityId = null;

    this.root.addEventListener('click', (event) => {
      const target = event.target.closest('[data-action]');
      if (!target || ['SELECT', 'OPTION'].includes(target.tagName)) return;
      this.#handle(target.dataset.action, target.dataset.arg);
    });

    this.root.addEventListener('change', (event) => {
      const keySelect = event.target.closest('select[data-action="lock-key"]');
      if (keySelect) {
        this.onLockKey?.(keySelect.value);
        this.audio.ui();
        this.render();
        return;
      }
      const select = event.target.closest('select[data-action="assign"]');
      if (!select) return;
      const [crewId, postId] = select.value.split('|');
      this.sim.assignCrew(crewId, postId);
      this.crewActors?.refreshTargets();
      this.audio.ui();
      this.render();
    });
  }

  get isOpen() {
    return this.kind !== null;
  }

  open(kind, facilityId = null) {
    // An unknown kind or facility id would leave the root open but empty,
    // freezing the simulation until the player finds Escape.
    if (!PANEL_KINDS.has(kind)) return false;
    if (kind === 'facility' && !this.colony.get(facilityId)) return false;
    this.kind = kind;
    this.facilityId = facilityId;
    this.root.classList.remove('is-hidden');
    this.hud.hidePrompt();
    this.audio.open();
    this.render();
    return true;
  }

  close() {
    const wasOpen = this.kind !== null;
    this.kind = null;
    this.facilityId = null;
    this.root.classList.add('is-hidden');
    this.root.innerHTML = '';
    if (wasOpen) this.onClose?.();
  }

  /* ───────────────────────────── rendering ───────────────────────────── */

  render() {
    if (!this.kind) return;
    const { head, body } = this.#layout();
    this.root.innerHTML = `
      <div class="panel">
        <header class="panel-head">
          <div>
            ${head}
          </div>
          <button class="panel-close" data-action="close" aria-label="Close">✕</button>
        </header>
        <div class="panel-body">${body}</div>
      </div>`;
  }

  #layout() {
    if (this.kind === 'facility') {
      const f = this.colony.get(this.facilityId);
      return {
        head: `<p class="eyebrow">${esc(f.code)} · facility console</p><h2>${esc(f.name)}</h2><p class="purpose">${esc(f.purpose)}</p>`,
        body: this.#facilityBody(f),
      };
    }
    if (this.kind === 'crew') {
      return {
        head: `<p class="eyebrow">Crew roster</p><h2>Assignment board</h2><p class="purpose">Three specialists, eight posts. Every posting you fill is a posting you leave empty.</p>`,
        body: this.#crewBody(),
      };
    }
    if (this.kind === 'research') {
      return {
        head: `<p class="eyebrow">SCI-Lab · research programme</p><h2>Research queue</h2><p class="purpose">Research costs 16 power units and runs on its own clock. A scientist at SCI-Lab doubles the rate.</p>`,
        body: this.#researchBody(),
      };
    }
    if (this.kind === 'telemetry') {
      return {
        head: `<p class="eyebrow">Colony telemetry</p><h2>Power and load control</h2><p class="purpose">Shed loads before the battery empties, or the brownout controller will shed them for you.</p>`,
        body: this.#telemetryBody(),
      };
    }
    return {
      head: `<p class="eyebrow">Paused</p><h2>Mission console</h2><p class="purpose">The simulation is stopped. Nothing is lost.</p>`,
      body: this.#pauseBody(),
    };
  }

  /* ───────────────────────────── facility consoles ───────────────────────────── */

  #facilityBody(f) {
    const sim = this.sim;
    const s = sim.state;
    const d = sim.derived;
    const broken = s.failures[f.id];

    const parts = [];

    if (s.seal.active && s.seal.facilityId === f.id) {
      const worker = sim.crewAt(f.id);
      parts.push(this.#note(
        `<strong class="bad-text">Seal malfunction</strong> at ${esc(f.code)}. External O₂ is bleeding off. ` +
          (worker
            ? `<strong>${esc(worker.name)}</strong> is re-pressing it — ${Math.round(s.seal.progress * 100)}% done.`
            : 'Re-press it yourself or post a crew member here.'),
      ));
      if (!worker) {
        parts.push(this.#actions([
          [this.player.repair ? 'Repair in progress…' : `Re-press seal (${PLAYER.repairSeconds} s)`, 'repair-seal', f.id, 'Stay at the facility while it runs', Boolean(this.player.repair)],
        ], true));
      }
    }

    if (f.id === 'hab') {
      const roster = sim.crewRoster();
      const asleep = roster.filter((c) => c.sleeping).length;
      parts.push(this.#stats([
        ['Oxygen', pct(s.oxygen), `${d.flow.oxygen.toFixed(2)}/s`, s.oxygen < 45 ? 'warn' : ''],
        ['Crew aboard', `${roster.filter((c) => c.alive).length}`, `${roster.length} assigned`],
        ['In their bunks', `${asleep}/${roster.length}`, `rest window ${SLEEP.hours} h per Sol`, asleep ? 'good' : 'warn'],
        ['Power', pct(s.battery), `${d.net >= 0 ? '+' : ''}${d.net.toFixed(0)} net`],
      ]));
      parts.push(`<h3 class="section-title">Crew status</h3>`);
      parts.push(roster.map((c) => this.#statusLine(
        `${c.name} · ${c.role}`,
        `${c.status} · fatigue ${Math.round(c.fatigue)}%`,
        !c.alive ? 'bad' : c.sleeping ? 'ok' : c.fatigue >= FATIGUE.severe ? 'bad' : c.fatigue >= FATIGUE.moderate ? 'warn' : 'ok',
      )).join(''));
      parts.push(this.#note(
        'Four berths line the habitat hull. Every astronaut needs <strong>4 simulated hours</strong> in one each Sol; '
          + 'the rotation is staggered so only one specialist is offline at a time, and you cover the gap.',
      ));
      parts.push(this.#actions([
        ['Open crew assignments', 'crew', null, 'Postings, fatigue and rest windows'],
        [s.player.sleeping ? 'Get up from the bunk' : 'Rest here (4 h)', 'rest-player', null, 'Pulls the camera back to the colony overview', !s.player.alive],
        ['Open telemetry', 'telemetry', null, 'Power loads, reserves and propellant'],
      ]));
    }

    if (f.id === 'bio') {
      const readyCount = s.plots.filter((p) => p.mature).length;
      parts.push(this.#stats([
        ['Water reserve', pct(s.water), `${d.flow.water.toFixed(2)}/s`, s.water < 20 ? 'bad' : s.water < 35 ? 'warn' : ''],
        ['Grow lights', d.powered.grow ? 'Powered' : 'OFF', `draws ${POWER.grow} units`, d.powered.grow ? 'good' : 'warn'],
        ['Ready to harvest', String(readyCount), `of ${s.plots.length} beds`],
      ]));

      parts.push(`<h3 class="section-title">Crop beds</h3>`);
      s.plots.forEach((plot, i) => {
        const p = Math.round(plot.growth * 100);
        parts.push(`
          <div class="status-line">
            <span class="label">Bed ${i + 1} · ${plot.mature ? 'mature' : 'growing'}</span>
            <span class="value">${plot.mature ? 'READY' : p + '%'}</span>
            <span class="meter ${plot.mature ? 'good' : ''}" style="width:120px"><i style="width:${p}%"></i></span>
            <button class="action" data-action="harvest" data-arg="${i}" ${plot.mature ? '' : 'disabled'}>Harvest</button>
          </div>`);
      });

      const cropWater = RATES.cropWaterPerPlot * s.plots.filter((p) => !p.mature).length;
      parts.push(this.#note(
        `Crops consume <strong>${num(cropWater)} water/s</strong> while growing and need both water and grow lights. ` +
          (sim.crewAt('bio')
            ? 'A crew member is posted here and will harvest automatically.'
            : 'Post the botanist here and harvesting becomes automatic.'),
      ));
    }

    if (f.id === 'solar') {
      const cooldown = Math.ceil(this.player.cleanCooldown);
      parts.push(this.#stats([
        ['Array output', num(d.solar), 'power units', broken ? 'bad' : ''],
        ['Panel dust', pct(s.dust * 100), 'cuts output up to 55%', s.dust > 0.45 ? 'warn' : ''],
        ['Weather', s.storm.active ? 'DUST STORM' : 'Clear', s.storm.active ? `${Math.ceil(s.storm.timeLeft)} s left` : '', s.storm.active ? 'bad' : ''],
      ]));

      if (broken) {
        const repairing = sim.crewAt('solar');
        parts.push(this.#note(
          repairing
            ? `<strong>${esc(repairing.name)}</strong> is repairing the array field — ${Math.round(s.repair.solar * 100)}% done.`
            : 'The arrays are damaged and producing nothing. Assign the engineer here, or repair them yourself.',
        ));
        parts.push(this.#actions([
          [this.player.repair ? 'Repair in progress…' : `Repair arrays (${PLAYER.repairSeconds} s)`, 'repair', null, 'You stay at the facility while it runs', Boolean(this.player.repair)],
        ], true));
      } else {
        parts.push(this.#actions([
          [`Clean panels${cooldown > 0 ? ` (${cooldown}s)` : ''}`, 'clean', null, 'Resets dust to zero', cooldown > 0, true],
        ], true));
      }

      parts.push(this.#note(
        `Dust builds up continuously${s.storm.active ? ' and storms accelerate it' : ''}. A crew member on maintenance duty cleans slowly but constantly.`,
      ));
    }

    if (f.id === 'bat') {
      parts.push(this.#stats([
        ['Battery', pct(s.battery), `${POWER.batteryCapacity}% capacity`, s.battery < 15 ? 'bad' : s.battery < 30 ? 'warn' : 'good'],
        ['Generation', num(d.solar + (s.backup.active ? POWER.backupUnits : 0)), s.backup.active ? 'incl. RTG' : 'solar only'],
        ['Demand', num(d.demand), d.shed.length ? `shed: ${d.shed.join(', ')}` : 'all loads served', d.shed.length ? 'warn' : ''],
      ]));
      parts.push(this.#systemToggles());
      parts.push(this.#note('If the battery hits zero, loads are shed automatically in this order: <strong>propellant → research → rover → grow lights → water → oxygen</strong>. Life support is last, not first.'));
    }

    if (f.id === 'aqua') {
      const remaining = s.sites.reduce((t, d2) => t + (d2.kind === 'ice' ? d2.remaining : 0), 0);
      parts.push(this.#stats([
        ['Water reserve', pct(s.water), `${d.flow.water.toFixed(2)}/s`, s.water < 20 ? 'bad' : s.water < 35 ? 'warn' : ''],
        ['Ice hopper', `${s.ice.toFixed(0)} kg`, `${num(d.iceRate)} kg/s melted`, s.ice < 40 ? 'warn' : 'good'],
        ['Production', num(d.waterProduction), `${pct(WATER.iceToWater * 100)} reserve per kg ice`, d.waterProduction > 0 ? 'good' : 'bad'],
        ['Plant status', broken ? 'DAMAGED' : 'Nominal', broken ? `${Math.round(s.repair.aqua * 100)}% repaired` : `recycler returns ${pct(WATER.recycle * 100)}`, broken ? 'bad' : 'good'],
      ]));
      if (broken) {
        parts.push(this.#actions([
          [this.player.repair ? 'Repair in progress…' : `Repair AQUA-Core (${PLAYER.repairSeconds} s)`, 'repair', null, 'Or post the engineer here', Boolean(this.player.repair)],
        ], true));
        parts.push(this.#note('Water feeds the crew and the crops. Every second of downtime costs you twice.'));
      } else {
        parts.push(this.#note(
          sim.crewAt('aqua')
            ? `A crew member is stationed here: melting ${(d.iceRate).toFixed(2)} kg of ice per second.`
            : 'No crew here, so the melter runs at reduced rate.',
        ));
      }
      parts.push(this.#note(
        `<strong>There is no water generator.</strong> The only source is ice ROVER-01 hauls in, and ${remaining.toFixed(0)} kg of mapped ice is left in the field. `
          + `When the deposits run out, the recycler's ${pct(WATER.recycle * 100)} recovery is all that stands between the colony and dry tanks.`,
      ));
    }

    if (f.id === 'o2') {
      parts.push(this.#stats([
        ['Oxygen reserve', pct(s.oxygen), `${d.flow.oxygen.toFixed(2)}/s`, s.oxygen < 25 ? 'bad' : s.oxygen < 45 ? 'warn' : ''],
        ['Production', num(d.oxygenProduction), d.oxygenProduction > 0 ? 'MOXIE running' : 'MOXIE stopped', d.oxygenProduction > 0 ? 'good' : 'bad'],
        ['Plant status', broken ? 'DAMAGED' : 'Nominal', broken ? `${Math.round(s.repair.o2 * 100)}% repaired` : '', broken ? 'bad' : 'good'],
      ]));
      if (broken) {
        parts.push(this.#actions([
          [this.player.repair ? 'Repair in progress…' : `Repair MOXIE (${PLAYER.repairSeconds} s)`, 'repair', null, 'Or post the engineer here', Boolean(this.player.repair)],
        ], true));
      }
      parts.push(this.#note(
        `Crew demand is ${num(RATES.oxygenUsePerCrew * RATES.crewCount * this.sim.difficulty.consumption)} O₂/s. ` +
          'If oxygen reaches zero the mission ends. An astronaut who runs out of air, water or food does not come back.',
      ));
    }

    if (f.id === 'sci') {
      const active = s.topics.find((t) => t.id === s.activeTopic);
      parts.push(this.#stats([
        ['Research points', Math.round(s.researchPoints).toString(), `resupply needs ${CHOICES.resupplyCost}`],
        ['Active topic', active ? active.name : 'none', active ? `${Math.round((active.progress / active.cost) * 100)}%` : 'pick one in the research queue'],
        ['Rate', `×${(1 + sim.derived.factor.sci).toFixed(2)}`, d.powered.research ? 'powered' : 'no power', d.powered.research ? 'good' : 'warn'],
      ]));
      parts.push(this.#actions([['Open research queue', 'research', null, 'Six programmes, permanent effects', true]]));
      parts.push(this.#note('Research keeps running while you walk around — but it stops whenever the power budget is shed or the battery is empty.'));
    }

    if (f.id === 'comms') {
      parts.push(this.#stats([
        ['Research points', Math.round(s.researchPoints).toString(), `need ${CHOICES.resupplyCost}`],
        ['Resupply', s.resupply.used ? 'USED' : 'available', 'one request per mission', s.resupply.used ? 'warn' : 'good'],
        ['Link', 'Nominal', 'local simulation, offline build'],
      ]));
      parts.push(this.#actions([
        [
          s.resupply.used ? 'Resupply already used' : `Request resupply (−${CHOICES.resupplyCost} research)`,
          'resupply',
          null,
          `+${CHOICES.resupplyGain.oxygen} O₂ · +${CHOICES.resupplyGain.water} water · +${CHOICES.resupplyGain.food} food`,
          s.resupply.used || s.researchPoints < CHOICES.resupplyCost,
          true,
        ],
      ], true));
      parts.push(this.#note('Trading research progress for supplies is sometimes the only way to survive a bad sol. It is a one-time trade.'));
    }

    if (f.id === 'shelter') {
      const b = s.backup;
      const rad = s.radiation;
      parts.push(this.#stats([
        ['Storm', s.storm.active ? 'ACTIVE' : s.storm.fired ? 'passed' : 'expected', s.storm.active ? `${Math.ceil(s.storm.timeLeft)} s` : 'solar loss 65%', s.storm.active ? 'bad' : ''],
        ['Radiation', rad.phase === 'none' ? 'clear' : rad.phase.toUpperCase(), rad.phase === 'warning' ? `spike in ${Math.ceil(rad.timeLeft)} s` : rad.phase === 'peak' ? 'shelter until it passes' : 'telemetry monitored', rad.phase === 'none' ? '' : 'bad'],
        ['Crew', s.crewSheltered ? 'SHELTERED' : 'at posts', s.crewSheltered ? 'outdoor posts unmanned' : 'working their assignments', s.crewSheltered ? 'warn' : 'good'],
        ['RTG charges', String(b.charges), `+${POWER.backupUnits} power for ${POWER.backupDuration} s`, b.charges ? 'good' : 'warn'],
      ]));
      parts.push(this.#actions([
        [s.crewSheltered ? 'Recall crew to posts' : 'Shelter the crew', s.crewSheltered ? 'recall-crew' : 'shelter-crew', null, s.crewSheltered ? 'Ends their rest and sends them back' : 'They walk in now; outdoor output stops', false],
        [b.active ? 'RTG already running' : 'Activate backup RTG', 'backup', null, `${b.charges} charge(s) left`, b.active || b.charges <= 0, true],
      ], true));
      parts.push(this.#note(
        'Sheltering protects the crew from a solar radiation event, but every post outside the habitat is unmanned while they are in here — '
          + 'that is a production decision, not a free button. The bunker also holds an independent power source: the cheapest way through a dust storm.',
      ));
    }

    if (f.id === 'rover') {
      const r = s.rover;
      const status = sim.roverStatus();
      const active = sim.roverActive();
      const progressPct = Math.round(sim.roverProgress() * 100);
      const site = r.survey >= 0 ? SITES[r.survey] : null;
      const mission = MISSIONS.find((m) => m.kind === r.mission);

      parts.push(this.#stats([
        ['Status', status, site ? `${site.name} · ${progressPct}%` : `${r.trips} trip(s) logged`, r.malfunction ? 'bad' : active ? 'good' : ''],
        ['Mission', mission ? mission.label : 'No orders', r.cargo ? `bay holds ${r.cargo.kg} kg ${r.cargo.kind}` : 'bay empty', r.cargo ? 'good' : ''],
        ['Last report', r.result ? (r.result.success ? 'SECURED' : 'DRY') : '—', r.result ? `${r.result.site} · Sol ${r.result.sol}` : 'no run on file', r.result && !r.result.success ? 'warn' : ''],
        ['Ice hauled', `${r.iceCollected} kg`, `${iceRemaining(s).toFixed(0)} kg ice left in the field`],
        ['Power draw', `${POWER.rover}${['outbound', 'collecting', 'returning'].includes(r.phase) ? ` +${ROVER.travelDemand}` : ''}`, 'units while deployed', s.systems.rover ? '' : 'warn'],
      ]));

      if (r.result) {
        const label = MATERIAL_LABEL[r.result.kind] ?? String(r.result.kind).toUpperCase();
        parts.push(this.#note(
          r.result.success
            ? `<strong>ROVER-01 REPORT: ${esc(label)} DEPOSIT FOUND. MATERIAL SECURED.</strong> ${r.result.kg} kg at ${esc(r.result.site)}`
              + (r.cargo ? ' — still in the bay, so the find is not banked until it drives in.' : ' — already unloaded.')
            : `<strong>ROVER-01 REPORT: NO USABLE ${esc(label)} DEPOSIT FOUND. RETURNING EMPTY.</strong> `
              + `${esc(r.result.site)} came up dry; ${s.stats.dryTrips} dry run(s) logged.`,
        ));
      }

      if (r.malfunction) {
        const nearby = this.rover
          ? Math.hypot(this.player.position.x - this.rover.position.x, this.player.position.z - this.rover.position.z) < PLAYER.interactRadius + 3
          : false;
        parts.push(this.#note(
          this.sim.crewAt('rover')
            ? `<strong>${esc(this.sim.crewAt('rover').name)}</strong> is chasing the fault — ${Math.round(r.repairProgress * 100)}% done.`
            : nearby
              ? `ROVER-01 has stopped${site ? ` out at ${esc(site.name)}` : ' on its pad'}. You are beside it — start the repair and stay there.`
              : `ROVER-01 has stopped${site ? ` out at ${esc(site.name)}` : ' on its pad'}. Walk to it and repair it by hand, or post the engineer at its bay.`,
        ));
        parts.push(this.#actions([
          [this.player.repair ? 'Repair in progress…' : `Repair ROVER-01 (${PLAYER.repairSeconds} s)`, 'repair-rover', null, 'Stay beside the rover while it runs', Boolean(this.player.repair)],
        ], true));
      } else {
        parts.push(`<h3 class="section-title">Mission types</h3>`);
        parts.push(this.#actions(
          MISSIONS.map((m) => {
            const idx = sim.bestSiteFor(m.kind);
            const left = s.sites.reduce((t, dep, i) => t + (SITES[i].kind === m.kind ? dep.remaining : 0), 0);
            return [
              m.label,
              'dispatch-kind',
              m.kind,
              `${left.toFixed(0)} kg mapped · unloads at ${m.target === 'aqua' ? 'AQUA-Core' : 'FUEL-PROCESSOR'}`,
              active || idx < 0 || !s.systems.rover,
            ];
          }),
          true,
        ));

        parts.push(`<h3 class="section-title">Mapped deposits</h3>`);
        SITES.forEach((dep, i) => {
          const route = roverRoute(i);
          const left = s.sites[i]?.remaining ?? 0;
          const locked = active || r.malfunction || !s.systems.rover || left <= 0;
          parts.push(`
            <div class="status-line">
              <span class="label"><span class="swatch" style="background:${SITE_TINT[dep.kind]}"></span>${esc(dep.name)} <span class="dim">${dep.dist} m · ${esc(dep.kind)}</span></span>
              <span class="meter ${left > dep.capacity * 0.35 ? 'good' : left > 0 ? 'warn' : 'bad'}" style="width:100px"><i style="width:${Math.max(0, (left / dep.capacity) * 100)}%"></i></span>
              <span class="value">${left.toFixed(0)}/${dep.capacity} kg · ${route.total.toFixed(0)} s</span>
              <button class="action" data-action="dispatch" data-arg="${i}" ${locked ? 'disabled' : ''}>Dispatch</button>
            </div>`);
        });
        parts.push(this.#note(
          active
            ? 'ROVER-01 is on a run — it drives out, drills, rolls the find, hauls the load in and returns to recharge. It is support equipment; you stay on foot.'
            : `Fuel runs are a real gamble: the drill finds usable material about <strong>${pct(PROSPECT_CHANCE * 100)}</strong> of the time and the bay comes back empty otherwise. `
              + 'Ice is proven ground — a site loads until it is worked out. Choose the deposit by hand to spend the drive on the store you actually need.',
        ));
      }
    }

    if (f.id === 'fuel') {
      const licensed = sim.fuelLicensed();
      const powered = d.powered.fuel;
      const need = {
        carbon: FUEL.recipe.carbon * ROCKET.capacity,
        oxygen: FUEL.recipe.oxygen * ROCKET.capacity,
        hydrogen: FUEL.recipe.hydrogen * ROCKET.capacity,
      };

      parts.push(this.#stats([
        ['Propellant tank', pct(s.fuel.percent), `${ROCKET.capacity}% fills a full load`, s.fuel.percent >= ROCKET.capacity ? 'good' : s.fuel.percent > 0 ? 'warn' : ''],
        ['Licence', licensed ? 'IN FORCE' : 'NOT RESEARCHED', licensed ? 'Sabatier + LOX' : 'compulsory SCI-Lab topic', licensed ? 'good' : 'bad'],
        ['Line status', s.fuel.making ? (broken ? 'HALTED — damaged' : 'MANUFACTURING') : 'IDLE', broken ? `${Math.round(s.repair.fuel * 100)}% repaired` : powered ? `${POWER.fuelPlant} units drawn` : 'no served power', broken || !powered ? 'bad' : s.fuel.making ? 'good' : ''],
        ['Staffing', sim.crewAt('fuel') ? esc(sim.crewAt('fuel').name) : 'Unmanned', `×${(FUEL.unstaffed + (1 - FUEL.unstaffed) * d.factor.fuel).toFixed(2)} harvest rate`, sim.crewAt('fuel') ? 'good' : 'warn'],
      ]));

      parts.push(`<h3 class="section-title">Feedstock stores</h3>`);
      for (const kind of ['carbon', 'oxygen', 'hydrogen']) {
        const have = s.fuel[kind];
        const store = FUEL.store[kind];
        const short = have < FUEL.recipe[kind];
        parts.push(`
          <div class="status-line">
            <span class="label"><span class="swatch" style="background:${SITE_TINT[kind]}"></span>${MATERIAL_LABEL[kind]}</span>
            <span class="meter ${have > store * 0.35 ? 'good' : short ? 'bad' : 'warn'}" style="width:120px"><i style="width:${Math.min(100, (have / store) * 100)}%"></i></span>
            <span class="value ${short ? 'bad-text' : ''}">${have.toFixed(0)} / ${store} kg · needs ${need[kind].toFixed(0)}</span>
          </div>`);
      }

      if (broken) {
        parts.push(this.#actions([
          [this.player.repair ? 'Repair in progress…' : `Repair the plant (${PLAYER.repairSeconds} s)`, 'repair', null, 'Or post the engineer at FUEL-PROCESSOR', Boolean(this.player.repair)],
        ], true));
      }

      parts.push(this.#actions([
        licensed
          ? s.fuel.making
            ? ['Stop the line', 'fuel-stop', null, 'Interrupting costs you the batch clock', false]
            : ['Start propellant line', 'fuel-start', null,
              s.fuel.percent >= ROCKET.capacity ? 'Plant tank already full' : `Consumes ${FUEL.recipe.carbon}/${FUEL.recipe.oxygen}/${FUEL.recipe.hydrogen} kg C/O/H per 1%`,
              !sim.fuelCanMake()]
          : ['Fuel licence required', 'fuel-start', null, 'Research Martian Fuel Production Technology first', true],
        s.fuel.percent > 0
          ? ['Transfer to M3', 'fuel-transfer', null,
            `${s.fuel.percent.toFixed(0)}% plant tank → M3 (${FUEL.transferSeconds} s of line pressure)`,
            s.rocket.transferring || s.rocket.percent >= ROCKET.capacity - 0.05]
          : ['Transfer to M3', 'fuel-transfer', null, 'Plant tank empty — run the propellant line first', true],
      ], true));

      parts.push(this.#note(
        'Carbon and oxygen are stripped from the Martian atmosphere; hydrogen is electrolysed out of the <strong>same water reserve the crew drinks</strong>. '
          + 'A posted engineer roughly doubles the harvest, and every feedstock store is capped — the plant must run while you spend it, not after.',
      ));
      if (s.fuel.interrupted > 0 && !s.fuel.making) {
        parts.push(this.#note(`<strong class="bad-text">Line stopped ${Math.round(s.fuel.interrupted)} s after start.</strong> A store ran dry or power dropped. Clear the cause and restart.`));
      }
    }

    if (f.id === 'pad') {
      const rk = s.rocket;
      const ready = sim.launchReady();
      const readiness = sim.missionReadiness();

      parts.push(this.#stats([
        ['M3 propellant', pct(rk.percent), rk.transferring ? `${Math.ceil(rk.transferLeft)} s of transfer` : rk.ready ? 'tanks full' : 'loading line cold', rk.ready ? 'good' : rk.percent > 0 ? 'warn' : ''],
        ['Status', rk.launched ? 'AWAY' : rk.ready ? 'READY FOR LAUNCH' : 'NOT READY', rk.launched ? 'crew is in transit' : 'launch console interlocked', rk.launched || rk.ready ? 'good' : 'bad'],
        ['Crew aboard', `${this.sim.crewRoster().filter((c) => c.alive).length}/4`, 'all four must survive to lift off', this.sim.crewRoster().every((c) => c.alive) ? 'good' : 'bad'],
        ['Plant tank', pct(s.fuel.percent), s.fuel.percent > 0 ? 'ready to top up the M3' : 'run the line to make propellant', s.fuel.percent > 0 ? 'good' : 'warn'],
      ]));

      parts.push(`<h3 class="section-title">Launch board — ${readiness.filter((c) => c.done).length}/${readiness.length}</h3>`);
      parts.push(readiness.map((c) => this.#statusLine(c.label, c.detail, c.done ? 'ok' : 'warn')).join(''));

      parts.push(this.#actions([
        rk.percent < ROCKET.capacity - 0.05
          ? ['Transfer propellant', 'fuel-transfer', null,
            `plant tank (${s.fuel.percent.toFixed(0)}%) → M3 tanks (${FUEL.transferSeconds} s)`,
            rk.transferring || s.fuel.percent <= 0]
          : ['Tanks full', 'fuel-transfer', null, 'Nothing left to load', true],
        [
          rk.launched ? 'M3 is away' : ready ? 'LAUNCH — carry the crew home' : 'Launch interlocked',
          'launch', null,
          ready ? 'Ends the mission' : `outstanding: ${readiness.filter((c) => !c.done).slice(0, 2).map((c) => c.label).join(', ')}`,
          !ready || rk.launched,
          true,
        ],
      ], true));

      parts.push(this.#note(
        'M3 has been standing on this pad since the landing burn, empty because its transfer stage never fuelled at home. '
          + 'The console will not release the clamps until every objective on the board is green — surviving ten Sols alone is not the mission.',
      ));
    }

    return parts.join('');
  }

  /* ───────────────────────────── shared blocks ───────────────────────────── */

  #stats(items) {
    return `<div class="stat-grid">${items
      .map(
        ([k, v, s, cls = '']) =>
          `<div class="stat ${cls}"><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`,
      )
      .join('')}</div>`;
  }

  #statusLine(label, value, dot = 'ok') {
    return `<div class="status-line"><span class="label"><span class="dot ${dot === 'ok' ? '' : dot}"></span>${esc(label)}</span><span class="value">${esc(value)}</span></div>`;
  }

  #actions(items, primary = false) {
    return `<div class="action-row">${items
      .map(
        ([label, action, arg, sub, disabled]) =>
          `<button class="action ${primary ? 'primary' : ''}" data-action="${action}" ${arg ? `data-arg="${arg}"` : ''} ${disabled ? 'disabled' : ''}>${label}${sub ? `<small>${sub}</small>` : ''}</button>`,
      )
      .join('')}</div>`;
  }

  #note(html) {
    return `<p class="note">${html}</p>`;
  }

  #systemToggles() {
    const s = this.sim.state;
    const d = this.sim.derived;
    const rows = [
      ['grow', 'Grow lights', `BIO-Dome · ${POWER.grow} units`],
      ['water', 'Water processing', `AQUA-Core · ${POWER.water} units`],
      ['oxygen', 'O₂ production', `O2-MOXIE · ${POWER.oxygen} units`],
      ['research', 'Research power', `SCI-Lab · ${POWER.research} units`],
      ['rover', 'Rover charging', `ROVER-01 · ${POWER.rover} units`],
      ['fuel', 'Propellant plant', `FUEL-PROCESSOR · ${POWER.fuel} idle / ${POWER.fuelPlant} making`],
    ];

    return `
      <h3 class="section-title">Load control</h3>
      <div class="toggle-list">
        ${rows
          .map(([id, label, sub]) => {
            const on = s.systems[id];
            const served = d.powered[id];
            const state = !on ? 'off' : served ? 'on' : 'shed';
            return `<div class="toggle-row">
              <div><div class="t-label">${label}</div><div class="t-sub">${sub}${!on ? ' · switched off' : served ? '' : ' · shed by brownout'}</div></div>
              <button class="switch ${on ? 'on' : ''}" data-action="toggle" data-arg="${id}" aria-label="Toggle ${label}"></button>
            </div>`;
          })
          .join('')}
        <div class="toggle-row">
          <div><div class="t-label">Night rationing</div><div class="t-sub">Sheds propellant harvest, research, grow lights and rover after dark</div></div>
          <button class="switch ${s.nightRationing ? 'on' : ''}" data-action="rationing" aria-label="Toggle night rationing"></button>
        </div>
      </div>`;
  }

  /* ───────────────────────────── crew ───────────────────────────── */

  #crewBody() {
    const sim = this.sim;
    const s = sim.state;
    const hour = sim.solHour();
    const fmt = (h) => `${String(Math.floor(h)).padStart(2, '0')}:00`;

    const rows = s.crew.map((c) => {
      const specialist = sim.isSpecialist(c);
      const post = POSTS.find((p) => p.id === c.postId);
      const options = POSTS.map(
        (p) => `<option value="${c.id}|${p.id}" ${p.id === c.postId ? 'selected' : ''}>${p.label} — ${p.short}</option>`,
      ).join('');
      const fatigueClass = c.fatigue >= FATIGUE.severe ? 'bad' : c.fatigue >= FATIGUE.moderate ? 'warn' : 'good';
      const window = `${fmt(c.shift)}–${fmt(c.shift + SLEEP.hours)}`;
      const sleeping = c.sleeping;
      return `
        <div class="crew-card ${specialist ? '' : 'mismatch'}">
          <div class="top"><span class="name">${esc(c.name)}</span><span class="role">${esc(c.role)} · ${esc(c.status)}</span></div>
          <p class="quote">“${esc(c.line)}”</p>
          <div class="status-line">
            <span class="label">Fatigue</span>
            <span class="meter ${fatigueClass}" style="width:150px"><i style="width:${Math.min(100, c.fatigue)}%"></i></span>
            <span class="value">${Math.round(c.fatigue)}% · ×${sim.fatigueFactor(c).toFixed(2)} output</span>
          </div>
          <div class="status-line">
            <span class="label">Health</span>
            <span class="meter ${c.health < 45 ? 'bad' : c.health < 70 ? 'warn' : 'good'}" style="width:150px"><i style="width:${Math.max(0, c.health)}%"></i></span>
            <span class="value">${Math.round(c.health)}% · rested ${c.sleptHours.toFixed(1)}/${FATIGUE.requiredRestHours} h</span>
          </div>
          <div class="status-line">
            <span class="label">Rest window</span>
            <span class="value">${window}${sleeping ? ' · IN BUNK' : hour >= c.shift && hour < c.shift + SLEEP.hours ? ' · due now' : ''}</span>
            <button class="action" data-action="rest-shift" data-arg="${c.id}|-1" ${sleeping ? 'disabled' : ''}>−1 h</button>
            <button class="action" data-action="rest-shift" data-arg="${c.id}|1" ${sleeping ? 'disabled' : ''}>+1 h</button>
            <button class="action" data-action="rest-now" data-arg="${c.id}" ${sleeping ? 'disabled' : ''}>Send to bunk</button>
          </div>
          <select data-action="assign" ${sleeping || !c.alive ? 'disabled' : ''}>${options}</select>
          <div class="effect">${
            !c.alive
              ? 'Lost. No assignment, no rest — the roster is one person short.'
              : sleeping
              ? `Asleep until ${fmt((c.shift + SLEEP.hours) % 24)}. Assignments are locked while they are in the bunk.`
              : specialist
              ? `Specialist post: full effect, less fatigue penalty (${esc(post ? post.blurb : '')}).`
              : 'Off-speciality post: 45% effect. Worth it only in an emergency.'
          }</div>
        </div>`;
    }).join('');

    const p = s.player;
    const timeline = Array.from({ length: FATIGUE.hoursPerSol }, (_, h) => {
      const who = [...s.crew, p].filter((c) => c.alive && (c.id === 'player'
        ? h >= p.shift && h < p.shift + SLEEP.hours
        : h >= c.shift && h < c.shift + SLEEP.hours)).map((c) => c.name.split(' ')[0]);
      return `<i class="slot ${who.length ? 'lit' : ''}" title="${who.join(', ') || 'full crew on duty'}"></i>`;
    }).join('');

    return `
      ${rows}
      <div class="status-line">
        <span class="label">You · Commander · ${esc(p.status)}</span>
        <span class="meter ${p.fatigue >= FATIGUE.severe ? 'bad' : p.fatigue >= FATIGUE.moderate ? 'warn' : 'good'}" style="width:150px"><i style="width:${Math.min(100, p.fatigue)}%"></i></span>
        <span class="value">${Math.round(p.fatigue)}% · rested ${p.sleptHours.toFixed(1)}/${FATIGUE.requiredRestHours} h</span>
        <button class="action" data-action="rest-player">${p.sleeping ? 'Leave the bunk' : 'Rest 4 h'}</button>
      </div>

      <h3 class="section-title">Rest rotation across the Sol</h3>
      <div class="shift-strip">${timeline}</div>
      <p class="note">Sol hour ${Math.floor(hour)} now. The windows never overlap, so one pair of hands is always offline — and the post they leave empty is yours to cover, or the line stops.</p>

      <h3 class="section-title">Postings ledger</h3>
      <div class="stat-grid">
        <div class="stat"><div class="k">Posts staffed</div><div class="v">${sim.derived.totalStaffed}/3</div><div class="s">${POSTS.length} posts on the board</div></div>
        <div class="stat"><div class="k">Fleet output</div><div class="v">×${sim.derived.efficiency.toFixed(2)}</div><div class="s">colony-wide fatigue factor</div></div>
        <div class="stat ${s.stats.missedRest ? 'bad' : 'good'}"><div class="k">Missed rest</div><div class="v">${s.stats.missedRest}</div><div class="s">short sleeps since landing</div></div>
      </div>
      <p class="note">Fatigue is a production stat, not decoration: past ${FATIGUE.moderate}% output slips to ×${FATIGUE.efficiency.moderate}, past ${FATIGUE.severe}% it is ×${FATIGUE.efficiency.severe} and ${pct(FATIGUE.mistakeChance * 100)} per Sol something gets mis-set. At ${FATIGUE.exhausted}% the body will not stay upright.</p>`;
  }

  /* ───────────────────────────── research ───────────────────────────── */

  #researchBody() {
    const sim = this.sim;
    const s = sim.state;
    const d = sim.derived;

    const cards = s.topics
      .map((t) => {
        const progress = Math.round((t.progress / t.cost) * 100);
        const isActive = s.activeTopic === t.id;
        return `
          <div class="research-card ${t.done ? 'done' : ''} ${isActive ? 'active' : ''} ${t.compulsory ? 'compulsory' : ''}">
            <div class="top">
              <span class="name">${esc(t.name)}${t.compulsory ? ' <span class="tag compulsory">compulsory</span>' : ''}</span>
              <span class="tag ${t.done ? 'done' : isActive ? 'active' : ''}">${t.done ? 'complete' : isActive ? 'running' : 'available'}</span>
            </div>
            <p class="summary">${esc(t.summary)}</p>
            <div class="meter ${t.done ? 'good' : isActive ? '' : 'warn'}"><i style="width:${t.done ? 100 : progress}%"></i></div>
            <div class="action-row" style="margin-top:10px">
              <button class="action" data-action="research-start" data-arg="${t.id}" ${t.done || isActive || !d.powered.research ? 'disabled' : ''}>
                ${t.done ? 'Completed' : isActive ? `${progress}% — running` : 'Start research'}
                <small>${t.cost} research points</small>
              </button>
            </div>
          </div>`;
      })
      .join('');

    return `
      <div class="stat-grid">
        <div class="stat ${d.powered.research ? 'good' : 'warn'}"><div class="k">Research power</div><div class="v">${d.powered.research ? 'ONLINE' : 'SHED'}</div><div class="s">${POWER.research} units</div></div>
        <div class="stat"><div class="k">Rate</div><div class="v">×${(1 + d.factor.sci).toFixed(2)}</div><div class="s">${sim.crewAt('sci') ? esc(sim.crewAt('sci').name) + ' at SCI-Lab' : 'no scientist posted'}</div></div>
        <div class="stat"><div class="k">Completed</div><div class="v">${sim.completedTopics()}/${s.topics.length}</div><div class="s">${CHOICES.successResearch} needed for the return window</div></div>
      </div>
      <h3 class="section-title">Programmes</h3>
      <div class="research-list">${cards}</div>
      ${sim.fuelLicensed() ? '' : '<p class="note"><strong>MARTIAN FUEL PRODUCTION TECHNOLOGY is compulsory.</strong> Until it completes the FUEL-PROCESSOR cannot manufacture propellant — the plant is dead steel, however much carbon you bank.</p>'}`;
  }

  /* ───────────────────────────── telemetry ───────────────────────────── */

  #telemetryBody() {
    const sim = this.sim;
    const s = sim.state;
    const d = sim.derived;
    const warnings = sim.warnings();
    const readiness = sim.missionReadiness();
    const done = readiness.filter((c) => c.done).length;
    const fuelTotal = sim.crewRoster().reduce((t, c) => t + c.fatigue, 0) / sim.crewRoster().length;

    return `
      <div class="stat-grid">
        <div class="stat ${s.battery < 15 ? 'bad' : s.battery < 30 ? 'warn' : 'good'}"><div class="k">Battery</div><div class="v">${pct(s.battery)}</div><div class="s">${d.net >= 0 ? '+' : ''}${d.net.toFixed(0)} net units</div></div>
        <div class="stat"><div class="k">Generation</div><div class="v">${num(d.solar + (s.backup.active ? POWER.backupUnits : 0))}</div><div class="s">solar ${num(d.solar)}${s.backup.active ? ' + RTG' : ''}</div></div>
        <div class="stat"><div class="k">Demand</div><div class="v">${num(d.demand)}</div><div class="s">${d.shed.length ? 'shed: ' + d.shed.join(', ') : 'all loads served'}</div></div>
        <div class="stat"><div class="k">Sol</div><div class="v">${s.sol}</div><div class="s">hour ${String(Math.floor(s.hour)).padStart(2, '0')}:00 · ${CHOICES.successSol} sols to the window</div></div>
      </div>

      <h3 class="section-title">Journey home</h3>
      <div class="stat-grid">
        <div class="stat"><div class="k">Ice hopper</div><div class="v">${s.ice.toFixed(0)} kg</div><div class="s">${iceRemaining(s).toFixed(0)} kg left in the field</div></div>
        <div class="stat"><div class="k">Carbon</div><div class="v">${s.fuel.carbon.toFixed(0)} kg</div><div class="s">store ${FUEL.store.carbon} · needs ${(FUEL.recipe.carbon * ROCKET.capacity).toFixed(0)}</div></div>
        <div class="stat"><div class="k">Oxygen (propellant)</div><div class="v">${s.fuel.oxygen.toFixed(0)} kg</div><div class="s">store ${FUEL.store.oxygen} · needs ${(FUEL.recipe.oxygen * ROCKET.capacity).toFixed(0)}</div></div>
        <div class="stat"><div class="k">Hydrogen</div><div class="v">${s.fuel.hydrogen.toFixed(0)} kg</div><div class="s">store ${FUEL.store.hydrogen} · needs ${(FUEL.recipe.hydrogen * ROCKET.capacity).toFixed(0)}</div></div>
        <div class="stat ${s.fuel.percent >= ROCKET.capacity ? 'good' : 'warn'}"><div class="k">Plant tank</div><div class="v">${pct(s.fuel.percent)}</div><div class="s">${s.fuel.making ? `making ${num(d.fuelRate)}%/s` : 'line idle'}</div></div>
        <div class="stat ${s.rocket.ready ? 'good' : 'warn'}"><div class="k">M3 propellant</div><div class="v">${pct(s.rocket.percent)}</div><div class="s">${s.rocket.transferring ? `${Math.ceil(s.rocket.transferLeft)} s transfer` : s.rocket.ready ? 'tanks full' : 'not loaded'}</div></div>
        <div class="stat"><div class="k">Rover run</div><div class="v">${s.rover.mission ? MATERIAL_LABEL[s.rover.mission] : 'no orders'}</div><div class="s">${s.rover.result ? (s.rover.result.success ? `${s.rover.result.kg} kg secured` : 'returned empty') : 'awaiting report'}</div></div>
        <div class="stat ${done === readiness.length ? 'good' : 'warn'}"><div class="k">Mission board</div><div class="v">${done}/${readiness.length}</div><div class="s">${readiness.filter((c) => !c.done)[0]?.label ?? 'all conditions met'}</div></div>
      </div>

      <h3 class="section-title">Crew</h3>
      <div>
        ${sim.crewRoster().map((c) => this.#statusLine(
          `${c.name} · ${c.role}`,
          `${c.status} · fatigue ${Math.round(c.fatigue)}% · rested ${c.sleptHours.toFixed(1)} h`,
          !c.alive ? 'bad' : c.sleeping ? 'ok' : c.fatigue >= FATIGUE.severe ? 'bad' : c.fatigue >= FATIGUE.moderate ? 'warn' : 'ok',
        )).join('')}
      </div>
      <p class="note">Average fatigue ${Math.round(fuelTotal)}%. Colony-wide output is running at ×${d.efficiency.toFixed(2)} of rated.</p>

      ${this.#systemToggles()}
      <h3 class="section-title">System state</h3>
      <div>
        ${this.#statusLine('Solar arrays', s.failures.solar ? 'damaged' : d.solar > 1 ? 'producing' : 'no sunlight', s.failures.solar ? 'bad' : d.solar > 1 ? 'ok' : 'warn')}
        ${this.#statusLine('AQUA-Core', s.failures.aqua ? 'damaged' : d.iceRate > 0 ? `melting ${num(d.iceRate)} kg/s` : 'no ice to melt', s.failures.aqua ? 'bad' : d.iceRate > 0 ? 'ok' : 'warn')}
        ${this.#statusLine('O2-MOXIE', s.failures.o2 ? 'damaged' : d.powered.oxygen ? 'running' : 'stopped', s.failures.o2 || !d.powered.oxygen ? 'bad' : 'ok')}
        ${this.#statusLine('BIO-Dome', d.powered.grow ? 'lit' : 'dark', d.powered.grow ? 'ok' : 'warn')}
        ${this.#statusLine('SCI-Lab', d.powered.research ? 'powered' : 'unpowered', d.powered.research ? 'ok' : 'warn')}
        ${this.#statusLine('FUEL-PROCESSOR', s.failures.fuel ? 'damaged' : !d.fuelLicensed ? 'unlicensed' : s.fuel.making ? 'manufacturing' : d.powered.fuel ? 'harvesting' : 'unpowered', s.failures.fuel || !d.fuelLicensed ? 'bad' : s.fuel.making ? 'ok' : 'warn')}
        ${this.#statusLine('ROVER-01', s.rover.malfunction ? 'fault' : sim.roverStatus(), s.rover.malfunction ? 'bad' : 'ok')}
        ${this.#statusLine('Storm', s.storm.active ? 'active' : s.storm.fired ? 'passed' : 'expected', s.storm.active ? 'warn' : 'ok')}
      </div>
      <h3 class="section-title">Advisories</h3>
      ${warnings.length ? warnings.map((w) => `<p class="note">${esc(w.text)}</p>`).join('') : '<p class="note">No active advisories. All reserves inside tolerance.</p>'}
      <h3 class="section-title">Session</h3>
      ${this.#actions([
        ['Save outpost', 'save', null, 'Writes to this browser', false],
        ['Sound on/off', 'mute', null, 'Procedural audio'],
        ['Return to mission', 'close', null, 'Resume play', false],
      ])}`;
  }

  #pauseBody() {
    const locked = Boolean(this.isLocked?.());
    const current = this.lockKey?.() ?? 'KeyX';
    const altLabel = LOCK_KEY_OPTIONS.find((k) => k.code === current)?.label ?? 'X';
    const options = LOCK_KEY_OPTIONS
      .map((k) => `<option value="${esc(k.code)}"${k.code === current ? ' selected' : ''}>${esc(k.label)}</option>`)
      .join('');

    return `
      <div class="stat-grid">
        <div class="stat"><div class="k">Sol</div><div class="v">${this.sim.state.sol}</div><div class="s">${(this.sim.state.elapsed / SOL_SECONDS).toFixed(1)} elapsed</div></div>
        <div class="stat"><div class="k">Research</div><div class="v">${this.sim.completedTopics()}/${this.sim.state.topics.length}</div><div class="s">${CHOICES.successResearch} needed</div></div>
        <div class="stat"><div class="k">Speed</div><div class="v">${this.sim.state.speed}×</div><div class="s">T cycles 1× / 2× / 4×</div></div>
      </div>
      <h3 class="section-title">Controls</h3>
      <div class="status-line"><span class="label"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span><span class="value">Walk — always relative to the camera</span></div>
      <div class="status-line"><span class="label"><kbd>Shift</kbd></span><span class="value">Sprint (both camera modes)</span></div>
      <div class="status-line"><span class="label">${locked ? '<kbd>Mouse</kbd>' : '<kbd>Mouse drag</kbd> / <kbd>Wheel</kbd>'}</span><span class="value">${locked ? 'Turn — the rig is locked to the shoulder' : 'Orbit / zoom'}</span></div>
      <div class="status-line"><span class="label"><kbd>E</kbd></span><span class="value">Interact with the nearest facility</span></div>
      <div class="status-line"><span class="label"><kbd>C</kbd> / <kbd>R</kbd> / <kbd>M</kbd></span><span class="value">Crew / research / telemetry</span></div>
      <div class="status-line"><span class="label"><kbd>T</kbd></span><span class="value">Simulation speed</span></div>
      <h3 class="section-title">Camera</h3>
      <div class="status-line"><span class="label">Shift Lock</span><span class="value">${locked ? '<strong class="ok-text">ON</strong> — over-the-shoulder' : 'OFF — orbit follow'}</span></div>
      <div class="status-line"><span class="label"><kbd>Caps Lock</kbd> / <kbd>${esc(altLabel)}</kbd></span><span class="value">Toggle Shift Lock</span></div>
      <div class="status-line"><span class="label">Alternate toggle key</span><span class="value"><select class="chip" data-action="lock-key">${options}</select></span></div>
      ${this.#actions([
        [locked ? 'Shift Lock off' : 'Shift Lock on', 'toggle-lock', null, 'Roblox-style: the astronaut faces where you look', false],
        ['Resume', 'close', null, null, false],
        ['Save outpost', 'save', null, 'Also autosaves every 25 s', false],
        ['Sound on/off', 'mute', null, 'Procedural audio', false],
        ['Abandon mission', 'quit', null, 'Stops the simulation', false],
      ], true)}
      <p class="note">Numbers here are gameplay values tuned for a ten-minute mission. They are simplified models, not Mars engineering data — the science notes on the mission console explain what each system represents.</p>`;
  }

  /* ───────────────────────────── actions ───────────────────────────── */

  #handle(action, arg) {
    const sim = this.sim;

    switch (action) {
      case 'close':
        this.close();
        break;
      case 'toggle-lock':
        this.onLock?.();
        this.render();
        break;
      case 'clean': {
        const facility = this.colony.nearest(this.player.position);
        if (!facility || facility.id !== 'solar') {
          sim.pushLog('Stand at the SOLAR-Grid to clean the panels yourself.', 'warn');
          break;
        }
        if (this.player.cleanCooldown > 0) break;
        sim.cleanPanels();
        this.player.cleanPanels();
        this.audio.good();
        break;
      }
      case 'repair': {
        const facility = this.colony.get(this.facilityId) ?? this.colony.nearest(this.player.position);
        if (!facility) break;
        this.player.startRepair({ id: facility.id, mode: 'facility' });
        this.close();
        break;
      }
      case 'repair-seal': {
        const facility = this.colony.get(arg) ?? this.colony.nearest(this.player.position);
        if (!facility) break;
        this.player.startRepair({ id: facility.id, mode: 'seal' });
        this.close();
        break;
      }
      case 'repair-rover': {
        const anchor = this.rover?.position;
        if (!anchor) {
          sim.pushLog('ROVER-01 is not reachable from this console — walk to it.', 'warn');
          break;
        }
        this.player.startRepair({ id: 'rover', mode: 'rover', anchor });
        this.close();
        break;
      }
      case 'dispatch':
        if (sim.dispatchRover(Number(arg))) this.audio.ui();
        break;
      case 'dispatch-kind': {
        const idx = sim.bestSiteFor(arg);
        if (idx < 0) {
          sim.pushLog(`No ${arg} deposit with material left — the mapped ground is worked out.`, 'warn');
          break;
        }
        if (sim.dispatchRover(idx)) this.audio.ui();
        break;
      }
      case 'fuel-start':
        if (sim.startFuelProduction()) this.audio.good();
        break;
      case 'fuel-stop':
        if (sim.stopFuelProduction()) this.audio.ui();
        break;
      case 'fuel-transfer':
        if (sim.transferFuel()) this.audio.good();
        break;
      case 'launch':
        if (sim.launchRocket()) {
          this.close();
          this.audio.good();
          return;
        }
        break;
      case 'rest-player':
        if (sim.togglePlayerRest()) {
          this.close();
          this.audio.ui();
          return;
        }
        break;
      case 'rest-shift': {
        const [crewId, delta] = String(arg).split('|');
        const member = sim.state.crew.find((c) => c.id === crewId);
        if (member) sim.setRestShift(crewId, member.shift + Number(delta));
        this.audio.ui();
        break;
      }
      case 'rest-now':
        if (sim.standCrewDown(arg, !sim.state.crew.find((c) => c.id === arg)?.sleeping)) {
          this.crewActors?.refreshTargets();
          this.audio.ui();
        }
        break;
      case 'shelter-crew':
        if (sim.setCrewSheltered(true)) {
          this.audio.warn();
          this.crewActors.refreshTargets();
        }
        break;
      case 'recall-crew':
        if (sim.setCrewSheltered(false)) {
          this.audio.ui();
          this.crewActors.refreshTargets();
        }
        break;
      case 'harvest':
        if (sim.harvest(Number(arg))) this.audio.good();
        break;
      case 'research-start':
        if (sim.startResearch(arg)) this.audio.good();
        break;
      case 'toggle':
        sim.toggleSystem(arg);
        this.audio.ui();
        break;
      case 'rationing':
        sim.setNightRationing(!sim.state.nightRationing);
        this.audio.ui();
        break;
      case 'resupply':
        if (sim.requestResupply()) this.audio.good();
        break;
      case 'backup':
        if (sim.activateBackup()) this.audio.good();
        break;
      case 'crew':
        this.open('crew');
        return;
      case 'research':
        this.open('research');
        return;
      case 'telemetry':
        this.open('telemetry');
        return;
      case 'save':
        this.onSave?.();
        this.audio.ui();
        break;
      case 'mute':
        this.onMute?.();
        this.audio.ui();
        break;
      case 'quit':
        this.close();
        this.onQuit?.();
        return;
      default:
        break;
    }

    this.render();
  }
}
