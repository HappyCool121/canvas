import { useState } from "react";
import { Download, GitBranch, LoaderCircle, PanelLeftClose, Plus } from "lucide-react";
import { canvasUsage } from "../shared/usage";
import type { Canvas } from "../shared/types";

export function CanvasMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`canvas-mark ${small ? "small" : ""}`}>
      <GitBranch size={small ? 17 : 23} strokeWidth={1.8} />
    </span>
  );
}

export function Sidebar({
  canvases,
  activeId,
  collapsed,
  onCollapse,
  onCreate,
  onSelect,
  onExport,
  saveState,
  preferenceError,
  onRetrySave,
  connected,
  onProvider,
}: {
  canvases: Canvas[];
  activeId: string;
  collapsed: boolean;
  onCollapse: () => void;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onExport: (id: string) => Promise<void>;
  saveState?: { saving: boolean; error?: string };
  preferenceError: string;
  onRetrySave: () => void;
  // Names of the connected providers.
  connected: string[];
  onProvider: () => void;
}) {
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const active = canvases.find((canvas) => canvas.id === activeId)!;
  const usage = canvasUsage(active);
  const usd = (amount: number) => amount === 0 ? "$0.00" : amount < 0.000001
    ? "<$0.000001"
    : `$${amount.toFixed(6)}`;
  return (
    <aside
      className={`sidebar ${collapsed ? "collapsed" : ""}`}
      aria-label="Canvases"
      inert={collapsed}
    >
      <div className="sidebar-inner">
        <div className="sidebar-head">
          <a className="brand" href="#" onClick={(e) => e.preventDefault()}>
            <CanvasMark small />
            <span>
              canvas<span className="brand-period">.</span>
            </span>
          </a>
          <button
            className="icon-button"
            aria-label="Hide sidebar"
            title="Hide sidebar"
            onClick={onCollapse}
          >
            <PanelLeftClose size={17} />
          </button>
        </div>
        <button className="new-canvas" onClick={onCreate}>
          <Plus size={17} /> New canvas
        </button>
        <div className="sidebar-section">
          <span>YOUR SPACE</span>
          <span>{canvases.length.toString().padStart(2, "0")}</span>
        </div>
        <nav className="canvas-list" aria-label="Saved canvases">
          {[...canvases]
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((c) => (
              <button
                key={c.id}
                className={`canvas-item ${activeId === c.id ? "active" : ""}`}
                aria-current={activeId === c.id ? "page" : undefined}
                onClick={() => onSelect(c.id)}
              >
                <GitBranch size={15} />
                <span>{c.title}</span>
                {c.messages.some((m) => m.status === "pending") ? (
                  <LoaderCircle className="spin" size={12} />
                ) : (
                  <span className="canvas-count">
                    {c.messages.length || "—"}
                  </span>
                )}
              </button>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <dl className="sidebar-usage" aria-label="Canvas usage" aria-live="polite">
            <dt>Tokens used</dt>
            <dd>{usage.tokens.toLocaleString()}{usage.missingUsage && " (partial)"}</dd>
            <dt>Estimated cost (USD)</dt>
            <dd title="At list prices from the models.dev catalog, or as the provider reported. DeepSeek charges more at peak hours.">
              ≈ {usd(usage.cost)}{usage.partial && " (partial)"}
            </dd>
          </dl>
          <button className="export-canvas" disabled={exporting} onClick={async () => {
            setExporting(true);
            setExportError("");
            try {
              await onExport(activeId);
            } catch (error) {
              setExportError((error as Error).message || "Canvas export failed. Try again.");
            } finally {
              setExporting(false);
            }
          }}>
            <Download size={15} /> Export canvas as JSON
          </button>
          {exportError && <p className="export-error" role="alert">{exportError}</p>}
          <div className="sidebar-save">
            <div className="save-status" role="status">
              {saveState?.saving && <LoaderCircle className="spin" size={13} />}
              {saveState?.saving ? "Saving…" : saveState?.error ? "Not saved" : "Saved locally"}
            </div>
            {saveState?.error && (
              <>
                <p role="alert">{saveState.error}</p>
                <button onClick={onRetrySave}>Try saving again</button>
              </>
            )}
            {preferenceError && <p role="alert">{preferenceError}</p>}
          </div>
          <div className="sidebar-footer">
            <button className="provider-button" onClick={onProvider} aria-haspopup="dialog">
              <span className={`status-dot ${connected.length ? "online" : ""}`} />
              {connected.length === 1
                ? `${connected[0]} connected`
                : connected.length
                  ? `${connected.length} providers connected`
                  : "Connect a provider"}
            </button>
            <span>v0.4</span>
          </div>
        </div>
      </div>
    </aside>
  );
}
