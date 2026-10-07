// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { EventPack } from "./engine/types";

// The editor's canvas needs layout; these tests exercise the session handoff.
vi.mock("./editor/EditorScreen", () => ({
  default: ({ onPlaytest }: { onPlaytest: (pack: EventPack) => void }) => <button onClick={() => onPlaytest({
    id: "preview", name: "Preview pack", version: "1", events: [{
      id: "preview_event", title: "Preview", description: "Preview", choices: [{ id: "ok", text: "OK", result: "OK" }],
    }],
  })}>Preview test pack</button>,
}));

let root: Root;
let container: HTMLDivElement;
const auto = () => JSON.parse(window.localStorage.getItem("lifesim.save.v1.autosave")!);

async function click(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);
  expect(button, `Missing button: ${label}`).toBeTruthy();
  expect(button!.disabled).toBe(false);
  await act(async () => { button!.click(); });
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  HTMLElement.prototype.scrollTo = () => {};
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<App />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("persistent game session", () => {
  it("autosaves new lives, uses household mode by default, and preserves seed zero", async () => {
    const seed = container.querySelector<HTMLInputElement>('[aria-label="Life seed"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(seed, "0");
      seed.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("New life");
    expect(auto().seed).toBe(0);
    expect(auto().household.enabled).toBe(true);
    expect(container.textContent).toContain("Harbor Works");
    await click("Age up → 1");
    expect(auto().character.age).toBe(1);
    expect(container.textContent).toContain("2001 annual update");
  });

  it("keeps the active life across Play/Editor navigation and a reload", async () => {
    await click("New life");
    await click("Age up → 1");
    const before = auto();
    await click("Mod Editor");
    await click("Play");
    expect(container.textContent).toContain("Age 1 · 2001");
    expect(auto()).toEqual(before);
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<App />));
    expect(container.textContent).toContain("Age 1 · 2001");
    expect(auto()).toEqual(before);
  });

  it("preserves manual slots and safely handles an empty slot", async () => {
    await click("New life");
    await click("Save slot");
    await click("Age up → 1");
    await click("Load slot");
    expect(container.textContent).toContain("Age 0 · 2000");
    expect(auto().character.age).toBe(0);
    const selector = container.querySelector<HTMLSelectElement>('[aria-label="Save slot"]')!;
    await act(async () => {
      selector.value = "slot2";
      selector.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("Load slot");
    expect(container.textContent).toContain("slot is empty");
    expect(auto().character.age).toBe(0);
  });

  it("keeps playtest mutations out of the regular life and autosave", async () => {
    await click("New life");
    await click("Age up → 1");
    const before = auto();
    await click("Mod Editor");
    await click("Preview test pack");
    expect(container.textContent).toContain("Playtest session");
    await click("Age up → 1");
    expect(auto()).toEqual(before);
    await click("Load slot");
    expect(container.textContent).toContain("That save slot is empty");
    await click("End playtest");
    expect(container.textContent).toContain("Age 1 · 2001");
    expect(auto()).toEqual(before);
  });

  it("reports storage failures while keeping the new life playable", async () => {
    vi.spyOn(window, "localStorage", "get").mockReturnValue({
      setItem: () => { throw new Error("Quota exceeded"); },
    } as unknown as Storage);
    await click("New life");
    expect(container.textContent).toContain("Autosave failed");
    expect(container.textContent).toContain("Export a save");
    await click("Age up → 1");
    expect(container.textContent).toContain("Age 1 · 2001");
  });

  it("keeps a corrupt autosave intact and reports the recovery error", async () => {
    await act(async () => root.unmount());
    window.localStorage.setItem("lifesim.save.v1.autosave", "broken save");
    root = createRoot(container);
    await act(async () => root.render(<App />));
    expect(container.textContent).toContain("Autosave could not be loaded");
    expect(window.localStorage.getItem("lifesim.save.v1.autosave")).toBe("broken save");
  });

  it("validates imported files before replacing the active life", async () => {
    await click("New life");
    const saved = auto();
    await click("Age up → 1");
    const input = container.querySelector<HTMLInputElement>('.save-panel input[type="file"]')!;
    const upload = async (text: string) => {
      Object.defineProperty(input, "files", { configurable: true, value: [new File([text], "life.json", { type: "application/json" })] });
      await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    };
    await upload("invalid JSON");
    expect(container.textContent).toContain("Your current life is unchanged");
    expect(auto().character.age).toBe(1);
    await upload(JSON.stringify(saved));
    expect(container.textContent).toContain("Age 0 · 2000");
    expect(auto().character.age).toBe(0);
  });
});
