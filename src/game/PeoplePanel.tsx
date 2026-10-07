import { useState } from "react";
import { LifeSim } from "../engine/engine";
import type { Person } from "../engine/types";
import { actionsLeft } from "../engine/actions";

/**
 * People menu: persistent NPCs (family, friends, partners, coworkers, kids)
 * with relationship meters and per-person interactions that persist across
 * years. Actions come from the engine (`sim.peopleActions`) so the panel
 * only shows what is currently allowed.
 */
export default function PeoplePanel({
  sim,
  onAct,
}: {
  sim: LifeSim;
  onAct: () => void;
}) {
  const people = sim.peopleList();
  const [openId, setOpenId] = useState<string | null>(null);

  if (!people.length) {
    return <p style={{ color: "var(--muted)", fontSize: 13 }}>Nobody yet.</p>;
  }
  return (
    <div className="people-list">
      {people.map((p) => (
        <PersonRow
          key={p.id}
          sim={sim}
          person={p}
          open={openId === p.id}
          onToggle={() => setOpenId(openId === p.id ? null : p.id)}
          onAct={onAct}
        />
      ))}
    </div>
  );
}

const REL_COLOR = (rel: number) =>
  rel >= 60 ? "var(--accent-2)" : rel >= 25 ? "var(--accent)" : rel >= 0 ? "var(--muted)" : "var(--danger)";

function PersonRow({
  sim,
  person,
  open,
  onToggle,
  onAct,
}: {
  sim: LifeSim;
  person: Person;
  open: boolean;
  onToggle: () => void;
  onAct: () => void;
}) {
  const actions = open ? sim.peopleActions(person.id) : [];
  return (
    <div className="person-row">
      <button className="person-head" onClick={onToggle}>
        <span className="person-name">{person.name}</span>
        <span className="person-meta">
          {person.relation} · {person.age}
        </span>
        <span className="person-rel" style={{ color: REL_COLOR(person.rel) }}>
          {person.rel}
        </span>
      </button>
      <div className="rel-bar">
        <div
          className="rel-fill"
          style={{
            width: `${Math.max(0, Math.min(100, person.rel))}%`,
            background: REL_COLOR(person.rel),
          }}
        />
      </div>
      {open && (
        <div className="person-detail">
          <div className="person-traits">
            {person.traits.map((t) => (
              <span key={t} className="trait-chip">{t}</span>
            ))}
          </div>
          <div className="person-actions">
            {actions.map((a) => (
              <button
                key={a.id}
                className="btn mini"
                title={a.cost ? `costs $${a.cost(sim.character, person)}` : undefined}
                onClick={() => { sim.interact(person.id, a.id); onAct(); }}
              >
                {a.label}
                {a.cost ? ` $${a.cost(sim.character, person)}` : ""}
              </button>
            ))}
            {!actions.length && (
              <span style={{ color: "var(--muted)", fontSize: 12 }}>
                {sim.pending ? "Resolve the event first." : !sim.character.alive ? "This life is over." : actionsLeft(sim) <= 0 ? "No activities left this year." : "No actions available right now."}
              </span>
            )}
          </div>
          {person.memories.length > 0 && (
            <div className="person-memories">
              {person.memories.slice(-4).map((m, i) => (
                <div key={i} className="person-memory">{m}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
