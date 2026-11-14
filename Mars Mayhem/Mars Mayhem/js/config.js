/**
 * Resolved design decisions for MARS MAYHEM (MVP).
 * Every number in this file is a deliberate, simplified gameplay value,
 * not a real-world Mars engineering figure. See DOCS_SCIENTIFIC_NOTES in
 * README-less form: the in-game Help panel repeats this caveat.
 */

export const WORLD = {
  size: 700,          // terrain width/depth in metres (expanded from 460)
  segments: 176,      // terrain grid resolution
  colonyRadius: 30,   // flat plateau radius
  ringRadius: 33,     // facility ring radius
  roadRadius: 42,     // crew/rover travel lane around the buildings
  playableRadius: 250,// soft world bound for the astronaut and rover
  seed: 20261024,
};

/** One Sol lasts SOL_SECONDS of real time at 1x speed. */
export const SOL_SECONDS = 180;
export const MISSION_SOLS = 10;   // survive this many Sols to complete the mission
export const MISSION_SECONDS = SOL_SECONDS * MISSION_SOLS;
export const START_HOUR = 8;

/**
 * Resource sites for ROVER-01. Positions are derived from a bearing and a
 * distance so every deposit sits at a navigable range from the colony and
 * always outside the building ring. Deterministic per site id.
 *
 * `kind` decides what the rover collects and which facility it unloads to:
 * ice is the only source of water, while carbon / oxygen / hydrogen are the
 * three non-interchangeable feedstocks of the return propellant.
 * `capacity` is the finite kg recoverable from that deposit.
 */
export const SITES = [
  { id: 'ice-alpha', kind: 'ice', name: 'North Ice Field', bearing: 62, dist: 96, capacity: 540, richness: 1.0 },
  { id: 'ice-bravo', kind: 'ice', name: 'Crater Rim Deposit', bearing: 205, dist: 128, capacity: 700, richness: 1.15 },
  { id: 'ice-charlie', kind: 'ice', name: 'Eastern Scarp', bearing: 328, dist: 112, capacity: 580, richness: 0.95 },
  { id: 'carb-sulphur', kind: 'carbon', name: 'Sulphur Flats', bearing: 148, dist: 152, capacity: 420, richness: 0.9 },
  { id: 'carb-graphite', kind: 'carbon', name: 'Graphite Ridge', bearing: 20, dist: 214, capacity: 560, richness: 1.2 },
  { id: 'oxy-frost', kind: 'oxygen', name: 'Frost Line Outcrop', bearing: 250, dist: 172, capacity: 480, richness: 1.1 },
  { id: 'oxy-medusae', kind: 'oxygen', name: 'Medusae Terrace', bearing: 306, dist: 128, capacity: 360, richness: 0.95 },
  { id: 'hyd-basin', kind: 'hydrogen', name: 'Hydrogen Basin', bearing: 334, dist: 196, capacity: 380, richness: 1.15 },
  { id: 'hyd-scarp', kind: 'hydrogen', name: 'Scarp Vein', bearing: 112, dist: 188, capacity: 300, richness: 0.9 },
].map((s) => {
  const a = (s.bearing * Math.PI) / 180;
  return { ...s, x: Math.cos(a) * s.dist, z: Math.sin(a) * s.dist };
});

/** The four selectable rover mission types, in console order. */
export const MISSIONS = [
  { kind: 'ice', label: 'Water-Ice Survey', target: 'aqua', unit: 'kg ice' },
  { kind: 'carbon', label: 'Carbon Collection', target: 'fuel', unit: 'kg carbon' },
  { kind: 'oxygen', label: 'Oxygen Resource Survey', target: 'fuel', unit: 'kg oxygen' },
  { kind: 'hydrogen', label: 'Hydrogen Collection', target: 'fuel', unit: 'kg hydrogen' },
];

/** Per-material report copy, so the rover talks like a machine and not a narrator. */
export const MATERIAL_LABEL = {
  ice: 'WATER ICE',
  carbon: 'CARBON',
  oxygen: 'OXYGEN',
  hydrogen: 'HYDROGEN',
};

/** Mission types that must roll for a find; water sites are already proven. */
export const PROSPECT_CHANCE = 0.4;

/** Rover movement + mission tuning. Distances are metres, times are sim seconds. */
export const ROVER = {
  speed: 11,             // driving speed, m/s
  turnLerp: 4.5,         // heading easing while steering
  wheelRadius: 0.55,
  collectSeconds: 10,
  unloadSeconds: 6,
  cooldownSeconds: 10,
  autoRepairSeconds: 16,   // engineer repair time once they are beside the rover
  autoRepairFallback: 60,  // travel/return failsafe if no actor reports arrival (sim seconds)
  gateRadius: WORLD.colonyRadius + 16, // waypoint just outside the buildings
  iceLoadKg: 260,      // nominal ice recovered per successful survey trip
  travelDemand: 14,      // extra power units drawn while driving/collecting
  // kg delivered by one *successful* fuel-material haul, before site richness.
  // Sized so a rover run meaningfully beats the plant's own atmospheric intake
  // (FUEL.intake) without making a 10-Sol return window impossible.
  load: { carbon: 58, oxygen: 66, hydrogen: 48 },
};

export const CAMERA = {
  distance: 7.5,
  minDistance: 3.5,
  maxDistance: 16,
  height: 1.55,
  pitch: 0.32,
  minPitch: -0.15,
  maxPitch: 1.15,
};

/**
 * Shift Lock: the Roblox-style over-the-shoulder camera. The rig is fixed to the
 * commander's right shoulder at one distance, so the only freedom left is the
 * direction you look. Sprint stays on Left Shift — the mode is toggled with
 * Caps Lock precisely because Shift is already spoken for.
 */
export const SHIFT_LOCK = {
  distance: 3.9,       // metres behind the shoulder
  lateral: 0.85,       // metres to the right of the spine
  eyeLift: 0.52,       // camera height above the head when the pitch is level
  lookAhead: 0.9,      // aim point in front of the head, keeps the reticle usable
  shoulderBias: 0.42,  // share of the lateral offset folded into the aim (keeps the body near centre)
  followLerp: 14,      // how hard the target tracks the astronaut
  positionLerp: 16,    // extra smoothing while blending between camera modes
  blendSeconds: 0.45,  // how long the smoothing stays on after a toggle
  yawSpeed: 0.0026,    // radians per pixel of mouse travel
  pitchSpeed: 0.0018,
  minPitch: -0.3,
  maxPitch: 0.48,
  idleFaceLerp: 7,     // turn-to-camera speed while standing still
};

/** Keys the player may bind to the Shift Lock toggle; values are KeyboardEvent.code. */
export const LOCK_KEY_OPTIONS = [
  { code: 'CapsLock', label: 'Caps Lock' },
  { code: 'KeyX', label: 'X' },
  { code: 'KeyF', label: 'F' },
  { code: 'KeyZ', label: 'Z' },
  { code: 'KeyQ', label: 'Q' },
  { code: 'ControlRight', label: 'Right Ctrl' },
  { code: 'AltRight', label: 'Right Alt' },
];

export const PLAYER = {
  walkSpeed: 5.4,
  sprintSpeed: 9.0,
  turnLerp: 10,
  interactRadius: 7.5,
  coverFactor: 0.55,      // share of a specialist's boost while the commander stands at the console
  repairSeconds: 12,
  cleanCooldown: 45,
};

export const DIFFICULTIES = {
  cadet: {
    id: 'cadet',
    label: 'Cadet',
    blurb: 'Forgiving reserves. Recommended for a first run or a live demo.',
    consumption: 0.85,
    hazardChance: 0.08,
    stormStrength: 0.55,
    start: { battery: 78, water: 78, oxygen: 88, food: 72, ice: 300 },
  },
  commander: {
    id: 'commander',
    label: 'Commander',
    blurb: 'Tighter reserves and more frequent failures. The real test.',
    consumption: 1.0,
    hazardChance: 0.14,
    stormStrength: 0.7,
    start: { battery: 62, water: 66, oxygen: 76, food: 60, ice: 210 },
  },
};

/**
 * Resources are tracked as a percentage of a nominal reserve (0-100) so that
 * the HUD stays readable. Rates below are percentage points per simulated second.
 */
export const RATES = {
  crewCount: 4,            // player astronaut + 3 crew

  oxygenUsePerCrew: 0.048,
  waterUsePerCrew: 0.026,
  foodUsePerCrew: 0.042,
  cropWaterPerPlot: 0.018,

  oxygenProduction: 0.235, // O2-MOXIE at full power, undamaged

  cropGrowth: 0.0072,      // per second per plot (needs water + grow lights)
  cropYield: 20,           // food points per mature plot
  researchRate: 0.9,       // research points per second

  dustGain: 0.0016,        // panel soiling per second
  dustCleanRate: 0.055,    // engineer cleaning rate per second
  batteryRate: 0.011,      // battery percent change per (net power unit * second)
};

/**
 * Water is a *processed* resource, not a generator. AQUA-Core turns stored ice
 * into potable reserve at a finite rate, so the colony only makes water for as
 * long as ROVER-01 keeps hauling ice in from deposits that run out.
 */
export const WATER = {
  iceToWater: 0.27,     // % reserve per kg of ice processed
  processingRate: 0.9, // kg ice per sim second, fully staffed and powered
  unstaffed: 0.5,       // share of that rate when nobody is posted at AQUA-Core
  recycle: 0.38,        // share of crew + crop use the recycler claws back
  minStock: 1,          // kg below which the plant has nothing to melt
  hopper: 1000,         // kg the AQUA-Core ice hopper can hold (HUD scale only)
};

/** Crew fatigue, rest and the four-hours-per-Sol sleep rule. */
export const FATIGUE = {
  hoursPerSol: 24,        // one Sol is 24 simulated hours, whatever the speed
  requiredRestHours: 4,   // per astronaut, per Sol — on the simulation clock
  gainPerHour: 4.3,       // awake and on duty
  gainStanding: 2.6,      // awake at HAB, off rotation
  restorePerHour: 28,     // in a bunk — a full window pays for a full Sol on duty
  moderate: 55,           // efficiency starts to slip
  severe: 82,             // mistakes become likely
  exhausted: 97,          // cannot work at all until rested
  efficiency: { normal: 1, moderate: 0.82, severe: 0.56 },
  mistakeChance: 0.3,     // rolled per Sol against a severely fatigued crew member
  healthDrain: 1.4,       // % health per Sim-hour past the exhaustion line
};

/**
 * Rotational bunks. Rest windows are in Sol-relative hours (Sol hour 0 is the
 * 08:00 mission start) and run a little past the 4 h rule, so an astronaut who
 * takes the whole window always clears the end-of-Sol audit. Exactly one
 * specialist is offline at a time and the player has to cover the gap.
 */
export const SLEEP = {
  hours: 4.5,
  shifts: { maya: 1, alex: 7, sam: 13 },
  playerShift: 19,
  bunkOffsets: [
    { x: -2.6, z: 2.2 }, { x: -0.9, z: 2.6 }, { x: 0.9, z: 2.6 }, { x: 2.6, z: 2.2 },
  ],
};

/**
 * The propellant chain: CO₂-stripper carbon and oxygen, hydrogen from
 * electrolysed ice water, Sabatier methane plus LOX into the rocket tanks.
 * Quantities are per 1% of the rocket's propellant load.
 */
export const FUEL = {
  recipe: { carbon: 1.8, oxygen: 2.2, hydrogen: 0.8 },  // kg consumed per 1% fuel
  rate: 0.7,               // % fuel per sim second while the line runs
  store: { carbon: 200, oxygen: 240, hydrogen: 120 },   // kg of raw storage
  intake: { carbon: 0.13, oxygen: 0.16 },              // kg/s from the atmosphere
  electrolysis: { hydrogen: 0.065, water: 0.024 },       // kg H₂/s, % reserve/s
  makePower: 20,           // power units drawn while manufacturing
  harvestPower: 8,         // power units drawn by the stripper alone
  unstaffed: 0.4,          // share of intake/electrolysis with nobody posted
  transferSeconds: 30,     // plant tank → rocket tanks
};

export const ROCKET = {
  capacity: 100,           // % of the return propellant load required to launch
  launchPad: { bearing: 355, dist: 132 },
};


export const POWER = {
  habitat: 16,      // always-on life support floor
  oxygen: 14,
  water: 11,
  grow: 9,
  research: 12,
  rover: 5,
  fuel: FUEL.harvestPower,   // CO₂ stripper and electrolysis idling
  fuelPlant: FUEL.makePower, // propellant line manufacturing
  // Sized against the full day load (≈94 units with the plant idling) so a clear,
  // dust-free day still ends in surplus, but a storm or a solar failure spends
  // the battery and forces a brown-out.
  solarPeak: 300,
  batteryCapacity: 100,
  backupUnits: 25,   // SHELTER-Bunker RTG contribution
  backupCharges: 3,
  backupDuration: 45,
  lowestBattery: 0,
};

/** System shut-down order when the battery is empty. First entries die first. */
export const BROWNOUT_ORDER = ['fuel', 'research', 'rover', 'grow', 'water', 'oxygen'];

export const SYSTEMS = {
  oxygen: { id: 'oxygen', label: 'O₂ production', facility: 'o2' },
  water: { id: 'water', label: 'Water processing', facility: 'aqua' },
  grow: { id: 'grow', label: 'Grow lights', facility: 'bio' },
  research: { id: 'research', label: 'Research power', facility: 'sci' },
  rover: { id: 'rover', label: 'Rover charging', facility: 'rover' },
  fuel: { id: 'fuel', label: 'Propellant plant', facility: 'fuel' },
};

export const RESEARCH = [
  {
    id: 'fuel',
    name: 'Martian Fuel Production Technology',
    summary: 'COMPULSORY. Sabatier methane + LOX licence. Without it the FUEL-PROCESSOR stays cold.',
    cost: 230,
    effect: { fuel: true },
    compulsory: true,
  },
  {
    id: 'soil',
    name: 'Martian Soil Analysis',
    summary: 'Perchlorate-tolerant substrate. Crop growth +25%.',
    cost: 210,
    effect: { cropGrowth: 0.25 },
  },
  {
    id: 'solar',
    name: 'Solar Power Efficiency',
    summary: 'Dust-shedding panel coating. Solar output +18%.',
    cost: 220,
    effect: { solar: 0.18 },
  },
  {
    id: 'ice',
    name: 'Water-Ice Extraction',
    summary: 'Better drilling target selection. Water output +30%.',
    cost: 280,
    effect: { water: 0.30 },
  },
  {
    id: 'crop',
    name: 'Crop Growth in Martian Conditions',
    summary: 'LED spectrum tuning. Crop yield +8 food per harvest.',
    cost: 320,
    effect: { cropYield: 8 },
  },
  {
    id: 'o2',
    name: 'Oxygen Production from CO₂',
    summary: 'MOXIE solid-oxide stack tuning. O₂ output +25%.',
    cost: 340,
    effect: { oxygen: 0.25 },
  },
  {
    id: 'shield',
    name: 'Radiation Shielding Materials',
    summary: 'Storm-hardened seals. Dust storms do 50% less damage.',
    cost: 380,
    effect: { storm: 0.5 },
  },
];

export const CREW = [
  {
    id: 'maya',
    name: 'Maya Chen',
    role: 'Scientist',
    roleId: 'sci',
    color: 0x4fd1c5,
    line: 'Sample assays first. Guessing is how people die up here.',
  },
  {
    id: 'alex',
    name: 'Alex Rivera',
    role: 'Botanist',
    roleId: 'bio',
    color: 0x9ae66e,
    line: 'The greenhouse is the only thing on this planet that grows.',
  },
  {
    id: 'sam',
    name: 'Sam Okafor',
    role: 'Engineer',
    roleId: 'eng',
    color: 0xf6ad55,
    line: 'Everything breaks eventually. I just get there first.',
  },
];

/** A crew member can be posted anywhere, but only their own speciality is fully effective. */
export const POSTS = [
  { id: 'hab', label: 'HAB-Alpha', short: 'Rest rotation', blurb: 'Crew oxygen demand −8%' },
  { id: 'bio', label: 'BIO-Dome', short: 'Agriculture', blurb: 'Crop growth ×1.6, auto-harvest' },
  { id: 'solar', label: 'SOLAR-Grid', short: 'Maintenance', blurb: 'Cleans panels, +8 solar output' },
  { id: 'aqua', label: 'AQUA-Core', short: 'Water plant', blurb: 'Melts stored ice into water, repairs AQUA' },
  { id: 'o2', label: 'O2-MOXIE', short: 'Life support', blurb: 'Oxygen output ×1.4, repairs MOXIE' },
  { id: 'sci', label: 'SCI-Lab', short: 'Research', blurb: 'Research rate ×2.0' },
  { id: 'fuel', label: 'FUEL-PROCESSOR', short: 'Propellant plant', blurb: 'Strips CO₂ into carbon and oxygen' },
  { id: 'rover', label: 'ROVER-01', short: 'Resource haul', blurb: 'Slow steady survey support' },
];

export const POST_EFFECT = {
  sci: 1.0,       // research rate bonus at SCI-Lab (x2 total for a specialist)
  bio: 0.6,       // crop growth bonus
  aqua: 0.6,      // water output bonus
  o2: 0.4,        // oxygen output bonus
  solar: 8,       // flat solar units
  fuel: 1.0,      // scales the plant's atmospheric intake
  rover: 1.0,
  hab: 1.0,
};

export const OFF_SPECIALITY = 0.45;

export const CHOICES = {
  successSol: MISSION_SOLS,
  successResearch: 3,
  resupplyCost: 40,
  resupplyGain: { oxygen: 22, water: 22, food: 18 },
  storm: { startAt: 205, duration: 70, solarLoss: 0.65, dustGain: 0.0022 },
  failureWindow: { from: 95, every: 26 },
  saveKey: 'mars-outpost-survival-save-v3',
  saveVersion: 3,
  autosaveSeconds: 25,
};

/**
 * Random-event director tuning. Each event declares how often it is rolled,
 * its severity band (used to stop two catastrophes stacking) and how it scales
 * across the ten Sols. Probabilities are per roll window, not guaranteed.
 */
export const EVENTS = {
  rollEvery: 42,          // seconds between eligibility rolls (sim time)
  firstSolQuiet: 1.15,    // no random events during the opening phase (fraction of a sol)
  maxConcurrent: 2,       // hard cap on simultaneous active events
  severeLockout: 26,      // seconds the colony stays "busy" after a severe event
  // sol-scaled frequency multiplier: gentle early, tight in the last two sols
  phaseCurve: [0.5, 0.62, 0.78, 0.9, 1.05, 1.2, 1.34, 1.5, 1.7, 1.85],
  kinds: [
    { id: 'dust_devil', label: 'Dust devil', base: 0.26, minSol: 1, severe: false },
    { id: 'dust_storm', label: 'Dust storm', base: 0.20, minSol: 3, severe: true },
    { id: 'greenhouse', label: 'Greenhouse fault', base: 0.24, minSol: 3, severe: false },
    { id: 'rover_breakdown', label: 'Rover breakdown', base: 0.22, minSol: 3, severe: false },
    { id: 'marsquake', label: 'Marsquake', base: 0.20, minSol: 4, severe: false },
    { id: 'seal', label: 'Seal malfunction', base: 0.18, minSol: 5, severe: true },
    { id: 'radiation', label: 'Solar radiation', base: 0.17, minSol: 5, severe: true },
    { id: 'meteorite', label: 'Meteorite impact', base: 0.20, minSol: 5, severe: true },
    { id: 'cpms_failure', label: 'COMS communication failure', base: 0.14, minSol: 2, severe: false },
  ],
};

/**
 * Colony Predictive Monitoring System — the delivery layer between the game's
 * data sources (NASA DONKI, the environmental forecast and HUD warnings) and
 * the player. A CPMS failure never stops the simulation; it only cuts the
 * announcements until an engineer repairs the COMMS-TOWER console.
 */
export const CPMS = {
  facilityId: 'comms',
  repairSeconds: 18,   // simulated seconds of work at the console
  label: 'COLONY PREDICTIVE MONITORING SYSTEM',
};

/**
 * Mars environmental forecast model. This is the game's own offline predictive
 * layer over the event director — it is not a NASA product and it never reads
 * DONKI. The event director schedules a pending hazard, issues one forecast for
 * it and then triggers the event when the countdown reaches zero. Meteorite
 * impacts and solar radiation are deliberately absent: they already carry their
 * own in-game warnings, and leaving them out keeps the forecast honest.
 */
export const FORECAST = {
  leadMin: 22,            // earliest advance warning, simulation seconds
  leadMax: 55,            // latest advance warning, simulation seconds
  maxPending: 2,          // never stack more forecasts than this
  maintenanceWindow: 30,  // sensor look-ahead for the baseline wear failures
  maintenanceChance: 0.5, // the model does not catch every wear window
  kinds: {
    dust_storm: {
      code: 'DUST STORM',
      headline: 'High atmospheric dust activity expected in approximately {seconds} seconds.',
      systems: 'Solar power generation and panel efficiency.',
      action: 'Prepare backup power and check battery reserves.',
    },
    marsquake: {
      code: 'MARSQUAKE',
      headline: 'Ground instability detected. Seismic activity expected shortly.',
      systems: 'Colony equipment and research systems.',
      action: 'Check critical facilities and prepare for possible repairs.',
    },
    dust_devil: {
      code: 'DUST DEVIL',
      headline: 'Localised dust activity approaching the solar array field.',
      systems: 'Visibility and solar-panel efficiency.',
      action: 'Prepare to inspect and clean the solar arrays.',
    },
    greenhouse: {
      code: 'GREENHOUSE SYSTEM',
      headline: 'Possible greenhouse malfunction detected.',
      systems: 'Crop irrigation, temperature and lighting.',
      action: 'Keep the botanist available for maintenance.',
    },
    rover_breakdown: {
      code: 'ROVER-01',
      headline: 'Possible rover malfunction detected during the next operational period.',
      systems: 'Resource collection and return-propellant production.',
      action: 'Keep the engineer available for repairs.',
    },
    seal: {
      code: 'SEAL MALFUNCTION',
      headline: 'Hull pressure anomaly detected on an external seal.',
      systems: 'Oxygen reserves and facility pressure integrity.',
      action: 'Stand by to re-press the affected module or post a crew member.',
    },
    equipment: {
      code: 'EQUIPMENT ISSUE',
      headline: 'Potential equipment issue detected in the life-support and power ring.',
      systems: 'AQUA-CORE, O2-MOXIE and SOLAR-GRID monitoring channels.',
      action: 'Hold an engineer free and keep the EVA toolkit ready.',
    },
  },
};

/** Expected severity per hazard class, rising across the ten Sols. */
export const FORECAST_SEVERITY = {
  dust_devil: (sol) => (sol >= 5 ? 'MODERATE' : 'LOW'),
  dust_storm: (sol) => (sol >= 7 ? 'SEVERE' : 'HIGH'),
  greenhouse: (sol) => (sol >= 6 ? 'HIGH' : 'MODERATE'),
  rover_breakdown: (sol) => (sol >= 7 ? 'HIGH' : 'MODERATE'),
  marsquake: (sol) => (sol >= 6 ? 'HIGH' : 'MODERATE'),
  seal: (sol) => (sol >= 7 ? 'SEVERE' : 'HIGH'),
  equipment: (sol) => (sol >= 6 ? 'MODERATE' : 'LOW'),
};

/** Gradual resource pressure so Sols 7–10 bite without being unfair. */
export const PRESSURE = {
  fromSol: 5,
  perSol: 0.035,   // extra consumption multiplier per sol past fromSol
  max: 1.28,
};

export const FACILITIES = [
  {
    id: 'hab', code: 'HAB-ALPHA', name: 'Crew Habitat',
    purpose: 'Pressurised living quarters, life-support status and the four crew bunks.',
    angle: 0, color: 0xbcd3e0, height: 6.2,
  },
  {
    id: 'bio', code: 'BIO-DOME', name: 'Agriculture Dome',
    purpose: 'Hydroponic beds. Crops need water, light and time.',
    angle: 36, color: 0x9ae66e, height: 6.0,
  },
  {
    id: 'solar', code: 'SOLAR-GRID', name: 'Solar Array Field',
    purpose: 'Primary power. Dust on the panels cuts output.',
    angle: 72, color: 0x5a8cff, height: 5.0,
  },
  {
    id: 'bat', code: 'BAT-VAULT', name: 'Battery Vault',
    purpose: 'Stores surplus power and lets you shed loads.',
    angle: 108, color: 0xf6e05e, height: 5.0,
  },
  {
    id: 'aqua', code: 'AQUA-CORE', name: 'Water Processing',
    purpose: 'Melts stored ice into potable water. No ice, no water.',
    angle: 144, color: 0x63c7ff, height: 5.6,
  },
  {
    id: 'o2', code: 'O2-MOXIE', name: 'Oxygen Plant',
    purpose: 'Splits CO₂ from the Martian atmosphere into oxygen.',
    angle: 180, color: 0x7ef0d0, height: 5.8,
  },
  {
    id: 'sci', code: 'SCI-LAB', name: 'Science Laboratory',
    purpose: 'Turns power and a scientist into permanent upgrades.',
    angle: 216, color: 0xc98cff, height: 5.4,
  },
  {
    id: 'comms', code: 'COMMS-TOWER', name: 'Communications',
    purpose: 'One emergency resupply request, paid for in research.',
    angle: 252, color: 0xff9f7a, height: 5.4,
  },
  {
    id: 'shelter', code: 'SHELTER-BUNKER', name: 'Radiation Shelter',
    purpose: 'Shelters the crew and hosts the backup RTG.',
    angle: 288, color: 0xd8b48a, height: 5.2,
  },
  {
    id: 'rover', code: 'ROVER-01', name: 'Survey Rover',
    purpose: 'Ice, carbon, oxygen and hydrogen prospecting. Support equipment, not the protagonist.',
    angle: 324, color: 0xe0e0e0, height: 4.4,
  },
  {
    id: 'fuel', code: 'FUEL-PROCESSOR', name: 'Mars Return Propellant Plant',
    purpose: 'Carbon + hydrogen → methane. Oxygen as oxidiser. Needs the fuel licence.',
    angle: 90, orbit: 60, padRadius: 10.5, color: 0xff8a5c, height: 7.4,
  },
  {
    id: 'pad', code: 'LAUNCH-SITE', name: 'Return Rocket M3',
    purpose: 'The ship that never fuelled at home. Load it and go.',
    angle: ROCKET.launchPad.bearing, orbit: ROCKET.launchPad.dist,
    padRadius: 15, color: 0xdfe6ea, height: 8.2,
  },
];

export const KEYS = {
  interact: ['e', 'E'],
  crew: ['c', 'C'],
  research: ['r', 'R'],
  telemetry: ['m', 'M'],
  help: ['h', 'H', 'Escape'],
  speed: ['t', 'T'],
};

/* ───────────────────────── rover route geometry ─────────────────────────
 * Pure maths shared by the simulation (trip durations) and the rover actor
 * (waypoint following), so the sim stays render-free and the two never drift.
 * Routes leave the colony through a gate point outside the building ring and
 * return along the road lane, so the rover never drives through facilities. */

const degRad = (d) => (d * Math.PI) / 180;

export function facilityXZ(id) {
  const f = FACILITIES.find((x) => x.id === id);
  const a = degRad(f.angle);
  const r = f.orbit ?? WORLD.ringRadius;
  return { x: Math.cos(a) * r, z: Math.sin(a) * r };
}

function gatePoint(angleRad, radius) {
  return { x: Math.cos(angleRad) * radius, z: Math.sin(angleRad) * radius };
}

export function arcPoints(fromAngle, toAngle, radius, step) {
  let delta = toAngle - fromAngle;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  const pts = [];
  const n = Math.max(1, Math.ceil(Math.abs(delta) / step));
  for (let i = 1; i < n; i++) pts.push(gatePoint(fromAngle + (delta * i) / n, radius));
  return pts;
}

export const pathLen = (pts) => {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return d;
};

/** Point + travel direction at arc-length fraction t along a waypoint polyline. */
export function pathPoint(points, t) {
  const segLen = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
    segLen.push(d);
    total += d;
  }
  let want = Math.min(1, Math.max(0, t)) * total;
  for (let i = 0; i < segLen.length; i++) {
    if (want <= segLen[i] || i === segLen.length - 1) {
      const a = points[i];
      const b = points[i + 1];
      const f = segLen[i] > 0 ? Math.min(1, Math.max(0, want / segLen[i])) : 1;
      return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, dx: b.x - a.x, dz: b.z - a.z };
    }
    want -= segLen[i];
  }
  const end = points[points.length - 1];
  return { x: end.x, z: end.z, dx: 0, dz: 1 };
}

/**
 * Full route for a survey trip: pad → gate → site → gate → target plant → pad.
 * Returns waypoint legs plus sim-second durations for each driving phase.
 */
export function roverRoute(siteIndex) {
  const s = SITES[Math.max(0, Math.min(SITES.length - 1, siteIndex))];
  const pad = facilityXZ('rover');
  const targetId = MISSIONS.find((m) => m.kind === s.kind)?.target ?? 'aqua';
  const target = facilityXZ(targetId);
  const siteAngle = Math.atan2(s.z, s.x);
  const padAngle = Math.atan2(pad.z, pad.x);
  const targetAngle = Math.atan2(target.z, target.x);

  const out = [pad, ...arcPoints(padAngle, siteAngle, ROVER.gateRadius + 4, 0.6), gatePoint(siteAngle, ROVER.gateRadius), { x: s.x, z: s.z }];
  const back = [{ x: s.x, z: s.z }, gatePoint(siteAngle, ROVER.gateRadius), ...arcPoints(siteAngle, targetAngle, ROVER.gateRadius + 4, 0.6), target];
  const toPad = [target, ...arcPoints(targetAngle, padAngle, ROVER.gateRadius + 4, 0.6), pad];

  const dist = { out: pathLen(out), back: pathLen(back), toPad: pathLen(toPad) };
  return {
    out,
    back,
    toPad,
    dist,
    target: targetId,
    seconds: {
      outbound: dist.out / ROVER.speed,
      returning: dist.back / ROVER.speed,
      standby: dist.toPad / ROVER.speed,
      collecting: ROVER.collectSeconds,
      unloading: ROVER.unloadSeconds,
    },
    total:
      (dist.out + dist.back + dist.toPad) / ROVER.speed +
      ROVER.collectSeconds +
      ROVER.unloadSeconds,
    survey: s,
  };
}

/** Indices into SITES for one mission kind, richest deposit first. */
export function sitesForKind(kind) {
  return SITES.map((s, i) => ({ s, i }))
    .filter(({ s }) => s.kind === kind)
    .map(({ i }) => i);
}
