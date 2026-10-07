import type { Character, Person, Relation, SubjectSelector } from "./types";
import type { Rng } from "./rng";

/**
 * Persistent NPCs ("people"): generation, yearly aging and player
 * interactions. Everything here is deterministic given the sim's rng.
 * The module never mutates outside `c.people` / `c.stats` / `c.money` /
 * `c.flags` / the log lines it returns.
 */

const FIRST_NAMES = [
  "Ava", "Liam", "Maya", "Noah", "Zoe", "Ethan", "Ruby", "Owen", "Nora",
  "Caleb", "Iris", "Jonah", "Priya", "Marcus", "Elena", "Tobias", "Wren",
  "Diego", "Hazel", "Felix", "Amara", "Silas", "June", "Ravi", "Celeste",
  "Milo", "Ines", "Kofi", "Tessa", "Hugo",
];
const SURNAMES = [
  "Rivera", "Nguyen", "Okafor", "Larsen", "Petrov", "Kim", "Ali", "Brooks",
  "Moreau", "Tanaka", "Fitzgerald", "Hale", "Novak", "Santos", "Webb",
];

const PERSON_TRAITS = [
  "warm", "stern", "funny", "frugal", "dramatic", "quiet", "ambitious",
  "chill", "nosy", "loyal",
];

const pick = <T>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];

function makePerson(
  rng: Rng,
  init: Omit<Person, "id" | "traits" | "alive" | "memories" | "lastActAge"> & { memories?: string[] },
  id: string,
): Person {
  const traits: string[] = [];
  const n = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < n; i++) {
    const t = pick(rng, PERSON_TRAITS);
    if (!traits.includes(t)) traits.push(t);
  }
  return {
    id,
    name: init.name,
    age: init.age,
    relation: init.relation,
    rel: Math.round(Math.max(-100, Math.min(100, init.rel))),
    alive: true,
    traits,
    metAge: init.metAge,
    memories: init.memories ?? [],
    lastActAge: {},
  };
}

export interface NamePools {
  first: string[];
  last: string[];
}

export function mergedNamePools(
  packs: { names?: { first?: string[]; last?: string[] } }[],
): NamePools {
  const first = [...FIRST_NAMES];
  const last = [...SURNAMES];
  for (const p of packs) {
    for (const n of p.names?.first ?? []) if (!first.includes(n)) first.push(n);
    for (const n of p.names?.last ?? []) if (!last.includes(n)) last.push(n);
  }
  return { first, last };
}

/** Generate the newborn's family: parents, maybe siblings, maybe a grandparent. */
export function genFamily(rng: Rng, pools: NamePools): Person[] {
  const surname = pick(rng, pools.last);
  const people: Person[] = [];
  const mk = (relation: Relation, age: number, rel: number, name?: string) =>
    people.push(
      makePerson(rng, {
        name: name ?? `${pick(rng, pools.first)} ${surname}`,
        age,
        relation,
        rel,
        metAge: 0,
      }, `p${people.length + 1}`),
    );

  mk("mother", 24 + Math.floor(rng() * 17), 75 + Math.floor(rng() * 20));
  if (rng() < 0.85) mk("father", 26 + Math.floor(rng() * 17), 70 + Math.floor(rng() * 20));
  const sibs = rng() < 0.45 ? 0 : rng() < 0.75 ? 1 : 2;
  for (let i = 0; i < sibs; i++) {
    mk("sibling", 1 + Math.floor(rng() * 9), 50 + Math.floor(rng() * 30));
  }
  if (rng() < 0.5) mk("grandparent", 62 + Math.floor(rng() * 18), 80 + Math.floor(rng() * 15));
  return people;
}

/** Create a new NPC the player meets during play (friend, coworker, child…). */
export function genPerson(
  rng: Rng,
  pools: NamePools,
  role: Relation,
  playerAge: number,
  opts: { id: string; name?: string; rel?: number },
): Person {
  const surname = role === "child" || role === "sibling" ? "" : ` ${pick(rng, pools.last)}`;
  const baseRel: Partial<Record<Relation, number>> = {
    friend: 35, coworker: 25, partner: 60, spouse: 75, child: 95, ex: -20,
    mother: 75, father: 70, sibling: 55, grandparent: 80,
  };
  const baseAge: Partial<Record<Relation, number>> = {
    child: 0, sibling: Math.max(0, playerAge - 4 + Math.floor(rng() * 8)),
    mother: playerAge + 24, father: playerAge + 26,
    grandparent: playerAge + 62,
  };
  const age =
    baseAge[role] ?? Math.max(0, playerAge - 5 + Math.floor(rng() * 11));
  return makePerson(rng, {
    name: (opts.name ?? pick(rng, pools.first)) + surname,
    age,
    relation: role,
    rel: opts.rel ?? baseRel[role] ?? 30,
    metAge: playerAge,
  }, opts.id);
}

/** Identity belongs to a life, so checkpoints and parallel lives cannot interfere. */
export function nextPersonId(people: Person[]): string {
  const ids = new Set(people.map((p) => p.id));
  let next = people.length + 1;
  while (ids.has(`p${next}`)) next++;
  return `p${next}`;
}

/** Living, not-moved people matching a selector (best rel match first). */
export function matchPeople(c: Character, sel?: SubjectSelector): Person[] {
  return c.people
    .filter((p) => {
      if (!p.alive || p.gone) return false;
      if (sel?.relation && !sel.relation.includes(p.relation)) return false;
      if (sel?.minRel !== undefined && p.rel < sel.minRel) return false;
      if (sel?.maxRel !== undefined && p.rel > sel.maxRel) return false;
      return true;
    })
    .sort((a, b) => b.rel - a.rel);
}

export function findPerson(c: Character, id: string): Person | undefined {
  return c.people.find((p) => p.id === id);
}

/**
 * Yearly people maintenance: everyone ages, elders can pass away, friends can
 * move away, neglected relationships cool off. Returns log lines.
 */
export function peopleTick(c: Character, rng: Rng): string[] {
  const notes: string[] = [];
  for (const p of c.people) {
    if (!p.alive) continue;
    p.age += 1;
    // Natural drift toward neutral when neglected (slow: ±2/yr below rel 10).
    if (p.rel > 10 && c.age - (p.lastActAge.__any ?? p.metAge) >= 3) p.rel = Math.max(10, p.rel - 1);
    // Elders pass away.
    if (p.age > 75) {
      const risk = Math.min(0.35, (p.age - 75) * 0.025);
      if (rng() < risk) {
        p.alive = false;
        p.gone = "died";
        p.memories.push(`Died at ${p.age}.`);
        notes.push(`Your ${p.relation}, ${p.name}, died at age ${p.age}.`);
        c.stats.happiness = Math.max(0, c.stats.happiness - 8);
        if (p.relation === "partner" || p.relation === "spouse") {
          delete c.flags.partner;
          delete c.flags.married;
          notes.push("You are suddenly, terribly alone.");
        }
        continue;
      }
    }
    // Friends/coworkers drift away when the player moves on in life.
    if (
      (p.relation === "friend" || p.relation === "coworker") &&
      p.rel < 25 &&
      c.age >= 16 &&
      rng() < 0.05
    ) {
      p.gone = "moved";
      p.memories.push("Moved away.");
      notes.push(`${p.name} moved away and you lost touch.`);
    }
  }
  return notes;
}

/* ------------------------------ interactions ------------------------------ */

export interface PeopleAction {
  id: string;
  label: string;
  /** Which relations the action applies to. */
  relations: Relation[];
  /** Extra gate beyond relation (e.g. needs rel>40 to ask out). */
  available?: (c: Character, p: Person) => boolean;
  /** Money cost. */
  cost?: (c: Character, p: Person) => number;
  /** Once per person per year. */
  yearly?: boolean;
  run: (c: Character, p: Person, rng: Rng) => string;
}

const clampRel = (v: number) => Math.max(-100, Math.min(100, Math.round(v)));

export const PEOPLE_ACTIONS: PeopleAction[] = [
  {
    id: "spend_time",
    label: "Spend time",
    relations: ["mother", "father", "sibling", "grandparent", "friend", "partner", "spouse", "child", "coworker", "ex"],
    run: (c, p, rng) => {
      p.rel = clampRel(p.rel + 5 + Math.floor(rng() * 4));
      c.stats.happiness = Math.min(100, c.stats.happiness + 2);
      return `You spent time with ${p.name}.`;
    },
  },
  {
    id: "compliment",
    label: "Compliment",
    relations: ["mother", "father", "sibling", "grandparent", "friend", "partner", "spouse", "child", "coworker", "ex"],
    run: (_c, p, rng) => {
      const good = rng() < 0.8;
      p.rel = clampRel(p.rel + (good ? 4 : -3));
      return good
        ? `${p.name} appreciated the compliment.`
        : `${p.name} thought the compliment was weird.`;
    },
  },
  {
    id: "gift",
    label: "Give a gift",
    relations: ["mother", "father", "sibling", "grandparent", "friend", "partner", "spouse", "child"],
    cost: (c) => Math.min(200, Math.max(25, Math.floor(Math.max(0, c.money) * 0.02) || 25)),
    run: (_c, p, rng) => {
      p.rel = clampRel(p.rel + 8 + Math.floor(rng() * 6));
      return `You gave ${p.name} a thoughtful gift.`;
    },
  },
  {
    id: "argue",
    label: "Argue",
    relations: ["mother", "father", "sibling", "grandparent", "friend", "partner", "spouse", "child", "coworker", "ex"],
    run: (c, p, rng) => {
      p.rel = clampRel(p.rel - 10 - Math.floor(rng() * 8));
      const vent = rng() < 0.4;
      if (vent) c.stats.happiness = Math.min(100, c.stats.happiness + 3);
      else c.stats.happiness = Math.max(0, c.stats.happiness - 3);
      return vent
        ? `You had it out with ${p.name}. Honestly? Cathartic.`
        : `You argued with ${p.name}. It went badly.`;
    },
  },
  {
    id: "ask_money",
    label: "Ask for money",
    relations: ["mother", "father", "grandparent", "sibling", "friend", "partner", "spouse"],
    yearly: true,
    run: (c, p, rng) => {
      if (p.rel < 20) {
        p.rel = clampRel(p.rel - 6);
        return `${p.name} refused to lend you money. Ouch.`;
      }
      const gift = Math.floor((10 + p.rel * 1.5) * (0.5 + rng()));
      c.money += gift;
      p.rel = clampRel(p.rel - 5);
      return `${p.name} slipped you $${gift.toLocaleString()}.`;
    },
  },
  {
    id: "ask_out",
    label: "Ask out",
    relations: ["friend"],
    yearly: true,
    available: (c, p) => c.age >= 13 && p.rel >= 35 && !c.flags.partner,
    run: (c, p, rng) => {
      if (rng() < 0.35 + p.rel / 200) {
        p.relation = "partner";
        p.rel = clampRel(Math.max(p.rel, 60));
        c.flags.partner = true;
        p.memories.push("You asked them out — they said yes.");
        return `${p.name} said yes! You're together now.`;
      }
      p.rel = clampRel(p.rel - 8);
      return `${p.name} turned you down. Awkward.`;
    },
  },
  {
    id: "propose",
    label: "Propose",
    relations: ["partner"],
    yearly: true,
    available: (c, p) => c.age >= 18 && p.rel >= 70,
    run: (c, p, rng) => {
      if (rng() < 0.4 + p.rel / 250) {
        p.relation = "spouse";
        p.rel = clampRel(Math.max(p.rel, 85));
        c.flags.married = true;
        c.flags.partner = true;
        c.stats.happiness = Math.min(100, c.stats.happiness + 12);
        p.memories.push(`You got engaged at ${c.age}.`);
        return `${p.name} said YES. You're getting married!`;
      }
      p.rel = clampRel(p.rel - 15);
      c.stats.happiness = Math.max(0, c.stats.happiness - 10);
      return `${p.name} said no. The ring went back in your pocket.`;
    },
  },
  {
    id: "break_up",
    label: "Break up",
    relations: ["partner", "spouse"],
    run: (c, p) => {
      const wasSpouse = p.relation === "spouse";
      p.relation = "ex";
      p.rel = clampRel(-30);
      delete c.flags.partner;
      delete c.flags.married;
      c.stats.happiness = Math.max(0, c.stats.happiness - (wasSpouse ? 15 : 8));
      p.memories.push(`You ${wasSpouse ? "divorced" : "broke up"} at age ${c.age}.`);
      return wasSpouse ? `You divorced ${p.name}.` : `You broke up with ${p.name}.`;
    },
  },
];

export function peopleActionFor(id: string): PeopleAction | undefined {
  return PEOPLE_ACTIONS.find((a) => a.id === id);
}

/** Actions currently usable on this person (relation + availability + yearly). */
export function availableActions(c: Character, p: Person): PeopleAction[] {
  return PEOPLE_ACTIONS.filter(
    (a) =>
      a.relations.includes(p.relation) &&
      p.alive &&
      !p.gone &&
      (!a.available || a.available(c, p)) &&
      (!a.yearly || p.lastActAge[a.id] !== c.age) &&
      (a.cost === undefined || a.cost(c, p) <= c.money),
  );
}

export function runPeopleAction(c: Character, p: Person, actionId: string, rng: Rng): string {
  const action = peopleActionFor(actionId);
  if (!action) return "(unknown action)";
  const cost = action.cost?.(c, p) ?? 0;
  if (cost > c.money) return "You can't afford that.";
  c.money -= cost;
  p.lastActAge[action.id] = c.age;
  p.lastActAge.__any = c.age;
  return action.run(c, p, rng);
}

/* ------------------------------ templating ------------------------------- */

const REL_LABEL: Record<Relation, string> = {
  mother: "mother", father: "father", sibling: "sibling",
  grandparent: "grandparent", friend: "friend", partner: "partner",
  spouse: "spouse", child: "child", coworker: "coworker", ex: "ex",
};

/** Interpolate {{name}}, {{age}} and {{subject.*}} tokens in pack text. */
export function interpolate(text: string, c: Character, subject?: Person): string {
  return text
    .replaceAll("{{name}}", c.name)
    .replaceAll("{{age}}", String(c.age))
    .replace(/\{\{subject\.(\w+)\}\}/g, (_m, field: string) => {
      if (!subject) return "someone";
      if (field === "name") return subject.name;
      if (field === "age") return String(subject.age);
      if (field === "relation") return REL_LABEL[subject.relation];
      if (field === "rel") return String(subject.rel);
      return `{{subject.${field}}}`;
    });
}
