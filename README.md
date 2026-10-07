# lifesim

A moddable, browser-based life simulator (BitLife-style) with a visual
node-graph mod editor. Built with TypeScript, Vite, React, and React Flow.

## Play

```bash
npm install
npm run dev        # http://localhost:5173
```

Other scripts:

```bash
npm test           # engine, save, and UI integration tests (vitest)
npm run typecheck  # check TypeScript without building
npm run build      # type-check + production build to dist/
npm run preview    # serve the production build
```

## What's inside

- **Simulation engine** (`src/engine/`) — ages a character year by year with
  health, happiness, smarts, and looks stats (0–100), unbounded money, named
  traits, and free-form flags (`in_school`, `employed`, `partner`,
  `in_prison`, …). Each year applies passive effects (salary, schooling,
  prison sentences, age-related health drift), then draws one eligible event
  for the player to resolve. Deterministic per seed.
- **Data-driven event system** — events live in JSON *packs*, not in code.
  There is no hardcoded if-then event logic; the engine interprets a small
  declarative DSL:
  - **Conditions** on age, stats, money, traits, flags, and past choices
    (`all` / `any` / `not` trees).
  - **Weighted random branches** per choice (`outcomes`), plus weighted event
    draws each year.
  - **Probability modifiers** — `weightModifiers` multiply or add to weights
    when a condition holds (e.g. the `athletic` trait tilts fight outcomes).
  - **Effects** — stat deltas, money, trait add/remove, flag set/unset, death,
    plus people/disease effects (`person`, `rel`, `relation`, `memory`,
    `ailment`, `cure`) described below.
  - **`goto` chains** — an outcome can hand off to another event immediately.
  - **World laws** — passive yearly rules (inflation, decay, era drift).
    See [World laws](#world-laws).
- **Persistent NPCs** (`src/engine/people.ts`) — the character is born into a
  generated family (mother, father, siblings, grandparent) and events can
  introduce more NPCs (`{ "kind": "person", "role": "partner" }` spawns one).
  Every person has a name, age, traits, a relationship meter (-100…100),
  and a memory log. NPCs age each year, drift in affection, can move away or
  die (elders especially), and the **People** panel in the game UI offers
  per-person actions: spend time, compliment, gift, argue, ask out, propose,
  break up, ask for money.
- **Diseases & conditions** (`src/engine/ailments.ts`) — packs define
  `ailments` (id, kind: physical/mental/injury, course: acute/chronic/
  progressive, severity, yearly stat drains, optional `lethalPerYear`,
  `onsetWeight`, and `treatments` with cost + cure chance). Acute ailments
  expire; chronic ones persist until treated; progressive ones worsen each
  year. The **Conditions** section of the character panel lists active
  ailments with treatments — buying treatment is how a sick life survives.
  Events contract or cure ailments via `{ "kind": "ailment" }` /
  `{ "kind": "cure" }` effects.
- **NPC-bound events** — an event with `"subject": { "relation": ["spouse"] }`
  only fires when a matching living NPC exists; that NPC becomes the event's
  subject, `{{subject.name}}` / `{{subject.age}}` interpolate into text, and
  `rel`/`relation`/`memory` effects apply to them.
- **Visual mod editor** (`src/editor/`) — a React Flow node graph where each
  node is an event and each edge is a `goto` link from a specific choice.
  Click a node to edit title, conditions, choices, branches, effects, and
  weights in the inspector. Import/export packs as JSON and *Playtest* them
  instantly in the simulator.
- **Starter pack** (`src/packs/core/`) — a *nested pack*: `pack.json` is the
  manifest and each subsection file (`schooling.json`, `jobs.json`,
  `relationships.json`, `crime.json`, `health.json`, `luck_life.json`) carries
  its own events and disease defs. Every subsection gets its own checkbox in
  the game's "Loaded packs" panel.
- **Sandboxed packs** — packs are data-only. `validatePack` (zod schema +
  semantic checks: unique ids, dangling `goto`s, choices without outcomes) is
  run on every import, and the engine only interprets validated data — no
  `eval`, no code paths in pack files.

## Living households & saves

New lives enable **Living household** by default. The calendar begins in
2000 and the world moves through growth, stability, recession, and recovery.
Inflation changes household bills and new job offers. Adults pay for housing,
essentials, and dependent children or a spouse; children have no household bills.
Living with family costs less than moving out. Careful, balanced, and comfortable
budgets trade spending against happiness. If the last family host dies or leaves,
the household moves to independent housing automatically.

The **Harbor Works Assistant** job offers an ongoing career: employer health
affects hiring and layoffs, while skill development improves performance and
promotion chances. Raises and promotions appear in the yearly review. Recession
layoffs include severance. Other pack-defined careers continue to work.

Life activities, job applications, social interactions, and household decisions
share the existing yearly activity budget. Resolve the current event before
taking other actions. Shopping, gambling, investments, and medical treatment
keep their existing rules. The annual review shows income, itemized household
bills, other money changes, and stat changes from the automatic yearly update;
choices made afterward appear in the life log and the next year's opening balance.

Uncheck **Living household** before starting a new life for classic play without
the built-in economy and household expenses. Pack world laws still apply in both
modes. Engine callers retain classic mode unless they pass
`{ livingHousehold: true }` to `LifeSim`.

Each new life and gameplay change autosaves in this browser. **Save & resume**
also has three manual slots and JSON import/export. Saves include the exact active
pack rules, RNG state, NPCs, ailments, household, pending event and offered choices,
and history, so loading continues the same seeded life. Changing pack checkboxes
affects the next new life. Save imports are validated before replacing the current
session; unsupported versions and invalid files leave it intact. Export a file to
move a life between browsers or keep a backup if browser storage is cleared.

Switching between Play and Mod Editor keeps the current life. Editor playtests
run in a separate classic session and do not change the regular autosave.
**End playtest** returns to the regular life; explicitly loading a save or starting
a new life replaces it.

## Pack format

```jsonc
{
  "id": "my_pack",
  "name": "My Mod Pack",
  "version": "1.0.0",
  "events": [
    {
      "id": "big_test",
      "title": "Big test",
      "description": "Finals are tomorrow.",
      "category": "school",
      "weight": 15,                         // draw weight (default 10)
      "once": true,                         // at most once per life
      "cooldown": 2,                        // min years between firings
      "repeatDecay": 0.6,                   // each firing multiplies future weight
      // "forced": true                     // always queues when eligible (milestones)
      "conditions": {
        "kind": "all",
        "conditions": [
          { "kind": "age", "min": 14, "max": 22 },
          { "kind": "flag", "flag": "in_school", "equals": true }
        ]
      },
      "choices": [
        {
          "id": "cram",
          "text": "Cram all night",
          "outcomes": [                      // weighted random branches
            {
              "weight": 60,
              "weightModifiers": [           // stat-driven probability
                { "when": { "kind": "stat", "stat": "smarts", "op": "gte", "value": 70 },
                  "add": 30 }
              ],
              "effects": [{ "kind": "stat", "stat": "smarts", "delta": 5 }],
              "result": "You aced it."
            },
            { "weight": 40, "result": "You fell asleep on the desk." }
          ]
        },
        {
          "id": "skip",
          "text": "Skip it",
          "conditions": { "kind": "not", "condition": { "kind": "trait", "trait": "bookish" } },
          "effects": [{ "kind": "stat", "stat": "happiness", "delta": 4 }],
          "result": "Beach day."
        }
      ]
    }
  ]
}
```

See `src/engine/types.ts` for the full type definitions and
`src/engine/schema.ts` for the validation rules.

### World laws

Put `laws` at the top level or inside a `sections` entry. Section laws follow
the section toggle and survive editor import/export. A pack may contain only
laws (no events).

Events need a player choice. **World laws** are the other half: passive,
data-only yearly rules the engine applies in its passive tick, with no
pending card. They are how a pack makes the world feel like it moves on its
own — cost-of-living inflation, slow health decay, era transitions, fame
cooling off.

```jsonc
{
  "id": "inflation",
  "title": "The cost of living rose.",   // life-log line (optional)
  "minAge": 18,                           // cadence anchor (default 0)
  "everyYears": 1,                        // fire every N years (default 1)
  "chance": 70,                           // 0..100, seeded (default 100)
  "conditions": { "kind": "flag", "flag": "employed", "equals": true },
  "drift": [{ "stat": "happiness", "amount": -1, "jitter": 1 }],
  "effects": [{ "kind": "money", "delta": -500 }]
}
```

- A law fires when `minAge <= age < maxAge` **and**
  `(age - minAge) % everyYears === 0`.
- `conditions` is the same DSL as events; `effects` supports the RNG-free, subject-free subset:
  `stat`, `money`, `trait`, `flag`, `unflag`, `counter`, `collect`,
  `loseitem`, `die`, `cure`. `person`, `ailment`, `rel`, `relation` and
  `memory` effects are rejected in laws.
- `drift` is shorthand for per-stat change with optional deterministic
  `jitter`.
- A law needs at least one of `effects` or `drift`.

Randomness in a law (`chance` and `drift` jitter) is **stream-isolated**: it
comes from deterministic noise keyed on `(seed, law id, age)` rather than the
simulation RNG. Adding, removing or retuning a law never advances the event RNG. Laws can
still change event eligibility through their effects on character state; a
seeded life with the same packs still replays exactly. (This mirrors the
temporal-slice `_seeded_unit_noise` used by EraLife.)

### Nested packs (subpacks)

A pack file may also declare `sections`, either inline or as sibling files:

```jsonc
// src/packs/core/pack.json
{
  "id": "core",
  "name": "Core Life Events",
  "version": "2.0.0",
  "sections": [
    { "id": "health", "name": "Health & Disease", "src": "health.json" },
    { "id": "crime", "name": "Crime", "events": [ /* inline works too */ ] }
  ],
  "names": { "first": ["Sam", "Riley"], "last": ["Chen", "Garcia"] } // optional NPC name pools
}
```

`src` sections resolve relative to the manifest's directory (bundled packs
only — imported packs must inline their sections). Each section can carry
`events`, `ailments` and `laws` of its own, and the game UI can toggle sections
independently. Flat v1 packs (top-level `events` only) keep working
unchanged.

### Ailment format

```jsonc
{
  "id": "influenza",
  "name": "Influenza",
  "kind": "physical",            // physical | mental | injury
  "course": "acute",             // acute | chronic | progressive
  "severity": 2,
  "durationYears": [1, 2],       // acute only
  "healthPerYear": -3,           // yearly drains
  "happinessPerYear": -2,
  "escalatePerYear": 1,          // progressive only — drain worsens
  "lethalPerYear": 0.02,         // optional death roll per year
  "treatable": true,
  "onsetWeight": 0.012,          // random contraction chance per eligible year
  "conditions": { "kind": "age", "min": 1 },
  "treatments": [
    { "id": "antivirals", "label": "Doctor visit + antivirals",
      "provider": "gp",            // gp | therapist | specialist | surgeon | er | self
      "cost": 120, "cureChance": 0.7, "relieveHealth": 3 }
  ]
}
```

Balance contract: combined ailment drain is capped at -3 health/year, mild
recovery (+3) applies while a life carries little condition load, and every
lethal bundled disease is age-gated — no early-life death spikes.

## Triggering & testing events

Each year the engine gathers every event whose `conditions` pass (and whose
`once`/`cooldown`/`repeatDecay` bookkeeping allows it), then draws one by
`weight` — with a "quiet year" dummy entry so some years have no event.
`forced: true` events skip the draw and always queue while eligible. A choice
outcome can `goto` another event id to chain it immediately (chain targets
conventionally use `weight: 0` so they only ever appear via `goto`).

Trigger-style examples:

- **Age/stats/money**: `{ "kind": "age", "min": 18 }`,
  `{ "kind": "money", "op": "gte", "value": 100000 }`
- **Flags set by earlier events**: `{ "kind": "flag", "flag": "conspiracist", "equals": true }`
  (the Total Chaos pack sets flags like `goose_enemy`, `internet_famous`,
  `crypto_stake` to unlock follow-ups)
- **Past choices**: `{ "kind": "chose", "event": "school_bully", "choice": "fight_back" }`
- **Compound**: wrap any of the above in `all` / `any` / `not`.

To force-test one event, edit the pack JSON: give the event `"forced": true`
and a narrow window, e.g. `"conditions": { "kind": "age", "min": 20, "max": 20 }`
— it then fires the year the character turns 20. For flag-gated events, also
relax the flag condition (or chain it from an event you can reach). You can
test in-game (Play tab → New life with a seed) or headlessly:

```bash
npx vitest run                 # engine + pack validation tests
npx vite-node scripts/distribution-report.ts 5000   # firing stats over N lives
```

The Mod Editor's *Playtest* button also drops your current graph into the
simulator as a temporary pack.

Bundled packs live in `src/packs/` — flat `*.json` files or nested
`<dir>/pack.json` manifests — and are discovered automatically by
`loadBundledPacks()` in `src/packs/index.ts`. Each one gets a checkbox in the
game's "Loaded packs" panel, and nested packs show per-section checkboxes.
The bundled **Total Chaos Pack** (`src/packs/chaos.json`) adds ~40
absurd events — goose vendettas, viral fame, crypto prophets, haunted
inheritances — on top of the core pack. Untick it for a calmer life.

## Project layout

```
src/
  engine/    types, condition evaluator, weighted RNG, LifeSim, zod schema
  packs/     bundled JSON event packs
  game/      playable UI (stat bars, event card, life log)
  editor/    React Flow mod editor + pack import/export
```
