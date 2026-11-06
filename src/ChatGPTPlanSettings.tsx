import { useEffect, useRef, useState } from "react";
import { CHATGPT_PLAN, CHATGPT_USAGE_URL } from "../shared/models";
import type { ChatGPTPlanState, PlanIssue, ProvidersState } from "../shared/types";
import { api } from "./api";

export const PLAN_PATH = `/api/providers/${CHATGPT_PLAN}`;

const statusLabel = {
  connected: "Connected",
  consent: "Plan permission needed",
  revoked: "Sign-in required",
  disconnected: "Disconnected",
  disconnecting: "Disconnecting…",
};

export function ChatGPTPlanSettings({ plan, catalogIssue, recovery, onChange, onRefreshModels }: {
  plan: ChatGPTPlanState;
  catalogIssue?: PlanIssue;
  recovery?: { profileId?: string; reconsent?: boolean };
  onChange: (state: ProvidersState) => void;
  onRefreshModels: () => void;
}) {
  const [selected, setSelected] = useState(recovery?.profileId ?? plan.activeId ?? plan.accounts[0]?.id ?? "");
  const [watching, setWatching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const popup = useRef<Window | null>(null);
  const knownAccounts = useRef(new Set(plan.accounts.map(item => item.id)));
  const signingIn = plan.signingIn || watching;
  const account = plan.accounts.find(item => item.id === selected);
  const active = plan.accounts.find(item => item.id === plan.activeId);
  const issue = plan.issue ?? catalogIssue;
  const reconsent = account?.status === "consent" || recovery?.reconsent ||
    issue?.code === "chatgpt_plan_consent";
  const blocked = busy || signingIn;

  useEffect(() => {
    if (!signingIn) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function check() {
      try {
        const state = await api<ProvidersState>("/api/providers");
        if (disposed) return;
        if (!state.chatGPTPlan?.signingIn) {
          setWatching(false);
          const result = state.chatGPTPlan;
          if (!result?.issue && result?.activeId) setSelected(result.activeId);
          if (result?.issue?.code === "chatgpt_plan_consent") {
            const added = result.accounts.find(item => item.status === "consent" && !knownAccounts.current.has(item.id));
            if (added) setSelected(added.id);
          }
          onChange(state);
          return;
        }
      } catch { /* Retry polling while Canvas is reachable again. */ }
      if (!disposed) timer = setTimeout(check, 750);
    }
    timer = setTimeout(check, 500);
    return () => { disposed = true; clearTimeout(timer); };
  }, [signingIn, onChange]);

  async function change(path: string, method: "POST" | "DELETE", profileId?: string) {
    setBusy(true);
    setError("");
    try {
      const state = await api<ProvidersState>(PLAN_PATH + path, { method, body: JSON.stringify({ profileId }) });
      setWatching(false);
      onChange(state);
      if (path === "/cancel") popup.current?.close();
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }

  async function signIn() {
    setError("");
    const tab = window.open("about:blank", "_blank");
    if (!tab) { setError("Allow Canvas to open a browser tab for ChatGPT sign-in."); return; }
    tab.opener = null;
    popup.current = tab;
    knownAccounts.current = new Set(plan.accounts.map(item => item.id));
    setBusy(true);
    try {
      const { launchUrl } = await api<{ launchUrl: string }>(`${PLAN_PATH}/sign-in`, {
        method: "POST",
        body: JSON.stringify({ profileId: account?.id, reconsent }),
      });
      tab.location.replace(launchUrl);
      setWatching(true);
    } catch (error) {
      tab.close();
      setError((error as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <section className="chatgpt-plan-settings" aria-labelledby="plan-title">
      <h3 id="plan-title">Use your ChatGPT plan</h3>
      <p>Eligible ChatGPT Plus and Pro accounts can use their plan in Canvas.</p>
      {plan.accounts.length > 0 && <>
        <label htmlFor="chatgpt-plan-account">Saved ChatGPT account</label>
        <select id="chatgpt-plan-account" value={account?.id ?? ""} disabled={blocked} onChange={event => {
          setSelected(event.target.value);
          setError("");
        }}>
          <option value="">Add another account</option>
          {plan.accounts.map(item => <option key={item.id} value={item.id}>
            {item.label} ({statusLabel[item.status]})
          </option>)}
        </select>
      </>}
      {active?.status === "connected" && <p className="plan-active">
        <span className="status-dot online" /> Active account: {active.label}
      </p>}
      {(error || issue) && <p className="form-error" role="alert">{error || issue?.message}</p>}
      <div className="plan-actions">
        {signingIn ? <>
          <span role="status">Waiting for ChatGPT sign-in…</span>
          <button type="button" disabled={busy} onClick={() => void change("/cancel", "POST")}>Cancel sign-in</button>
        </> : <>
          {account?.status === "connected" && account.id !== plan.activeId &&
            <button type="button" disabled={busy} onClick={() => void change("/select", "POST", account.id)}>Use account</button>}
          <button type="button" className="chatgpt-sign-in" data-oai-siwc-button="" disabled={blocked}
            onClick={() => void signIn()}>
            <img src="/chatgpt-sign-in.svg" alt="" /> Continue with ChatGPT
          </button>
          {account && ["connected", "consent", "revoked"].includes(account.status) &&
            <button type="button" className="disconnect" disabled={blocked}
              onClick={() => void change("", "DELETE", account.id)}>Disconnect</button>}
        </>}
        {["chatgpt_plan_revocation_unconfirmed", "chatgpt_plan_limit"].includes(issue?.code ?? "") &&
          <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">Manage usage</a>}
        {catalogIssue?.code === "chatgpt_plan_temporary" && !blocked &&
          <button type="button" onClick={onRefreshModels}>Refresh models</button>}
      </div>
    </section>
  );
}
