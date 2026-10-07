import type { LifeSim } from "../engine/engine";
import { STAT_KEYS } from "../engine/types";

const signed = (value: number) => `${value >= 0 ? "+" : "−"}$${Math.abs(value).toLocaleString()}`;

export default function YearReview({ sim }: { sim: LifeSim }) {
  const summary = sim.summaries[sim.summaries.length - 1];
  if (!summary) return null;
  const bills = summary.expenses.housing + summary.expenses.essentials + summary.expenses.dependents;
  const delta = summary.closingMoney - summary.openingMoney;
  return (
    <details className="panel year-review" open>
      <summary><span>{summary.year} annual update · age {summary.age}</span><b className={delta < 0 ? "cash-negative" : "cash-positive"}>{signed(delta)}</b></summary>
      <p className="household-note">Changes at age-up, before this year's choices.</p>
      <div className="year-ledger">
        <div><span>Pay earned</span><b>{signed(summary.income)}</b></div>
        <div><span>Household bills</span><b>{signed(-bills)}</b></div>
        <div><span>Other changes</span><b>{signed(summary.otherMoney)}</b></div>
      </div>
      {bills > 0 && <p className="household-note">Housing ${summary.expenses.housing.toLocaleString()} · essentials ${summary.expenses.essentials.toLocaleString()} · dependents ${summary.expenses.dependents.toLocaleString()}</p>}
      <div className="stat-deltas">{STAT_KEYS.filter((key) => summary.statChanges[key] !== 0).map((key) => (
        <span key={key}>{key} {summary.statChanges[key] > 0 ? "+" : ""}{summary.statChanges[key]}</span>
      ))}</div>
      {summary.notes.length > 0 && <ul className="year-notes">{summary.notes.map((note, i) => <li key={i}>{note}</li>)}</ul>}
      {sim.summaries.length > 1 && <details className="year-history"><summary>Recent years</summary>
        {sim.summaries.slice(-6, -1).reverse().map((year) => <div key={year.year} className="household-metric">
          <span>{year.year} · age {year.age}</span><b>{signed(year.closingMoney - year.openingMoney)}</b>
        </div>)}
      </details>}
    </details>
  );
}
