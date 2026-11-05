import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  ArrowUp,
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
import type { ModelInfo } from "../shared/models";
import { groupAttachments, isImageFile, MAX_IMAGES, documentLabel, Thumbnail } from "./images";
import { plainText } from "./Markdown";

const imageFiles = (list: FileList | null | undefined) =>
  [...(list ?? [])].filter(isImageFile);

function ModelMenu({
  models,
  model,
  connected,
  onModel,
}: {
  models: ModelInfo[];
  model: ModelInfo;
  connected: boolean;
  onModel: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    // Capture first so Escape closes the menu without deselecting the bubble.
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
    };
    const pointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointerdown", pointer, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerdown", pointer, true);
    };
  }, [open]);
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
          {models.map((option) => (
            <button
              type="button"
              key={option.id}
              role="menuitemradio"
              aria-checked={option.id === model.id}
              onClick={() => {
                onModel(option.id);
                setOpen(false);
              }}
            >
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
              {option.id === model.id && <Check size={14} />}
            </button>
          ))}
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
  onCancelEdit,
  onDismissNotice,
  onModel,
}: {
  canvas: Canvas;
  empty: boolean;
  parent: Message | undefined;
  generating: boolean;
  notice: string;
  models: ModelInfo[];
  model: ModelInfo;
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
  onCancelEdit: () => void;
  onDismissNotice: () => void;
  onModel: (id: string) => void;
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
  const editing = Boolean(canvas.editingId);
  const blockedImages = !model.vision && images.length > 0;
  const ready =
    connected &&
    !generating &&
    !preparing &&
    !blockedImages &&
    Boolean(canvas.draft.trim() || images.length);
  const hint = blockedImages
    ? images.some((image) => image.docx)
      ? "Switch to DeepSeek Flash to send DOCX pages"
      : images.some((image) => image.pdf)
        ? "Switch to DeepSeek Flash to send PDF pages"
        : "Switch to DeepSeek Flash to send images"
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
              aria-label="Attach images, PDF or DOCX"
              title={
                model.vision
                  ? `Attach up to ${Math.max(0, MAX_IMAGES - branchImages - images.length)} more images or document pages`
                  : "Switch to DeepSeek Flash to attach images or document pages"
              }
              disabled={preparing || !model.vision || images.length + branchImages >= MAX_IMAGES}
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip size={16} />
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="image/*,.pdf,application/pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              multiple
              hidden
              onChange={(e) => {
                onAttach([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
            <ModelMenu
              models={models}
              model={model}
              connected={connected}
              onModel={onModel}
            />
          </div>
          <span className="attachment-budget">{Math.max(0, MAX_IMAGES - branchImages - images.length)} pages/images · {Math.max(0, 200 - (branchBytes + images.reduce((sum, image) => sum + (image.bytes ?? 0), 0)) / 1024 / 1024).toFixed(1)} MiB available</span>
          <div className="send-actions">
            {preparing && (
              <button type="button" className="attachment-progress" onClick={onCancelPreparation} aria-label="Cancel attachment preparation">
                {preparationProgress || "Preparing attachments…"} <X size={13} />
              </button>
            )}
            {!connected && (
              <button type="button" className="connect-prompt" onClick={onConnect}>
                <KeyRound size={13} /> Connect DeepSeek to send
              </button>
            )}
            {hint && (
              <span className={`model-hint ${blockedImages ? "warn" : ""}`}>
                {hint}
              </span>
            )}
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
        </div>
      </form>
    </div>
  );
}
