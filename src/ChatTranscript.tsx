import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Pencil, RotateCcw } from "lucide-react";
import type { Canvas, Message } from "../shared/types";
import { ancestorPath } from "../shared/graph";
import { effortLabel } from "../shared/models";
import { extractWebsite } from "../shared/website";
import { Markdown } from "./Markdown";
import { FileChips } from "./Files";
import { Thumbnail } from "./images";
import { WebsiteFrame } from "./WebsiteFrame";

// The selected branch as a chat: the path from its root to the selected
// bubble, plus the newest answer to a selected prompt while it is written.
export function chatMessages(canvas: Canvas): Message[] {
  let path: Message[] = [];
  try { path = ancestorPath(canvas, canvas.selectedId, true); } catch { return []; }
  const last = path.at(-1);
  if (last?.role !== "user") return path;
  const answer = canvas.messages
    .filter((m) => m.parentId === last.id && m.role === "assistant" && !m.editOf)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  return answer ? [...path, answer] : path;
}

function Turn({ message, current, canEdit, generating, onSelect, onEdit, onRetry, onLeaveOutSummary }: {
  message: Message;
  current: boolean;
  canEdit: boolean;
  generating: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onRetry: () => void;
  onLeaveOutSummary: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const assistant = message.role === "assistant";
  const website = useMemo(() => (assistant && message.status === "complete" ? extractWebsite(message.content) : undefined), [assistant, message.status, message.content]);
  return (
    <article
      className={`chat-turn ${assistant ? "answer" : "prompt"} ${current ? "current" : ""}`}
      data-message-id={message.id}
      data-status={message.status}
      aria-current={current ? "step" : undefined}
      onClick={(event) => {
        if ((event.target as Element).closest("a, button, iframe, summary, pre, code") || getSelection()?.toString()) return;
        if (message.status === "complete") onSelect();
      }}
    >
      <div className="chat-body">
        {message.summary && <span className="summary-label">Summary of earlier context</span>}
        {message.images?.length ? (
          <div className="chat-images">{message.images.slice(0, 8).map((image) => <Thumbnail key={image.id} image={image} />)}</div>
        ) : null}
        {message.files?.length ? <FileChips files={message.files} /> : null}
        {message.status === "pending" ? (
          <div className="typing" role="status" aria-label={message.summary ? "Writing a summary" : "Writing an answer"}><span /><span /><span /></div>
        ) : message.status === "error" || message.status === "interrupted" ? (
          <div className="chat-error" role="alert">
            <strong>{message.status === "interrupted" ? "Request interrupted" : "A small interruption"}</strong>
            <p>{message.error}</p>
            <button disabled={generating} onClick={onRetry}><RotateCcw size={13} /> {message.summary ? "Retry summary" : "Retry answer"}</button>
            {message.summary && <button disabled={generating} onClick={onLeaveOutSummary}>Leave it out</button>}
          </div>
        ) : (
          <>
            {website && <WebsiteFrame page={website} title="Website from this answer" className="website-frame chat-website" />}
            {message.content && <Markdown content={message.content} />}
          </>
        )}
        {message.truncated && <p className="truncation-note">The output token limit was reached.</p>}
      </div>
      {message.status === "complete" && (
        <div className="chat-actions">
          {assistant && message.reasoning && <small>{effortLabel(message.reasoning)} thinking</small>}
          <button aria-label="Copy message" title="Copy" onClick={async () => {
            try { await navigator.clipboard.writeText(message.content); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { setCopied(false); }
          }}>{copied ? <Check size={13} /> : <Copy size={13} />}</button>
          {!assistant && <button aria-label="Edit prompt" title="Edit prompt" disabled={!canEdit} onClick={onEdit}><Pencil size={13} /></button>}
        </div>
      )}
    </article>
  );
}

export function ChatTranscript({ canvas, canEdit, generating, onSelect, onEdit, onRetry, onLeaveOutSummary }: {
  canvas: Canvas;
  canEdit: boolean;
  generating: boolean;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onRetry: (id: string) => void;
  onLeaveOutSummary: (id: string) => void;
}) {
  const messages = chatMessages(canvas);
  const scroller = useRef<HTMLDivElement>(null);
  const tail = messages.at(-1);
  const signature = `${messages.length}:${tail?.id}:${tail?.status}`;
  // Follow the conversation as turns arrive, as a chat does.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [signature]);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    // Late layout (images, math, websites) keeps the newest turn in view.
    const timer = setTimeout(() => element.scrollTo({ top: element.scrollHeight, behavior: "smooth" }), 250);
    return () => clearTimeout(timer);
  }, [signature]);
  return (
    <div className="chat-transcript" ref={scroller} aria-label="Selected branch as a chat">
      <div className="chat-column">
        {messages.map((message) => (
          <Turn
            key={message.id}
            message={message}
            current={message.id === canvas.selectedId}
            canEdit={canEdit}
            generating={generating}
            onSelect={() => onSelect(message.id)}
            onEdit={() => onEdit(message.id)}
            onRetry={() => onRetry(message.id)}
            onLeaveOutSummary={() => onLeaveOutSummary(message.id)}
          />
        ))}
      </div>
    </div>
  );
}
