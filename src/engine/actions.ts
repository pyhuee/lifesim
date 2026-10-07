import { evalCondition, effectiveWeight } from "./conditions";
import { hiringModifier, HOUSEHOLD_JOB, jobSalary } from "./household";
import type { LifeSim } from "./engine";
import type { Character, Choice, GameAction, Job, ShopItem } from "./types";

/**
 * Player-initiated actions: jobs, shop purchases, gambling and per-year life
 * actions. Everything is pack data interpreted against the same condition /
 * effect / outcome DSL as events, so a mod pack can add its own actions,
 * items and jobs.
 *
 * Action state lives on the character's flags so `chose`/`flag`/`counter`
 * conditions can gate events on it:
 *   flags.action_year   — year the per-year counters were last reset
 *   flags.action_uses   — { actionOrItemId: uses this year }
 *   flags.action_budget — life-action points left this year
 *   flags.job_applied   — { jobId: true } applications this year
 *   flags.items         — owned item ids (string[])
 *   flags.item_<id>     — true while owned (item-driven event conditions)
 *   flags.job           — current job title (string)
 *   history[action.id]  — "done" once an action has ever been performed
 *   history[`buy_${item.id}`] — "done" once purchased
 */

/** Life-category actions the player may take per year (shared budget). */
export const ACTIONS_PER_YEAR = 3;
/** Yearly interest credited on the `savings` counter. */
export const SAVINGS_INTEREST = 0.03;
/** Yearly interest charged on negative money (debt). */
export const DEBT_INTEREST = 0.08;
/** Investment yearly roll: up 65% (+9%), dip 25% (-4%), crash 10% (-25%). */
export const INVEST_UP_P = 0.65;
export const INVEST_UP_PCT = 0.09;
export const INVEST_DIP_PCT = -0.04;
export const INVEST_CRASH_PCT = -0.25;
/** Jobs can only be applied for once each per year. */

const num = (c: Character, flag: string) => Number(c.flags[flag] ?? 0) || 0;

const uses = (c: Character) => c.flags.action_uses as Record<string, number>;
const applied = (c: Character) => c.flags.job_applied as Record<string, boolean>;
const owned = (c: Character) => (c.flags.items as string[] | undefined) ?? [];

/** Reset per-year action state when the age rolls over. */
export function refreshActions(sim: LifeSim) {
  const c = sim.character;
  if (c.flags.action_year !== c.age) {
    c.flags.action_year = c.age;
    c.flags.action_uses = {};
    c.flags.action_budget = ACTIONS_PER_YEAR;
    c.flags.job_applied = {};
  }
}

export function actionsLeft(sim: LifeSim): number {
  refreshActions(sim);
  return num(sim.character, "action_budget");
}

/**
 * Called once per year from the engine's passive tick: item passive effects,
 * savings/investment growth, and debt interest.
 */
export function actionYearTick(sim: LifeSim): string[] {
  const c = sim.character;
  const notes: string[] = [];
  refreshActions(sim);

  for (const id of owned(c)) {
    const item = sim.items.get(id);
    if (item?.passiveEffects) sim.applyEffects(item.passiveEffects);
  }

  const savings = num(c, "savings");
  if (savings > 0) {
    const interest = Math.max(1, Math.round(savings * SAVINGS_INTEREST));
    c.flags.savings = savings + interest;
    notes.push(`Savings earned $${interest.toLocaleString()} interest.`);
  }

  const invested = num(c, "invested");
  if (invested > 0) {
    const roll = sim.rng();
    const pct =
      roll < INVEST_UP_P ? INVEST_UP_PCT : roll < 0.9 ? INVEST_DIP_PCT : INVEST_CRASH_PCT;
    const delta = Math.round(invested * pct);
    c.flags.invested = Math.max(0, invested + delta);
    notes.push(
      pct === INVEST_UP_PCT
        ? `Investments grew (+$${delta.toLocaleString()}).`
        : pct === INVEST_DIP_PCT
          ? `Investments dipped (-$${Math.abs(delta).toLocaleString()}).`
          : `Market crash — investments tumbled (-$${Math.abs(delta).toLocaleString()}).`,
    );
  }

  if (c.money < 0) {
    const interest = Math.max(1, Math.round(-c.money * DEBT_INTEREST));
    c.money -= interest;
    notes.push(`Debt interest: -$${interest.toLocaleString()}.`);
  }

  return notes;
}

/* --------------------------------- actions --------------------------------- */

const countsBudget = (a: GameAction) => a.usesBudget ?? (a.category ?? "life") === "life";

export interface ActionStatus {
  action: GameAction;
  eligible: boolean;
  /** Remaining uses this year (Infinity when unlimited). */
  usesLeft: number;
  reason?: string;
}

export function actionStatus(sim: LifeSim, action: GameAction): ActionStatus {
  const c = sim.character;
  refreshActions(sim);
  const usesLeft = (action.usesPerYear ?? 1) - (uses(c)[action.id] ?? 0);
  let reason: string | undefined;
  if (action.once && c.history[action.id]) reason = "Done";
  else if (usesLeft <= 0) reason = "Done for this year";
  else if (!evalCondition(action.conditions, c)) reason = action.hint ?? "Locked";
  else if (action.cost && !action.allowDebt && c.money < action.cost)
    reason = "Can't afford it";
  else if (countsBudget(action) && num(c, "action_budget") <= 0)
    reason = "No activities left this year";
  return { action, eligible: !reason, usesLeft, reason };
}

export function listActions(sim: LifeSim, category?: string): ActionStatus[] {
  return [...sim.actions.values()]
    .filter((a) => !category || (a.category ?? "life") === category)
    .map((a) => actionStatus(sim, a));
}

/** Perform an action: charge cost, tick uses, resolve its outcome branches. */
export function performAction(
  sim: LifeSim,
  actionId: string,
): { ok: boolean; reason?: string } {
  const action = sim.actions.get(actionId);
  if (!action) return { ok: false, reason: "Unknown action" };
  if (sim.pending || !sim.character.alive)
    return { ok: false, reason: "Resolve the current event first" };
  const st = actionStatus(sim, action);
  if (!st.eligible) return { ok: false, reason: st.reason };

  const c = sim.character;
  uses(c)[action.id] = (uses(c)[action.id] ?? 0) + 1;
  if (countsBudget(action)) c.flags.action_budget = num(c, "action_budget") - 1;
  if (action.cost) c.money -= action.cost;
  c.history[action.id] = "done";

  sim.log.push({ age: c.age, text: `→ ${action.title}`, kind: "event" });
  // Resolve like an event choice — weighted outcomes, effects, goto chains.
  const choice: Choice = {
    id: action.id,
    text: action.title,
    outcomes: action.outcomes,
    effects: action.effects,
    result: action.result,
    goto: action.goto,
  };
  sim.resolveChoice(choice, 0);
  return { ok: true };
}

/* ----------------------------------- jobs ---------------------------------- */

export interface JobStatus {
  job: Job;
  eligible: boolean;
  current: boolean;
  reason?: string;
}

export function jobStatus(sim: LifeSim, job: Job): JobStatus {
  const c = sim.character;
  refreshActions(sim);
  const current = c.flags.job === job.title;
  let reason: string | undefined;
  if (current) reason = "Current job";
  else if (c.flags.in_prison) reason = "In prison";
  else if (applied(c)[job.id]) reason = "Already applied this year";
  else if (!evalCondition(job.conditions, c)) reason = job.hint ?? "Locked";
  else if (actionsLeft(sim) <= 0) reason = "No activities left this year";
  return { job, eligible: !reason, current, reason };
}

export function listJobs(sim: LifeSim): JobStatus[] {
  return [...sim.jobs.values()].map((j) => jobStatus(sim, j));
}

/** Apply for a job: one hire roll, weighted by hireWeight + hireModifiers. */
export function applyForJob(sim: LifeSim, jobId: string): { ok: boolean; reason?: string } {
  const job = sim.jobs.get(jobId);
  if (!job) return { ok: false, reason: "Unknown job" };
  if (sim.pending || !sim.character.alive)
    return { ok: false, reason: "Resolve the current event first" };
  const st = jobStatus(sim, job);
  if (!st.eligible) return { ok: false, reason: st.reason };

  const c = sim.character;
  c.flags.action_budget = actionsLeft(sim) - 1;
  applied(c)[job.id] = true;
  sim.log.push({ age: c.age, text: `→ Applied for ${job.title}`, kind: "event" });

  const p = Math.min(95, Math.max(5, effectiveWeight(job.hireWeight ?? 65, job.hireModifiers, c) + hiringModifier(sim)));
  if (sim.rng() * 100 < p) {
    c.flags.employed = true;
    c.flags.salary = jobSalary(sim, job);
    c.flags.job = job.title;
    sim.household.employment = sim.household.enabled && job.id === HOUSEHOLD_JOB.id
      ? { tenure: 0, performance: 50 } : null;
    delete c.flags.seeking_work;
    c.stats.happiness = Math.min(100, c.stats.happiness + 6);
    c.history[`job_${job.id}`] = "hired";
    sim.log.push({
      age: c.age,
      text: `Hired as ${job.title} — $${Number(c.flags.salary).toLocaleString()}/year.`,
      kind: "result",
    });
  } else {
    c.stats.happiness = Math.max(0, c.stats.happiness - 3);
    c.history[`job_${job.id}`] = "rejected";
    sim.log.push({ age: c.age, text: `${job.title} turned you down.`, kind: "result" });
  }
  return { ok: true };
}

export function quitJob(sim: LifeSim): boolean {
  const c = sim.character;
  if (sim.pending || !c.alive) return false;
  if (!c.flags.employed) return false;
  const title = String(c.flags.job ?? "your job");
  delete c.flags.employed;
  delete c.flags.salary;
  delete c.flags.job;
  sim.household.employment = null;
  c.flags.seeking_work = true;
  sim.log.push({ age: c.age, text: `→ Quit ${title}.`, kind: "event" });
  return true;
}

/* ----------------------------------- shop ---------------------------------- */

export interface ItemStatus {
  item: ShopItem;
  owned: boolean;
  eligible: boolean;
  usesLeft: number;
  reason?: string;
}

export function itemStatus(sim: LifeSim, item: ShopItem): ItemStatus {
  const c = sim.character;
  refreshActions(sim);
  const has = owned(c).includes(item.id);
  const limit = item.usesPerYear ?? 0;
  const usesLeft = limit ? limit - (uses(c)[`buy_${item.id}`] ?? 0) : Infinity;
  let reason: string | undefined;
  if (has && !item.repeatable) reason = "Owned";
  else if (usesLeft <= 0) reason = "Done for this year";
  else if (!evalCondition(item.conditions, c)) reason = item.hint ?? "Locked";
  else if (c.money < item.price) reason = "Can't afford it";
  return { item, owned: has, eligible: !reason, usesLeft, reason };
}

export function listItems(sim: LifeSim): ItemStatus[] {
  return [...sim.items.values()].map((i) => itemStatus(sim, i));
}

export function buyItem(sim: LifeSim, itemId: string): { ok: boolean; reason?: string } {
  const item = sim.items.get(itemId);
  if (!item) return { ok: false, reason: "Unknown item" };
  if (sim.pending || !sim.character.alive)
    return { ok: false, reason: "Resolve the current event first" };
  const st = itemStatus(sim, item);
  if (!st.eligible) return { ok: false, reason: st.reason };

  const c = sim.character;
  c.money -= item.price;
  const items = owned(c);
  if (!items.includes(item.id)) c.flags.items = [...items, item.id];
  c.flags[`item_${item.id}`] = true;
  uses(c)[`buy_${item.id}`] = (uses(c)[`buy_${item.id}`] ?? 0) + 1;
  c.history[`buy_${item.id}`] = "done";

  sim.log.push({
    age: c.age,
    text: `→ Bought ${item.name} for $${item.price.toLocaleString()}.`,
    kind: "event",
  });
  if (item.effects) sim.applyEffects(item.effects);
  return { ok: true };
}
