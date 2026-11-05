import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, KeyRound, LoaderCircle, Sparkles, X } from "lucide-react";
import { api } from "./api";
import type { ProviderStatus } from "../shared/types";

export function ProviderDialog({
  status,
  onChange,
  onClose,
}: {
  status: ProviderStatus;
  onChange: (s: ProviderStatus) => void;
  onClose: () => void;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    // Capture first so Escape closes the dialog without deselecting the bubble
    // behind it, even after focus leaves the disabled input.
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (!busy) onClose();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [busy, onClose]);
  async function request(init: RequestInit) {
    setBusy(true);
    setError("");
    try {
      onChange(await api<ProviderStatus>("/api/provider", init));
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
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
          aria-label="Close DeepSeek settings"
          disabled={busy}
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <span className="dialog-icon">
          <KeyRound size={23} />
        </span>
        <span className="eyebrow">YOUR MODEL, YOUR KEY</span>
        <h2 id="provider-title">Connect DeepSeek.</h2>
        <p>Bring a DeepSeek API key. DeepSeek bills your account directly for every answer.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (busy) return;
            const enteredKey = key.trim();
            setKey("");
            void request({ method: "POST", body: JSON.stringify({ key: enteredKey }) });
          }}
        >
          <label htmlFor="api-key">
            DeepSeek API key{" "}
            <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">
              Get a key <ArrowUpRight size={12} />
            </a>
          </label>
          <input
            ref={input}
            id="api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-…"
            disabled={busy}
          />
          <p className="key-note">
            <KeyRound size={12} /> Your key stays in local server memory. It is never saved in your
            browser or written to disk.
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {status.connected && (
            <div className="connected-note" role="status">
              <Check size={14} />
              {status.source === "env"
                ? "Connected with DEEPSEEK_API_KEY from .env."
                : "DeepSeek is connected for this session."}
            </div>
          )}
          <button className="primary connect-button" disabled={busy || !key.trim()}>
            {busy ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}
            {busy ? "Checking your key…" : status.connected ? "Replace key" : "Connect DeepSeek"}
          </button>
        </form>
        {status.connected && (
          <button className="disconnect" disabled={busy} onClick={() => void request({ method: "DELETE" })}>
            Disconnect
          </button>
        )}
        <p className="dialog-footnote">
          {status.source === "env"
            ? "Disconnecting lasts until Canvas restarts, which reconnects the .env key."
            : "Restarting Canvas clears this key. Disconnect clears it now and stops answers in progress."}
        </p>
      </section>
    </div>
  );
}
