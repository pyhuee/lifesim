import { describe, expect, it } from "vitest";
import { LifeSim } from "./engine";
import { actionsLeft, applyForJob, performAction } from "./actions";
import {
  advanceWorld, employerTick, householdCosts, householdTick, hiringModifier,
  HOUSEHOLD_JOB, performHouseholdAction,
} from "./household";
import { seededNoise } from "./rng";
import type { EventPack } from "./types";

const pack: EventPack = {
  id: "test", name: "Test", version: "1", events: [],
  actions: [{ id: "study", title: "Study", result: "Studied", effects: [{ kind: "stat", stat: "smarts", delta: 1 }] }],
};
function adult(seed = 1, enabled = true) {
  const sim = new LifeSim([pack], { seed, livingHousehold: enabled });
  sim.character.age = 18;
  sim.world.year += 18;
  return sim;
}

describe("living household", () => {
  it("advances calendar time once, with no advance while busy or dead", () => {
    const sim = new LifeSim([], { seed: 1, livingHousehold: true, startYear: 1990 });
    sim.ageUp();
    expect(sim.world.year).toBe(1991);
    expect(sim.summaries).toHaveLength(1);
    sim.applyEffects([{ kind: "die", cause: "test" }]);
    sim.ageUp();
    expect(sim.world.year).toBe(1991);
  });

  it("cycles deterministically without advancing the event RNG", () => {
    const a = adult(77);
    const b = adult(77);
    const initial = a.rng.getState();
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) {
      advanceWorld(a);
      advanceWorld(b);
      seen.add(a.world.economy.phase);
      expect(a.world).toEqual(b.world);
    }
    expect(seen.size).toBe(4);
    expect(a.world.economy.priceIndex).toBeGreaterThan(1);
    expect(a.rng.getState()).toBe(initial);
    expect(hiringModifier(a)).toBeGreaterThanOrEqual(-25);
    a.world.economy.phase = "recession";
    expect(hiringModifier(a)).toBe(-25);
  });

  it("covers childhood costs, charges adults, and honors the classic option", () => {
    const child = new LifeSim([], { seed: 1, livingHousehold: true });
    child.character.age = 17;
    expect(householdCosts(child)).toEqual({ housing: 0, essentials: 0, dependents: 0 });
    const sim = adult();
    const result = householdTick(sim);
    expect(result.expenses).toEqual({ housing: 2400, essentials: 3600, dependents: 0 });
    expect(sim.character.money).toBe(-6000);
    expect(householdCosts(adult(1, false))).toEqual({ housing: 0, essentials: 0, dependents: 0 });
  });

  it("makes independent living cost more, and careful spending cheaper", () => {
    const sim = adult();
    const family = householdCosts(sim);
    expect(performHouseholdAction(sim, "independent").ok).toBe(true);
    const independent = householdCosts(sim);
    expect(independent.housing).toBeGreaterThan(family.housing);
    expect(performHouseholdAction(sim, "careful").ok).toBe(true);
    expect(householdCosts(sim).essentials).toBe(Math.round(independent.essentials * 0.8));
    expect(performHouseholdAction(sim, "family").reason).toMatch(/Already moved/);
  });

  it("adds costs for dependent children and a spouse, and removes unavailable family housing", () => {
    const sim = adult();
    sim.applyEffects([{ kind: "person", role: "child" }, { kind: "person", role: "spouse" }]);
    expect(householdCosts(sim).dependents).toBe(4400);
    for (const p of sim.character.people) {
      if (["mother", "father", "grandparent"].includes(p.relation)) p.alive = false;
    }
    householdTick(sim);
    expect(sim.household.housing).toBe("independent");
    expect(performHouseholdAction(sim, "family").ok).toBe(false);
  });

  it("shares one budget across relationships, studying, job applications and household choices", () => {
    const sim = adult();
    const mom = sim.character.people.find((p) => p.relation === "mother")!;
    sim.interact(mom.id, "spend_time");
    expect(actionsLeft(sim)).toBe(2);
    expect(performAction(sim, "study").ok).toBe(true);
    expect(applyForJob(sim, HOUSEHOLD_JOB.id).ok).toBe(true);
    expect(actionsLeft(sim)).toBe(0);
    const before = structuredClone(sim.character);
    const rng = sim.rng.getState();
    expect(sim.interact(mom.id, "spend_time")).toMatch(/No activities/);
    expect(sim.peopleActions(mom.id)).toEqual([]);
    expect(performHouseholdAction(sim, "careful").ok).toBe(false);
    expect(sim.character).toEqual(before);
    expect(sim.rng.getState()).toBe(rng);
    sim.ageUp();
    expect(actionsLeft(sim)).toBe(3);
  });

  it("blocks invalid social actions without costs, budget or randomness", () => {
    const sim = adult();
    const mom = sim.character.people.find((p) => p.relation === "mother")!;
    const rng = sim.rng.getState();
    const budget = actionsLeft(sim);
    sim.interact(mom.id, "propose");
    expect(actionsLeft(sim)).toBe(budget);
    expect(sim.rng.getState()).toBe(rng);
    mom.alive = false;
    expect(sim.peopleActions(mom.id)).toEqual([]);
    expect(sim.interact(mom.id, "spend_time")).toMatch(/isn't available/);
  });

  it("applies employer layoffs before pay, with severance and no event-RNG draw", () => {
    const seed = Array.from({ length: 100 }, (_, i) => i).find((i) => seededNoise(i, "layoff", 2018) < 0.25)!;
    const sim = adult(seed);
    sim.character.flags.employed = true;
    sim.character.flags.job = HOUSEHOLD_JOB.title;
    sim.character.flags.salary = 26000;
    sim.household.employment = { tenure: 1, performance: 80 };
    sim.world.economy.phase = "recession";
    sim.world.employer.health = 20;
    const rng = sim.rng.getState();
    expect(employerTick(sim).join(" ")).toContain("laid you off");
    expect(sim.character.money).toBe(6500);
    expect(sim.character.flags.salary).toBeUndefined();
    expect(sim.character.flags.seeking_work).toBe(true);
    expect(sim.household.employment).toBeNull();
    expect(sim.rng.getState()).toBe(rng);
  });

  it("rewards developed skills with a promotion when the business can support it", () => {
    const seed = Array.from({ length: 100 }, (_, i) => i).find((i) => seededNoise(i, "layoff", 2018) > 0.01 && seededNoise(i, "promotion", 2018) < 0.2)!;
    const sim = adult(seed);
    sim.character.flags.employed = true;
    sim.character.flags.job = HOUSEHOLD_JOB.title;
    sim.character.flags.salary = 26000;
    sim.household.employment = { tenure: 1, performance: 60 };
    sim.world.economy.phase = "growth";
    sim.world.economy.inflation = 0.02;
    expect(performHouseholdAction(sim, "develop_skills").ok).toBe(true);
    expect(performHouseholdAction(sim, "develop_skills").ok).toBe(false);
    expect(employerTick(sim).join(" ")).toContain("promoted");
    expect(sim.character.flags.salary).toBe(28600);
  });

  it("reconciles each yearly financial summary exactly", () => {
    const sim = adult(9);
    sim.character.flags.employed = true;
    sim.character.flags.salary = 20000;
    sim.character.flags.job = "Pack job";
    sim.character.flags.savings = 1000;
    sim.character.money = 5000;
    sim.ageUp();
    const review = sim.summaries[0];
    const bills = Object.values(review.expenses).reduce((sum, v) => sum + v, 0);
    expect(review.closingMoney).toBe(review.openingMoney + review.income - bills + review.otherMoney);
    expect(review.income).toBe(20000);
    expect(bills).toBeGreaterThan(6000);
    expect(review.notes.some((n) => n.includes("Household bills"))).toBe(true);
  });
});
