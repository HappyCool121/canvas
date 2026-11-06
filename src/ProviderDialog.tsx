import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, KeyRound, LoaderCircle, Sparkles, X } from "lucide-react";
import { api } from "./api";
import type { PlanIssue, ProvidersState } from "../shared/types";
import type { Preset } from "../shared/providers";
import { CHATGPT_USAGE_URL } from "../shared/models";
import { ChatGPTPlanSettings, PLAN_PATH } from "./ChatGPTPlanSettings";

const SOURCE = { env: "from .env", session: "this session", saved: "local, remembered" };
const placeholder = (url: string) => /\{[^}]*\}/.test(url);

export function ProviderDialog({
  state,
  onChange,
  onClose,
  onRefreshModels,
  catalogIssue,
  recovery,
}: {
  state: ProvidersState;
  onChange: (s: ProvidersState) => void;
  onClose: () => void;
  onRefreshModels: () => void;
  catalogIssue?: PlanIssue;
  recovery?: { profileId?: string; reconsent?: boolean };
}) {
  const keyConnections = state.connected.flatMap(c => c.source === "plan" ? [] : [{ ...c, source: c.source }]);
  const connected = new Set(keyConnections.map(c => c.id));
  const welcomeId = state.chatGPTPlan?.welcomeId;
  const [presetId, setPresetId] = useState(
    () => state.presets.find((p) => !connected.has(p.id))?.id ?? state.presets[0]?.id ?? "",
  );
  const preset = state.presets.find((p) => p.id === presetId);
  const defaultBase = (p: Preset | undefined) =>
    p ? state.savedBaseUrls[p.id] ?? (placeholder(p.baseUrl) ? "" : p.baseUrl) : "";
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(() => defaultBase(preset));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, [presetId]);
  useEffect(() => {
    // Capture first so Escape closes the dialog without deselecting the bubble
    // behind it, even after focus leaves the disabled input.
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (!busy && !welcomeId) onClose();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [busy, onClose, welcomeId]);
  async function request(path: string, init: RequestInit) {
    setBusy(true);
    setError("");
    try {
      onChange(await api<ProvidersState>(path, init));
      return true;
    } catch (error) {
      setError((error as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const showBaseUrl = Boolean(preset && (preset.editableBaseUrl || preset.baseUrlChoices));
  const groups = [...new Set(state.presets.map((p) => p.group))];
  if (welcomeId) return (
    <div className="modal-backdrop">
      <section className="provider-dialog plan-welcome" role="dialog" aria-modal="true" aria-labelledby="provider-title">
        <h2 id="provider-title">You’re using your ChatGPT plan</h2>
        <p>Eligible requests on this route use your ChatGPT plan. <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">Manage usage</a> in ChatGPT settings.</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button type="button" className="primary" autoFocus disabled={busy} onClick={() => void request(`${PLAN_PATH}/welcome`, {
          method: "POST", body: JSON.stringify({ profileId: welcomeId }),
        })}>Got it</button>
      </section>
    </div>
  );
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <section
        className="provider-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-title"
      >
        <button
          className="icon-button close-dialog"
          aria-label="Close provider settings"
          disabled={busy}
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <span className="dialog-icon">
          <KeyRound size={23} />
        </span>
        <span className="eyebrow">YOUR MODELS, YOUR KEYS</span>
        <h2 id="provider-title">Connect a provider.</h2>
        <p>Bring an API key from any provider below, or point Canvas at a local or OpenAI-compatible server. Each provider bills your own account.</p>
        {state.chatGPTPlan && <ChatGPTPlanSettings key={recovery?.profileId} plan={state.chatGPTPlan} catalogIssue={catalogIssue}
          recovery={recovery} onChange={onChange} onRefreshModels={onRefreshModels} />}
        {keyConnections.length > 0 && (
          <ul className="connected-providers" aria-label="Connected providers">
            {keyConnections.map((c) => (
              <li key={c.id}>
                <span className="status-dot online" />
                <span>
                  <strong>{state.presets.find((p) => p.id === c.id)?.name ?? c.id}</strong>
                  <small>{SOURCE[c.source]}</small>
                </span>
                <button
                  type="button"
                  className="disconnect"
                  disabled={busy}
                  onClick={() => void request(`/api/providers/${c.id}`, { method: "DELETE" })}
                >
                  Disconnect
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy || !preset) return;
            const enteredKey = key.trim();
            setKey("");
            await request(`/api/providers/${preset.id}`, {
              method: "POST",
              body: JSON.stringify({ ...(enteredKey ? { key: enteredKey } : {}), ...(showBaseUrl ? { baseUrl: baseUrl.trim() } : {}) }),
            });
          }}
        >
          <label htmlFor="provider-select">Provider</label>
          <select
            id="provider-select"
            value={presetId}
            disabled={busy}
            onChange={(e) => {
              const next = state.presets.find((p) => p.id === e.target.value);
              setPresetId(e.target.value);
              setKey("");
              setBaseUrl(defaultBase(next));
              setError("");
            }}
          >
            {groups.map((group) => (
              <optgroup key={group} label={group}>
                {state.presets.filter((p) => p.group === group).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}{connected.has(p.id) ? " (connected)" : ""}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {preset && (
            <>
              <label htmlFor="api-key">
                {preset.name} API key{preset.keyless ? " (optional)" : ""}
                {preset.keyUrl && (
                  <a href={preset.keyUrl} target="_blank" rel="noreferrer">
                    Get a key <ArrowUpRight size={12} />
                  </a>
                )}
              </label>
              <input
                ref={input}
                id="api-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={preset.keyless ? "Not needed for a local server" : "Paste your key"}
                disabled={busy}
              />
              {showBaseUrl && (
                <>
                  <label htmlFor="base-url">Base URL</label>
                  <input
                    id="base-url"
                    type="url"
                    autoComplete="off"
                    spellCheck={false}
                    list={preset.baseUrlChoices ? "base-url-choices" : undefined}
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder={preset.baseUrl || "https://your-server.example/v1"}
                    disabled={busy}
                  />
                  {preset.baseUrlChoices && (
                    <datalist id="base-url-choices">
                      {preset.baseUrlChoices.map((url) => <option key={url} value={url} />)}
                    </datalist>
                  )}
                </>
              )}
            </>
          )}
          <p className="key-note">
            <KeyRound size={12} /> Keys stay in local server memory. They are never saved in your
            browser or written to disk.
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button
            className="primary connect-button"
            disabled={busy || !preset || (!preset.keyless && !key.trim()) || (showBaseUrl && !baseUrl.trim())}
          >
            {busy ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}
            {busy ? "Checking…" : preset && connected.has(preset.id) ? `Replace ${preset.name} connection` : `Connect ${preset?.name ?? "provider"}`}
          </button>
        </form>
        <p className="dialog-footnote">
          Restarting Canvas clears keys entered here; keys from .env reconnect.
          Disconnect clears a key now and stops its answers in progress.
        </p>
      </section>
    </div>
  );
}
