/**
 * NASA DONKI space-weather feed and the in-game monitor.
 *
 * Data source: CCMC DONKI. The legacy kauai.ccmc.gsfc.nasa.gov host was
 * superseded by the official migration of 30 September 2026; the current
 * documented base is https://ccmc.gsfc.nasa.gov/DONKI-API/get with the same
 * endpoint names after /get/. Requests are unauthenticated and CORS-enabled.
 *
 * DONKI is a database of observations, analyses and notifications. Nothing here
 * is a measurement of radiation at the Mars colony, and a CME is never treated
 * as a guaranteed impact. The risk bands below are documented game-side
 * interpretations of the returned fields, not NASA severity values.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export const DONKI = {
  baseUrl: 'https://ccmc.gsfc.nasa.gov/DONKI-API/get',
  endpoints: ['FLR', 'CME', 'SEP', 'GST'],
  lookbackDays: 30,          // DONKI rejects date ranges longer than 60 days
  timeoutMs: 15_000,
  autoRefreshMs: 15 * 60_000,
  manualCooldownMs: 60_000,
  firstRefreshDelayMs: 1_500,
  cacheKey: 'mars-outpost-donki-cache-v1',
  cacheVersion: 1,
  eventListLimit: 4,
  maxEventsPerFeed: 20,
  alertWindowDays: 7,
  meta: {
    FLR: { short: 'FLR', label: 'Solar Flare', facility: 'solar' },
    CME: { short: 'CME', label: 'Coronal Mass Ejection', facility: 'shelter' },
    SEP: { short: 'SEP', label: 'Solar Energetic Particles', facility: 'shelter' },
    GST: { short: 'GST', label: 'Geomagnetic Storm', facility: null },
  },
};

export const LEVELS = {
  green: {
    rank: 0,
    label: 'GREEN',
    note: 'No relevant active alert found in the retrieved data.',
  },
  yellow: {
    rank: 1,
    label: 'YELLOW',
    note: 'Space-weather event detected; monitor conditions.',
  },
  orange: {
    rank: 2,
    label: 'ORANGE',
    note: 'Potentially significant event; prepare the crew.',
  },
  red: {
    rank: 3,
    label: 'RED',
    note: 'High-priority space-weather warning; follow shelter procedures.',
  },
};

const safeStorage = {
  get(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  },
};

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const parseTime = (value) => {
  const t = value ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : null;
};

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

const formatUtc = (ms) => {
  if (!Number.isFinite(ms)) return '—';
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z`;
};

const ago = (ms, now = Date.now()) => {
  if (!Number.isFinite(ms)) return 'never';
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
};

const flareRank = (classType) => {
  const cls = String(classType ?? '').trim().toUpperCase();
  if (cls.startsWith('X')) return 3;
  if (cls.startsWith('M')) return 2;
  if (cls.startsWith('C')) return 1;
  return 0;
};

const mostAccurateCmeAnalysis = (analyses) => {
  if (!Array.isArray(analyses) || !analyses.length) return null;
  return analyses.find((a) => a && a.isMostAccurate)
    ?? analyses
      .slice()
      .sort((a, b) => (Number(b?.speed) || 0) - (Number(a?.speed) || 0))[0];
};

function explain(event) {
  const cls = event.classification ? ` (${event.classification})` : '';
  switch (event.type) {
    case 'SEP':
      return 'Solar energetic particle event reported. DONKI does not measure radiation at the Mars colony; this is a prompt to review radiation protection procedures.';
    case 'FLR':
      return `Solar flare${cls} reported. A flare is a solar activity event and is not automatically a colony radiation hazard.`;
    case 'CME':
      return `Coronal mass ejection detected${cls}. DONKI analyses are model-based; this is not a Mars-impact forecast and does not guarantee a radiation event.`;
    case 'GST':
      return `Geomagnetic storm${cls} reported near Earth. Included for situational awareness only; it does not directly describe conditions at Mars.`;
    default:
      return 'Space-weather record returned by DONKI.';
  }
}

function normalise(type, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const meta = DONKI.meta[type];
  let id = null;
  let time = null;
  let peak = null;
  let end = null;
  let classification = '';
  let speed = null;
  let kp = null;
  let note = '';

  if (type === 'FLR') {
    id = raw.flrID;
    time = raw.beginTime || raw.peakTime;
    peak = raw.peakTime;
    end = raw.endTime;
    classification = raw.classType || '';
    note = raw.note || '';
  } else if (type === 'CME') {
    id = raw.activityID;
    time = raw.startTime;
    const analysis = mostAccurateCmeAnalysis(raw.cmeAnalyses);
    if (analysis) {
      speed = Number(analysis.speed) || null;
      peak = analysis.time21_5 || null;
      classification = speed ? `${Math.round(speed)} km/s` : '';
    }
    note = raw.note || '';
  } else if (type === 'SEP') {
    id = raw.sepID;
    time = raw.eventTime;
    note = raw.note || '';
  } else if (type === 'GST') {
    id = raw.gstID;
    time = raw.startTime;
    peak = raw.startTime;
    const indices = Array.isArray(raw.allKpIndex) ? raw.allKpIndex : [];
    kp = indices.reduce((max, item) => Math.max(max, Number(item?.kpIndex) || 0), 0);
    classification = kp ? `max Kp ${kp}` : '';
    note = raw.note || '';
  }

  const timeMs = parseTime(time);
  if (!id || timeMs === null) return null;

  const event = {
    id,
    type,
    label: meta.label,
    short: meta.short,
    time,
    timeMs,
    peak: peak || null,
    end: end || null,
    classification,
    classRank: type === 'FLR' ? flareRank(classification) : 0,
    speed,
    kp,
    note,
    source: 'NASA DONKI',
  };
  event.explanation = explain(event);
  return event;
}

function normaliseList(type, items, now) {
  const seen = new Set();
  return (Array.isArray(items) ? items : [])
    .map((raw) => normalise(type, raw))
    .filter((event) => {
      if (!event) return false;
      if (event.timeMs > now + DAY_MS) return false;
      if (seen.has(event.id)) return false;
      seen.add(event.id);
      return true;
    })
    .sort((a, b) => b.timeMs - a.timeMs)
    .slice(0, DONKI.maxEventsPerFeed);
}

/** Coarse tone used only for the event-list badges. */
export function eventTone(event, now = Date.now()) {
  const ageH = (now - event.timeMs) / HOUR_MS;
  if (ageH < 0 || ageH > DONKI.alertWindowDays * 24) return 'quiet';
  if (event.type === 'SEP') return ageH <= 48 ? 'red' : ageH <= 168 ? 'orange' : 'yellow';
  if (event.type === 'FLR') {
    if (event.classRank >= 3 && ageH <= 24) return 'orange';
    if (event.classRank >= 2) return 'yellow';
    return 'quiet';
  }
  if (event.type === 'CME') {
    if (event.speed >= 800 && ageH <= 48) return 'orange';
    if (event.speed >= 500 && ageH <= 120) return 'yellow';
    return 'quiet';
  }
  return 'quiet';
}

function buildAdvisory(level, event) {
  const base = LEVELS[level];
  if (!event || level === 'green') {
    return {
      level: 'green',
      levelNote: base.note,
      eventId: null,
      kind: null,
      facility: null,
      title: 'No active advisory',
      banner: '',
      advisory: 'No active advisory. Retrieved DONKI records are below the game alert threshold; the MARS MAYHEM simulation continues normally.',
      log: '',
      logKind: 'info',
    };
  }

  const when = formatUtc(event.timeMs);
  const cls = event.classification ? ` (${event.classification})` : '';
  const speedStr = event.speed ? ` at a model speed of ${Math.round(event.speed)} km/s` : '';
  const common = {
    level,
    levelNote: base.note,
    eventId: event.id,
    kind: event.type,
    facility: DONKI.meta[event.type]?.facility ?? null,
    title: `${event.short} · ${event.label}`,
    eventTime: event.time,
  };

  if (event.type === 'SEP') {
    const red = level === 'red';
    return {
      ...common,
      banner: red
        ? 'NASA SPACE WEATHER ALERT: Solar energetic particle event reported. Review crew radiation protection procedures.'
        : 'NASA SPACE WEATHER ADVISORY: Solar energetic particle event reported. Crew protection advisory — review SHELTER-BUNKER procedures.',
      advisory: `DONKI reports a solar energetic particle event at ${when}. This is a space-weather notification, not a radiation measurement at the Mars colony. Game advisory: review radiation protection procedures and consider sheltering the crew at SHELTER-BUNKER.`,
      log: `NASA DONKI // SEP: Solar energetic particle event reported at ${when}. Radiation protection advisory — review SHELTER-BUNKER procedures. Game-side interpretation, not a Mars radiation measurement.`,
      logKind: red ? 'bad' : 'warn',
    };
  }

  if (event.type === 'FLR') {
    const xClass = event.classRank >= 3;
    return {
      ...common,
      banner: xClass
        ? `NASA SPACE WEATHER ADVISORY: X-class solar flare${cls} reported. Monitor conditions — not an automatic colony radiation event.`
        : `NASA SPACE WEATHER NOTICE: M-class solar flare${cls} reported. Monitor space weather.`,
      advisory: `DONKI reports a solar flare${cls} at ${when}. Solar flares are solar activity events; this game does not treat every flare as a colony radiation hazard. Monitor the feed and review shelter readiness if conditions escalate.`,
      log: `NASA DONKI // FLR: solar flare${cls} reported at ${when}. Space-weather monitoring only — not automatically a colony radiation event.`,
      logKind: 'warn',
    };
  }

  if (event.type === 'CME') {
    const fast = (event.speed ?? 0) >= 800;
    return {
      ...common,
      banner: fast
        ? 'NASA SPACE WEATHER ADVISORY: Fast coronal mass ejection analysed. Review crew protection procedures and monitor conditions.'
        : 'NASA SPACE WEATHER NOTICE: Coronal mass ejection detected. Monitor the feed; no Mars impact is forecast by this game.',
      advisory: `DONKI reports a coronal mass ejection${speedStr} at ${when}. DONKI analyses are model-based and do not forecast a Mars impact; treat this as a prompt to monitor conditions and review shelter procedures, not as a guaranteed radiation event.`,
      log: `NASA DONKI // CME: coronal mass ejection analysed${speedStr} at ${when}. Monitor conditions — not a Mars impact forecast.`,
      logKind: 'warn',
    };
  }

  return {
    ...common,
    banner: 'NASA SPACE WEATHER NOTICE: space-weather activity detected. Monitor conditions.',
    advisory: `DONKI returned a ${event.label.toLowerCase()} record at ${when}. Included for situational awareness; it is not a Mars forecast.`,
    log: `NASA DONKI // ${event.short}: record reported at ${when}. Monitor conditions.`,
    logKind: 'warn',
  };
}

/**
 * Documented game-side interpretation of the returned DONKI fields.
 * Recency and classification come from the feed; the bands are the game's own
 * rules, not NASA severity products.
 */
export function assessEvents(events, now = Date.now()) {
  const ageH = (event) => (now - event.timeMs) / HOUR_MS;
  const within = (event, hours) => ageH(event) >= 0 && ageH(event) <= hours;
  const sorted = events.slice().sort((a, b) => b.timeMs - a.timeMs);
  const of = (type) => sorted.filter((event) => event.type === type);

  const sep = of('SEP');
  const sepRed = sep.find((event) => within(event, 48));
  if (sepRed) return buildAdvisory('red', sepRed);

  const sepOrange = sep.find((event) => within(event, DONKI.alertWindowDays * 24));
  if (sepOrange) return buildAdvisory('orange', sepOrange);

  const flares = of('FLR');
  const xFlare = flares.find((event) => event.classRank >= 3 && within(event, 24));
  if (xFlare) return buildAdvisory('orange', xFlare);

  const fastCme = of('CME').find((event) => (event.speed ?? 0) >= 800 && within(event, 48));
  if (fastCme) return buildAdvisory('orange', fastCme);

  const mFlare = flares.find((event) => event.classRank === 2 && within(event, 72));
  if (mFlare) return buildAdvisory('yellow', mFlare);

  const cme = of('CME').find((event) => (event.speed ?? 0) >= 500 && within(event, 120));
  if (cme) return buildAdvisory('yellow', cme);

  const anyFlare = flares.find((event) => event.classRank >= 2 && within(event, DONKI.alertWindowDays * 24));
  if (anyFlare) return buildAdvisory('yellow', anyFlare);

  return buildAdvisory('green', null);
}

/** Network + cache layer. No DOM, so it can be exercised from the console or a test. */
export class SpaceWeatherService {
  constructor({ baseUrl = DONKI.baseUrl, storage = safeStorage } = {}) {
    this.baseUrl = baseUrl;
    this.storage = storage;
    this.byType = {};
    this.errors = {};
    this.status = 'idle';
    this.lastAttemptAt = 0;
    this.lastSuccessAt = 0;
    this.rateRemaining = null;
    this.inFlight = null;
    this.loadCache();
  }

  get events() {
    const all = [];
    for (const type of DONKI.endpoints) {
      const bucket = this.byType[type];
      if (bucket?.items) all.push(...bucket.items);
    }
    return all.sort((a, b) => b.timeMs - a.timeMs);
  }

  get lastUpdatedAt() {
    return DONKI.endpoints.reduce((max, type) => Math.max(max, this.byType[type]?.at ?? 0), 0);
  }

  loadCache() {
    const raw = this.storage.get(DONKI.cacheKey);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== DONKI.cacheVersion || typeof parsed.byType !== 'object') return;
      for (const type of DONKI.endpoints) {
        const bucket = parsed.byType[type];
        if (!bucket || !Array.isArray(bucket.items)) continue;
        const items = bucket.items
          .filter((event) => event && event.id && Number.isFinite(event.timeMs))
          .map((event) => ({ ...event, type, short: DONKI.meta[type].short, label: DONKI.meta[type].label }));
        this.byType[type] = { at: Number(bucket.at) || 0, items };
      }
      if (Object.keys(this.byType).length) this.status = 'cached';
    } catch {
      /* unreadable cache is ignored — live mode still works */
    }
  }

  saveCache() {
    const byType = {};
    for (const type of DONKI.endpoints) {
      const bucket = this.byType[type];
      if (bucket) byType[type] = { at: bucket.at, items: bucket.items };
    }
    this.storage.set(DONKI.cacheKey, JSON.stringify({
      version: DONKI.cacheVersion,
      savedAt: Date.now(),
      byType,
    }));
  }

  assess(now = Date.now()) {
    return assessEvents(this.events, now);
  }

  async refresh() {
    if (this.inFlight) return this.inFlight;

    const run = (async () => {
      const now = Date.now();
      this.status = 'loading';
      this.lastAttemptAt = now;

      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        this.status = 'offline';
        this.errors = { network: 'browser is offline' };
        return { ok: false, status: this.status, events: this.events, errors: this.errors };
      }

      const startDate = isoDay(now - DONKI.lookbackDays * DAY_MS);
      const endDate = isoDay(now);
      const results = await Promise.all(
        DONKI.endpoints.map(async (type) => {
          try {
            return { type, ok: true, items: await this.#fetchType(type, startDate, endDate) };
          } catch (error) {
            return {
              type,
              ok: false,
              code: error?.code ?? 'failed',
              message: error?.message ?? 'request failed',
            };
          }
        }),
      );

      const ok = results.filter((result) => result.ok);
      const failed = results.filter((result) => !result.ok);
      this.errors = Object.fromEntries(failed.map((result) => [result.type, result.code]));

      if (ok.length) {
        for (const result of ok) {
          this.byType[result.type] = {
            at: now,
            items: normaliseList(result.type, result.items, now),
          };
        }
        this.lastSuccessAt = now;
        this.saveCache();
      }

      if (!ok.length) {
        this.status = failed.every((result) => result.code === 'rate-limited') ? 'limited' : 'offline';
      } else {
        this.status = failed.length ? 'partial' : 'online';
      }

      return {
        ok: ok.length > 0,
        status: this.status,
        events: this.events,
        assessment: this.assess(now),
        errors: this.errors,
      };
    })();

    this.inFlight = run;
    try {
      return await run;
    } finally {
      this.inFlight = null;
    }
  }

  async #fetchType(type, startDate, endDate) {
    const url = new URL(`${this.baseUrl}/${type}`);
    url.searchParams.set('startDate', startDate);
    url.searchParams.set('endDate', endDate);

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), DONKI.timeoutMs) : null;

    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal: controller?.signal,
      });

      const rateHeader = response.headers.get('x-rate-limit-remaining');
      const remaining = rateHeader === null ? NaN : Number(rateHeader);
      if (Number.isFinite(remaining)) this.rateRemaining = remaining;

      if (response.status === 429) {
        const error = new Error('rate limited');
        error.code = 'rate-limited';
        throw error;
      }
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.code = `http-${response.status}`;
        throw error;
      }

      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        const error = new Error('invalid JSON');
        error.code = 'invalid-json';
        throw error;
      }
      if (!Array.isArray(data)) {
        const error = new Error('unexpected payload');
        error.code = 'unexpected-payload';
        throw error;
      }
      return data;
    } catch (error) {
      if (error?.name === 'AbortError') {
        const timeout = new Error('timeout');
        timeout.code = 'timeout';
        throw timeout;
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * HUD monitor. Owns polling, the panel DOM and the hand-off into the game's
 * existing advisory/log/banner/facility-highlight systems. A failed request
 * only ever changes the connection readout.
 */
export class SpaceWeatherMonitor {
  constructor({ sim, audio = null }) {
    this.sim = sim;
    this.audio = audio;
    this.service = new SpaceWeatherService();
    this.inFlight = false;
    this.lastManualAt = 0;
    this.nextAutoAt = Date.now() + DONKI.firstRefreshDelayMs;
    this.nextAssessmentAt = Date.now() + 60_000;
    this.lastKey = '';
    this.devMode = new URLSearchParams(window.location.search).get('dev') === '1'
      || safeStorage.get('mars-outpost-dev') === '1';

    this.el = {
      root: document.getElementById('space-weather'),
      connection: document.getElementById('sw-connection'),
      levelLabel: document.getElementById('sw-level-label'),
      levelNote: document.getElementById('sw-level-note'),
      event: document.getElementById('sw-event'),
      category: document.getElementById('sw-category'),
      time: document.getElementById('sw-time'),
      advisory: document.getElementById('sw-advisory'),
      updated: document.getElementById('sw-updated'),
      readinessBunker: document.getElementById('sw-bunker'),
      readinessShield: document.getElementById('sw-shield'),
      list: document.getElementById('sw-event-list'),
      refresh: document.getElementById('sw-refresh'),
      source: document.getElementById('sw-source'),
      foot: document.getElementById('sw-foot'),
      dev: document.getElementById('sw-dev'),
      cpms: document.getElementById('sw-cpms'),
    };

    if (!this.el.root) return;
    this.#bind();
    this.#bindDev();
    if (Object.keys(this.service.byType).length) this.#applyAssessment(this.service.assess());
    this.render(true);
  }

  #bind() {
    this.el.refresh?.addEventListener('click', () => this.refresh(true));
    window.addEventListener('online', () => this.refresh(false));
    window.addEventListener('offline', () => this.render(true));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Date.now() - this.service.lastSuccessAt > DONKI.autoRefreshMs) {
        this.refresh(false);
      }
    });
  }

  #bindDev() {
    if (!this.el.dev || !this.devMode || !this.sim.events) return;
    this.el.dev.hidden = false;
    this.el.dev.addEventListener('click', (event) => {
      const button = event.target.closest('[data-sw-dev]');
      if (!button) return;
      const kind = button.dataset.swDev;
      const ok = this.sim.events.forceTrigger(kind);
      this.sim.pushLog(
        `DEV PREVIEW: simulated ${kind === 'radiation' ? 'radiation warning' : 'dust storm'} started. This is a MARS MAYHEM game event, not NASA DONKI data.`,
        'info',
      );
      if (ok) this.audio?.ui();
      else this.audio?.warn();
    });
  }

  /** Called every frame from the main loop; network work is time-boxed. */
  update() {
    if (!this.el.root) return;
    const now = Date.now();
    if (now >= this.nextAssessmentAt) {
      this.nextAssessmentAt = now + 60_000;
      if (Object.keys(this.service.byType).length) this.#applyAssessment(this.service.assess(now));
    }
    if (now >= this.nextAutoAt) {
      this.nextAutoAt = now + DONKI.autoRefreshMs;
      if (!document.hidden) this.refresh(false);
    }
    this.render();
  }

  async refresh(manual = false) {
    if (!this.el.root || this.inFlight) return null;
    const now = Date.now();
    if (manual && now - this.lastManualAt < DONKI.manualCooldownMs) return null;
    if (manual) this.lastManualAt = now;

    this.inFlight = true;
    this.render(true);

    try {
      const result = await this.service.refresh();
      if (result.ok || Object.keys(this.service.byType).length) {
        this.#applyAssessment(result.assessment ?? this.service.assess());
      }
      if (result.ok && manual) this.audio?.ui();
      else if (!result.ok && manual) this.audio?.warn();
      return result;
    } catch (error) {
      this.service.status = 'offline';
      this.service.errors = { network: error?.message ?? 'request failed' };
      if (manual) this.audio?.warn();
      return null;
    } finally {
      this.inFlight = false;
      this.render(true);
    }
  }

  #applyAssessment(assessment) {
    if (!assessment) return;
    this.sim.applySpaceWeatherAdvisory({
      level: assessment.level,
      levelNote: assessment.levelNote,
      eventId: assessment.eventId,
      kind: assessment.kind,
      facility: assessment.facility,
      title: assessment.title,
      banner: assessment.banner,
      advisory: assessment.advisory,
      log: assessment.log,
      logKind: assessment.logKind,
      eventTime: assessment.eventTime ?? null,
      source: 'NASA DONKI',
    });
  }

  render(force = false) {
    if (!this.el.root) return;
    const now = Date.now();
    const sw = this.sim.state.spaceWeather ?? { level: 'green' };
    const latest = this.service.events[0] ?? null;
    const updatedAt = this.service.lastUpdatedAt;
    const status = this.inFlight ? 'loading' : this.service.status;
    const cooldown = Math.max(0, Math.ceil((DONKI.manualCooldownMs - (now - this.lastManualAt)) / 1000));
    const shieldDone = Boolean(this.sim.state.topics?.find((topic) => topic.id === 'shield')?.done);
    const cpmsOffline = this.sim.state.cpms?.online === false;
    const key = [
      status,
      updatedAt,
      Math.floor((now - updatedAt) / 60_000),
      sw.level,
      sw.eventId,
      latest?.id,
      this.service.events.length,
      cooldown,
      this.inFlight,
      this.sim.state.crewSheltered,
      shieldDone,
      this.service.rateRemaining,
      cpmsOffline,
      this.sim.state.cpms?.repairing,
    ].join('|');

    if (!force && key === this.lastKey) return;
    this.lastKey = key;

    // CPMS owns delivery. The feed may still poll into the cache, but the crew
    // cannot see DONKI records or advisories until the relay is restored.
    if (cpmsOffline) {
      this.el.root.dataset.cpms = 'offline';
      this.#text(this.el.connection, 'OFFLINE');
      if (this.el.connection) this.el.connection.dataset.state = 'offline';
      if (this.el.cpms) this.el.cpms.hidden = false;
      if (this.el.refresh) {
        this.el.refresh.disabled = true;
        this.el.refresh.textContent = 'COMS OFFLINE';
      }
      return;
    }
    this.el.root.dataset.cpms = 'online';
    if (this.el.cpms) this.el.cpms.hidden = true;

    const level = LEVELS[sw.level] ?? LEVELS.green;
    this.el.root.dataset.level = sw.level ?? 'green';

    let connection = {
      loading: ['SYNC', 'sync'],
      online: ['ONLINE', 'online'],
      partial: ['PARTIAL', 'warn'],
      limited: ['LIMITED', 'warn'],
      offline: ['OFFLINE', 'offline'],
      cached: ['CACHED', 'warn'],
      idle: ['STANDBY', 'offline'],
    }[status] ?? ['STANDBY', 'offline'];

    if ((status === 'offline' || status === 'limited') && Object.keys(this.service.byType).length) {
      connection = ['CACHED', 'warn'];
    }

    this.#text(this.el.connection, connection[0]);
    if (this.el.connection) this.el.connection.dataset.state = connection[1];
    this.#text(this.el.levelLabel, level.label);
    this.#text(this.el.levelNote, sw.levelNote ?? level.note);

    if (latest) {
      this.#text(
        this.el.event,
        `${latest.label}${latest.classification ? ` · ${latest.classification}` : ''}`,
      );
      this.#text(this.el.category, `${latest.short} · ${latest.source}`);
      this.#text(this.el.time, formatUtc(latest.timeMs));
    } else {
      this.#text(this.el.event, `No events in the last ${DONKI.lookbackDays} days`);
      this.#text(this.el.category, '—');
      this.#text(this.el.time, '—');
    }

    this.#text(
      this.el.advisory,
      sw.level === 'green'
        ? 'No active advisory. The retrieved records are below the game alert threshold; the MARS MAYHEM simulation continues normally.'
        : sw.advisory || level.note,
    );

    let updated = updatedAt ? `${formatUtc(updatedAt)} · ${ago(updatedAt, now)}` : 'never';
    if (['cached', 'offline', 'limited', 'partial'].includes(status) && Object.keys(this.service.byType).length) updated += ' · cached data';
    if (this.inFlight) updated += ' · syncing';
    this.#text(this.el.updated, updated);

    const bunker = this.el.readinessBunker;
    if (bunker) {
      const sheltered = Boolean(this.sim.state.crewSheltered);
      bunker.textContent = sheltered ? 'BUNKER: CREW SHELTERED' : 'BUNKER: CREW AT POSTS';
      bunker.className = sheltered ? 'ok' : 'warn';
    }
    const shield = this.el.readinessShield;
    if (shield) {
      shield.textContent = shieldDone ? 'SHIELDING: LICENSED' : 'SHIELDING: NOT RESEARCHED';
      shield.className = shieldDone ? 'ok' : 'warn';
    }

    if (this.el.list) {
      const events = this.service.events.slice(0, DONKI.eventListLimit);
      this.el.list.innerHTML = events.length
        ? events.map((event) => {
          const tone = eventTone(event, now);
          return `<li class="sw-event tone-${tone}">
            <div class="row">
              <span class="type">${escapeHtml(event.short)}</span>
              <span class="cls">${escapeHtml(event.classification || '—')}</span>
              <span class="when">${escapeHtml(formatUtc(event.timeMs))}</span>
            </div>
            <p class="why">${escapeHtml(event.explanation)}</p>
          </li>`;
        }).join('')
        : `<li class="quiet">No DONKI events returned for the last ${DONKI.lookbackDays} days.</li>`;
    }

    const missing = Object.keys(this.service.errors ?? {});
    let source = `NASA DONKI · ${DONKI.endpoints.join(' ')}`;
    if (this.service.rateRemaining !== null) source += ` · ${this.service.rateRemaining} req left`;
    if (missing.length && status !== 'online') source += ` · delayed ${missing.join(' ')}`;
    this.#text(this.el.source, source);

    if (this.el.foot) {
      const offline = status === 'offline' || status === 'limited';
      this.el.foot.textContent = offline
        ? 'NASA LIVE DATA UNAVAILABLE — SIMULATION MODE ACTIVE. Local dust storms, marsquakes, seal faults and equipment failures remain MARS MAYHEM simulation events.'
        : 'DONKI records are space-weather observations, analyses and notifications — not a radiation measurement at Mars. Risk levels are game-side interpretations. Dust storms, marsquakes and faults are MARS MAYHEM simulation, not DONKI forecasts.';
    }

    if (this.el.refresh) {
      const waiting = cooldown > 0;
      this.el.refresh.disabled = this.inFlight || waiting;
      this.el.refresh.textContent = this.inFlight
        ? 'REFRESHING…'
        : waiting
          ? `WAIT ${cooldown}s`
          : status === 'offline' || status === 'limited'
            ? 'RETRY NASA DATA'
            : 'REFRESH NASA DATA';
    }
  }

  prepareCpmsRestore() {
    if (Object.keys(this.service.byType).length) {
      this.#applyAssessment(this.service.assess());
    } else if (this.sim.state.spaceWeather?.level !== 'green') {
      this.#applyAssessment({ level: 'green' });
      this.sim.state.spaceWeather.deliveryPending = false;
    }
  }

  onCpmsRestored() {
    if (!this.el.root) return;
    this.lastKey = '';
    this.render(true);

    const stale = ['idle', 'cached', 'offline', 'limited'].includes(this.service.status);
    const cooling = Date.now() - this.service.lastAttemptAt < DONKI.manualCooldownMs;
    if (stale && !this.inFlight && !cooling) this.refresh(false);
  }

  #text(element, value) {
    if (element && element.textContent !== value) element.textContent = value;
  }
}
