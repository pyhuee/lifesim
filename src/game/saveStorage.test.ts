import { describe, expect, it } from "vitest";
import { LifeSim } from "../engine/engine";
import { readSlot, writeSlot } from "./saveStorage";

describe("save slots", () => {
  it("keeps manual slots independent of autosave", () => {
    const records = new Map<string, string>();
    const storage = { setItem: (k: string, v: string) => { records.set(k, v); }, getItem: (k: string) => records.get(k) ?? null };
    const sim = new LifeSim([], { seed: 0, name: "Slot test", livingHousehold: true });
    writeSlot(storage, "slot1", sim);
    sim.ageUp();
    writeSlot(storage, "autosave", sim);
    expect(readSlot(storage, "slot1")?.character.age).toBe(0);
    expect(readSlot(storage, "autosave")?.character.age).toBe(1);
    expect(readSlot(storage, "slot2")).toBeNull();
  });

  it("reports corrupt data and storage failures without deleting an earlier save", () => {
    const corrupt = "corrupt";
    const storage = { getItem: () => corrupt, setItem: () => { throw new Error("Quota exceeded"); } };
    const sim = new LifeSim([], { seed: 1 });
    expect(() => readSlot(storage, "autosave")).toThrow();
    expect(() => writeSlot(storage, "slot1", sim)).toThrow("Quota exceeded");
    expect(storage.getItem()).toBe(corrupt);
    expect(sim.character.alive).toBe(true);
  });
});
