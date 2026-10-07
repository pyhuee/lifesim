import { z } from "zod";
import { LifeSim } from "./engine";
import { validatePackFile } from "./schema";
import { interpolate } from "./people";
import { HOUSEHOLD_JOB } from "./household";
import type { Character, EventPack, LogEntry } from "./types";
import type { HouseholdState, WorldState, YearSummary } from "./household";

export const SAVE_VERSION = 1;
export const MAX_SAVE_BYTES = 10 * 1024 * 1024;

export interface LifeSave {
  schema: "lifesim.save";
  version: 1;
  seed: number;
  rngState: number;
  packs: EventPack[];
  character: Character;
  world: WorldState;
  household: HouseholdState;
  log: LogEntry[];
  summaries: YearSummary[];
  pending: { eventId: string; choiceIds: string[]; subjectId?: string } | null;
}

const finite = z.number().finite();
const age = finite.int().min(0).max(1000);
const meter = finite.min(0).max(100);
const text = z.string().max(10000);
const strings = z.array(text).max(10000);
const relation = z.enum(["mother", "father", "sibling", "grandparent", "friend", "partner", "spouse", "child", "coworker", "ex"]);
const stats = z.object({ health: meter, happiness: meter, smarts: meter, looks: meter });
const numericRecord = z.record(finite);
const economyPhase = z.enum(["growth", "stable", "recession", "recovery"]);
const expenses = z.object({ housing: finite.nonnegative(), essentials: finite.nonnegative(), dependents: finite.nonnegative() });

const flags = z.record(z.unknown()).superRefine((value, ctx) => {
  const known: Record<string, z.ZodTypeAny> = {
    action_year: age, action_budget: finite.int().min(0).max(1000),
    action_uses: z.record(finite.int().nonnegative()), job_applied: z.record(z.boolean()),
    items: strings, salary: finite.nonnegative(), savings: finite.nonnegative(), invested: finite.nonnegative(),
  };
  for (const [key, schema] of Object.entries(known)) {
    if (key in value && !schema.safeParse(value[key]).success) {
      ctx.addIssue({ code: "custom", path: [key], message: `Invalid ${key} state` });
    }
  }
});

const saveSchema = z.object({
  schema: z.literal("lifesim.save"), version: z.literal(SAVE_VERSION),
  seed: finite, rngState: finite.int().min(0).max(0xffffffff),
  packs: z.array(z.unknown()).max(100),
  character: z.object({
    name: z.string().min(1).max(200), age, stats, money: finite, traits: strings, flags,
    history: z.record(text), firedOnce: strings, lastFired: numericRecord, firedCount: numericRecord,
    people: z.array(z.object({
      id: text, name: text, age, relation, rel: finite.min(-100).max(100), alive: z.boolean(),
      gone: z.enum(["died", "moved"]).optional(), traits: strings, metAge: age, memories: strings,
      lastActAge: numericRecord,
    }).passthrough()).max(10000),
    ailments: z.array(z.object({
      id: text, defId: text, name: text, kind: z.enum(["physical", "mental", "injury"]),
      course: z.enum(["acute", "chronic", "progressive"]), severity: finite.int().min(1).max(3),
      yearsLeft: age.optional(), drain: finite, happy: finite, treatable: z.boolean(), sinceAge: age,
    }).passthrough()).max(1000),
    alive: z.boolean(), deathCause: text.optional(),
  }).passthrough(),
  world: z.object({
    startYear: finite.int().min(1).max(9000), year: finite.int().min(1).max(10000),
    economy: z.object({ phase: economyPhase, yearsInPhase: age, priceIndex: finite.positive().max(1e6), inflation: finite.min(0).max(1) }),
    employer: z.object({ id: z.literal("harbor_works"), name: text, health: meter }),
  }),
  household: z.object({
    enabled: z.boolean(), housing: z.enum(["family", "independent"]), spending: z.enum(["careful", "balanced", "comfortable"]),
    employment: z.object({ tenure: age, performance: meter }).nullable(), lastHousingAge: age.nullable(),
  }),
  log: z.array(z.object({ age, text, kind: z.enum(["year", "event", "result", "death", "birth"]) })).max(100000),
  summaries: z.array(z.object({
    year: finite.int(), age, economy: economyPhase, openingMoney: finite, closingMoney: finite,
    income: finite, expenses, otherMoney: finite,
    statChanges: z.object({ health: finite, happiness: finite, smarts: finite, looks: finite }), notes: strings,
  })).max(1000),
  pending: z.object({ eventId: text, choiceIds: z.array(text).min(1).max(20), subjectId: text.optional() }).nullable(),
});

/** A detached snapshot; saving is read-only and never draws randomness. */
export function saveLife(sim: LifeSim): LifeSave {
  return structuredClone({
    schema: "lifesim.save", version: SAVE_VERSION, seed: sim.seed, rngState: sim.rng.getState(),
    packs: sim.packSources, character: sim.character, world: sim.world, household: sim.household,
    log: sim.log, summaries: sim.summaries,
    pending: sim.pending ? {
      eventId: sim.pending.event.id, choiceIds: sim.pending.choices.map((c) => c.id), subjectId: sim.pending.subject?.id,
    } : null,
  });
}

/** Validate the entire checkpoint before replacing any live session. */
export function restoreLife(data: unknown): LifeSim {
  const parsed = saveSchema.safeParse(structuredClone(data));
  if (!parsed.success) throw new Error(`Invalid save: ${parsed.error.issues[0].path.join(".")} — ${parsed.error.issues[0].message}`);
  const save = parsed.data;
  if (save.world.year - save.world.startYear !== save.character.age) throw new Error("Invalid save: calendar and character age disagree");
  const ids = save.character.people.map((p) => p.id);
  if (new Set(ids).size !== ids.length) throw new Error("Invalid save: duplicate person IDs");
  const packs = save.packs.map((p, index) => {
    const result = validatePackFile(p, { allowEmpty: true });
    if (!result.ok) throw new Error(`Invalid saved pack ${index + 1}: ${result.errors.join("; ")}`);
    return result.loaded.pack;
  });
  const sim = new LifeSim(packs, { seed: save.seed, startYear: save.world.startYear, livingHousehold: save.household.enabled });
  sim.character = save.character as Character;
  sim.world = save.world;
  sim.household = save.household;
  sim.log = save.log;
  sim.summaries = save.summaries;
  sim.rng.setState(save.rngState);
  if (sim.household.employment && (!sim.household.enabled || !sim.character.flags.employed || sim.character.flags.job !== HOUSEHOLD_JOB.title)) {
    throw new Error("Invalid save: employer and current job disagree");
  }
  if (save.pending) {
    if (!sim.character.alive) throw new Error("Invalid save: a dead character cannot have a pending event");
    const event = sim.events.get(save.pending.eventId);
    if (!event) throw new Error("Invalid save: pending event is missing from its pack");
    const subject = save.pending.subjectId ? sim.character.people.find((p) => p.id === save.pending!.subjectId) : undefined;
    if (save.pending.subjectId && !subject) throw new Error("Invalid save: pending subject is missing");
    if (new Set(save.pending.choiceIds).size !== save.pending.choiceIds.length) throw new Error("Invalid save: duplicate pending choices");
    const choices = save.pending.choiceIds.map((id) => {
      const choice = event.choices.find((c) => c.id === id);
      if (!choice) throw new Error("Invalid save: pending choice is missing");
      return { ...choice, text: interpolate(choice.text, sim.character, subject) };
    });
    sim.pending = {
      event: { ...event, title: interpolate(event.title, sim.character, subject), description: interpolate(event.description, sim.character, subject) },
      choices, subject,
    };
  }
  return sim;
}

export function parseSave(text: string): LifeSim {
  if (new TextEncoder().encode(text).length > MAX_SAVE_BYTES) throw new Error("Save files must be smaller than 10 MB");
  return restoreLife(JSON.parse(text));
}
