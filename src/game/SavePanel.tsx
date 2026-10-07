import { useRef, useState } from "react";
import type { LifeSim } from "../engine/engine";
import { MAX_SAVE_BYTES, parseSave, saveLife } from "../engine/persistence";
import { readSlot, writeSlot, type SaveSlot } from "./saveStorage";

export default function SavePanel({ sim, onRestore, message, onMessage }: {
  sim: LifeSim | null;
  onRestore: (sim: LifeSim) => void;
  message: string;
  onMessage: (message: string) => void;
}) {
  const [slot, setSlot] = useState<SaveSlot>("slot1");
  const fileRef = useRef<HTMLInputElement>(null);
  const attempt = (fn: () => void) => {
    try { fn(); } catch (error) { onMessage(`Save error: ${(error as Error).message}`); }
  };
  const importSave = async (file: File) => {
    try {
      if (file.size > MAX_SAVE_BYTES) throw new Error("Save files must be smaller than 10 MB");
      const life = parseSave(await file.text());
      onRestore(life);
    } catch (error) { onMessage(`Save error: ${(error as Error).message}. Your current life is unchanged.`); }
  };
  return (
    <div className="save-panel">
      <div className="section-label">Save & resume</div>
      <div className="save-controls">
        <select aria-label="Save slot" value={slot} onChange={(e) => setSlot(e.target.value as SaveSlot)}>
          <option value="slot1">Slot 1</option>
          <option value="slot2">Slot 2</option>
          <option value="slot3">Slot 3</option>
          <option value="autosave">Autosave</option>
        </select>
        <button className="btn mini" disabled={!sim || slot === "autosave"} onClick={() => attempt(() => {
          writeSlot(window.localStorage, slot, sim!);
          onMessage(`Saved ${sim!.character.name} in ${slot.replace("slot", "slot ")}.`);
        })}>Save slot</button>
        <button className="btn mini" onClick={() => attempt(() => {
          const life = readSlot(window.localStorage, slot);
          if (life) onRestore(life);
          else onMessage("That save slot is empty. Your current life is unchanged.");
        })}>Load slot</button>
      </div>
      <div className="save-controls">
        <button className="btn mini" disabled={!sim} onClick={() => attempt(() => {
          const blob = new Blob([JSON.stringify(saveLife(sim!), null, 2)], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `${sim!.character.name.replace(/[^\w-]/g, "_")}-age-${sim!.character.age}.lifesim.json`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          onMessage("Exported a portable save, including this life's pack rules.");
        })}>Export save</button>
        <button className="btn mini" onClick={() => fileRef.current?.click()}>Import save</button>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void importSave(file);
        }} />
      </div>
      <p className="save-status" role="status">{message}</p>
    </div>
  );
}
