import { parseSave, saveLife } from "../engine/persistence";
import type { LifeSim } from "../engine/engine";

export type SaveSlot = "autosave" | "slot1" | "slot2" | "slot3";
const key = (slot: SaveSlot) => `lifesim.save.v1.${slot}`;

/** Storage errors propagate so the UI can show failure without losing the live life. */
export function writeSlot(storage: Pick<Storage, "setItem">, slot: SaveSlot, sim: LifeSim) {
  storage.setItem(key(slot), JSON.stringify(saveLife(sim)));
}

export function readSlot(storage: Pick<Storage, "getItem">, slot: SaveSlot): LifeSim | null {
  const text = storage.getItem(key(slot));
  return text === null ? null : parseSave(text);
}
