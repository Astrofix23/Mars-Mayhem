/* Dev-only balance + rules harness. Not referenced by index.html.
   Load in the page with:  const H = await import('tests/balance-harness.js');
   then H.run({ difficulty: 'commander', sols: 11 }) and H.assertions().          */

import { Simulation } from '../js/simulation.js';
import { FATIGUE, FUEL, ROCKET, ROVER, SITES, SOL_SECONDS } from '../js/config.js';

const H_PER_SOL = SOL_SECONDS / FATIGUE.hoursPerSol;

const need = {
  carbon: FUEL.recipe.carbon * ROCKET.capacity,
  oxygen: FUEL.recipe.oxygen * ROCKET.capacity,
  hydrogen: FUEL.recipe.hydrogen * ROCKET.capacity,
};

/** A competent-but-not-perfect player: keeps the chain moving, rests on fatigue, fixes what breaks. */
export function run({ difficulty = 'commander', sols = 11 } = {}) {
  const sim = new Simulation(difficulty);
  const s = sim.state;
  sim.assignCrew('maya', 'sci');
  sim.assignCrew('alex', 'bio');
  sim.assignCrew('sam', 'fuel');
  sim.startResearch('fuel');

  let wakeAt = 0;
  const mins = { oxygen: 100, water: 100, food: 100, battery: 100 };
  const slept = {};
  const perSol = [];
  let lastSol = 1;

  const track = () => {
    for (const m of sim.crewRoster()) {
      slept[m.id] = Math.max(slept[m.id] ?? 0, m.sleptHours);
    }
  };

  function policy() {
    const r = s.rover;
    if (!sim.roverActive() && !r.malfunction) {
      // A competent player keeps one full haul of ice in the hopper before the
      // rover starts spending trips on propellant feedstock.
      let want = null;
      if (s.ice < ROVER.iceLoadKg) {
        want = 'ice';
      } else {
        let worst = 0;
        for (const k of ['carbon', 'oxygen', 'hydrogen']) {
          const deficit = need[k] * 1.05 - s.fuel[k];
          if (deficit > worst) {
            worst = deficit;
            want = k;
          }
        }
      }
      if (want) {
        const idx = sim.bestSiteFor(want);
        if (idx >= 0) sim.dispatchRover(idx);
      }
    }
    const rocketShort = s.rocket.percent < ROCKET.capacity;
    if (sim.fuelCanMake() && !s.fuel.making && s.fuel.percent < ROCKET.capacity && rocketShort) sim.startFuelProduction();
    if (!s.fuel.making && s.fuel.percent > 0 && !s.rocket.transferring && rocketShort) sim.transferFuel();

    const active = s.topics.find((t) => t.id === s.activeTopic);
    if (!active || active.done) {
      const next = s.topics.find((t) => t.compulsory && !t.done) || s.topics.find((t) => !t.done);
      if (next) sim.startResearch(next.id);
    }

    for (const id of Object.keys(s.failures)) if (s.failures[id]) sim.repairFacility(id, true);
    if (r.malfunction) sim.repairRover(true);
    if (s.dust > 0.22) sim.cleanPanels();
    if (s.battery < 18) sim.activateBackup();
    if (s.fx.rad > 0.4 !== s.crewSheltered) sim.setCrewSheltered(s.fx.rad > 0.4);

    // the commander covers the plant while Sam is asleep, then takes a bunk
    if (s.player.fatigue > 55 && !s.player.sleeping && s.elapsed >= wakeAt) {
      sim.beginPlayerRest();
      wakeAt = s.elapsed + 4.6 * H_PER_SOL;
    } else if (s.player.sleeping && s.elapsed >= wakeAt) sim.endPlayerRest();
  }

  function step(n) {
    for (let i = 0; i < n; i++) {
      policy();
      sim.update(0.1);
      track();
      mins.oxygen = Math.min(mins.oxygen, s.oxygen);
      mins.water = Math.min(mins.water, s.water);
      mins.food = Math.min(mins.food, s.food);
      mins.battery = Math.min(mins.battery, s.battery);
      if (s.sol !== lastSol) {
        perSol.push({
          sol: lastSol,
          slept: Object.fromEntries(Object.entries(slept).map(([k, v]) => [k, +v.toFixed(1)])),
          o2: +s.oxygen.toFixed(0),
          water: +s.water.toFixed(0),
          food: +s.food.toFixed(0),
          bat: +s.battery.toFixed(0),
          ice: +s.ice.toFixed(0),
          trips: s.rover.trips,
          licensed: sim.fuelLicensed(),
          ready: sim.missionReadiness().map((c) => `${c.id.slice(0, 4)}${c.done ? '+' : '-'}`).join(' '),
          fuelPct: +s.fuel.percent.toFixed(0),
          rocketPct: +s.rocket.percent.toFixed(0),
        });
        for (const k of Object.keys(slept)) slept[k] = 0;
        lastSol = s.sol;
      }
      if (s.flags.failed || s.flags.complete) return i;
    }
    return n;
  }

  const ticks = step(Math.round(sols * SOL_SECONDS * 10));
  const launched = s.flags.complete ? true : sim.launchRocket();
  return {
    difficulty,
    ticks,
    sol: s.sol,
    ended: s.flags.failed ? 'failed' : s.flags.complete ? 'complete' : 'running',
    reason: s.flags.failureReason || '',
    launched,
    licensed: sim.fuelLicensed(),
    topics: sim.completedTopics(),
    mins: Object.fromEntries(Object.entries(mins).map(([k, v]) => [k, +v.toFixed(1)])),
    final: {
      oxygen: +s.oxygen.toFixed(1), water: +s.water.toFixed(1), food: +s.food.toFixed(1),
      battery: +s.battery.toFixed(1), ice: +s.ice.toFixed(0),
    },
    collected: Object.fromEntries(Object.entries(s.stats.collected).map(([k, v]) => [k, Math.round(v)])),
    stores: { carbon: +s.fuel.carbon.toFixed(0), oxygen: +s.fuel.oxygen.toFixed(0), hydrogen: +s.fuel.hydrogen.toFixed(0) },
    fuelPct: +s.fuel.percent.toFixed(1),
    rocketPct: +s.rocket.percent.toFixed(1),
    trips: s.rover.trips,
    dryTrips: s.stats.dryTrips,
    iceDelivered: s.stats.iceDelivered,
    materialsDelivered: { ...s.stats.materialsDelivered },
    missedRest: s.stats.missedRest,
    harvests: s.stats.harvests,
    breakdowns: s.stats.breakdowns,
    crew: sim.crewRoster().map((c) => ({
      name: c.name, fatigue: Math.round(c.fatigue), health: Math.round(c.health), alive: c.alive, status: c.status,
    })),
    readiness: sim.missionReadiness().map((c) => `${c.id}:${c.done ? 'Y' : 'n'}`).join(' '),
    perSol,
  };
}

/** Rule checks that must hold regardless of balance. */
export function assertions() {
  const out = {};
  const fresh = () => {
    const sim = new Simulation('cadet');
    sim.assignCrew('maya', 'sci');
    sim.assignCrew('sam', 'fuel');
    return sim;
  };

  // 1. launch is blocked with nothing done
  {
    const sim = fresh();
    out.launchBlockedCold = sim.launchRocket() === false && sim.state.rocket.launched === false;
    out.readinessCount = sim.missionReadiness().length;
  }

  // 2. fuel cannot be made without the licence
  {
    const sim = fresh();
    sim.state.fuel.carbon = FUEL.store.carbon;
    sim.state.fuel.oxygen = FUEL.store.oxygen;
    sim.state.fuel.hydrogen = FUEL.store.hydrogen;
    out.fuelNeedsLicence = sim.startFuelProduction() === false && sim.state.fuel.making === false;
  }

  // 3. fuel cannot be made without every feedstock
  {
    const sim = fresh();
    sim.state.topics.find((t) => t.id === 'fuel').done = true;
    sim.state.fuel.carbon = 400;
    sim.state.fuel.oxygen = 400;
    sim.state.fuel.hydrogen = 0;
    out.fuelNeedsHydrogen = sim.startFuelProduction() === false;
    sim.state.fuel.hydrogen = 200;
    out.fuelStartsWhenFull = sim.startFuelProduction() === true;
  }

  // 4. a dry rover trip genuinely carries nothing
  {
    const sim = fresh();
    const idx = SITES.findIndex((x) => x.kind === 'carbon');
    sim.dispatchRover(idx);
    const before = { ...sim.state.fuel };
    let guard = 0;
    while (sim.state.rover.phase !== 'idle' && guard++ < 20000) sim.update(0.1);
    const res = sim.state.rover.result;
    out.dryTripCarriesNothing = res
      ? (res.success ? sim.state.fuel.carbon > before.carbon : sim.state.fuel.carbon === before.carbon)
      : 'no result';
    out.prospectOddsAreReal = typeof res.success === 'boolean';
  }

  // 5. water is finite: with no ice the plant makes nothing
  {
    const sim = fresh();
    sim.state.ice = 0;
    const w0 = sim.state.water;
    for (let i = 0; i < 300; i++) sim.update(0.1);
    out.waterFallsWithoutIce = sim.state.water < w0 && sim.derived.iceRate === 0;
  }

  // 6. resources never go negative or overflow
  {
    const sim = fresh();
    let bad = '';
    for (let i = 0; i < 4000; i++) {
      sim.update(0.1);
      for (const k of ['oxygen', 'water', 'food', 'battery']) {
        const v = sim.state[k];
        if (!(v >= 0 && v <= 100.0001)) bad = `${k}=${v} at ${i}`;
      }
      if (sim.state.ice < 0 || sim.state.rover.iceCollected < 0) bad = `ice/collected negative at ${i}`;
    }
    out.boundsClean = bad || true;
  }

  // 7. the rest rule: a specialist on rotation clears 4 h every Sol
  {
    const sim = fresh();
    const seen = {};
    let lastSol = 1;
    const rows = [];
    for (let i = 0; i < 3 * SOL_SECONDS * 10; i++) {
      sim.update(0.1);
      for (const m of sim.crewRoster()) seen[m.id] = Math.max(seen[m.id] ?? 0, m.sleptHours);
      if (sim.state.sol !== lastSol) {
        rows.push({ sol: lastSol, ...Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, +v.toFixed(2)])) });
        for (const k of Object.keys(seen)) seen[k] = 0;
        lastSol = sim.state.sol;
      }
    }
    out.restWindows = rows;
  }

  // 8. save round-trip keeps the new state
  {
    const sim = fresh();
    sim.state.topics.find((t) => t.id === 'fuel').done = true;
    sim.state.fuel.carbon = 42;
    sim.state.sites[0].remaining = 12;
    sim.state.rover.mission = 'carbon';
    const json = JSON.parse(JSON.stringify(sim.state));
    const restored = new Simulation('cadet');
    restored.restoreState(json);
    out.saveRoundTrip = restored.state.fuel.carbon === 42
      && restored.state.sites[0].remaining === 12
      && restored.state.rover.mission === 'carbon'
      && restored.fuelLicensed() === true;
  }

  // 9. rover cannot teleport: position is a function of sim progress
  out.roverCyclePhases = (() => {
    const sim = fresh();
    const idx = SITES.findIndex((x) => x.kind === 'ice');
    sim.dispatchRover(idx);
    const phases = new Set();
    for (let i = 0; i < 3000 && sim.state.rover.phase !== 'idle'; i++) {
      sim.update(0.1);
      phases.add(sim.state.rover.phase);
    }
    return [...phases].join(',');
  })();

  out.iceFieldKg = SITES.filter((x) => x.kind === 'ice').reduce((t, x) => t + x.capacity, 0);
  {
    const sim = fresh();
    sim.state.ice = 0;
    const w0 = sim.state.water;
    for (let i = 0; i < SOL_SECONDS * 10; i++) sim.update(0.1);
    out.unfedWaterDrainPerSol = +(w0 - sim.state.water).toFixed(1);
  }
  {
    const sim = fresh();
    sim.triggerCpmsFailure();
    sim.events.forceForecast('dust_storm', 30);
    const pending = sim.state.events.pending[0];
    const offline = sim.warnings().length === 1
      && sim.warnings()[0].text === 'COMS OFF!REPAIR FOR UPCOMING ANOUNCEMENTS AND EVENTS'
      && !pending.announced;
    sim.beginCpmsRepair();
    for (let i = 0; i < 90; i++) sim.update(0.1);
    const restored = new Simulation('cadet');
    restored.restoreState(JSON.parse(JSON.stringify(sim.state)));
    for (let i = 0; i < 100; i++) restored.update(0.1);
    const forecasts = () => restored.state.log.filter((entry) => entry.text.startsWith('ENVIRONMENTAL FORECAST')).length;
    const delivered = forecasts();
    restored.triggerCpmsFailure();
    restored.restoreCpms();
    out.cpmsRepairRoundTrip = offline && restored.cpmsOnline() && restored.state.events.pending[0]?.announced
      && delivered === 1 && forecasts() === 1;
  }

  {
    const sim = fresh();
    sim.triggerCpmsFailure();
    sim.events.forceForecast('dust_storm', 4);
    sim.state.elapsed += 5;
    let forecastSignals = 0;
    sim.on((event) => { if (event.type.startsWith('forecast-')) forecastSignals++; });
    sim.restoreCpms();
    out.cpmsExpiredForecastNotReplayed = forecastSignals === 0
      && !sim.state.log.some((entry) => entry.text.startsWith('ENVIRONMENTAL FORECAST'))
      && sim.environmentForecast().status !== 'forecast';
    sim.events.update(0);
    out.cpmsExpiredHazardContinues = sim.state.storm.active && sim.state.events.pending.length === 0;
  }

  {
    const sim = fresh();
    sim.triggerCpmsFailure();
    sim.state.events.pending.push({ kind: 'equipment', dueAt: sim.state.elapsed, baselineFailures: {} });
    const signals = [];
    sim.on((event) => signals.push(event.type));
    sim.events.update(0);
    sim.triggerStorm(10);
    out.cpmsSuppressesOfflineAnnouncements = sim.state.storm.active
      && !signals.some((type) => type.startsWith('forecast-'))
      && !sim.state.log.some((entry) => /Maintenance forecast|DUST STORM inbound/.test(entry.text));
  }
  return out;
}
