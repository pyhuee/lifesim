import { LifeSim } from "../engine/engine";
import type { ActiveAilment } from "../engine/types";

/**
 * Health modifiers made visible: the character's active ailments with their
 * course (acute/chronic/progressive), kind, and the treatments on offer —
 * doctor visits, therapy, surgery — with cost and cure odds on the button.
 */
export default function AilmentList({
  sim,
  onAct,
}: {
  sim: LifeSim;
  onAct: () => void;
}) {
  const ailments = sim.character.ailments;
  if (!ailments.length) return null;
  return (
    <div className="ailments">
      <div className="section-label">Conditions</div>
      {ailments.map((a) => (
        <AilmentRow key={a.id} sim={sim} ailment={a} onAct={onAct} />
      ))}
    </div>
  );
}

const KIND_ICON: Record<ActiveAilment["kind"], string> = {
  physical: "🩹",
  mental: "🧠",
  injury: "🦴",
};

function AilmentRow({
  sim,
  ailment,
  onAct,
}: {
  sim: LifeSim;
  ailment: ActiveAilment;
  onAct: () => void;
}) {
  const offers = sim.treatments(ailment.id);
  return (
    <div className="ailment-row">
      <div className="ailment-head">
        <span className="ailment-name">
          {KIND_ICON[ailment.kind]} {ailment.name}
        </span>
        <span className={`ailment-course course-${ailment.course}`}>
          {ailment.course}
        </span>
      </div>
      <div className="ailment-sub">
        {ailment.drain < 0 && <span>{ailment.drain} health/yr</span>}
        {ailment.happy < 0 && <span>{ailment.happy} happiness/yr</span>}
        {ailment.yearsLeft !== undefined && (
          <span>~{ailment.yearsLeft}y left</span>
        )}
        {!ailment.treatable && <span>no known cure</span>}
      </div>
      {offers.length > 0 && (
        <div className="ailment-treatments">
          {offers.map((o) => (
            <button
              key={o.treatment.id}
              className="btn mini"
              disabled={!o.affordable || !!sim.pending || !sim.character.alive}
              title={
                o.affordable
                  ? `${o.treatment.label} — ${Math.round(o.treatment.cureChance * 100)}% cure`
                  : `Can't afford $${o.treatment.cost.toLocaleString()}`
              }
              onClick={() => { sim.treat(ailment.id, o.treatment.id); onAct(); }}
            >
              {o.treatment.label}
              {o.treatment.cost > 0 && ` $${o.treatment.cost.toLocaleString()}`}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
