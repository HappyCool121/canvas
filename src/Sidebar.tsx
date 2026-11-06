import { useRef, useState, type DragEvent, type ReactNode } from "react";
import {
  ArrowLeft, ChevronRight, Download, FilePlus2, FileUp, Folder, FolderInput, FolderOpen, FolderPlus,
  GitBranch, LoaderCircle, MoreHorizontal, PanelLeftClose, Pencil, Plus, Trash2,
} from "lucide-react";
import { CHATGPT_USAGE_URL } from "../shared/models";
import { canvasUsage } from "../shared/usage";
import type { Canvas } from "../shared/types";
import type { Folders } from "../shared/folders";
import { MenuItem, Popover, useMenu } from "./Menu";

export function CanvasMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`canvas-mark ${small ? "small" : ""}`}>
      <GitBranch size={small ? 17 : 23} strokeWidth={1.8} />
    </span>
  );
}

const DRAG_TYPE = "application/x-canvas-id";

// An inline name editor: Enter or leaving the field saves, Escape cancels.
function InlineName({ value, label, maxLength, onSubmit, onCancel }: {
  value: string;
  label: string;
  maxLength: number;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const name = draft.replace(/\s+/g, " ").trim();
    if (save && name && name !== value) onSubmit(name); else onCancel();
  };
  return (
    <input
      className="inline-name"
      aria-label={label}
      value={draft}
      maxLength={maxLength}
      autoFocus
      onFocus={event => event.target.select()}
      onChange={event => setDraft(event.target.value)}
      onBlur={() => finish(true)}
      onClick={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.key === "Enter") { event.preventDefault(); finish(true); }
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(false); }
      }}
    />
  );
}

// One of this account's canvases: open it, or rename, move or delete it.
// What a canvas row shows.
type Summary = { id: string; title: string; pending: boolean; count: number };

function CanvasRow({ summary, active, folders, folderId, onSelect, onRename, onMove, onDelete }: {
  summary: Summary;
  active: boolean;
  folders: Folders["folders"];
  folderId?: string;
  onSelect: () => void;
  onRename: (title: string) => void;
  onMove: (folderId: string | null) => void;
  onDelete: () => void;
}) {
  const menu = useMenu();
  const [view, setView] = useState<"main" | "move" | "delete">("main");
  const [renaming, setRenaming] = useState(false);
  const close = () => { menu.close(); setView("main"); };
  return (
    <div
      className={`canvas-item ${active ? "active" : ""} ${menu.open ? "menu-open" : ""}`}
      data-canvas-id={summary.id}
      draggable={!renaming}
      onDragStart={event => { event.dataTransfer.setData(DRAG_TYPE, summary.id); event.dataTransfer.effectAllowed = "move"; }}
    >
      {renaming ? <>
        <GitBranch size={15} />
        <InlineName value={summary.title} label="Canvas name" maxLength={120}
          onSubmit={title => { setRenaming(false); onRename(title); }} onCancel={() => setRenaming(false)} />
      </> : (
        <button className="canvas-open" aria-current={active ? "page" : undefined} onClick={onSelect} title={summary.title}>
          <GitBranch size={15} />
          <span>{summary.title}</span>
          {summary.pending
            ? <LoaderCircle className="spin" size={12} aria-label="Writing an answer" />
            : <span className="canvas-count">{summary.count || "—"}</span>}
        </button>
      )}
      <button className="row-options" aria-label={`Options for ${summary.title}`} aria-haspopup="menu" aria-expanded={menu.open}
        onClick={event => { setView("main"); menu.toggle(event); }}>
        <MoreHorizontal size={15} />
      </button>
      {menu.open && <Popover anchor={menu.anchor} onClose={close} label={`${summary.title} options`} align="end">
        {view === "main" && <>
          <MenuItem icon={<Pencil size={14} />} onSelect={() => { close(); setRenaming(true); }}>Rename</MenuItem>
          <MenuItem icon={<FolderInput size={14} />} onSelect={() => setView("move")} trailing={<ChevronRight size={14} className="menu-trailing" />}>Move to folder</MenuItem>
          <div className="menu-separator" role="separator" />
          <MenuItem icon={<Trash2 size={14} />} danger onSelect={() => setView("delete")}>Delete</MenuItem>
        </>}
        {view === "move" && <>
          <MenuItem icon={<ArrowLeft size={14} />} onSelect={() => setView("main")}>Back</MenuItem>
          <div className="menu-separator" role="separator" />
          <MenuItem icon={<GitBranch size={14} />} disabled={!folderId} onSelect={() => { close(); onMove(null); }}>Your space (no folder)</MenuItem>
          {folders.map(folder => (
            <MenuItem key={folder.id} icon={<Folder size={14} />} disabled={folder.id === folderId} onSelect={() => { close(); onMove(folder.id); }}>{folder.name}</MenuItem>
          ))}
          {!folders.length && <p className="menu-note">No folders yet. Use New folder at the bottom of the list.</p>}
        </>}
        {view === "delete" && <div className="menu-confirm" role="alertdialog" aria-label="Delete canvas permanently">
          <p>Permanently delete “{summary.title}”? Its file is removed from this computer.</p>
          <MenuItem icon={<Trash2 size={14} />} danger onSelect={() => { close(); onDelete(); }}>Delete permanently</MenuItem>
          <MenuItem onSelect={() => setView("main")}>Cancel</MenuItem>
        </div>}
      </Popover>}
    </div>
  );
}

// A collapsible folder heading that accepts dropped canvases and has a rename/delete menu.
function FolderGroup({ id, name, count, collapsed, onToggle, onDrop, onRename, onDelete, startRenaming = false, children }: {
  id: string;
  name: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  onDrop?: (canvasId: string) => void;
  onRename?: (name: string) => void;
  onDelete?: () => void;
  startRenaming?: boolean;
  children: ReactNode;
}) {
  const menu = useMenu();
  const [renaming, setRenaming] = useState(startRenaming);
  const [over, setOver] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const close = () => { menu.close(); setConfirming(false); };
  const drop = onDrop && {
    onDragOver: (event: DragEvent) => { if (event.dataTransfer.types.includes(DRAG_TYPE)) { event.preventDefault(); setOver(true); } },
    onDragLeave: () => setOver(false),
    onDrop: (event: DragEvent) => { event.preventDefault(); setOver(false); const canvas = event.dataTransfer.getData(DRAG_TYPE); if (canvas) onDrop(canvas); },
  };
  const Icon = collapsed ? Folder : FolderOpen;
  return (
    <div className="folder" role="group" aria-label={name} data-folder-id={id}>
      <div className={`folder-row ${over ? "drop-target" : ""} ${menu.open ? "menu-open" : ""}`} {...drop}>
        {renaming && onRename ? <>
          <ChevronRight size={13} className={`folder-chevron ${collapsed ? "" : "open"}`} />
          <Icon size={15} />
          <InlineName value={name} label="Folder name" maxLength={60}
            onSubmit={next => { setRenaming(false); onRename(next); }} onCancel={() => setRenaming(false)} />
        </> : (
          <button className="folder-toggle" aria-expanded={!collapsed} onClick={onToggle}>
            <ChevronRight size={13} className={`folder-chevron ${collapsed ? "" : "open"}`} />
            <Icon size={15} />
            <span>{name}</span>
            <span className="folder-count">{count}</span>
          </button>
        )}
        {onRename && onDelete && <>
          <button className="row-options" aria-label={`Options for folder ${name}`} aria-haspopup="menu" aria-expanded={menu.open} onClick={menu.toggle}>
            <MoreHorizontal size={15} />
          </button>
          {menu.open && <Popover anchor={menu.anchor} onClose={close} label={`Folder ${name} options`} align="end">
            {confirming ? <div className="menu-confirm" role="alertdialog" aria-label="Delete folder">
              <p>Delete the folder “{name}”? Its canvases move back to Your space.</p>
              <MenuItem icon={<Trash2 size={14} />} danger onSelect={() => { close(); onDelete(); }}>Delete folder</MenuItem>
              <MenuItem onSelect={() => setConfirming(false)}>Cancel</MenuItem>
            </div> : <>
              <MenuItem icon={<Pencil size={14} />} onSelect={() => { close(); setRenaming(true); }}>Rename folder</MenuItem>
              <MenuItem icon={<Trash2 size={14} />} danger onSelect={() => setConfirming(true)}>Delete folder</MenuItem>
            </>}
          </Popover>}
        </>}
      </div>
      {!collapsed && <div className="folder-items">{children}</div>}
    </div>
  );
}

export function Sidebar({
  canvases,
  activeId,
  collapsed,
  onCollapse,
  onCreate,
  onImport,
  onSelect,
  onExport,
  onRename,
  onDelete,
  folders,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onMoveCanvas,
  onToggleFolder,
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
  onImport: (file: File) => Promise<void>;
  onSelect: (id: string) => void;
  onExport: (id: string) => Promise<void>;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  folders: Folders;
  onCreateFolder: () => string;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
  onMoveCanvas: (canvasId: string, folderId: string | null) => void;
  onToggleFolder: (id: string) => void;
  saveState?: { saving: boolean; error?: string };
  preferenceError: string;
  onRetrySave: () => void;
  // Names of the connected providers.
  connected: string[];
  onProvider: () => void;
}) {
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [importing, setImporting] = useState(false);
  const [newFolder, setNewFolder] = useState<string>();
  const [overRoot, setOverRoot] = useState(false);
  const createMenu = useMenu();
  // The file picker is created on demand, so the composer's is the page's only file input.
  const chooseImport = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setImporting(true);
      try { await onImport(file); } finally { setImporting(false); }
    };
    input.click();
  };
  const active = canvases.find((canvas) => canvas.id === activeId)!;
  const usage = canvasUsage(active);
  const usd = (amount: number) => amount === 0 ? "$0.00" : amount < 0.000001
    ? "<$0.000001"
    : `$${amount.toFixed(6)}`;
  const sorted = [...canvases].sort((a, b) => b.createdAt - a.createdAt);
  const known = new Set(folders.folders.map(f => f.id));
  const folderOf = (id: string) => known.has(folders.placement[id]) ? folders.placement[id] : undefined;
  const row = (c: Canvas) => (
    <CanvasRow key={c.id} active={activeId === c.id} folders={folders.folders} folderId={folderOf(c.id)}
      summary={{ id: c.id, title: c.title, count: c.messages.length, pending: c.messages.some((m) => m.status === "pending") }}
      onSelect={() => onSelect(c.id)} onRename={title => onRename(c.id, title)}
      onMove={folder => onMoveCanvas(c.id, folder)} onDelete={() => onDelete(c.id)} />
  );
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
        <button className="new-canvas" aria-haspopup="menu" aria-expanded={createMenu.open} disabled={importing} onClick={createMenu.toggle}>
          {importing ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />} {importing ? "Importing…" : "New canvas"}
        </button>
        {createMenu.open && <Popover anchor={createMenu.anchor} onClose={createMenu.close} label="New canvas" className="wide">
          <MenuItem icon={<FilePlus2 size={15} />} onSelect={() => { createMenu.close(); onCreate(); }} hint="Start from an empty map">Blank canvas</MenuItem>
          <MenuItem icon={<FileUp size={15} />} onSelect={() => { createMenu.close(); chooseImport(); }} hint="Open a Canvas JSON export">Import canvas JSON…</MenuItem>
        </Popover>}
        <nav className="canvas-list" aria-label="Saved canvases">
          <div
            className={`sidebar-section ${overRoot ? "drop-target" : ""}`}
            onDragOver={event => { if (event.dataTransfer.types.includes(DRAG_TYPE)) { event.preventDefault(); setOverRoot(true); } }}
            onDragLeave={() => setOverRoot(false)}
            onDrop={event => { event.preventDefault(); setOverRoot(false); const id = event.dataTransfer.getData(DRAG_TYPE); if (id) onMoveCanvas(id, null); }}
          >
            <span>YOUR SPACE</span>
            <span>{canvases.length.toString().padStart(2, "0")}</span>
          </div>
          {folders.folders.map(folder => {
            const items = sorted.filter(c => folderOf(c.id) === folder.id);
            return (
              <FolderGroup key={folder.id} id={folder.id} name={folder.name} count={items.length}
                collapsed={folders.collapsed.includes(folder.id)} onToggle={() => onToggleFolder(folder.id)}
                onDrop={id => onMoveCanvas(id, folder.id)} onRename={name => onRenameFolder(folder.id, name)}
                onDelete={() => onDeleteFolder(folder.id)} startRenaming={newFolder === folder.id}>
                {items.length ? items.map(row) : <p className="folder-empty">Drag canvases here</p>}
              </FolderGroup>
            );
          })}
          {sorted.filter(c => !folderOf(c.id)).map(row)}
        </nav>
        <div className="sidebar-bottom">
          <button className="new-folder" onClick={() => setNewFolder(onCreateFolder())}>
            <FolderPlus size={15} /> New folder
          </button>
          <dl className="sidebar-usage" aria-label="Canvas usage" aria-live="polite">
            <dt>Tokens used</dt>
            <dd>{usage.tokens.toLocaleString()}{usage.missingUsage && " (partial)"}</dd>
            {usage.planAnswers && <>
              <dt>ChatGPT plan tokens</dt>
              <dd>{usage.planTokens.toLocaleString()}{usage.missingPlanUsage && " (partial)"}{" "}
                <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">Manage usage</a>
              </dd>
            </>}
            <dt>{usage.planAnswers ? "Estimated API cost (USD)" : "Estimated cost (USD)"}</dt>
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
