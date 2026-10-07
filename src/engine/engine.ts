import { evalCondition, effectiveWeight } from "./conditions";
import { actionYearTick, actionsLeft } from "./actions";
import { applyWorldLaws } from "./world";
import { makeRng, weightedPick, type StatefulRng } from "./rng";
import {
  advanceWorld, createHousehold, createWorld, employerTick, HOUSEHOLD_JOB,
  householdTick, syncEmployment,
  type HouseholdState, type WorldState, type YearSummary,
} from "./household";
import {
  availableActions,
  genFamily,
  genPerson,
  nextPersonId,
  interpolate,
  matchPeople,
  mergedNamePools,
  peopleTick,
  runPeopleAction,
  type NamePools,
  type PeopleAction,
} from "./people";
import {
  ailmentTick,
  contractAilment,
  cureAilment,
  treatAilment,
  treatmentsFor,
  type TreatmentOffer,
} from "./ailments";
import type {
  Character,
  Choice,
  DiseaseDef,
  Effect,
  EventPack,
  GameAction,
  Job,
  LogEntry,
  Outcome,
  PendingEvent,
  ShopItem,
  Person,
  SimEvent,
  StatKey,
  WorldLaw,
} from "./types";

const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

/** Traits a new character can be born with (starter pool, not pack data). */
export const BIRTH_TRAITS = [
  "athletic",
  "bookish",
  "charming",
  "sickly",
  "lucky",
  "hot-headed",
  "shy",
] as const;

const MAX_GOTO_DEPTH = 5;

export interface SimOptions {
  seed?: number;
  name?: string;
  /** Opt-in for engine callers; the game's new-life UI enables it by default. */
  livingHousehold?: boolean;
  startYear?: number;
}

/**
 * The engine holds one character's life plus the merged event pool from all
 * loaded packs. It is UI-agnostic: `ageUp()` queues an event, `resolve()`
 * applies the player's choice. Everything is deterministic for a given seed.
 */
export class LifeSim {
  readonly rng: StatefulRng;
  /** Exact pack definitions used by this life, including imported content. */
  readonly packSources: EventPack[] = [];
  world: WorldState;
  household: HouseholdState;
  summaries: YearSummary[] = [];
  /** Effective seed used for stream-isolated world noise. */
  readonly seed: number;
  readonly laws = new Map<string, WorldLaw>();
  readonly events = new Map<string, SimEvent>();
  /** Player-initiated actions, shop items and jobs, merged from packs. */
  readonly actions = new Map<string, GameAction>();
  readonly items = new Map<string, ShopItem>();
  readonly jobs = new Map<string, Job>();
  /** Disease definitions contributed by packs, keyed by def id. */
  readonly ailments = new Map<string, DiseaseDef>();
  readonly namePools: NamePools;
  character: Character;
  log: LogEntry[] = [];
  pending: PendingEvent | null = null;

  constructor(packs: EventPack[], opts: SimOptions = {}) {
    this.seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
    this.rng = makeRng(this.seed);
    this.world = createWorld(opts.startYear);
    this.household = createHousehold(opts.livingHousehold);
    for (const pack of packs) this.loadPack(pack);
    if (this.household.enabled) this.jobs.set(HOUSEHOLD_JOB.id, HOUSEHOLD_JOB);
    this.namePools = mergedNamePools(packs);
    this.character = this.birth(opts.name ?? "Alex");
  }

  /** Merge a pack's content into the pool. Ids must be unique across packs. */
  /** Merge a pack's events (and disease defs) into the pool. */
  loadPack(pack: EventPack) {
    this.packSources.push(structuredClone(pack));
    for (const ev of pack.events) this.events.set(ev.id, ev);
    for (const a of pack.actions ?? []) this.actions.set(a.id, a);
    for (const i of pack.items ?? []) this.items.set(i.id, i);
    for (const j of pack.jobs ?? []) this.jobs.set(j.id, j);
    for (const d of pack.ailments ?? []) this.ailments.set(d.id, d);
    for (const law of pack.laws ?? []) this.laws.set(law.id, law);
  }

  private birth(name: string): Character {
    const r = this.rng;
    const stats = {
      health: 60 + Math.floor(r() * 40),
      happiness: 50 + Math.floor(r() * 30),
      smarts: 30 + Math.floor(r() * 40),
      looks: 30 + Math.floor(r() * 40),
    };
    const traits: string[] = [];
    if (r() < 0.6) traits.push(BIRTH_TRAITS[Math.floor(r() * BIRTH_TRAITS.length)]);
    this.log.push({ age: 0, text: `${name} was born.`, kind: "birth" });
    return {
      name,
      age: 0,
      stats,
      money: 0,
      traits,
      flags: {},
      history: {},
      firedOnce: [],
      lastFired: {},
      firedCount: {},
      people: genFamily(r, this.namePools),
      ailments: [],
      alive: true,
    };
  }

  /* -------------------------------- yearly tick -------------------------------- */

  private passiveTick() {
    const c = this.character;
    const notes: string[] = [...advanceWorld(this), ...employerTick(this)];
    let income = 0;
    let expenses: YearSummary["expenses"] = { housing: 0, essentials: 0, dependents: 0 };

    if (c.flags.in_school) c.stats.smarts = clamp(c.stats.smarts + 1);
    if (c.flags.employed) {
      const salary = Number(c.flags.salary ?? 0);
      c.money += salary;
      income += salary;
      if (salary) notes.push(`Earned $${salary.toLocaleString()} at work.`);
    }
    if (c.flags.in_prison) {
      c.stats.health = clamp(c.stats.health - 2);
      c.stats.happiness = clamp(c.stats.happiness - 3);
      const left = Number(c.flags.sentence ?? 1) - 1;
      if (left <= 0) {
        delete c.flags.in_prison;
        delete c.flags.sentence;
        if (!c.flags.employed) c.flags.seeking_work = true;
        notes.push("Released from prison.");
      } else {
        c.flags.sentence = left;
        notes.push(`${left} year${left === 1 ? "" : "s"} left on the sentence.`);
      }
    }
    if (c.flags.partner) c.stats.happiness = clamp(c.stats.happiness + 1);

    // Items, savings, investments, debt interest and per-year action resets.
    notes.push(...actionYearTick(this));

    // Persistent NPCs age, drift, move away and pass on.
    notes.push(...peopleTick(c, this.rng));
    if (!c.alive) return { notes, income, expenses };
    // Diseases: drains, progression, expiry, lethality, new onsets.
    const sick = ailmentTick(c, this.ailments, this.rng);
    notes.push(...sick.notes);
    if (sick.died) {
      this.die(sick.died);
      return { notes, income, expenses };
    }

    // Mild recovery — a body carrying little or no condition load repairs
    // a little each year; anything draining harder than a mild ache blocks it.
    const drainSum = c.ailments.reduce((s, a) => s + a.drain, 0);
    if (c.stats.health < 70 && drainSum > -2) {
      c.stats.health = clamp(c.stats.health + 3);
    }

    // Age-related health drift.
    if (c.age > 85) c.stats.health = clamp(c.stats.health - 6);
    else if (c.age > 70) c.stats.health = clamp(c.stats.health - 4);
    else if (c.age > 55) c.stats.health = clamp(c.stats.health - 2);

    if (c.traits.includes("sickly")) c.stats.health = clamp(c.stats.health - 1);

    // Data-driven world laws (inflation, decay, era drift…). These resolve
    // randomness from stream-isolated seeded noise, leaving the event RNG
    // untouched. Their state changes can still affect event eligibility.
    notes.push(...applyWorldLaws(this));

    if (c.alive) {
      const bills = householdTick(this);
      expenses = bills.expenses;
      notes.push(...bills.notes);
    }

    return { notes, income, expenses };
  }

  private checkDeath(): boolean {
    const c = this.character;
    // A `die` effect may already have fired (e.g. from a world law or an item
    // passive effect); don't let ageUp draw an event for a dead character.
    if (!c.alive) return true;
    if (c.stats.health <= 0) {
      this.die("failing health");
      return true;
    }
    // Old-age mortality ramps up past 80.
    if (c.age > 80) {
      const p = Math.min(0.5, (c.age - 80) * 0.03 + (c.traits.includes("sickly") ? 0.05 : 0));
      if (this.rng() < p) {
        this.die("old age");
        return true;
      }
    }
    return false;
  }

  private die(cause: string) {
    const c = this.character;
    c.alive = false;
    c.deathCause = cause;
    this.log.push({ age: c.age, text: `${c.name} died of ${cause} at age ${c.age}.`, kind: "death" });
    this.pending = null;
  }

  /**
   * Events eligible to be drawn right now (conditions pass, `once` not spent,
   * at least one usable choice) with their effective weights.
   */
  eligibleEvents(): { event: SimEvent; weight: number }[] {
    const c = this.character;
    const out: { event: SimEvent; weight: number }[] = [];
    for (const ev of this.events.values()) {
      if (ev.once && c.firedOnce.includes(ev.id)) continue;
      if (
        ev.cooldown !== undefined &&
        c.lastFired[ev.id] !== undefined &&
        c.age - c.lastFired[ev.id] < ev.cooldown
      ) {
        continue;
      }
      if (!evalCondition(ev.conditions, c)) continue;
      // Events about a person need someone who matches the selector.
      if (ev.subject && !matchPeople(c, ev.subject).length) continue;
      const choices = ev.choices.filter((ch) => evalCondition(ch.conditions, c));
      if (!choices.length) continue;
      let w = effectiveWeight(ev.weight ?? 10, ev.weightModifiers, c);
      // Each past firing dampens a repeatable event's draw weight.
      if (ev.repeatDecay !== undefined && ev.repeatDecay < 1) {
        w *= Math.pow(ev.repeatDecay, c.firedCount[ev.id] ?? 0);
      }
      out.push({ event: ev, weight: w });
    }
    return out;
  }

  /** Advance one year. Returns the queued event, if any. */
  ageUp(): PendingEvent | null {
    const c = this.character;
    if (!c.alive) return null;
    if (this.pending) return this.pending; // must resolve the pending event first

    const openingMoney = c.money;
    const openingStats = { ...c.stats };
    c.age += 1;
    this.log.push({ age: c.age, text: `Age ${c.age}`, kind: "year" });
    const tick = this.passiveTick();
    for (const note of tick.notes) {
      this.log.push({ age: c.age, text: note, kind: "year" });
    }
    const died = this.checkDeath();
    const totalExpenses = tick.expenses.housing + tick.expenses.essentials + tick.expenses.dependents;
    this.summaries.push({
      year: this.world.year, age: c.age, economy: this.world.economy.phase,
      openingMoney, closingMoney: c.money, income: tick.income, expenses: tick.expenses,
      otherMoney: c.money - openingMoney - tick.income + totalExpenses,
      statChanges: {
        health: c.stats.health - openingStats.health,
        happiness: c.stats.happiness - openingStats.happiness,
        smarts: c.stats.smarts - openingStats.smarts,
        looks: c.stats.looks - openingStats.looks,
      },
      notes: tick.notes,
    });
    if (died) return null;

    const entries = this.eligibleEvents();
    const eligible = entries.map((e) => e.event);
    const weights = entries.map((e) => e.weight);

    // Forced events (milestones like starting school) always queue when
    // eligible instead of competing in the weighted draw.
    const forced = entries.filter((e) => e.event.forced);
    if (forced.length) {
      const ev = forced[Math.max(0, weightedPick(this.rng, forced.map((f) => f.weight)))].event;
      return this.queueEvent(ev);
    }

    // Quiet-year baseline: ~15% of the total draw weight, so most years
    // something happens but calm years exist.
    const total = weights.reduce((s, w) => s + w, 0);
    const quiet = Math.max(5, total * 0.15);
    const pick = weightedPick(this.rng, [...weights, quiet]);
    if (pick === weights.length || pick === -1) return null;

    const ev = eligible[pick];
    return this.queueEvent(ev);
  }

  /**
   * Queue an event as pending: pick its subject NPC (if it declares one) and
   * produce interpolated copies of the title/description/choices so the UI
   * and the log read naturally ("Your mother, Elena Rivera, …").
   */
  private queueEvent(ev: SimEvent): PendingEvent {
    const c = this.character;
    const candidates = ev.subject ? matchPeople(c, ev.subject) : [];
    const subject = candidates.length
      ? candidates[Math.floor(this.rng() * candidates.length)]
      : undefined;
    const shown: SimEvent = {
      ...ev,
      title: interpolate(ev.title, c, subject),
      description: interpolate(ev.description, c, subject),
    };
    this.pending = {
      event: shown,
      choices: ev.choices
        .filter((ch) => evalCondition(ch.conditions, c))
        .map((ch) => ({ ...ch, text: interpolate(ch.text, c, subject) })),
      subject,
    };
    this.log.push({
      age: c.age,
      text: `${shown.title} — ${shown.description}`,
      kind: "event",
    });
    return this.pending;
  }

  /** Resolve the pending event with the player's choice. */
  resolve(choiceId: string) {
    const pending = this.pending;
    if (!pending) throw new Error("no pending event");
    const choice = pending.choices.find((ch) => ch.id === choiceId);
    if (!choice) throw new Error(`choice "${choiceId}" not available`);

    const c = this.character;
    c.history[pending.event.id] = choice.id;
    c.lastFired[pending.event.id] = c.age;
    c.firedCount[pending.event.id] = (c.firedCount[pending.event.id] ?? 0) + 1;
    if (pending.event.once && !c.firedOnce.includes(pending.event.id)) {
      c.firedOnce.push(pending.event.id);
    }
    this.pending = null;
    this.resolveChoice(choice, 0, pending.subject);
  }

  resolveChoice(choice: Choice, depth: number, subject?: Person) {
    const c = this.character;
    const outcome = this.pickOutcome(choice);
    if (outcome?.effects) this.applyEffects(outcome.effects, subject);
    const text = outcome?.result;
    if (text) this.log.push({ age: c.age, text: interpolate(text, c, subject), kind: "result" });
    if (!c.alive) return;
    // An outcome-level goto wins; a choice-level goto is the default for all
    // outcomes (this is also what the graph editor's edges write).
    const goto = outcome?.goto ?? choice.goto;
    if (goto && depth < MAX_GOTO_DEPTH) this.chain(goto, depth + 1, subject);
  }

  private pickOutcome(choice: Choice): Outcome | null {
    if (choice.outcomes?.length) {
      const weights = choice.outcomes.map((o) =>
        effectiveWeight(o.weight, o.weightModifiers, this.character),
      );
      const i = weightedPick(this.rng, weights);
      return choice.outcomes[Math.max(0, i)];
    }
    // Shorthand fixed outcome.
    return { weight: 1, effects: choice.effects, result: choice.result ?? "", goto: choice.goto };
  }

  private chain(eventId: string, _depth: number, inheritSubject?: Person) {
    const ev = this.events.get(eventId);
    if (!ev) {
      this.log.push({ age: this.character.age, text: `(missing event "${eventId}")`, kind: "result" });
      return;
    }
    // A `once` event that already fired can't be re-entered via goto.
    if (ev.once && this.character.firedOnce.includes(ev.id)) return;
    // The target's gate conditions still apply for chained events.
    if (!evalCondition(ev.conditions, this.character)) return;
    const choices = ev.choices.filter((ch) => evalCondition(ch.conditions, this.character));
    if (!choices.length) return;
    const shown: SimEvent = {
      ...ev,
      title: interpolate(ev.title, this.character, inheritSubject),
      description: interpolate(ev.description, this.character, inheritSubject),
    };
    this.pending = {
      event: shown,
      choices: choices.map((ch) => ({
        ...ch,
        text: interpolate(ch.text, this.character, inheritSubject),
      })),
      subject: inheritSubject,
    };
    this.log.push({
      age: this.character.age,
      text: `${shown.title} — ${shown.description}`,
      kind: "event",
    });
  }

  applyEffects(effects: Effect[], subject?: Person) {
    const c = this.character;
    for (const e of effects) {
      switch (e.kind) {
        case "stat":
          c.stats[e.stat as StatKey] = clamp(c.stats[e.stat] + e.delta);
          break;
        case "money":
          c.money += e.delta;
          break;
        case "trait":
          if (e.action === "add" && !c.traits.includes(e.trait)) c.traits.push(e.trait);
          if (e.action === "remove") c.traits = c.traits.filter((t) => t !== e.trait);
          break;
        case "flag":
          c.flags[e.flag] = e.value;
          break;
        case "unflag":
          delete c.flags[e.flag];
          break;
        case "counter":
          c.flags[e.flag] = Number(c.flags[e.flag] ?? 0) + e.delta;
          break;
        case "collect":
          c.money += Number(c.flags[e.flag] ?? 0);
          c.flags[e.flag] = 0;
          break;
        case "loseitem": {
          const items = (c.flags.items as string[] | undefined) ?? [];
          c.flags.items = items.filter((i) => i !== e.item);
          delete c.flags[`item_${e.item}`];
          break;
        }
        case "die":
          this.die(e.cause);
          break;
        case "ailment": {
          const def = this.ailments.get(e.ailment);
          if (def && !c.ailments.some((a) => a.defId === def.id)) {
            contractAilment(c, def, this.rng);
          }
          break;
        }
        case "cure":
          cureAilment(c, e.ailment);
          break;
        case "rel":
          if (subject?.alive) {
            subject.rel = Math.max(-100, Math.min(100, subject.rel + e.delta));
          }
          break;
        case "relation":
          if (subject?.alive) subject.relation = e.relation;
          break;
        case "person": {
          const p = genPerson(this.rng, this.namePools, e.role, c.age, {
            id: nextPersonId(c.people),
            name: e.name,
            rel: e.rel,
          });
          c.people.push(p);
          if (e.role === "partner") c.flags.partner = true;
          if (e.role === "spouse") {
            c.flags.partner = true;
            c.flags.married = true;
          }
          break;
        }
        case "memory":
          subject?.memories.push(e.text);
          break;
      }
    }
    syncEmployment(this);
  }

  /* --------------------------- people & health UI -------------------------- */

  /** Living people still in the character's life, family first. */
  peopleList(): Person[] {
    const order = (p: Person) =>
      ["mother", "father", "sibling", "grandparent", "child", "partner", "spouse", "friend", "coworker", "ex"].indexOf(p.relation);
    return this.character.people
      .filter((p) => p.alive && !p.gone)
      .sort((a, b) => order(a) - order(b) || b.rel - a.rel);
  }

  /** Actions the player can take on a person right now. */
  peopleActions(personId: string): PeopleAction[] {
    if (this.pending || !this.character.alive || actionsLeft(this) <= 0) return [];
    const p = this.character.people.find((x) => x.id === personId);
    return p ? availableActions(this.character, p) : [];
  }

  /** Run a People-menu action; logs and returns the result line. */
  interact(personId: string, actionId: string): string {
    const c = this.character;
    const p = c.people.find((x) => x.id === personId);
    if (!p) return "(no such person)";
    if (this.pending) return "Resolve the current event first.";
    if (!c.alive) return "This life is over.";
    if (actionsLeft(this) <= 0) return "No activities left this year.";
    if (!availableActions(c, p).some((a) => a.id === actionId)) return "That interaction isn't available.";
    c.flags.action_budget = actionsLeft(this) - 1;
    const text = runPeopleAction(c, p, actionId, this.rng);
    this.log.push({ age: c.age, text, kind: "result" });
    return text;
  }

  /** Treatments offered for one of the character's active ailments. */
  treatments(ailmentId: string): TreatmentOffer[] {
    const a = this.character.ailments.find((x) => x.id === ailmentId);
    if (!a) return [];
    return treatmentsFor(this.character, this.ailments.get(a.defId), a);
  }

  /** Pay for and attempt a treatment; logs and returns the result line. */
  treat(ailmentId: string, treatmentId: string): string {
    if (this.pending) return "Resolve the current event first.";
    if (!this.character.alive) return "This life is over.";
    const text = treatAilment(
      this.character,
      ailmentId,
      treatmentId,
      this.ailments,
      this.rng,
    );
    this.log.push({ age: this.character.age, text, kind: "result" });
    return text;
  }
}
