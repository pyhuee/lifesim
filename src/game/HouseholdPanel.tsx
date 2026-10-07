import type { LifeSim } from "../engine/engine";
import { actionsLeft } from "../engine/actions";
import {
  householdActionReason, householdCosts, performHouseholdAction,
  type HouseholdAction,
} from "../engine/household";

export default function HouseholdPanel({ sim, onAct }: { sim: LifeSim; onAct: () => void }) {
  if (!sim.household.enabled) return null;
  const { world, household, character } = sim;
  const costs = householdCosts(sim);
  const total = costs.housing + costs.essentials + costs.dependents;
  const button = (action: HouseholdAction, label: string) => {
    const reason = householdActionReason(sim, action);
    return <button key={action} className="btn mini" disabled={!!reason} title={reason ?? "Uses 1 activity"} onClick={() => {
      performHouseholdAction(sim, action);
      onAct();
    }}>{label}</button>;
  };
  return (
    <section className="household-panel" aria-label="Living household">
      <div className="world-heading"><h3>Your world</h3><span>{world.year}</span></div>
      <div className={`economy-pill economy-${world.economy.phase}`}>{world.economy.phase}</div>
      <p className="household-note">Prices rose {(world.economy.inflation * 100).toFixed(1)}% this year.
        {world.economy.phase === "recession" ? " Hiring is tougher and layoffs are more likely." : " Job offers reflect today's cost of living."}</p>
      <div className="section-label">Household</div>
      <div className="household-metric"><span>Housing</span><b>{household.housing === "family" ? "Family home" : "Independent"}</b></div>
      <div className="household-metric"><span>Spending</span><b>{household.spending}</b></div>
      <div className="household-metric"><span>Estimated bills / year</span><b>${total.toLocaleString()}</b></div>
      {character.age < 18 ? <p className="household-note">Your family covers childhood expenses. Household decisions open at 18.</p> : <>
        <div className="household-buttons">{button("family", "Family home")}{button("independent", "Own place")}</div>
        <div className="household-buttons">{button("careful", "Careful")}{button("balanced", "Balanced")}{button("comfortable", "Comfortable")}</div>
        <p className="household-note">Careful spending reduces essentials by 20%, with −1 happiness each year. Comfortable spending costs 30% more, with +1 happiness. Changes apply at the next age-up.</p>
      </>}
      <div className="section-label">{world.employer.name}</div>
      <div className="household-metric"><span>Business health</span><b>{world.employer.health}/100</b></div>
      <div className="business-bar"><div style={{ width: `${world.employer.health}%` }} /></div>
      {household.employment ? <>
        <p className="household-note">{household.employment.tenure} years employed · performance {household.employment.performance}/100.
          Strong performance opens promotion opportunities.</p>
        {button("develop_skills", "Develop work skills")}
      </> : <p className="household-note">Apply for Harbor Works Assistant in Jobs to join this employer.</p>}
      <p className="activity-total">{actionsLeft(sim)} activities left · shared by life choices, people, job applications and household decisions.</p>
    </section>
  );
}
