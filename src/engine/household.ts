import { seededNoise } from "./rng";
import { actionsLeft } from "./actions";
import type { LifeSim } from "./engine";
import type { Character, Job, Stats } from "./types";

export type EconomyPhase = "growth" | "stable" | "recession" | "recovery";
export type Housing = "family" | "independent";
export type Spending = "careful" | "balanced" | "comfortable";

export interface WorldState {
  startYear: number;
  year: number;
  economy: { phase: EconomyPhase; yearsInPhase: number; priceIndex: number; inflation: number };
  employer: { id: string; name: string; health: number };
}

export interface HouseholdState {
  enabled: boolean;
  housing: Housing;
  spending: Spending;
  employment: { tenure: number; performance: number } | null;
  lastHousingAge: number | null;
}

export interface YearSummary {
  year: number;
  age: number;
  economy: EconomyPhase;
  openingMoney: number;
  closingMoney: number;
  income: number;
  expenses: { housing: number; essentials: number; dependents: number };
  otherMoney: number;
  statChanges: Stats;
  notes: string[];
}

export const HOUSEHOLD_JOB: Job = {
  id: "household:harbor_assistant",
  title: "Harbor Works Assistant",
  description: "A steady local employer. Economic conditions affect hiring, raises and layoffs.",
  salary: 26000,
  hireWeight: 75,
  conditions: { kind: "age", min: 18 },
  hint: "Available from age 18",
};

export function createWorld(startYear = 2000): WorldState {
  if (!Number.isInteger(startYear) || startYear < 1 || startYear > 9000) {
    throw new Error("Starting year must be between 1 and 9000");
  }
  return {
    startYear, year: startYear,
    economy: { phase: "stable", yearsInPhase: 0, priceIndex: 1, inflation: 0 },
    employer: { id: "harbor_works", name: "Harbor Works", health: 70 },
  };
}

export function createHousehold(enabled = false): HouseholdState {
  return { enabled, housing: "family", spending: "balanced", employment: null, lastHousingAge: null };
}

const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));
const phases: EconomyPhase[] = ["stable", "growth", "recession", "recovery"];

/** Background randomness is keyed by calendar year and never consumes the event RNG. */
export function advanceWorld(sim: LifeSim): string[] {
  const w = sim.world;
  w.year += 1;
  if (!sim.household.enabled) return [];
  const e = w.economy;
  const notes: string[] = [];
  e.yearsInPhase++;
  const duration = 2 + Math.floor(seededNoise(sim.seed, "economy_duration", e.phase, w.year - e.yearsInPhase) * 3);
  if (e.yearsInPhase >= duration) {
    e.phase = phases[(phases.indexOf(e.phase) + 1) % phases.length];
    e.yearsInPhase = 0;
    notes.push(`The economy entered ${e.phase}.`);
  }
  const base = { growth: 0.025, stable: 0.02, recession: 0.008, recovery: 0.015 }[e.phase];
  e.inflation = base + seededNoise(sim.seed, "inflation", w.year) * 0.012;
  e.priceIndex *= 1 + e.inflation;
  const business = { growth: 8, stable: 1, recession: -15, recovery: 8 }[e.phase];
  w.employer.health = clamp(w.employer.health + business + (seededNoise(sim.seed, "employer", w.year) * 8 - 4));
  return notes;
}

/** Modifier applies to job applications only in household mode. */
export function hiringModifier(sim: LifeSim): number {
  return sim.household.enabled
    ? { growth: 12, stable: 0, recession: -25, recovery: 5 }[sim.world.economy.phase]
    : 0;
}

export function jobSalary(sim: LifeSim, job: Job): number {
  return Math.round(job.salary * (sim.household.enabled ? sim.world.economy.priceIndex : 1));
}

/** Clear this career when a pack event or another job changes employment. */
export function syncEmployment(sim: LifeSim) {
  if (!sim.character.flags.employed || sim.character.flags.job !== HOUSEHOLD_JOB.title) {
    sim.household.employment = null;
  }
}

/** Resolve the employer before paying the year's wages. */
export function employerTick(sim: LifeSim): string[] {
  if (!sim.household.enabled) return [];
  syncEmployment(sim);
  const career = sim.household.employment;
  if (!career) return [];
  const c = sim.character;
  const w = sim.world;
  const notes: string[] = [];
  career.tenure++;
  const risk = w.economy.phase === "recession" ? 0.12 + (100 - w.employer.health) / 500 : 0.01;
  if (seededNoise(sim.seed, "layoff", w.year) < risk) {
    const severance = Math.round(Number(c.flags.salary ?? 0) / 4);
    c.money += severance;
    delete c.flags.employed;
    delete c.flags.salary;
    delete c.flags.job;
    c.flags.seeking_work = true;
    sim.household.employment = null;
    c.stats.happiness = clamp(c.stats.happiness - 8);
    notes.push(`${w.employer.name} laid you off during ${w.economy.phase}. Severance: $${severance.toLocaleString()}.`);
    return notes;
  }
  const promoted = career.performance >= 70 && w.economy.phase !== "recession" &&
    seededNoise(sim.seed, "promotion", w.year) < 0.2;
  const raise = w.economy.phase === "recession" ? 0 : w.economy.inflation + (promoted ? 0.08 : 0);
  c.flags.salary = Math.round(Number(c.flags.salary ?? 0) * (1 + raise));
  if (promoted) {
    c.stats.happiness = clamp(c.stats.happiness + 5);
    notes.push(`Your work paid off: ${w.employer.name} promoted you with an 8% raise above inflation.`);
  } else if (raise > 0) {
    notes.push(`${w.employer.name} adjusted your salary for the cost of living.`);
  }
  career.performance = clamp(career.performance - 3);
  return notes;
}

export function hasFamilyHome(c: Character): boolean {
  return c.people.some((p) => p.alive && !p.gone && ["mother", "father", "grandparent"].includes(p.relation));
}

export function householdCosts(sim: LifeSim): YearSummary["expenses"] {
  const c = sim.character;
  if (!sim.household.enabled || c.age < 18) return { housing: 0, essentials: 0, dependents: 0 };
  const independent = sim.household.housing === "independent" || !hasFamilyHome(c);
  const index = sim.world.economy.priceIndex;
  const multiplier = { careful: 0.8, balanced: 1, comfortable: 1.3 }[sim.household.spending];
  const children = c.people.filter((p) => p.alive && !p.gone && p.relation === "child" && p.age < 18).length;
  const spouse = c.people.some((p) => p.alive && !p.gone && p.relation === "spouse") ? 1 : 0;
  return {
    housing: c.flags.in_prison ? 0 : Math.round((independent ? 7200 : 2400) * index),
    essentials: c.flags.in_prison ? 0 : Math.round((independent ? 4800 : 3600) * index * multiplier),
    dependents: Math.round((children * 2000 + spouse * 2400) * index * multiplier),
  };
}

export function householdTick(sim: LifeSim): { expenses: YearSummary["expenses"]; notes: string[] } {
  const notes: string[] = [];
  if (sim.household.enabled && sim.character.age >= 18) {
    if (sim.household.housing === "family" && !hasFamilyHome(sim.character)) {
      sim.household.housing = "independent";
      notes.push("With no family home available, you began living independently.");
    }
  }
  const expenses = householdCosts(sim);
  const total = expenses.housing + expenses.essentials + expenses.dependents;
  if (total) {
    sim.character.money -= total;
    notes.push(`Household bills: $${total.toLocaleString()} (housing, essentials and dependents).`);
    const change = { careful: -1, balanced: 0, comfortable: 1 }[sim.household.spending];
    sim.character.stats.happiness = clamp(sim.character.stats.happiness + change);
    if (sim.character.money < 0) {
      sim.character.stats.happiness = clamp(sim.character.stats.happiness - 2);
      notes.push("Your household ran short of cash; unpaid costs added to debt.");
    }
  }
  return { expenses, notes };
}

export type HouseholdAction = "family" | "independent" | "careful" | "balanced" | "comfortable" | "develop_skills";

export function householdActionReason(sim: LifeSim, action: HouseholdAction): string | undefined {
  if (!sim.household.enabled) return "Household mode is off";
  if (!sim.character.alive) return "This life is over";
  if (sim.pending) return "Resolve the event first";
  if (sim.character.age < 18) return "Available from age 18";
  if (action === "develop_skills") {
    syncEmployment(sim);
    if (!sim.household.employment) return "Join Harbor Works first";
    if (sim.character.flags.household_training_age === sim.character.age) return "Already trained this year";
  } else if (action === "family" || action === "independent") {
    if (action === sim.household.housing) return "Current home";
    if (action === "family" && !hasFamilyHome(sim.character)) return "No family home available";
    if (sim.household.lastHousingAge === sim.character.age) return "Already moved this year";
  } else if (action === sim.household.spending) return "Current budget";
  if (actionsLeft(sim) <= 0) return "No activities left this year";
  return undefined;
}

export function performHouseholdAction(sim: LifeSim, action: HouseholdAction): { ok: boolean; reason?: string } {
  const reason = householdActionReason(sim, action);
  if (reason) return { ok: false, reason };
  const c = sim.character;
  c.flags.action_budget = actionsLeft(sim) - 1;
  let text: string;
  if (action === "family" || action === "independent") {
    sim.household.housing = action;
    sim.household.lastHousingAge = c.age;
    text = action === "family" ? "You moved back into the family home to share costs." : "You moved into your own place.";
  } else if (action === "develop_skills") {
    sim.household.employment!.performance = clamp(sim.household.employment!.performance + 15);
    c.stats.smarts = clamp(c.stats.smarts + 2);
    c.flags.household_training_age = c.age;
    text = "You developed your work skills. Your performance at Harbor Works improved.";
  } else {
    sim.household.spending = action;
    text = `You switched to a ${action} household budget.`;
  }
  sim.log.push({ age: c.age, text, kind: "result" });
  return { ok: true };
}
