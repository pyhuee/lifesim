import { describe, expect, it } from "vitest";
import { LifeSim } from "./engine";
import { parseSave, restoreLife, saveLife } from "./persistence";
import { applyForJob, performAction, actionsLeft } from "./actions";
import { HOUSEHOLD_JOB, performHouseholdAction } from "./household";
import { makeRng } from "./rng";
import { bundledCorePack } from "../packs/index";
import actionsPack from "../packs/actions.json";
import type { EventPack } from "./types";

const packs = [bundledCorePack(), actionsPack as EventPack];
const snapshot = (sim: LifeSim) => JSON.parse(JSON.stringify(saveLife(sim)));
const advance = (sim: LifeSim) => {
  if (sim.pending) sim.resolve(sim.pending.choices[0].id);
  else sim.ageUp();
};

describe("portable checkpoints", () => {
  it("resumes the exact RNG sequence, including an initial state before the first draw", () => {
    const a = makeRng(0);
    const b = makeRng(123);
    b.setState(a.getState());
    expect(a()).toBe(b());
    for (let i = 0; i < 50; i++) a();
    b.setState(a.getState());
    expect(Array.from({ length: 20 }, () => a())).toEqual(Array.from({ length: 20 }, () => b()));
    expect(() => b.setState(-1)).toThrow();
  });

  it("saving consumes no RNG and detaches all mutable state", () => {
    const sim = new LifeSim(packs, { seed: 0, livingHousehold: true });
    const rngState = sim.rng.getState();
    const save = saveLife(sim);
    expect(sim.rng.getState()).toBe(rngState);
    save.character.money = 123;
    save.character.people[0].memories.push("test");
    expect(sim.character.money).toBe(0);
    expect(sim.character.people[0].memories).not.toContain("test");
  });

  it.each([0, 7, 12345])("repeated JSON checkpoints preserve a complete seeded life (%i)", (seed) => {
    const uninterrupted = new LifeSim(packs, { seed, livingHousehold: true });
    let resumed = parseSave(JSON.stringify(saveLife(uninterrupted)));
    for (let i = 0; i < 150 && uninterrupted.character.alive; i++) {
      advance(uninterrupted);
      advance(resumed);
      expect(snapshot(resumed)).toEqual(snapshot(uninterrupted));
      if (i % 3 === 0) resumed = parseSave(JSON.stringify(saveLife(resumed)));
    }
  });

  it("reconnects a pending NPC subject to the saved roster, preserving offered choices", () => {
    const pack: EventPack = { id: "npc", name: "NPC", version: "1", events: [{
      id: "call", title: "{{subject.name}} calls", description: "A call", forced: true,
      subject: { relation: ["mother"] }, choices: [{ id: "chat", text: "Chat with {{subject.name}}", result: "A nice talk", effects: [{ kind: "rel", delta: 5 }] }],
    }] };
    const sim = new LifeSim([pack], { seed: 1 });
    sim.ageUp();
    const restored = restoreLife(saveLife(sim));
    expect(restored.pending?.choices).toEqual(sim.pending?.choices);
    expect(restored.pending?.event.title).toEqual(sim.pending?.event.title);
    const subject = restored.character.people.find((p) => p.id === restored.pending!.subject!.id)!;
    expect(restored.pending!.subject).toBe(subject);
    const before = subject.rel;
    restored.resolve("chat");
    expect(subject.rel).toBe(before + 5);
    expect(sim.pending).not.toBeNull();
  });

  it("preserves career, household choices, investments and spent activity points", () => {
    let sim: LifeSim | undefined;
    for (let seed = 0; seed < 30; seed++) {
      const candidate = new LifeSim(packs, { seed, livingHousehold: true });
      candidate.character.age = 18;
      candidate.world.year = candidate.world.startYear + 18;
      applyForJob(candidate, HOUSEHOLD_JOB.id);
      if (candidate.household.employment) { sim = candidate; break; }
    }
    expect(sim).toBeTruthy();
    performHouseholdAction(sim!, "careful");
    performAction(sim!, "act_study");
    sim!.character.flags.invested = 1000;
    sim!.character.flags.savings = 500;
    expect(actionsLeft(sim!)).toBe(0);
    const restored = parseSave(JSON.stringify(saveLife(sim!)));
    expect(actionsLeft(restored)).toBe(0);
    expect(restored.household).toEqual(sim!.household);
    advance(sim!);
    advance(restored);
    expect(snapshot(restored)).toEqual(snapshot(sim!));
  });

  it("supports an empty engine and packs whose sections were all disabled", () => {
    for (const source of [[], [{ id: "empty", name: "Empty", version: "1", events: [] }]]) {
      const sim = new LifeSim(source, { seed: 1 });
      sim.ageUp();
      const restored = restoreLife(saveLife(sim));
      expect(restored.character).toEqual(sim.character);
      expect(restored.events.size).toBe(0);
    }
  });

  it("restores a dead life without resurrecting it", () => {
    const sim = new LifeSim(packs, { seed: 1 });
    sim.applyEffects([{ kind: "die", cause: "test" }]);
    const restored = restoreLife(saveLife(sim));
    expect(restored.character.alive).toBe(false);
    expect(restored.ageUp()).toBeNull();
    expect(restored.world.year).toBe(sim.world.year);
  });

  it("rejects invalid state, unknown versions and broken pending references", () => {
    const pack: EventPack = { id: "test", name: "Test", version: "1", events: [{
      id: "event", title: "Event", description: "d", forced: true,
      choices: [{ id: "ok", text: "OK", result: "OK" }],
    }] };
    const sim = new LifeSim([pack], { seed: 1 });
    sim.ageUp();
    const valid = snapshot(sim);
    const changes: Array<(save: ReturnType<typeof snapshot>) => void> = [
      (s) => { s.version = 99; },
      (s) => { s.rngState = -1; },
      (s) => { s.character.stats.health = 101; },
      (s) => { s.character.flags.action_uses = "bad"; },
      (s) => { s.world.year++; },
      (s) => { s.character.people.push(s.character.people[0]); },
      (s) => { s.pending.eventId = "missing"; },
      (s) => { s.pending.choiceIds = ["missing"]; },
      (s) => { s.pending.choiceIds = ["ok", "ok"]; },
      (s) => { s.pending.subjectId = "missing"; },
      (s) => { s.packs[0].events[0].choices[0].effects = [{ kind: "unknown" }]; },
    ];
    for (const change of changes) {
      const invalid = structuredClone(valid);
      change(invalid);
      expect(() => restoreLife(invalid)).toThrow();
      expect(snapshot(sim)).toEqual(valid);
    }
    expect(() => parseSave("not JSON")).toThrow();
  });
});
