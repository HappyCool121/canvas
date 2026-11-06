import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  CircleAlert,
  GitBranch,
  KeyRound,
  Paperclip,
  LoaderCircle,
  Pencil,
  X,
} from "lucide-react";
import type { Canvas, Message } from "../shared/types";
import { CHATGPT_PLAN, CHATGPT_USAGE_URL, MODEL_ID, effortLabel, modelKey, unknownModel, type ModelInfo } from "../shared/models";
import { groupAttachments, isImageFile, MAX_IMAGES, documentLabel, Thumbnail } from "./images";
import { plainText } from "./Markdown";
import { FileChips } from "./Files";

const imageFiles = (list: FileList | null | undefined) =>
  [...(list ?? [])].filter(isImageFile);

function ModelMenu({
  models,
  model,
  providers,
  connected,
  onModel,
}: {
  models: ModelInfo[];
  model: ModelInfo;
  // Connected providers, for typing a model the list doesn't show.
  providers: { id: string; name: string }[];
  connected: boolean;
  onModel: (model: ModelInfo) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) setQuery(""); }, [open]);
  useDismiss(open, () => setOpen(false), root);
  const search = query.trim().toLowerCase();
  const shown = search
    ? models.filter((m) => `${m.label} ${m.id} ${m.providerName}`.toLowerCase().includes(search))
    : models;
  const groups = [...new Set(shown.map((m) => m.providerName))];
  const typed = query.trim();
  const custom = MODEL_ID.test(typed) && !models.some((m) => m.provider !== CHATGPT_PLAN && m.id === typed) ? providers : [];
  const choose = (option: ModelInfo) => {
    onModel(option);
    setOpen(false);
  };
  return (
    <div className="model-menu" ref={root}>
      <button
        type="button"
        className="model-pill"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Model: ${model.label}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{model.label}</span>
        <span className={`status-dot ${connected ? "online" : ""}`} />
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="model-options" role="menu" aria-label="Choose a model">
          {(models.length > 8 || providers.length > 0) && (
            <input
              className="model-search"
              aria-label="Search models"
              placeholder={providers.length ? "Search, or type a model id" : "Search models"}
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          <div className="model-list">
            {groups.map((group) => (
              <div key={group} role="group" aria-label={group}>
                <span className="model-group">{group}</span>
                {shown.filter((m) => m.providerName === group).map((option) => (
                  <button
                    type="button"
                    key={modelKey(option.provider, option.id)}
                    role="menuitemradio"
                    aria-checked={option.provider === model.provider && option.id === model.id}
                    onClick={() => choose(option)}
                  >
                    <span>
                      <strong>{option.label}</strong>
                      <small>{option.description}</small>
                    </span>
                    {option.provider === model.provider && option.id === model.id && <Check size={14} />}
                  </button>
                ))}
              </div>
            ))}
            {custom.map((p) => (
              <button type="button" role="menuitem" key={p.id} onClick={() => choose(unknownModel(p.id, p.name, typed))}>
                <span>
                  <strong>Use “{typed}”</strong>
                  <small>with {p.name}</small>
                </span>
              </button>
            ))}
            {!shown.length && !custom.length && (
              <p className="model-empty">{providers.length ? "No matching models. Type a full model id to use it." : models.length ? "No matching models." : "Connect a provider to choose a model."}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Closes a composer menu on Escape or a click elsewhere. Capture first so
// Escape closes the menu without deselecting the bubble.
function useDismiss(open: boolean, close: () => void, root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    const pointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointerdown", pointer, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerdown", pointer, true);
    };
  }, [open]);
}

const EFFORT_HINTS: Record<string, string> = {
  none: "No thinking",
  minimal: "Barely thinks before answering",
  low: "Quick, light thinking",
  medium: "Balanced thinking",
  high: "Thinks longer before answering",
  xhigh: "Thinks longer than high",
  max: "Deepest thinking; slowest and costliest",
  off: "No thinking",
  on: "Thinks before answering",
};

// The thinking level for the next answer. "Default" sends no level, so the
// provider's own default applies; it is named when the provider reports it.
function ThinkingMenu({ model, level, onLevel }: {
  model: ModelInfo;
  level?: string;
  onLevel: (level?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), root);
  const current = level ? effortLabel(level) : model.defaultEffort ? effortLabel(model.defaultEffort) : "Default";
  const choose = (next?: string) => {
    onLevel(next);
    setOpen(false);
  };
  return (
    <div className="model-menu thinking-menu" ref={root}>
      <button
        type="button"
        className="model-pill thinking-pill"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Thinking: ${current}`}
        title="How much the model thinks before answering"
        onClick={() => setOpen((v) => !v)}
      >
        <Brain size={13} />
        <span>{current}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="model-options thinking-options" role="menu" aria-label="Thinking level">
          <div className="model-list">
            <button type="button" role="menuitemradio" aria-checked={!level} onClick={() => choose(undefined)}>
              <span>
                <strong>{model.defaultEffort ? `Default · ${effortLabel(model.defaultEffort)}` : "Default"}</strong>
                <small>{model.defaultEffort ? "The provider’s usual level" : "The provider decides; Canvas sends no level"}</small>
              </span>
              {!level && <Check size={14} />}
            </button>
            {model.efforts!.filter((option) => option !== model.defaultEffort).map((option) => (
              <button type="button" role="menuitemradio" key={option} aria-checked={level === option} onClick={() => choose(option)}>
                <span>
                  <strong>{effortLabel(option)}</strong>
                  <small>{EFFORT_HINTS[option] ?? ""}</small>
                </span>
                {level === option && <Check size={14} />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function fitPrompt(field: HTMLTextAreaElement) {
  field.style.height = "";
  field.style.height = `${field.scrollHeight}px`;
}

export function Composer({
  canvas,
  empty,
  parent,
  generating,
  notice,
  models,
  model,
  providers,
  connected,
  onConnect,
  branchImages,
  branchBytes,
  textarea,
  onDraft,
  onSubmit,
  onAttach,
  preparing,
  preparationProgress,
  onCancelPreparation,
  welcome,
  onRemoveImage,
  onRemoveFile,
  onCancelEdit,
  onDismissNotice,
  onModel,
  reasoning,
  onReasoning,
}: {
  canvas: Canvas;
  empty: boolean;
  parent: Message | undefined;
  generating: boolean;
  notice: string;
  models: ModelInfo[];
  model: ModelInfo;
  providers: { id: string; name: string }[];
  connected: boolean;
  onConnect: () => void;
  // Images already in the branch this prompt continues.
  branchImages: number;
  branchBytes: number;
  textarea: RefObject<HTMLTextAreaElement | null>;
  onDraft: (draft: string) => void;
  onSubmit: () => void;
  onAttach: (files: File[]) => void;
  preparing: boolean;
  preparationProgress: string;
  onCancelPreparation: () => void;
  welcome: ReactNode;
  onRemoveImage: (id: string) => void;
  onRemoveFile: (id: string) => void;
  onCancelEdit: () => void;
  onDismissNotice: () => void;
  onModel: (model: ModelInfo) => void;
  // The chosen thinking level for this model; absent means Default.
  reasoning?: string;
  onReasoning: (level?: string) => void;
}) {
  useLayoutEffect(() => {
    const field = textarea.current;
    if (field) fitPrompt(field);
  }, [textarea, canvas.draft, empty]);

  useEffect(() => {
    const field = textarea.current;
    if (!field) return;
    let width = field.offsetWidth;
    let frame = 0;
    let disposed = false;
    const resize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => fitPrompt(field));
    };
    const observer = new ResizeObserver(() => {
      if (field.offsetWidth === width) return;
      width = field.offsetWidth;
      resize();
    });
    observer.observe(field);
    void document.fonts?.ready.then(() => { if (!disposed) resize(); });
    window.addEventListener("resize", resize);
    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(frame);
    };
  }, [textarea]);

  const fileInput = useRef<HTMLInputElement>(null);
  const [dropping, setDropping] = useState(false);
  const images = canvas.draftImages ?? [];
  const files = canvas.draftFiles ?? [];
  const editing = Boolean(canvas.editingId);
  const blockedImages = !model.vision && images.length > 0;
  const plan = model.provider === CHATGPT_PLAN;
  // Nothing to choose from: no provider is connected, or listing models failed.
  const needsProvider = !connected && models.length === 0;
  const ready =
    connected &&
    !generating &&
    !preparing &&
    !blockedImages &&
    !(plan && !model.vision && branchImages) &&
    Boolean(canvas.draft.trim() || images.length || files.length);
  const hint = blockedImages
    ? `${model.label} can’t see ${images.some((image) => image.docx)
      ? "DOCX pages"
      : images.some((image) => image.pdf) ? "PDF pages" : "images"}. Choose a model that can.`
    : !model.vision && branchImages
      ? `${model.label} can’t see the ${branchImages === 1 ? "image" : `${branchImages} images`} in this branch`
      : null;

  return (
    <div className={`composer-dock ${empty ? "is-empty" : ""}`}>
      {welcome}
      {notice && (
        <div className="composer-notice" role="alert">
          <CircleAlert size={15} />
          <p>{notice}</p>
          <button
            type="button"
            aria-label="Dismiss message"
            onClick={onDismissNotice}
          >
            <X size={13} />
          </button>
        </div>
      )}
      {!empty && (
        <div className={`context-label ${editing ? "editing" : ""}`}>
          {editing ? (
            <>
              <Pencil size={12} />
              <span>Editing prompt — the answer will branch from it</span>
              <button type="button" onClick={onCancelEdit}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <span className="context-dot" />
              <span>
                {generating ? "Following your thought…" : "Following up on"}
              </span>
              {!generating && parent && (
                <strong>
                  {plainText(parent.content).slice(0, 80) || "Image prompt"}
                </strong>
              )}
              <GitBranch size={12} />
            </>
          )}
        </div>
      )}
      <form
        className={`composer ${dropping ? "dropping" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) onSubmit();
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => {
          setDropping(false);
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          e.stopPropagation();
          onAttach([...e.dataTransfer.files]);
        }}
      >
        {images.length > 0 && (
          <div className="composer-images">
            {groupAttachments(images).map(({ id, name, kind, images }) => (
              <div className={name ? "pdf-group" : "composer-image"} key={id}>
                {name && <span className="pdf-label">{documentLabel(name, images)}</span>}
                <div className="attachment-previews">
                  {images.map((image) => <Thumbnail key={image.id} image={image} />)}
                </div>
                <button
                  type="button"
                  aria-label={name ? `Remove ${kind} ${name}` : "Remove image"}
                  disabled={preparing}
                  onClick={() => onRemoveImage(id)}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        {files.length > 0 && <FileChips files={files} onRemove={onRemoveFile} disabled={preparing} />}
        <textarea
          ref={textarea}
          aria-label="Your prompt"
          value={canvas.draft}
          rows={empty ? 3 : 2}
          placeholder={empty ? undefined : editing
            ? "Rewrite this prompt…"
            : "Where would you like to take this thought?"}
          onChange={(e) => onDraft(e.target.value)}
          onPaste={(e) => {
            const files = imageFiles(e.clipboardData.files);
            if (!files.length) return;
            e.preventDefault();
            onAttach(files);
          }}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              if (ready) onSubmit();
            }
          }}
        />
        <div className="composer-bottom">
          <div className="composer-tools">
            <button
              type="button"
              className="attach-button"
              aria-label="Attach files"
              title={
                model.vision
                  ? `Attach code or text files, or up to ${Math.max(0, MAX_IMAGES - branchImages - images.length)} more images or document pages`
                  : `Attach code or text files. ${model.label} can’t see images or document pages`
              }
              disabled={preparing}
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip size={16} />
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                onAttach([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
            {needsProvider ? (
              <button type="button" className="connect-prompt" onClick={onConnect}>
                <KeyRound size={13} /> Connect a provider to send
              </button>
            ) : (
              <>
                <ModelMenu
                  models={models}
                  model={model}
                  providers={providers}
                  connected={connected}
                  onModel={onModel}
                />
                {model.efforts?.length ? <ThinkingMenu model={model} level={reasoning} onLevel={onReasoning} /> : null}
              </>
            )}
          </div>
          <button
            className="send-button"
            type="submit"
            aria-label="Send prompt"
            disabled={!ready}
          >
            {generating ? (
              <LoaderCircle className="spin" size={17} />
            ) : (
              <ArrowUp size={18} />
            )}
          </button>
        </div>
        <div className="composer-notes">
          {plan && connected && <p className="plan-route">
            Using ChatGPT plan <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">Manage usage</a>
          </p>}
          {preparing && (
            <button type="button" className="attachment-progress" onClick={onCancelPreparation} aria-label="Cancel attachment preparation">
              {preparationProgress || "Preparing attachments…"} <X size={13} />
            </button>
          )}
          {hint && !needsProvider && (
            <span className={`model-hint ${blockedImages ? "warn" : ""}`}>
              {hint}
            </span>
          )}
          {!connected && !needsProvider && model.provider && (
            <span className="model-hint">{model.label} isn’t connected. Choose another model.</span>
          )}
          <span className="attachment-budget">{Math.max(0, MAX_IMAGES - branchImages - images.length)} pages/images · {Math.max(0, 200 - (branchBytes + images.reduce((sum, image) => sum + (image.bytes ?? 0), 0)) / 1024 / 1024).toFixed(1)} MiB available</span>
        </div>
      </form>
    </div>
  );
}
