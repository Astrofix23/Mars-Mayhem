import { CHOICES, PLAYER, SOL_SECONDS } from './config.js';
import { World, OrbitFollow } from './world.js';
import { Colony } from './colony.js';
import { Simulation } from './simulation.js';
import { Player } from './player.js';
import { CrewActors } from './crew.js';
import { RoverActor } from './rover.js';
import { Hud } from './hud.js';
import { Panels } from './panels.js';
import { AudioEngine } from './audio.js';
import { music } from './music.js';
import { clearSave, hasSave, loadGame, loadSettings, saveGame, saveSettings } from './save.js';
import { playIntro } from './intro.js';
import { playOutro } from './outro.js';
import { CheatConsole } from './cheat.js';
import { setVisorLight } from './visor.js';

const input = { forward: false, back: false, left: false, right: false, sprint: false };

/** Player options (camera mode, bound key) — kept out of the mission snapshot. */
const settings = loadSettings();

let world = null;
let colony = null;
let sim = null;
let player = null;
let orbit = null;
let crewActors = null;
let roverActor = null;
let hud = null;
let panels = null;
let audio = null;
let cheat = null;

let paused = false;
let cheatMode = false;
let cheatPaused = false;
let cinematicActive = false;
let resultsShown = false;
let outroHandle = null;
let outroFinished = false;
let introShown = false;
let animTime = 0;
let simTime = 0;
let simAccumulator = 0;
let autosaveTimer = 0;
let lastFrame = 0;
let frameErrorLogged = false;
let stormAudio = false;
let lastPanelOpen = false;
const meteorsSpawned = new WeakSet();

/* ─────────────────────────────── bootstrap ─────────────────────────────── */

window.addEventListener('DOMContentLoaded', () => {
  if (typeof THREE === 'undefined') {
    document.body.innerHTML =
      '<div id="boot">three.js failed to load. Check js/vendor/three.min.js and serve the folder over HTTP.</div>';
    return;
  }

  const continueBtn = document.getElementById('btn-continue');
  const returning = hasSave();
  if (returning) continueBtn.hidden = false;

  // The opening sequence is for a crew that has not landed yet, so it belongs to
  // a new outpost — not to the Continue button, which resumes mid-mission.
  document.querySelectorAll('.diff-card').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.difficulty === 'cheat') {
        document.getElementById('title-screen').classList.remove('is-open');
        document.getElementById('cheat-setup').classList.add('is-open');
        audio.init();
        audio.ui();
        return;
      }
      startGame(btn.dataset.difficulty);
      if (!introShown) {
        introShown = true;
        // Carry an intro mute into the outpost instead of leaving the score silent.
        playIntro({ onDone: () => audio.setMuted(music.muted) });
      }
    });
  });

  document.querySelectorAll('[data-cheat-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.cheatTab;
      document.getElementById('cheat-setup').classList.remove('is-open');
      if (tab === 'back') {
        document.getElementById('title-screen').classList.add('is-open');
        return;
      }
      startGame('cheat', null, tab);
    });
  });

  continueBtn.addEventListener('click', () => {
    const saved = loadGame();
    if (saved) startGame(saved.difficulty, saved);
  });

  document.getElementById('btn-restart').addEventListener('click', () => {
    if (!cheatMode) clearSave();
    window.location.reload();
  });

  audio = new AudioEngine();
  window.addEventListener('pointerdown', () => audio.init(), { once: true });
  window.addEventListener('keydown', () => audio.init(), { once: true });

  window.addEventListener('resize', () => world?.resize());
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', resetInput);
});

function startGame(difficultyId, savedState = null, cheatTab = 'home') {
  const container = document.getElementById('viewport');

  try {
    world = new World(container);
  } catch (error) {
    console.error(error);
    document.body.innerHTML =
      '<div id="boot">WebGL is unavailable in this browser, so the 3D colony cannot start.</div>';
    return;
  }

  cheatMode = difficultyId === 'cheat';
  colony = new Colony(world);
  sim = new Simulation(cheatMode ? 'cadet' : (difficultyId ?? 'cadet'));
  sim.cheatMode = cheatMode;
  if (savedState) sim.restoreState(savedState);

  player = new Player(world, colony);
  orbit = new OrbitFollow(world.camera, world);
  orbit.target.copy(player.focus);
  if (settings.shiftLock && !sim.state.player.sleeping) orbit.setLock(true);

  crewActors = new CrewActors(world, colony, sim);
  roverActor = new RoverActor(world, colony, sim);
  world.setCameraTarget(player.position);

  // A restored mission starts with the crew and rover already where the sim
  // says they are, rather than replaying a walk the player already watched.
  if (savedState) {
    crewActors.sync();
    roverActor.sync();
  }

  hud = new Hud({
    sim,
    player,
    colony,
    rover: roverActor,
    audio,
    onSpeed: () => cycleSpeed(),
    onLock: () => toggleShiftLock(),
    isLocked: () => Boolean(orbit?.locked),
  });

  panels = new Panels({
    sim,
    player,
    colony,
    crewActors,
    audio,
    hud,
    onSpeed: () => cycleSpeed(),
    onLock: () => toggleShiftLock(),
    isLocked: () => Boolean(orbit?.locked),
    lockKey: () => settings.altLockKey,
    onLockKey: (code) => setAlternateLockKey(code),
    onSave: () => {
      if (sim.cheatMode) {
        sim.pushLog('Saving is disabled in Cheat Code Mode — your normal outpost save is untouched.', 'info');
        return;
      }
      if (saveGame(sim)) sim.pushLog('Outpost state saved locally.', 'info');
    },
    onQuit: () => window.location.reload(),
    onMute: () => audio.setMuted(!audio.muted),
    onClose: () => {
      paused = false;
    },
  });
  panels.rover = roverActor;

  sim.on(handleSimEvent);
  player.onFootstep = () => audio.step();

  if (cheatMode) {
    cheat = new CheatConsole({
      sim,
      audio,
      hud,
      isPaused: () => cheatPaused,
      onTogglePause: () => {
        cheatPaused = !cheatPaused;
        if (cheatPaused) resetInput();
      },
      onSpeed: () => cycleSpeed(),
      onMute: () => audio.setMuted(!audio.muted),
      onCinematic: (active) => {
        cinematicActive = active;
        if (active) {
          resetInput();
          releasePointerLock();
        }
      },
      onExit: () => window.location.reload(),
      getSummary: () => outroSummary(sim),
    });
    document.body.classList.add('cheat-mode');
    cheat.open(cheatTab, { sandbox: cheatTab === 'survive' });
    sim.pushLog('CHEAT CODE MODE online — every system is yours to command. Saving is disabled; your normal outpost is untouched.', 'good');
  }

  // Debug handle: useful for demos, balance checks and console poking.
  window.__MARS__ = { sim, player, colony, world, panels, hud, orbit, crewActors, roverActor, settings, toggleShiftLock, cheat, music };

  document.getElementById('title-screen').classList.remove('is-open');
  hud.show();
  attachMouse();
  // Single soundtrack bus: the intro will layer its own scene over this one.
  audio.startMusic('gameplay');

  sim.pushLog('Outpost online. Sol 1, local morning. All systems nominal.', 'good');
  lastFrame = performance.now();
  requestAnimationFrame(frame);
}

/* ─────────────────────────────── loop ─────────────────────────────── */

function frame(now) {
  try {
    step(now);
  } catch (error) {
    // One bad frame must not brick a live demonstration.
    if (!frameErrorLogged) {
      frameErrorLogged = true;
      console.error('Frame step failed', error);
    }
  } finally {
    requestAnimationFrame(frame);
  }
}

function step(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  animTime += dt;

  const frozen = paused || panels.isOpen || cheatPaused || cinematicActive || sim.state.flags.complete || sim.state.flags.failed;

  // A console you cannot click is worse than a camera mode, so Shift Lock hands
  // the cursor back for as long as a panel is up.
  const panelOpen = panels.isOpen;
  if (panelOpen !== lastPanelOpen) {
    lastPanelOpen = panelOpen;
    if (panelOpen) releasePointerLock();
  }
  // Actors move on the simulation clock, not the wall clock: pausing stops the
  // crew and the rover too, and 2×/4× makes them walk and drive faster.
  const simDt = frozen ? 0 : dt * sim.state.speed;
  if (!frozen) simTime += simDt;

  if (!frozen) {
    simAccumulator += dt * sim.state.speed;
    let guard = 0;
    while (simAccumulator >= 0.1 && guard++ < 8) {
      sim.update(0.1);
      simAccumulator -= 0.1;
    }

    player.update(dt, animTime, input, orbit.yaw, orbit.locked);
    // The sim derives Walking vs Working from this; only the renderer knows speed.
    sim.state.player.moving = !sim.state.player.sleeping && player.speed > 0.4;
    sim.setPlayerCover(player.coveringPost());

    if (player.repair?.done) {
      finishRepair(player.repair);
      player.cancelRepair();
      audio.good();
    }

    if (!cheatMode) {
      autosaveTimer += dt;
      if (autosaveTimer >= CHOICES.autosaveSeconds) {
        autosaveTimer = 0;
        saveGame(sim);
      }
    }
  } else if (paused) {
    resetInput();
  }

  if (sim.state.flags.failed || sim.state.flags.complete) {
    showResults();
  }

  meteorWatch();

  orbit.update(dt, player.focus);
  const fx = sim.state.fx;
  world.update(dt, {
    hour: sim.state.hour,
    storm: sim.state.storm.active ? 1 : 0,
    devil: fx.devil > 0 ? Math.min(1, fx.devil / 5) : 0,
    devilPos: fx.devil > 0 ? { x: fx.devilX, z: fx.devilZ } : null,
    radiation: fx.rad,
    simDt,
  });
  setVisorLight(World.daylight(sim.state.hour));
  if (fx.quake > 0) shakeCamera(Math.min(0.3, fx.quake * 0.3));
  if (fx.flash > 0) world.renderer.toneMappingExposure = 1.12 + fx.flash * 0.9;
  else if (world.renderer.toneMappingExposure !== 1.12) world.renderer.toneMappingExposure = 1.12;

  colony.update(dt, sim, animTime, player.position);
  crewActors.update(simDt, simTime);
  roverActor.update(simDt, dt, simTime);
  cheat?.update(dt);
  hud.render();

  if (stormAudio !== sim.state.storm.active) {
    stormAudio = sim.state.storm.active;
    audio.setStorm(stormAudio);
  }

  // Panels and facility consoles do not count: only a real pause ducks the score.
  audio.setMusicPaused(paused || cheatPaused || resultsShown);

  world.render();
}

/** The renderer decides when a tracked meteorite becomes a visible streak. */
function meteorWatch() {
  for (const entry of sim.state.events.active) {
    if (entry.kind !== 'meteorite' || !entry.data || entry.data.x === undefined) continue;
    if (entry.timeLeft > 1.4 || meteorsSpawned.has(entry)) continue;
    meteorsSpawned.add(entry);
    world.spawnMeteor(entry.data.x, entry.data.z, null, Math.min(1.4, entry.timeLeft));
  }
}

function shakeCamera(amp) {
  const c = world.camera;
  c.position.x += (Math.random() - 0.5) * amp;
  c.position.y += (Math.random() - 0.5) * amp;
  c.position.z += (Math.random() - 0.5) * amp;
}

/** Routes a finished walk-up repair to the right simulation action. */
function finishRepair(repair) {
  const id = repair.id;
  if (repair.mode === 'rover') sim.repairRover(true);
  else if (repair.mode === 'seal') sim.repairSeal(true);
  else sim.repairFacility(id, true);
}

/* ─────────────────────────────── input ─────────────────────────────── */

function attachMouse() {
  const canvas = world.renderer.domElement;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  canvas.addEventListener('pointerdown', (event) => {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture?.(event.pointerId);
    // A click is the browser's user gesture, so it is also how we (re)capture the
    // cursor after Escape or a panel released it.
    if (orbit.locked && !panels?.isOpen) requestPointerLock();
  });

  window.addEventListener('pointerup', () => {
    dragging = false;
  });

  window.addEventListener('pointermove', (event) => {
    if (panels?.isOpen) return;

    if (orbit.locked && document.pointerLockElement === canvas) {
      orbit.look(event.movementX || 0, event.movementY || 0);
      return;
    }
    if (!dragging) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    // Dragging always works: pointer lock is an enhancement, not a requirement.
    if (orbit.locked) orbit.look(dx, dy);
    else orbit.rotate(dx, dy);
  });

  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      if (panels?.isOpen) return;
      orbit.zoom(event.deltaY);
    },
    { passive: false },
  );
}

/* ───────────────────────────── shift lock ───────────────────────────── */

let pointerLockAsked = false;

function requestPointerLock() {
  // The override console needs the cursor — cheat mode keeps the drag-look camera.
  if (cheatMode) return;
  const canvas = world?.renderer?.domElement;
  if (!canvas || typeof canvas.requestPointerLock !== 'function') return;
  if (document.pointerLockElement === canvas) return;
  try {
    const result = canvas.requestPointerLock();
    // Denied (iframe policy, user refusal) only costs the captured cursor.
    if (result && typeof result.catch === 'function') result.catch(() => {});
    pointerLockAsked = true;
  } catch {
    /* unsupported — drag-look still works */
  }
}

function releasePointerLock() {
  if (document.pointerLockElement && typeof document.exitPointerLock === 'function') {
    document.exitPointerLock();
  }
}

/**
 * Shift Lock on/off. Left Shift keeps sprinting untouched — the mode is a camera
 * setting, and Caps Lock was chosen as its key for exactly that reason.
 */
function toggleShiftLock(force = null) {
  if (!orbit) return;
  if (sim?.state.player.sleeping) {
    if (force === null) sim.pushLog('Wake up first (E) before changing the camera.', 'info');
    return;
  }
  const next = force === null ? !orbit.locked : Boolean(force);
  if (next === orbit.locked) return;
  orbit.setLock(next);
  settings.shiftLock = next;
  saveSettings(settings);
  if (next) {
    if (!panels?.isOpen) requestPointerLock();
  } else releasePointerLock();
  hud?.render();
  audio?.ui();
  sim?.pushLog(
    next
      ? 'Shift Lock on — mouse turns the view, WASD follows it, Left Shift still sprints.'
      : 'Shift Lock off — free orbit camera restored.',
    'info',
  );
}

function setAlternateLockKey(code) {
  settings.altLockKey = code;
  saveSettings(settings);
  panels?.render();
}

function onKeyDown(event) {
  const key = event.key;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(key)) event.preventDefault();
  if (!sim) return;
  // Cinematics run their own key handlers; the dock's buttons keep native focus.
  if (cinematicActive) return;
  if (cheatMode && document.activeElement?.closest?.('#cheat-dock')) return;

  if (key === 'Escape' || key === 'h' || key === 'H') {
    event.preventDefault();
    togglePause();
    return;
  }

  // Shift Lock is a camera mode, so it toggles even with a panel open. Caps Lock
  // is the default; the alternate binding is configurable in the mission console.
  if (key === 'CapsLock' || event.code === settings.altLockKey) {
    event.preventDefault();
    if (!event.repeat) toggleShiftLock();
    return;
  }

  if (panels.isOpen) {
    if (key === 'e' || key === 'E') panels.close();
    else if (key === 'm' || key === 'M') {
      audio.setMuted(!audio.muted);
      audio.ui();
      panels.render();
    }
    return;
  }

  switch (key) {
    case 'w':
    case 'W':
    case 'ArrowUp':
      input.forward = true;
      break;
    case 's':
    case 'S':
    case 'ArrowDown':
      input.back = true;
      break;
    case 'a':
    case 'A':
    case 'ArrowLeft':
      input.left = true;
      break;
    case 'd':
    case 'D':
    case 'ArrowRight':
      input.right = true;
      break;
    case 'Shift':
      input.sprint = true;
      break;
    case 'e':
    case 'E':
      interact();
      break;
    case 'c':
    case 'C':
      panels.open('crew');
      break;
    case 'r':
    case 'R':
      panels.open('research');
      break;
    case 'm':
    case 'M':
      panels.open('telemetry');
      break;
    case 't':
    case 'T':
      cycleSpeed();
      break;
    default:
      break;
  }
}

function onKeyUp(event) {
  switch (event.key) {
    case 'w':
    case 'W':
    case 'ArrowUp':
      input.forward = false;
      break;
    case 's':
    case 'S':
    case 'ArrowDown':
      input.back = false;
      break;
    case 'a':
    case 'A':
    case 'ArrowLeft':
      input.left = false;
      break;
    case 'd':
    case 'D':
    case 'ArrowRight':
      input.right = false;
      break;
    case 'Shift':
      input.sprint = false;
      break;
    default:
      break;
  }
}

function resetInput() {
  input.forward = input.back = input.left = input.right = input.sprint = false;
}

function interact() {
  if (panels.isOpen) {
    panels.close();
    return;
  }

  // Lying down is a mode, not a prompt: E is how you get back up.
  if (sim.state.player.sleeping) {
    sim.endPlayerRest();
    return;
  }

  // The rover is a vehicle out on the surface, not a building: standing next to
  // it is what counts, wherever it has stopped.
  const r = sim.state.rover;
  if (roverActor) {
    const d = Math.hypot(player.position.x - roverActor.position.x, player.position.z - roverActor.position.z);
    if (d < PLAYER.interactRadius + 2.5) {
      if (r.malfunction && !player.repair) {
        player.startRepair({ id: 'rover', mode: 'rover', anchor: roverActor.position });
        sim.pushLog('EVA toolkit on ROVER-01 — stay beside it until the fault is cleared.', 'info');
        audio.open();
        return;
      }
      if (!r.malfunction) {
        panels.open('facility', 'rover');
        return;
      }
    }
  }

  const nearest = player.nearestFacility();
  if (nearest) {
    panels.open('facility', nearest.id);
    return;
  }
  sim.pushLog('Nothing within reach. Walk closer to a facility.', 'info');
}

function togglePause() {
  if (panels.isOpen) {
    panels.close();
    paused = false;
    return;
  }
  paused = true;
  resetInput();
  panels.open('pause');
}

function cycleSpeed() {
  const speed = sim.cycleSpeed();
  audio.ui();
  hud.render();
  return speed;
}

/* ─────────────────────────────── events ─────────────────────────────── */

let restCam = null;
let restLock = false;

/**
 * The astronaut rests where the shift finds them: in a HAB bunk if they made it
 * home, on the surface if they did not. Either way the camera pulls back to the
 * colony overview so the run can be watched while it keeps going without you.
 */
function setPlayerRest(on) {
  if (on) {
    const near = player.nearestFacility();
    const bunk = near?.id === 'hab' ? colony.bunks[3] ?? colony.bunks[0] ?? null : null;
    player.beginRest(bunk);
    // The overview is an orbit shot, so the shoulder rig steps aside for it.
    // This is a temporary hand-off, not a change to the player's saved setting.
    restLock = orbit.locked;
    if (restLock) {
      orbit.setLock(false);
      releasePointerLock();
    }
    restCam = { distance: orbit.distance, pitch: orbit.pitch };
    orbit.distance = 46;
    orbit.pitch = 1.04;
    hud.hidePrompt();
    return;
  }
  player.endRest();
  if (restCam) {
    orbit.distance = restCam.distance;
    orbit.pitch = restCam.pitch;
    restCam = null;
  }
  if (restLock) {
    restLock = false;
    orbit.setLock(true);
  }
}

/** The Journey Home sequence, then the report. Victory is the only run that plays it. */
function playEnding() {
  if (outroHandle) return;
  paused = true;
  resetInput();
  outroHandle = playOutro({
    summary: outroSummary(sim),
    onDone: () => {
      outroHandle = null;
      outroFinished = true;
      if (sim.cheatMode) {
        // The launch demo ends at the report; the sandbox keeps running so every
        // showcase stays live. No results screen, and no save is ever touched.
        outroFinished = false;
        paused = false;
        sim.state.flags.complete = false;
        sim.state.rocket.launched = false;
        sim.pushLog('Cheat code: launch demo complete — sandbox resumed, the M3 is still loaded for another go.', 'good');
        cheat?.applyLive();
        return;
      }
      showResults();
    },
  });
}

function outroSummary(s) {
  const state = s.state;
  const roster = s.crewRoster();
  return {
    solsSurvived: Math.min(CHOICES.successSol, state.elapsed / SOL_SECONDS),
    eventsSurvived: state.events.encountered,
    roverTrips: state.rover.trips,
    iceCollected: state.rover.iceCollected,
    fuelMade: state.fuel.percent,
    rocketFuel: state.rocket.percent,
    materials: { ...state.stats.collected },
    resources: { oxygen: state.oxygen, water: state.water, food: state.food, battery: state.battery },
    crew: roster.map((c) => ({ name: c.name, role: c.role, status: c.status, fatigue: c.fatigue })),
    topics: state.topics.map((t) => ({ name: t.name, done: t.done })),
  };
}

function handleSimEvent(event) {
  switch (event.type) {
    case 'log':
      if (event.kind === 'bad') audio.warn();
      break;
    case 'storm-start':
      audio.storm();
      break;
    case 'storm-end':
      audio.setStorm(false);
      break;
    case 'failure':
    case 'seal-fault':
    case 'rover-fault':
    case 'radiation-peak':
    case 'crew-lost':
      audio.warn();
      break;
    case 'event-start':
      if (event.severe) audio.warn();
      else audio.ui();
      break;
    case 'meteor-impact':
      colony.spawnCrater(event.x, event.z);
      audio.storm();
      break;
    case 'rover-result':
      if (event.result?.success) audio.good();
      else audio.warn();
      break;
    case 'rover-delivery':
      audio.good();
      break;
    case 'rover-repaired':
      audio.good();
      break;
    case 'fuel-licensed':
      audio.good();
      break;
    case 'fuel-start':
    case 'rocket-transfer':
      audio.ui();
      break;
    case 'fuel-full':
    case 'rocket-transfer-end':
      if (event.ready !== false) audio.good();
      else audio.warn();
      break;
    case 'crew-shelter':
    case 'crew-sleep':
      crewActors.refreshTargets();
      break;
    case 'player-rest':
      setPlayerRest(event.on);
      break;
    case 'launch':
      playEnding();
      break;
    case 'failed':
    case 'complete':
      showResults();
      break;
    default:
      break;
  }
}

function showResults() {
  if (resultsShown) return;
  // A win waits for the Journey Home sequence; the report is never skipped, only the cinematic is.
  if (sim.state.flags.complete && !outroFinished) return;
  resultsShown = true;
  paused = true;
  audio.setMusicScene('results');
  panels.close();
  hud.showResults(sim, sim.state.flags.complete);
  if (!sim.cheatMode) clearSave();
}
