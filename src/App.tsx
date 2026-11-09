import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { ChevronLeft, LoaderCircle, X } from "lucide-react";
import { useWorkspace } from "./useWorkspace";
import { Graph } from "./Graph";
import type { CameraRequest } from "./camera";
import { ImageLoaderContext } from "./images";
import { CanvasMark, Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { ExpandButton, ReadingPanel } from "./ReadingPanel";
import { ChatTranscript } from "./ChatTranscript";
import { DocumentPages } from "./DocumentPages";
import { Composer } from "./Composer";
import { ContextMeter } from "./ContextMeter";
import { ProviderDialog } from "./ProviderDialog";
import { PlanRetryDialog } from "./PlanRetryDialog";
import { api } from "./api";
import { ancestorPath, contextTokens, visualParent } from "../shared/graph";
import { CHATGPT_PLAN, CHATGPT_PLAN_NAME, REASONING_KEY, modelKey, parseModelKey, parseReasoning, unknownModel, type ModelInfo } from "../shared/models";
import type { Canvas, Message, PlanIssue, ProvidersState } from "../shared/types";

const SIDEBAR_KEY = "canvas.sidebar";
const MODEL_KEY = "canvas.model";
const MINIMAP_KEY = "canvas.minimap";

function stored(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Preferences are a convenience; the workspace works without them.
  }
}

// Images in the conversation the next prompt continues.
function branchImageCount(canvas: Canvas) {
  const contextId = canvas.editingId
    ? (canvas.messages.find((m) => m.id === canvas.editingId)?.parentId ??
      null)
    : canvas.draftParentId;
  try {
    return ancestorPath(canvas, contextId, true).reduce(
      (count, m) => count + (m.images?.length ?? 0),
      0,
    );
  } catch {
    return 0;
  }
}

const NO_MODEL: ModelInfo = { provider: "", providerName: "", id: "", label: "Choose a model", description: "", vision: true };

export default function App() {
  const [providers, setProviders] = useState<ProvidersState>({ presets: [], connected: [], savedBaseUrls: {} });
  const [listedModels, setModels] = useState<ModelInfo[]>([]);
  const [catalogIssue, setCatalogIssue] = useState<PlanIssue>();
  const plan = providers.chatGPTPlan;
  const models = listedModels.filter(m => m.provider !== CHATGPT_PLAN || m.profileId === plan?.activeId);
  const workspace = useWorkspace(models);
  const { active: canvas } = workspace;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => stored(SIDEBAR_KEY) === "collapsed" ||
      (stored(SIDEBAR_KEY) === null && matchMedia("(max-width: 700px)").matches),
  );
  // The minimap covers a corner of the canvas, so it starts closed.
  const [minimapOpen, setMinimapOpen] = useState(false);
  // "provider/model"; an older plain model id means DeepSeek.
  const [modelChoice, setModelChoice] = useState(() => stored(MODEL_KEY));
  const connectedIds = new Set(providers.connected.map((c) => c.id));
  const choice = parseModelKey(modelChoice);
  const providerName = (id: string) => id === CHATGPT_PLAN ? CHATGPT_PLAN_NAME : providers.presets.find(p => p.id === id)?.name ?? id;
  const modelConnected = (model: ModelInfo) => connectedIds.has(model.provider) &&
    (model.provider !== CHATGPT_PLAN || Boolean(model.profileId && model.profileId === plan?.activeId));
  // The chosen model, else the first model of a connected provider.
  const model =
    (choice && models.find((m) => m.provider === choice.provider && m.id === choice.id)) ??
    (choice && (choice.provider === CHATGPT_PLAN || connectedIds.has(choice.provider)) ? unknownModel(choice.provider, providerName(choice.provider), choice.id) : undefined) ??
    models.find(m => m.provider !== CHATGPT_PLAN) ?? NO_MODEL;
  // The last thinking level chosen for each model, if it still offers it.
  const levels = parseReasoning(workspace.preferences[REASONING_KEY]);
  const chosenLevel = levels[modelKey(model.provider, model.id)];
  const reasoning = chosenLevel && model.efforts?.includes(chosenLevel) ? chosenLevel : undefined;
  const [camera, setCamera] = useState<CameraRequest>();
  const [lastRead, setLastRead] = useState<{ canvasId: string; message: Message }>();
  const [providerOpen, setProviderOpen] = useState(false);
  const [retryTarget, setRetryTarget] = useState<{ canvasId: string; answerId: string }>();
  const [planRecovery, setPlanRecovery] = useState<{ profileId?: string; reconsent?: boolean }>();
  function openProviders(recovery?: typeof planRecovery) {
    setPlanRecovery(recovery);
    setProviderOpen(true);
  }
  const geometry = useRef<Record<string, import("../shared/graph").PlacementRect>>({});
  const stage = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (workspace.loading) return;
    const prefs = workspace.preferences;
    if (prefs[SIDEBAR_KEY]) setSidebarCollapsed(prefs[SIDEBAR_KEY] === "collapsed");
    if (prefs[MODEL_KEY]) setModelChoice(prefs[MODEL_KEY]);
    if (prefs[MINIMAP_KEY]) setMinimapOpen(prefs[MINIMAP_KEY] === "open");
  }, [workspace.loading]);
  useEffect(() => {
    store(SIDEBAR_KEY, sidebarCollapsed ? "collapsed" : "open");
  }, [sidebarCollapsed]);
  useEffect(() => {
    if (modelChoice) store(MODEL_KEY, modelChoice);
  }, [modelChoice]);
  // Selecting a bubble opens the composer for a follow-up from it.
  useEffect(() => {
    if (canvas?.selectedId) composer.current?.focus({ preventScroll: true });
  }, [canvas?.selectedId, canvas?.editingId]);
  useEffect(() => {
    if (!canvas) return;
    const listener = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || workspace.pageSelection) return;
      if (canvas.editingId) workspace.cancelEdit(canvas.id);
      // Chat mode steps back to the side panel before anything is deselected.
      else if (canvas.readerExpanded && canvas.readingPanelOpen !== false && canvas.selectedId)
        void workspace.update(canvas.id, (c) => ({ ...c, readerExpanded: false }));
      else {
        stage.current?.dispatchEvent(new Event("canvas-clear-selection"));
        workspace.deselect(canvas.id);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [canvas?.id, canvas?.selectedId, canvas?.editingId, canvas?.readerExpanded, canvas?.readingPanelOpen, workspace.pageSelection]);

  // Keys live in server memory, so recheck when a restart may have cleared them.
  const generatingAny = workspace.canvases.some((c) => c.messages.some((m) => m.status === "pending"));
  const modelRefresh = useRef(0);
  const refreshModels = useCallback(() => {
    const version = ++modelRefresh.current;
    void api<{ models: ModelInfo[]; planIssue?: PlanIssue }>("/api/models").then(({ models, planIssue }) => {
      if (version !== modelRefresh.current) return;
      setModels(models);
      setCatalogIssue(planIssue);
      if (planIssue) void api<ProvidersState>("/api/providers").then(state => {
        if (version === modelRefresh.current) setProviders(state);
      }, () => {});
    }, () => {});
  }, []);
  const updateProviders = useCallback((state: ProvidersState) => {
    setProviders(state);
    refreshModels();
  }, [refreshModels]);
  useEffect(() => {
    const refresh = () =>
      void api<ProvidersState>("/api/providers").then(updateProviders, () => {});
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [generatingAny, updateProviders]);

  const empty = canvas?.messages.length === 0;
  const attach = (files: File[]) => {
    if (canvas) void workspace.attachFiles(canvas.id, files, model.vision);
  };
  useEffect(() => {
    if (!empty) return;
    const allowDrop = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    const drop = (event: DragEvent) => {
      const files = [...(event.dataTransfer?.files ?? [])];
      if (event.defaultPrevented || !files.length) return;
      event.preventDefault();
      attach(files);
    };
    window.addEventListener("dragover", allowDrop);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", allowDrop);
      window.removeEventListener("drop", drop);
    };
  }, [empty, canvas?.id, model.vision]);

  const selected = canvas?.messages.find((m) => m.id === canvas.selectedId);
  if (canvas && selected && (lastRead?.canvasId !== canvas.id || lastRead.message !== selected))
    setLastRead({ canvasId: canvas.id, message: selected });
  const readerOpen = !!selected && canvas?.readingPanelOpen !== false;
  // Chat mode: the reader covers the canvas as a chat of the selected branch.
  const chat = readerOpen && !!canvas?.readerExpanded;
  const reading = selected ?? (lastRead?.canvasId === canvas?.id ? lastRead?.message : undefined);
  const retryAnswer = retryTarget?.canvasId === canvas?.id
    ? canvas?.messages.find(message => message.id === retryTarget?.answerId) : undefined;
  const retryModels = (models.includes(model) ? models : [...models, model]).filter(modelConnected);
  useLayoutEffect(() => {
    const element = stage.current;
    const dock = composer.current?.closest<HTMLElement>(".composer-dock");
    if (!element || !dock) return;
    const measure = () => element.style.setProperty("--composer-height", `${dock.offsetHeight}px`);
    const observer = new ResizeObserver(measure);
    observer.observe(dock);
    measure();
    return () => {
      observer.disconnect();
      element.style.removeProperty("--composer-height");
    };
  }, [canvas?.id, empty, !!selected]);

  if (workspace.loading)
    return (
      <main className="startup">
        <CanvasMark />
        <LoaderCircle className="spin" size={20} />
        <p>Opening your workspace…</p>
      </main>
    );
  if (workspace.loadError || !canvas)
    return (
      <main className="startup">
        <CanvasMark />
        <h1>Your workspace needs a moment.</h1>
        <p role="alert">
          {workspace.loadError || "Could not open this canvas."}
        </p>
        <button className="primary" onClick={() => location.reload()}>
          Try opening again
        </button>
        <small>Existing browser data has not been deleted.</small>
      </main>
    );
  const generating = canvas.messages.some((m) => m.status === "pending");
  const parent = canvas.messages.find((m) => m.id === canvas.draftParentId);
  const select = (id: string) => workspace.selectMessage(canvas.id, id);

  return (
    <ImageLoaderContext.Provider value={workspace.loadImage}>
      <div className="app-shell">
        <Sidebar
          canvases={workspace.canvases}
          activeId={canvas.id}
          collapsed={sidebarCollapsed}
          onCollapse={() => { setSidebarCollapsed(true); workspace.setPreference(SIDEBAR_KEY, "collapsed"); }}
          onImport={workspace.importFile}
          onRename={workspace.renameCanvas}
          onDelete={(id) => void workspace.deleteCanvas(id)}
          folders={workspace.folders}
          onCreateFolder={() => workspace.createFolder()}
          onRenameFolder={workspace.renameFolder}
          onDeleteFolder={workspace.deleteFolder}
          onMoveCanvas={workspace.moveCanvas}
          onToggleFolder={workspace.toggleFolder}
          onCreate={() => {
            setCamera(undefined);
            workspace.createCanvas();
            if (matchMedia("(max-width: 700px)").matches) { setSidebarCollapsed(true); workspace.setPreference(SIDEBAR_KEY, "collapsed"); }
            composer.current?.focus({ preventScroll: true });
          }}
          onSelect={(id) => {
            if (id !== canvas.id) setCamera(undefined);
            workspace.selectCanvas(id);
            if (matchMedia("(max-width: 700px)").matches) { setSidebarCollapsed(true); workspace.setPreference(SIDEBAR_KEY, "collapsed"); }
          }}
          onExport={workspace.exportCanvas}
          saveState={workspace.saveState}
          preferenceError={workspace.preferenceError}
          onRetrySave={() => void workspace.retrySave()}
          connected={providers.connected.map((c) => providerName(c.id))}
          onProvider={() => openProviders()}
        />
        <ReactFlowProvider key={canvas.id}>
          <main className="main-workspace">
            <div ref={stage} className={`workspace-stage ${empty ? "empty" : ""}`} data-reading={readerOpen} data-chat={chat}>
              {!empty && (
                <Graph
                  canvas={canvas}
                  camera={camera}
                  onGeometry={rectangles => { geometry.current = rectangles; }}
                  onSelect={select}
                  onDeselect={() => workspace.deselect(canvas.id)}
                  onGroupSelection={active => workspace.setGroupSelection(canvas.id, active)}
                  onRetry={(id) => void workspace.retry(canvas.id, id)}
                  onPlanSettings={(profileId, reconsent) => openProviders({ profileId, reconsent })}
                  onPlanReroute={(answerId) => setRetryTarget({ canvasId: canvas.id, answerId })}
                  onAppearance={(id, patch) => {
                    // Resizing modes reframe the bubble; colors leave the camera alone.
                    if (patch.displayMode !== undefined) setCamera({ ids: [id] });
                    void workspace.update(canvas.id, (c) => ({ ...c, messages: c.messages.map((m) => m.id === id ? { ...m, ...patch } : m) }));
                  }}
                  // A summary is written by the model chosen in the composer.
                  onBranch={(id, mode, summarize) => void workspace.branchOff(canvas.id, id, mode, summarize && modelConnected(model) ? model : undefined, geometry.current).then((branched) => {
                    if (branched) setCamera({ ids: branched.focus });
                  })}
                  onDropSummary={(id) => workspace.continueWithoutSummary(canvas.id, id)}
                  summaryModel={{ label: model.label, contextWindow: model.contextWindow, connected: modelConnected(model) }}
                  onFocus={(id) => { select(id); setCamera({ ids: [id] }); }}
                  savedColors={workspace.savedColors}
                  onSaveColor={workspace.saveColor}
                  minimap={minimapOpen && !chat}
                  onResize={(id, size, position, offset) => {
                    void workspace.update(canvas.id, (c) => ({ ...c, layout: "force-v2", messages: c.messages.map((m) => m.id === id ? { ...m, placementOffset: undefined, position, sizes: { ...m.sizes, [m.displayMode || "preview"]: size }, ...(offset ? { layoutOffset: offset } : {}) } : m) }));
                  }}
                  onLayout={(positions, rebase) => {
                    void workspace.update(canvas.id, (c) => ({
                      ...c,
                      layout: "force-v2",
                      messages: c.messages.map((m) => {
                        const position = positions.get(m.id) ?? m.position;
                        if (!rebase) return position.x === m.position.x && position.y === m.position.y ? m : { ...m, position };
                        const parent = c.messages.find(p => p.id === visualParent(m));
                        const parentPosition = parent ? positions.get(parent.id) ?? parent.position : undefined;
                        const own = geometry.current[m.id], anchor = parent ? geometry.current[parent.id] : undefined;
                        return { ...m, position, ...(parentPosition ? {
                          ...(m.placementOffset ? { placementOffset: { x: position.x-parentPosition.x, y: position.y-parentPosition.y } } : {}),
                          layoutOffset: { x: position.x-parentPosition.x + ((own?.width ?? 520)-(anchor?.width ?? 520))/2, y: position.y-parentPosition.y + ((own?.height ?? 210)-(anchor?.height ?? 210))/2 },
                        } : {}) };
                      }),
                    }));
                  }}
                  onDrop={(positions, offsets) => {
                    void workspace.update(canvas.id, (c) => ({
                      ...c,
                      layout: "force-v2",
                      messages: c.messages.map((m) =>
                        positions.has(m.id)
                          ? {
                              ...m,
                              position: positions.get(m.id)!,
                              placementOffset: undefined,
                              ...(offsets.has(m.id) ? { layoutOffset: offsets.get(m.id) } : {}),
                            }
                          : m,
                      ),
                    }));
                  }}
                  onViewport={(viewport) => {
                    void workspace.update(canvas.id, (c) =>
                      c.viewport.x === viewport.x && c.viewport.y === viewport.y && c.viewport.zoom === viewport.zoom
                        ? c : { ...c, viewport });
                  }}
                />
              )}
              <TopBar
                canvas={canvas}
                empty={empty}
                sidebarCollapsed={sidebarCollapsed}
                onShowSidebar={() => { setSidebarCollapsed(false); workspace.setPreference(SIDEBAR_KEY, "open"); }}
                onSelect={(id) => {
                  select(id);
                  setCamera({ ids: [id] });
                }}
                minimap={minimapOpen}
                onMinimap={() => {
                  setMinimapOpen(!minimapOpen);
                  workspace.setPreference(MINIMAP_KEY, minimapOpen ? "closed" : "open");
                }}
              />
              {workspace.notice && !(empty || selected) && (
                <div className="workspace-alert" role="alert">
                  <p>{workspace.notice}</p>
                  <button onClick={workspace.dismissNotice}>Dismiss</button>
                </div>
              )}
              <ContextMeter
                tokens={
                  canvas.selectedId
                    ? contextTokens(canvas, canvas.selectedId)
                    : null
                }
                limit={model.contextWindow}
                request={workspace.chatRequest?.canvasId === canvas.id
                  ? workspace.chatRequest.sequence
                  : undefined}
              />
              {(empty || selected) && (
                <Composer
                  canvas={canvas}
                  empty={empty}
                  parent={parent}
                  generating={generating}
                  notice={workspace.notice}
                  models={models}
                  model={model}
                  providers={providers.connected.filter(c => c.id !== CHATGPT_PLAN).map(c => ({ id: c.id, name: providerName(c.id) }))}
                  connected={modelConnected(model)}
                  onConnect={() => openProviders()}
                  branchImages={branchImageCount(canvas)}
                  branchBytes={ancestorPath(canvas, canvas.editingId ? canvas.messages.find(m => m.id === canvas.editingId)?.parentId ?? null : canvas.draftParentId, true).flatMap(m => m.images ?? []).reduce((sum, image) => sum + (image.bytes ?? 0), 0)}
                  textarea={composer}
                  onDraft={(draft) =>
                    void workspace.update(canvas.id, (c) => ({ ...c, draft }))
                  }
                  onSubmit={() => {
                    void workspace.send(
                      canvas.id,
                      canvas.draft,
                      canvas.draftParentId,
                      model,
                      (ids, first) => setCamera({ ids: first ? [ids[1]] : ids, first, center: true, followId: ids[1] }),
                      geometry.current,
                      reasoning,
                    );
                    composer.current?.focus({ preventScroll: true });
                  }}
                  onAttach={attach}
                  preparing={workspace.preparing}
                  preparationProgress={workspace.preparationProgress}
                  onCancelPreparation={workspace.cancelPreparation}
                  welcome={empty && (
                    <h1 className="welcome-heading">
                      <span>Canvas</span>
                    </h1>
                  )}
                  onRemoveImage={(id) =>
                    workspace.removeDraftImage(canvas.id, id)
                  }
                  onRemoveFile={(id) => workspace.removeDraftFile(canvas.id, id)}
                  onCancelEdit={() => workspace.cancelEdit(canvas.id)}
                  onDismissNotice={workspace.dismissNotice}
                  onModel={(m) => { const key = modelKey(m.provider, m.id); setModelChoice(key); workspace.setPreference(MODEL_KEY, key); }}
                  reasoning={reasoning}
                  onReasoning={(level) => {
                    const { [modelKey(model.provider, model.id)]: _previous, ...rest } = levels;
                    workspace.setPreference(REASONING_KEY, JSON.stringify(level ? { ...rest, [modelKey(model.provider, model.id)]: level } : rest));
                  }}
                />
              )}
              {selected && !readerOpen && <button className="reader-reopen icon-button" aria-label="Open reading panel" aria-controls="reading-panel" aria-expanded={false} onClick={() => void workspace.update(canvas.id, c => ({ ...c, readingPanelOpen: true }))}><ChevronLeft size={18} /></button>}
              <aside
                id="reading-panel"
                className="reading-panel"
                data-open={readerOpen}
                data-expanded={chat}
                inert={!readerOpen}
                aria-hidden={!readerOpen}
                aria-label={chat ? "Chat with the selected branch" : "Full message"}
              >
                {chat ? (
                  <>
                    <ExpandButton expanded onToggle={() => void workspace.update(canvas.id, c => ({ ...c, readerExpanded: false }))} />
                    <button className="icon-button reading-close" aria-label="Close reading panel" onClick={() => {
                      void workspace.update(canvas.id, c => ({ ...c, readingPanelOpen: false, readerExpanded: false }));
                      composer.current?.focus({ preventScroll: true });
                    }}>
                      <X size={18} />
                    </button>
                    <ChatTranscript
                      canvas={canvas}
                      canEdit={!generating && !workspace.preparing}
                      generating={generating}
                      onSelect={select}
                      onEdit={(id) => workspace.startEdit(canvas.id, id)}
                      onRetry={(id) => void workspace.retry(canvas.id, id)}
                      onDropSummary={(id) => workspace.continueWithoutSummary(canvas.id, id)}
                    />
                  </>
                ) : reading && (
                  <ReadingPanel
                    message={reading}
                    canEdit={!generating && !workspace.preparing}
                    onEdit={() => workspace.startEdit(canvas.id, reading.id)}
                    onClose={() => { void workspace.update(canvas.id, c => ({ ...c, readingPanelOpen: false, readerExpanded: false })); composer.current?.focus({ preventScroll: true }); }}
                    onExpand={() => { void workspace.update(canvas.id, c => ({ ...c, readerExpanded: true })); composer.current?.focus({ preventScroll: true }); }}
                  />
                )}
              </aside>
            </div>
          </main>
        </ReactFlowProvider>
        {workspace.pageSelection && (
          <DocumentPages selection={workspace.pageSelection} cancel={workspace.cancelPreparation} />
        )}
        {retryAnswer && ["error", "interrupted"].includes(retryAnswer.status) && (
          <PlanRetryDialog
            answer={retryAnswer}
            models={retryModels}
            accounts={plan?.accounts ?? []}
            onClose={() => setRetryTarget(undefined)}
            onRetry={(route) => {
              setRetryTarget(undefined);
              void workspace.retry(canvas.id, retryAnswer.id, route);
            }}
          />
        )}
        {(providerOpen || plan?.welcomeId) && (
          <ProviderDialog
            state={providers}
            onChange={updateProviders}
            catalogIssue={catalogIssue}
            onRefreshModels={refreshModels}
            recovery={planRecovery}
            onClose={() => {
              setProviderOpen(false);
              composer.current?.focus({ preventScroll: true });
            }}
          />
        )}
      </div>
    </ImageLoaderContext.Provider>
  );
}
