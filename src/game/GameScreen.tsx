import { useEffect, useMemo, useRef, useState } from "react";
import { LifeSim } from "../engine/engine";
import { validatePackFile } from "../engine/schema";
import { sectionKey } from "../engine/packs";
import { STAT_KEYS, type EventPack, type LoadedPack } from "../engine/types";
import ActionsPanel from "./ActionsPanel";
import StatBar from "./StatBar";
import PeoplePanel from "./PeoplePanel";
import AilmentList from "./AilmentList";
import SavePanel from "./SavePanel";
import HouseholdPanel from "./HouseholdPanel";
import YearReview from "./YearReview";

interface Props {
  sim: LifeSim | null;
  onReplaceSession: (sim: LifeSim) => void;
  onSessionChange: () => void;
  saveMessage: string;
  onSaveMessage: (message: string) => void;
  packs: EventPack[];
  bundledPacks: LoadedPack[];
  enabledPackIds: string[];
  onTogglePack: (id: string) => void;
  disabledSections: ReadonlySet<string>;
  onToggleSection: (key: string) => void;
  onImportPack: (pack: LoadedPack) => void;
}

export default function GameScreen({ sim, onReplaceSession, onSessionChange, saveMessage, onSaveMessage, packs, bundledPacks, enabledPackIds, onTogglePack, disabledSections, onToggleSection, onImportPack }: Props) {
  const [name, setName] = useState("Alex");
  const [seedText, setSeedText] = useState("");
  const [householdMode, setHouseholdMode] = useState(true);
  const [importError, setImportError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const eventRef = useRef<HTMLDivElement>(null);
  const isMobile = useMediaQuery("(max-width: 860px)");
  // Rebuild the sim only when a new life starts or the pack list changes.
  const packsRef = useRef(packs);
  packsRef.current = packs;

  const rerender = () => {
    onSessionChange();
    requestAnimationFrame(() => {
      eventRef.current?.scrollIntoView({ block: "nearest" });
      logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
    });
  };

  const startLife = () => {
    const seed = seedText.trim()
      ? (Number.isFinite(Number(seedText)) ? Number(seedText) : hashSeed(seedText))
      : undefined;
    onReplaceSession(new LifeSim(packsRef.current, { name: name.trim() || "Alex", seed, livingHousehold: householdMode }));
    setImportError("");
  };

  const importPackFile = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      const res = validatePackFile(data);
      if (!res.ok) {
        setImportError(res.errors.join("\n"));
        return;
      }
      onImportPack(res.loaded);
      setImportError("");
    } catch (e) {
      setImportError(`Not valid JSON: ${(e as Error).message}`);
    }
  };

  const c = sim?.character;
  const pending = sim?.pending;

  return (
    <div className="game">
      <details className="panel fold" open={!isMobile || !sim || !c?.alive}>
        <summary onClick={(e) => !isMobile && e.preventDefault()}>
          Character
          {c && (
            <span className="fold-mini">
              {c.name} · {c.age} · ${c.money.toLocaleString()}
            </span>
          )}
        </summary>
        {c ? (
          <>
            <div className="char-name">{c.name}</div>
            <div className="char-age">
              Age {c.age} · {sim!.world.year}
              {c.alive ? "" : ` — died (${c.deathCause})`}
            </div>
            {STAT_KEYS.map((k) => (
              <StatBar key={k} name={k} value={c.stats[k]} />
            ))}
            <div className="money">${c.money.toLocaleString()}</div>
            {typeof c.flags.job === "string" && (
              <div className="char-job">{String(c.flags.job)}</div>
            )}
            {(Number(c.flags.savings ?? 0) > 0 || Number(c.flags.invested ?? 0) > 0) && (
              <div className="char-finance">
                {Number(c.flags.savings ?? 0) > 0 && (
                  <span>Savings ${Number(c.flags.savings).toLocaleString()}</span>
                )}
                {Number(c.flags.invested ?? 0) > 0 && (
                  <span>Invested ${Number(c.flags.invested).toLocaleString()}</span>
                )}
              </div>
            )}
            <div className="traits">
              {c.traits.map((t) => (
                <span key={t} className="trait-chip">{t}</span>
              ))}
              {Object.entries(c.flags)
                .filter(([, v]) => v === true)
                .map(([k]) => (
                  <span key={k} className="trait-chip">{k.replaceAll("_", " ")}</span>
                ))}
            </div>
            <AilmentList sim={sim!} onAct={rerender} />
            <div className="section-label">People</div>
            <PeoplePanel sim={sim!} onAct={rerender} />
          </>
        ) : (
          <p style={{ color: "var(--muted)" }}>No life yet. Start one below.</p>
        )}
        <div className="new-life">
          <input aria-label="Character name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
          <input
            value={seedText}
            aria-label="Life seed"
            onChange={(e) => setSeedText(e.target.value)}
            placeholder="Seed (opt.)"
            style={{ maxWidth: 90 }}
          />
        </div>
        <label className="mode-control"><input type="checkbox" checked={householdMode} onChange={(e) => setHouseholdMode(e.target.checked)} /> Living household for the next life</label>
        <div className="new-life">
          <button className="btn primary" onClick={startLife} style={{ flex: 1 }}>
            New life
          </button>
          <button className="btn" onClick={() => fileRef.current?.click()}>
            Load pack…
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => e.target.files?.[0] && importPackFile(e.target.files[0])}
          />
        </div>
        {importError && <div className="err">{importError}</div>}
        <SavePanel sim={sim} onRestore={onReplaceSession} message={saveMessage} onMessage={onSaveMessage} />
      </details>

      <div className="center-col">
        <button
          className="age-btn"
          disabled={!sim || !c?.alive || !!pending}
          onClick={() => { sim?.ageUp(); rerender(); }}
        >
          {!sim ? "Start a new life" : !c?.alive ? "R.I.P." : pending ? "Choose first" : `Age up → ${c.age + 1}`}
        </button>
        {sim && <YearReview sim={sim} />}
        {!c?.alive && sim && (
          <div className="dead-banner">
            {c?.name} died at {c?.age} of {c?.deathCause} with $
            {c?.money.toLocaleString()} to their name.
          </div>
        )}
        {pending && (
          <div className="event-card" ref={eventRef}>
            <div className="event-cat">
              {pending.event.category ?? "life"}
              {pending.subject && (
                <span className="event-subject"> · {pending.subject.name}</span>
              )}
            </div>
            <div className="event-title">{pending.event.title}</div>
            <div className="event-desc">{pending.event.description}</div>
            {pending.choices.map((ch) => (
              <button
                key={ch.id}
                className="choice-btn"
                onClick={() => { sim?.resolve(ch.id); rerender(); }}
              >
                {ch.text}
              </button>
            ))}
          </div>
        )}
        {sim && <ActionsPanel sim={sim} onAct={rerender} mobile={isMobile} />}
        <div className="panel" style={{ flex: 1 }}>
          <h3>Life log</h3>
          <div className="lifelog" ref={logRef}>
            {sim?.log.map((entry, i) => (
              <div key={i} className={`log-${entry.kind}`}>
                {entry.kind !== "year" && <span style={{ color: "var(--muted)" }}>[{entry.age}] </span>}
                {entry.text}
              </div>
            )) ?? <span style={{ color: "var(--muted)" }}>Your story will appear here.</span>}
          </div>
        </div>
      </div>

      <details className="panel fold" open={!isMobile}>
        <summary onClick={(e) => !isMobile && e.preventDefault()}>
          World & packs
          <span className="fold-mini">{sim ? `${sim.world.year} · ${sim.household.enabled ? sim.world.economy.phase : "Classic"}` : `${bundledPacks.length} packs`}</span>
        </summary>
        {sim && <HouseholdPanel sim={sim} onAct={rerender} />}
        {sim && <details className="current-packs"><summary>This life's rules</summary>
          {sim.packSources.map((p, i) => <div key={`${p.id}:${i}`} className="household-note">{p.name} · v{p.version}</div>)}
          <p className="household-note">{sim.household.enabled ? "Living household" : "Classic mode"}. Saved rules stay with this life.</p>
        </details>}
        <h3>Packs for the next life</h3>
        <p className="household-note">Pack switches take effect when you start a new life.</p>
        {bundledPacks.map((lp) => {
          const p = lp.pack;
          const enabled = enabledPackIds.includes(p.id);
          return (
            <div key={p.id} className="cond-row">
              <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={() => onTogglePack(p.id)}
                />
                <b>{p.name}</b> <span style={{ color: "var(--muted)" }}>v{p.version}</span>
              </label>
              <div style={{ color: "var(--muted)", fontSize: 12 }}>
                {p.events.length} events
                {p.ailments?.length ? `, ${p.ailments.length} conditions` : ""}
              </div>
              {lp.sections.map((s) => {
                const key = sectionKey(p.id, s.id);
                return (
                  <label key={s.id} className="pack-section">
                    <input
                      type="checkbox"
                      checked={enabled && !disabledSections.has(key)}
                      disabled={!enabled}
                      onChange={() => onToggleSection(key)}
                    />
                    <span>{s.name}</span>
                    <span style={{ color: "var(--muted)", fontSize: 11 }}>
                      {s.eventIds.length} ev{s.ailmentIds.length ? ` · ${s.ailmentIds.length} cond` : ""}
                    </span>
                  </label>
                );
              })}
            </div>
          );
        })}
        {packs
          .filter((p) => !bundledPacks.some((b) => b.pack.id === p.id))
          .map((p) => (
            <div key={p.id} className="cond-row">
              <b>{p.name}</b> <span style={{ color: "var(--muted)" }}>v{p.version}</span>
              <div style={{ color: "var(--muted)", fontSize: 12 }}>
                {p.events.length} events (imported)
              </div>
            </div>
          ))}
        <PackSummary packs={packs} />
      </details>
    </div>
  );
}

/** Track a CSS media query so markup can adapt (e.g. panels collapse on mobile). */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

function PackSummary({ packs }: { packs: EventPack[] }) {
  const cats = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of packs)
      for (const e of p.events) m.set(e.category ?? "uncategorized", (m.get(e.category ?? "uncategorized") ?? 0) + 1);
    return [...m.entries()].sort();
  }, [packs]);
  return (
    <>
      <div className="section-label">Categories</div>
      {cats.map(([cat, n]) => (
        <div key={cat} style={{ fontSize: 13, color: "var(--muted)" }}>
          {cat} — {n}
        </div>
      ))}
    </>
  );
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (const ch of s) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
