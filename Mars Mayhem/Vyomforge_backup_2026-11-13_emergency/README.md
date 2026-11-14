# MARS: OUTPOST SURVIVAL

A playable 3D Mars-colony survival prototype. You are the astronaut on the ground:
walk the outpost, open the consoles, dispatch ROVER-01 on resource runs, keep four people
alive and rested through ten sols of dust storms, marsquakes, seal leaks and radiation
events, and manufacture the propellant that takes the crew home. Surviving ten sols is no
longer the win condition — **survive Mars, build your fuel, find your way home.**

Built for NASA Space Apps Challenge 2026. Runs fully offline — no network calls, no
external assets, no build step.

---

## Running it

The game uses ES modules, so it must be served over HTTP rather than opened as a file.
Two tiny host scripts do that. Both send `Cache-Control: no-store` (a reload always
gives you the code you just edited) and both step to the next free port if 8123 is taken.

**Windows** — double-click `start.bat`, or from a prompt:

```
start.bat                                    http://localhost:8123/
start.bat --lan                              also reachable from other machines on the network
start.bat --port 9000                        different port
powershell -NoProfile -ExecutionPolicy Bypass -File host.ps1    run the host directly
py host.py --lan                             use the Python host instead
```

`host.ps1` opens a plain TCP socket, so it needs nothing installed and no admin
rights. `--lan` listens on all interfaces — Windows may ask about the firewall.
`start.bat` prefers the Python host when Python is present (that one is tested end
to end) and falls back to PowerShell otherwise; either way the window stays open
with the error text if something fails.

**Linux / macOS** — `./host.py`, which is Python 3 standard library only:

```bash
./host.py              # http://127.0.0.1:8123/
./host.py --lan        # also reachable from other machines on the same network
./host.py --port 9000  # different port
```

`start.sh` is the alias for the Python host. Any static file server works too
(VS Code Live Server, `npx serve`, nginx) — but those cache ES modules aggressively,
so hard-reload (`Ctrl+Shift+R`) after editing. No internet access is required at any
point; `js/vendor/three.min.js` (r128) is committed locally.

---

## Two-minute test route

1. Serve the folder (`start.bat` / `./host.py`) and open the printed URL. The title screen
   should show **10 sols** and no console errors (`F12` → Console must stay clean).
2. Pick **Cadet**. The opening cinematic starts immediately: Earth, the three Ares-Home
   rockets on the orbital pad, two leaving and one held back by a propellant shortage, the
   mission-control message, the transit and the landing on the colony. `Esc` / **SKIP INTRO**
   jumps straight to the game; the tagline reads *SURVIVE MARS. BUILD YOUR FUEL. FIND YOUR
   WAY HOME.*
3. Sol 1 is hazard-free: walk with `WASD`, orbit with the mouse, press `E` at a pad to open
   its console. The HAB console lists all four crew with status and fatigue; **Rest here
   (4 h)** pulls you onto a bunk and back to the colony overview camera, `E` gets you up.
4. Press `T` twice (4×) and walk to ROVER-BAY: choose one of the four mission types
   (Water-Ice Survey, Carbon Collection, Oxygen Resource Survey, Hydrogen Collection), watch
   ROVER-01 drive the route, drill, and either report a secured deposit or come back empty —
   ~40% of fuel-material runs are dry. The HUD chip tracks
   `Travelling / Collecting / Returning / Unloading / Recharging`.
5. Research **Martian Fuel Production Technology** at the SCI-Lab (it is compulsory), then
   open the FUEL-PROCESSOR console: the plant strips CO₂ for carbon and oxygen, electrolyses
   water for hydrogen, and only then runs the propellant line. Fill the plant tank, transfer
   to M3 at the LAUNCH-SITE and launch once all ten journey-home objectives are green — the
   launch console stays interlocked before that.
6. Press `Esc` mid-drive: the rover, the crew and the sim clock all stop. Resume and the
   rover continues from the same percentage.
7. From ~sol 2 the event director starts rolling: watch the log/banner, then the sky
   (storm, radiation tint, meteor streak), the camera (marsquake) and the consoles
   (seal, greenhouse, rover breakdown). Shelter the crew from SHELTER-BUNKER during a
   radiation warning.
8. Pause → **Save outpost**, reload the page, **Continue saved outpost**: the mission
   resumes with the same sol, resources, deposits, fatigue and rover phase — and the opening
   cinematic does not replay.
9. Let oxygen run down, or let the commander collapse from missed rest, to see the failure
   report (sols survived, crew status, research, propellant, reserves and the reason). Hold
   ten sols, three topics and a fuelled M3 to play the ending cinematic and the graded
   **MISSION SUCCESSFUL** report.

---

## Controls

| Input | Action |
|---|---|
| `W` `A` `S` `D` / arrow keys | Walk (camera-relative) |
| `Shift` | Sprint |
| Mouse drag | Orbit the camera |
| Mouse wheel | Zoom |
| `E` | Open / close the nearest facility console |
| `C` | Crew assignment board |
| `R` | Research queue |
| `M` | Colony telemetry and load control |
| `T` | Cycle simulation speed (1× / 2× / 4×) |
| `H` / `Esc` | Pause, controls, save |
| `Esc` / `Space` | Skip the opening or ending cinematic (the mission report itself is never skippable) |
| `M` | Sound on/off (also works inside the cinematics) |

Opening any console pauses the simulation. The clock resumes when you close it.
`E` also gets you out of a bunk; while you sleep the camera holds the colony overview.

---

## The mission

Ten sols (one sol = 180 s, so ~30 minutes at 1× and ~8 minutes at 4×) is the window, not the
goal. The run is won by clearing all **ten journey-home objectives** on the HUD board:

| # | Objective | Checked by |
|---|---|---|
| 1 | Survive 10 Sols | `elapsed ≥ 10 × SOL_SECONDS` |
| 2 | All four astronauts alive | `crewRoster().filter(alive).length ≥ 4` |
| 3 | Martian Fuel Production Technology | compulsory topic licensed |
| 4 | 3 research topics complete | `CHOICES.successResearch = 3` |
| 5 | Collect return carbon | cumulative collected ≥ 180 kg |
| 6 | Collect oxidiser oxygen | cumulative collected ≥ 220 kg |
| 7 | Collect hydrogen | cumulative collected ≥ 80 kg |
| 8 | Manufacture the propellant load | cumulative `fuel.made ≥ 100%` |
| 9 | Load the return rocket | M3 tanks ≥ 100% |
| 10 | Launch for Earth | `rocket.launched` |

`sim.missionReadiness()` returns exactly these ten rows and `launchRocket()` refuses
while any of them is open — it logs `LAUNCH SCRUBBED — n objectives outstanding: …` instead.
Surviving ten sols with an unfuelled rocket is a stalemate, not a win.

Failure is `MISSION FAILED — THE CREW DID NOT SURVIVE.` (oxygen at zero, or a crew member
lost), reported with sols survived, crew status, research, propellant, feedstock, final
reserves, objectives cleared and the reason. No success cinematic plays on a failed run.

Two difficulties: **Cadet** (forgiving reserves, fewer breakdowns) and **Commander**
(tighter reserves, more failures, stronger storms, harsher hazard curve).

Resource pressure ramps gradually: sols 1–2 are quiet so you can learn the colony, hazards
get more frequent and longer into sols 3–6, and from sol 5 every system consumes a little
more each sol (`PRESSURE` in `js/config.js`). The mission report grades the run
(A · HOME down to D · MARGINAL) on sols survived, research, final reserves, crew rest and
rover work.

---

## How the systems depend on each other

Nothing in the colony is a standalone button.

- **Power is the master resource.** Solar arrays generate; HAB-Alpha, O₂-MOXIE,
  AQUA-Core, the grow lights, the lab, the propellant plant and the rover all draw from
  the same budget. Night rationing sheds research, grow lights and rover after dark. If
  the battery empties anyway, the brownout controller sheds loads in a fixed order —
  fuel → research → rover → grow lights → water → oxygen — so life support goes last.
- **Dust is a slow tax.** Panels soil continuously and far faster in a storm. Output
  drops by up to 55%. You can clean them by hand at SOLAR-Grid, or leave a crew
  member on maintenance duty to clean continuously.
- **No power, no oxygen.** MOXIE only produces while powered and undamaged, so a
  power decision becomes a life-support decision a few minutes later.
- **Water is finite now.** It comes out of the ice hopper at AQUA-Core, and the hopper is
  only ever as full as the last ROVER-01 haul. Recycling recovers 38% of what the crew and
  crops drink, so a colony that stops hauling ice dries out: an unmanaged reserve falls
  ~12.6%/sol. The three ice deposits hold 1 820 kg in total and each one drains trip by trip.
- **The propellant chain is the endgame.** Carbon and oxygen are stripped from the
  atmosphere at the FUEL-PROCESSOR, hydrogen is electrolysed out of the *same* water the
  crew drinks, and the line only runs with a fuel licence, three non-interchangeable
  feedstock stores and power. Nothing is produced by a button alone.
- **Water splits between crew, crops and the hydrogen line.** Crops consume water per
  growing bed, electrolysis consumes it per 1% of propellant, and the crew drink from the
  same reserve. Sending every litre into the fuel plant is a real risk, not a free trade.
- **Food is a crop cycle, not a tap.** Beds need water, light and ~170 s of growth.
  Post the botanist at BIO-Dome and harvesting becomes automatic; otherwise you walk
  over and harvest yourself.
- **Research is paid for in power and personnel.** 12 units and a specialist at
  SCI-Lab double the rate. Every completed topic changes the simulation rather than
  decorating it (see below).
- **Crew are the multipliers — and they need sleep.** Three specialists, eight posts, one
  body each. A specialist is worth 2× a non-specialist; posting the engineer at SOLAR-Grid
  means they are *not* repairing AQUA-Core. Each astronaut also needs 4 simulated hours in
  a bunk every sol, on a staggered rotation so only one specialist is offline at a time —
  and you cover the gap.

### Research effects

Seven topics, three of them required to finish (`CHOICES.successResearch = 3`). Costs run
210–380 points; the engineer-posted rate is ~1.8 points/s, so three topics are roughly
four sols of lab time and the fuel licence is the one to take first.

| Topic | Cost | Effect |
|---|---|---|
| **Martian Fuel Production Technology** (compulsory) | 230 | Unlocks the FUEL-PROCESSOR line — Sabatier methane + LOX licence |
| Martian Soil Analysis | 210 | Crop growth +25% |
| Solar Power Efficiency | 220 | Solar output +18% |
| Water-Ice Extraction | 280 | Water output +30%, richer rover finds |
| Crop Growth in Martian Conditions | 320 | +8 food per harvest |
| Oxygen Production from CO₂ | 340 | O₂ output +25% |
| Radiation Shielding Materials | 380 | Dust storms do 50% less damage |

### Hazards

A random-event director (`js/events.js`) rolls the hazard calendar every sim tick. Rolls
are every ~42 s scaled by the sol-band curve, kinds have their own cooldowns (110 s for a
dust devil, 280 s for a meteorite), a maximum of two concurrent events, and a lockout
after any severe event so they never stack. Every hazard warns first and is survivable.

| Event | Warns | What it does | Your response |
|---|---|---|---|
| Dust devil | log + haze on the array field | 14–22 s of visibility loss, dust on the panels | walk to SOLAR-Grid and clean |
| Dust storm | sol-2 scripted storm + log | solar collapses, dust ~2.4× faster, longer into the mission | RTG backup, rationing, shelter the crew |
| Greenhouse fault | console + log | BIO-Dome irrigation/temperature/lighting failure | post the botanist or repair it yourself |
| Rover breakdown | HUD chip turns red | ROVER-01 stops mid-survey (never permanent) | walk to it and repair, or let the engineer do it |
| Marsquake | log + camera vibration | shaking; may damage one non-habitat system or de-calibrate sensors (research halved for 90 s) | repair, or ride it out |
| Seal malfunction | console + banner + log | rare external O₂ leak at one facility (never the habitat core) | REPAIR SEAL from that facility's console |
| Solar radiation | telemetry warning 42 s ahead | 22 s peak; if the crew is exposed, efficiency drops to 75% for a stretch | SHELTER CREW from the bunker console |
| Meteorite | TRACK log line 16 s ahead + visible streak | crater at the impact point; may disable one array/aqua/O₂ unit | move nothing — it is never a colony-killer |

- Random equipment failures also start on their own timer after ~95 s: the arrays,
  AQUA-Core or MOXIE go dark until repaired. Repair by posting the engineer (20 s) or by
  doing it yourself at the facility (12 s, and you must stay put).
- The SHELTER-BUNKER holds three backup RTG charges (+25 power for 45 s each) — the
  cheapest way through a storm — and is where you shelter the crew.

### ROVER-01 and the resource field

The rover is a physical vehicle with a simulation-owned phase machine
(`idle → outbound → collecting → returning → unloading → standby → cooldown`) and a
rendering actor that is a pure function of that state, so it never drifts when you pause,
change speed or reload a save. It walks/rolls the whole route — pad, gate arc, deposit,
plant, pad — with visible wheel rotation, a drill at the marker and a cargo load that only
exists once the roll is won. It draws `POWER.rover` plus `ROVER.travelDemand` while
deployed. The HUD chip shows `Idle / Travelling / Collecting / Returning / Unloading /
Recharging / Malfunction` with live progress and trip count.

From the ROVER-BAY console you choose one of four mission types, each bound to its own
typed deposits:

| Mission | Material | Unloads at | Typical haul |
|---|---|---|---|
| Water-Ice Survey | ice | AQUA-Core hopper → water | up to 260 kg × richness, always yields while the deposit lasts |
| Carbon Collection | carbon | FUEL-PROCESSOR store | 58 kg × richness |
| Oxygen Resource Survey | oxygen | FUEL-PROCESSOR store | 66 kg × richness |
| Hydrogen Collection | hydrogen | FUEL-PROCESSOR store | 48 kg × richness (electrolysis feedstock) |

Fuel-material runs are **prospected at 40%** (`PROSPECT_CHANCE`). A dry run genuinely
carries nothing: the console reports
`ROVER-01 REPORT: NO USABLE CARBON DEPOSIT FOUND. RETURNING EMPTY.`, the bay stays empty,
the store does not move, and the deposit still loses 35% of a load because the drill worked
ground that was not there. A hit reports
`ROVER-01 REPORT: CARBON DEPOSIT FOUND. MATERIAL SECURED.` — and the result is on the board
while the cargo is still in the bay, so you see the find before it is banked at the plant.

Nine deposits are mapped inside the 700 × 700 m field (three ice, two each of carbon,
oxygen and hydrogen, 1 820 kg of ice in total). Every trip subtracts from `state.sites[i].remaining`,
the console shows the kilograms left per material, and an exhausted deposit refuses the
dispatch — the field is a budget, not a respawn point.

### FUEL-PROCESSOR: the return-propellant plant

A physical plant on its own pad 60 m out on the colony ring, with harvest intakes, three
separate feedstock tanks, an electrolyser, a reactor column, a product tank and its own
console.

- **Three non-interchangeable materials.** Per 1% of propellant the line eats
  1.8 kg carbon + 2.2 kg oxygen + 0.8 kg hydrogen. Carbon and oxygen come off the
  Martian atmosphere through the intakes (0.13 / 0.16 kg/s with a staffed plant, roughly
  half that unstaffed, and only while powered); hydrogen is electrolysed out of the
  *drinking* water reserve (0.065 kg/s of H₂ against 0.024 kg/s of water, and only while
  the reserve stays above 8%). ROVER-01 can top any of the three stores directly.
  No substitute, no bypass.
- **Gated by research.** `fuelCanMake()` is false until Martian Fuel Production Technology
  is complete; the console says `NO LICENCE: complete Martian Fuel Production Technology at
  the SCI-Lab first.` and the start button is inert.
- **Gated by materials and power.** Starting with a dry store logs
  `Not enough feedstock — the line needs carbon, oxygen and hydrogen in the mix.` The plant
  idles at 8 power units and draws 20 while manufacturing; a brownout or an empty store stops
  the line and records the interruption (`Line stopped n s after start`).
- **Storage is capped** at 200/240/120 kg, so the plant has to run while you spend the
  feedstock rather than after.
- **Product tank → M3.** Transfer takes 30 s of line pressure and moves whatever the plant
  tank holds; the M3 can be topped up in parts. `fuel.made` accumulates, so the
  "manufacture the propellant load" objective tracks total production instead of the
  instantaneous tank level — that combination is what keeps a partial transfer from
  soft-locking the launch.

### LAUNCH-SITE and the return rocket

M3 stands on its own pad 132 m outside the ring from the start of the run, with a visible
tank farm, gantry and fill line. The pad console shows propellant percentage,
transfer state, crew aboard and the full ten-row launch board; the launch button stays
disabled until `launchReady()` is true, and `launchRocket()` refuses with
`LAUNCH SCRUBBED — n objectives outstanding: …` if you try to force it. Launch sets
`flags.complete`, plays the ending cinematic and then the graded report.

### Crew rest and fatigue

Four astronauts — you, Maya Chen (scientist), Alex Rivera (botanist) and Sam Okafor
(engineer) — share four berths inside HAB-Alpha.

- Fatigue accrues on the sim clock — 4.3%/h while working a post, 2.6%/h awake and off
  rotation, and sheltering in the bunker recovers 60% of a bunk's rate. A bunk restores
  28%/h. Statuses are `Working / Walking / Resting / Sleeping / Sheltering / Exhausted`.
- Every astronaut needs **4 simulated hours** in a bunk each sol (`SLEEP.hours = 4.5`
  window). The rotation is staggered at sol hours 1 / 7 / 13, with the commander's window
  at 19, so only one specialist is offline at a time. The crew board shows each window,
  moves it ±1 h, and can send anyone (including you) to a bunk early.
- Assignments are blocked while a crew member is asleep:
  `Alex Rivera is in the bunk — let them finish their rest.`
- Past 55% fatigue colony output slips to ×0.82 and past 82% to ×0.56, with a 30%-per-Sol
  chance that a severely tired crew member mis-sets something and starts a fault. At 100%
  the body stops working: health drains 1.4%/sim-hour, and a crew member who reaches zero
  is lost.
- You rest from the HAB console (**Rest here (4 h)**) or from the crew board. The camera
  pulls back to the colony overview (distance 46, pitch 1.04), the sim keeps running, and
  `E` puts you back on duty with the camera restored.

---

## Cinematics

**Opening** (`js/intro.js`, 52.5 s, skippable with `Esc` / `Space` / **SKIP INTRO**). It is
a rendered Three.js sequence with its own scene, camera tracks and procedural audio — not a
slideshow: Earth in space, a dolly past the three Ares-Home rockets on the transfer pad,
two igniting while the third stays dark, the mission-control teletype
(`M3 REMAINS UNFUELLED. / PROPELLANT COVERS TWO SHIPS ONLY. / KEEP THE CREW. BUILD THE
RETURN.`), the transit streak, Mars growing on approach, the entry flash into the colony
taking shape with the four astronauts on the regolith, then the title card and the tagline
**SURVIVE MARS. BUILD YOUR FUEL. FIND YOUR WAY HOME.** It plays once per page session, on
the first difficulty pick, and never replays for a saved outpost.

**Ending** (`js/outro.js`, eleven beats over ~44 s, skippable up to the report): the fill
line, the launch-ready card, the crew crossing the pad, gantry retract and countdown,
ignition, liftoff, the cut to the space scene, the cruise with Mars and Earth both in
frame, arrival, then **MISSION SUCCESSFUL** and **FOUR ASTRONAUTS. ONE COLONY. ONE JOURNEY
HOME.** with the graded report. The report beat hides **SKIP** by design: you can skip the
flight, never the debrief. A failed run never plays it — `outro.js` is only reachable from
`flags.complete`.

---

## HUD and telemetry

The rust/basalt-and-cyan interface keeps the original look and now carries the journey:

- Life-support strip: power, water, **O₂ to breathe**, food and research.
- Journey-home strip, kept physically separate so the two clocks of the mission read
  apart: **Ice**, **Carbon**, **O₂ (fuel)**, **H₂**, **Plant**, **M3** and **Crew rest** —
  each with its own value, meter and one-line note.
- Mission board: all ten objectives with live values (`JOURNEY HOME · n OF 10`).
- Rover chip: phase, mission type, progress, trip count and the last report —
  `SECURED` or `DRY` — plus the kilograms left per deposit type.
- Fuel telemetry in the plant and telemetry consoles: plant tank %, cumulative propellant
  made, M3 %, feedstock stores, power draw and the licence state.
- Warning banner and the telemetry advisories list cover low water, an empty ice hopper,
  a nearly empty feedstock store, exhausted crew, an interrupted production line, a dry
  rover run, an unlicensed plant and an unfuelled or unready rocket.

---

## Decision register (resolves the open items in the PRD draft)

| PRD decision | Resolution in this build | Where |
|---|---|---|
| Game engine | Three.js r128 (vendored, offline), custom lightweight game loop | `js/vendor/`, `js/main.js` |
| Programming language / stack | Vanilla JavaScript ES modules, HTML, CSS. No framework, no bundler | `js/`, `index.html` |
| Camera and movement | Third-person orbit-follow camera, camera-relative walking on foot, terrain-following | `js/player.js`, `js/world.js` |
| Player character | Procedural EVA astronaut: helmet, reflective visor, life-support pack, four animated limbs | `js/astronaut.js` |
| World generation | Procedural heightmap terrain with craters and a ridged mountain rim, seeded and deterministic; colony plateau flattened | `js/world.js` |
| World size / boundaries | 700 × 700 m terrain, walkable inside a 250 m radius, hills and 16 craters outside the colony, nine typed resource deposits (3 ice / 2 carbon / 2 oxygen / 2 hydrogen) at 300–700 m | `js/config.js` (`WORLD`, `SITES`) |
| Facility list | The ten PRD facilities plus two new interactive sites — FUEL-PROCESSOR and LAUNCH-SITE — all explorable | `js/colony.js`, `js/industry.js` |
| Crew scope | Maya Chen (scientist), Alex Rivera (botanist), Sam Okafor (engineer) and the commander; 8 assignable posts, visible walk to the post with name badge, assignment ring, work animation and four HAB berths with a sleeping pose | `js/crew.js`, `js/industry.js` |
| Crew assignment mechanics | One crew per post, reassignment swaps occupants, specialist 100% / off-speciality 45%, sheltering zeroes every outdoor post, the commander physically covers a post at 55% while standing at it, and assignment is refused while anyone is in a bunk | `js/simulation.js` |
| Crew rest | 4 simulated hours in a bunk per Sol on a staggered rotation (sol hours 1 / 7 / 13 / 19), viewable and adjustable on the crew board, fatigue → output → mistakes → health | `js/config.js` (`FATIGUE`, `SLEEP`), `js/simulation.js` |
| Resource model | Percent-of-reserve resources with continuous rates; coupled production/consumption. Water is finite: it exists only while ice is in the AQUA hopper, and the ice field runs out | `js/config.js` (`RATES`, `WATER`), `js/simulation.js` |
| Power model | 300-unit solar peak against a ~94-unit day load, priority brownout shedding (fuel → research → rover → grow → water → oxygen), 100-unit battery, night rationing | `js/simulation.js` |
| Propellant | Sabatier methane + LOX from three non-interchangeable feedstocks (1.8 C / 2.2 O / 0.8 H per 1%), research-licensed, power-drawn, stored in a visible plant tank and transferred to M3 under line pressure | `js/config.js` (`FUEL`, `ROCKET`), `js/simulation.js`, `js/industry.js` |
| Research | Seven topics, 210–380 points each, one compulsory (Martian Fuel Production Technology); three topics are needed to launch | `js/config.js` (`RESEARCH`) |
| Mission structure | One mission: the ten-row journey-home board (survival, crew, licence, research, three feedstocks, manufacture, load, launch), then the ending cinematic and a graded report. Surviving 10 sols alone is not a win. No sandbox, no procedural missions | `js/simulation.js`, `js/hud.js` |
| Failure conditions | Oxygen at zero or any astronaut lost — reported as `MISSION FAILED — THE CREW DID NOT SURVIVE.` with sols survived, crew, research, propellant, reserves and the reason. No success cinematic plays | `js/simulation.js`, `js/hud.js` |
| Rover | Physically mobile, four selectable mission types, a real 40% prospect roll (dry runs carry nothing and still disturb the deposit), typed unloading, HUD status chip, power draw while driving, event-compatible breakdowns | `js/rover.js`, `js/simulation.js` |
| Cinematics | Animated 3D opening (Earth → three rockets → two launch → transit → Mars → colony → briefing, 52.5 s, skippable) and an 11-beat ending with the mission report (report is never skippable) | `js/intro.js`, `js/outro.js` |
| Random events | Eight families with per-kind cooldowns, sol-band frequency curve, severe-event lockout and a max of two concurrent | `js/events.js`, `js/config.js` (`EVENTS`) |
| Difficulty | Cadet / Commander presets | `js/config.js` (`DIFFICULTIES`) |
| Hazards | Event director: dust devil, dust storm, greenhouse fault, rover breakdown, marsquake, seal malfunction, solar radiation, meteorite — plus the baseline random equipment-failure timer | `js/events.js`, `js/simulation.js` |
| UI/UX design | Rust/basalt HUD with cyan telemetry, resource strip (incl. separate fuel-oxygen and life-support O₂), warning banner, ten-row journey board, crew-rest chip, rover mission/result chip, deposit remaining, event log, contextual prompt, modal consoles, graded results screen | `css/style.css`, `js/hud.js`, `js/panels.js` |
| Controls | WASD + arrows, Shift, mouse orbit/zoom, E, C, R, M, T, H/Esc, Esc/Space to skip a cinematic | `js/config.js` (`KEYS`) |
| Art direction | Low-poly primitives, procedural everything, ACES tone mapping, warm Mars palette | `js/world.js`, `js/colony.js`, `js/industry.js` |
| Audio | Procedural WebAudio only: filtered wind with LFO, footsteps, UI blips, alarms, storm swell, cinematic beds | `js/audio.js`, `js/intro.js`, `js/outro.js` |
| Save system | Single versioned snapshot (v3) in `localStorage`, autosave every 25 s plus manual save in the pause screen; v1/v2 snapshots are adopted and completed with defaults, unreadable or future-version payloads are ignored, and legacy keys stay on disk until the first v3 write | `js/save.js` |
| Single/multiplayer | Single-player only. No backend, no database | — |
| Target platform | Any desktop browser with WebGL; tested in Chromium at 1× device pixel ratio | — |

---

## Architecture

```
index.html          title screen, HUD skeleton, panel root, results
host.ps1            Windows host: raw TCP socket, no-store headers, free port, opens browser
host.py             Python host: same behaviour for Linux/macOS (stdlib only)
css/style.css       all interface styling
js/config.js        every tunable number and every resolved design decision
js/noise.js         seeded value noise / fbm / ridged noise
js/world.js          renderer, sky, lights, terrain, rocks, dust, orbit camera
js/colony.js         twelve facilities built from primitives + live visual state
js/industry.js       FUEL-PROCESSOR, LAUNCH-SITE/M3 and the four HAB berths: models and per-frame visual sync
js/astronaut.js      procedural astronaut rig with walk animation
js/player.js         movement, camera-relative input, repairs, footsteps, bunk rest
js/crew.js           NPC actors that walk the ring road to their assigned post or to a bunk
js/rover.js          ROVER-01 model, dock, and the actor that traces the survey route
js/simulation.js     resources, power, crops, research, crew, fatigue, rover, fuel, rocket, hazards, win/fail
js/events.js         random-event director (rolls, phases, cooldowns, severity lockout)
js/hud.js            resource strip, clock, warnings, journey board, crew-rest chip, log, results
js/panels.js         facility consoles, crew board, research queue, telemetry, pause
js/audio.js          WebAudio sound design
js/intro.js          opening cinematic: Earth, the three rockets, transit, landing, briefing
js/outro.js          ending cinematic: eleven beats from gantry release to Earth orbit, then the report
js/save.js           localStorage persistence with versioned adoption of old snapshots
js/main.js           bootstrap, fixed-step loop, input, event wiring
```

The simulation is deliberately separated from the rendering: `simulation.js` and
`events.js` know nothing about Three.js, so the resource model, the fuel chain, the rest
schedule and the event calendar can be unit-tested or rebalanced without touching the 3D
layer (`tests/balance-harness.js` runs whole missions headless). The rover and the crew are
rendered as pure functions of simulation state (`phase` + progress, post assignment,
`sleeping`), which is why pausing, 2×/4× and reloading a save never desynchronise them.
Crew, rover and event visual effects all advance on `simDt = dt × speed` (0 while paused),
so nothing keeps moving behind the pause menu. Both cinematics build their own throwaway
Three.js scene and tear it down completely — they never touch the colony renderer, and the
ending only ever plays from `flags.complete`. `window.__MARS__` exposes
`{ sim, player, colony, world, panels, hud, orbit, crewActors, roverActor }` for demos and
balance experiments in the browser console.

---

## Scientific integrity

All rates in `js/config.js` are **gameplay values**, tuned so a mission lasts about thirty
minutes at 1× (or eight minutes at 4×). They are not Mars engineering data and should not
be presented as such. The systems model real concepts — solar generation under Martian
insolation, dust soiling, CO₂ electrolysis, water recycling, controlled-environment
agriculture, radiation sheltering, subsurface ice prospecting — but every number is
simplified. If the project quotes figures in the competition presentation, they must come
from the cited literature, not from this code.

---

## Known limitations

- Terrain is a heightmap without cliff collision; the player walks up any slope.
- Crew and rover pathfinding follow the ring road around the colony rather than a general
  navmesh, so a post placed off the lane would be walked to in a straight line.
- The astronaut (and therefore walk-up repairs) moves on wall-clock time, not the sim
  clock: 2×/4× speed up the colony, the crew and the rover, not your footsteps. Pausing
  stops all of them.
- The opening cinematic plays once per page session, on the first difficulty pick. A saved
  outpost resumes straight into the game rather than replaying it; reload to see the
  sequence again.
- A dry prospect run is genuinely empty, but it is not free: the drill still disturbs
  35% of a load from the deposit, so a string of misses spends field inventory. That is
  deliberate — the alternative made infinite retrying costless.
- Meteor craters stay in the world as scenery for the rest of the run (one group per
  impact, bounded by how many meteorites the event director allows).
- No sandbox mode, no save slots, no accessibility options beyond keyboard + mouse.
- Balance is validated by scripted fast-forward runs (`tests/balance-harness.js`, a dev-only
  module that is not referenced by `index.html`): a competent-player policy clears all ten
  objectives on Cadet and Commander inside 12 sols with four crew alive, and the same file
  asserts the fuel gates, the 40% odds, finite water, rest windows, the rover phase cycle
  and the save round-trip. It is not a substitute for playtesting with real players.
- If the page shows an older build than the code on disk, another static server is still
  holding the port: both hosts step to the next free port and print the URL they actually
  serve, and both send `Cache-Control: no-store`.
