import { useEffect, useState } from "react";
import { CHATGPT_PLAN, modelKey, type ModelInfo } from "../shared/models";
import type { Message, PlanAccount } from "../shared/types";

export function PlanRetryDialog({ answer, models, accounts, onClose, onRetry }: {
  answer: Message;
  models: ModelInfo[];
  accounts: PlanAccount[];
  onClose: () => void;
  onRetry: (model: ModelInfo) => void;
}) {
  const [choice, setChoice] = useState("");
  const options = models.filter(model => model.provider !== answer.provider ||
    model.id !== answer.model || model.profileId !== answer.profileId);
  const routeKey = (model: ModelInfo) => modelKey(model.profileId ?? model.provider, model.id);
  const selected = options.find(model => routeKey(model) === choice);
  const label = (model: ModelInfo) => model.provider === CHATGPT_PLAN
    ? `${model.label} · ChatGPT plan · ${accounts.find(account => account.id === model.profileId)?.label ?? "Saved account"}`
    : `${model.label} · ${model.providerName} API`;
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="provider-dialog" role="dialog" aria-modal="true" aria-labelledby="retry-route-title">
        <h2 id="retry-route-title">Change retry route</h2>
        <p>{options.length ? "The next attempt will use the model and billing route you select." : "Connect another provider or select another ChatGPT account in provider settings."}</p>
        {options.length > 0 && <>
          <label htmlFor="retry-route">Model and billing route</label>
          <select id="retry-route" autoFocus value={choice} onChange={event => setChoice(event.target.value)}>
            <option value="">Choose a route</option>
            {options.map(model => {
              const key = routeKey(model);
              return <option key={key} value={key}>{label(model)}</option>;
            })}
          </select>
        </>}
        <div className="plan-retry-actions">
          {selected && <button type="button" className="primary" onClick={() => onRetry(selected)}>Retry with {label(selected)}</button>}
          <button type="button" autoFocus={!options.length} onClick={onClose}>Cancel</button>
        </div>
      </section>
    </div>
  );
}
