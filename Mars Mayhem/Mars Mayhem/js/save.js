import { CHOICES } from './config.js';

/**
 * Persistence layer: a single versioned snapshot in localStorage.
 * The current key is authoritative; the legacy keys are read once and adopted,
 * because Simulation.restoreState fills every system a Sol-10 save never had
 * (ice hopper, fuel stores, fatigue, deposits) with defaults.
 */

const LEGACY_KEYS = ['mars-outpost-survival-save-v2', 'mars-outpost-survival-save'];

/** Camera/option preferences live apart from the mission snapshot. */
const SETTINGS_KEY = 'mars-outpost-settings-v1';
const SETTINGS_DEFAULTS = { shiftLock: false, altLockKey: 'KeyX' };

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...SETTINGS_DEFAULTS };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...SETTINGS_DEFAULTS };
    return { ...SETTINGS_DEFAULTS, ...parsed };
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

function read(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const payload = JSON.parse(raw);
    return payload && payload.state ? payload : null;
  } catch (error) {
    console.warn('Load failed', error);
    return null;
  }
}

export function saveGame(sim) {
  // CHEAT CODE MODE never touches the normal mission's save slot.
  if (sim && sim.cheatMode) return false;
  try {
    const payload = {
      version: CHOICES.saveVersion,
      savedAt: Date.now(),
      state: sim.state,
    };
    localStorage.setItem(CHOICES.saveKey, JSON.stringify(payload));
    return true;
  } catch (error) {
    console.warn('Save failed', error);
    return false;
  }
}

export function loadGame() {
  const current = read(CHOICES.saveKey);
  if (current && current.version === CHOICES.saveVersion) return current.state;

  for (const key of LEGACY_KEYS) {
    const legacy = read(key);
    if (!legacy) continue;
    if (legacy.version !== 2 && legacy.version !== 1) return null;
    // The legacy snapshot stays on disk until the first v3 write replaces it —
    // deleting here would eat the save between hasSave() and the Continue click.
    return legacy.state;
  }
  return null;
}

export function hasSave() {
  return loadGame() !== null;
}

export function clearSave() {
  try {
    localStorage.removeItem(CHOICES.saveKey);
    for (const key of LEGACY_KEYS) localStorage.removeItem(key);
  } catch {
    /* storage unavailable — nothing to clear */
  }
}
