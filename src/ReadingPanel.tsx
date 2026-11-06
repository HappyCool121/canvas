import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Download, Maximize2, Minimize2, Pencil, X } from "lucide-react";
import { extractWebsite } from "../shared/website";
import { WebsiteFrame } from "./WebsiteFrame";
import type { Message } from "../shared/types";
import { Markdown } from "./Markdown";
import { groupAttachments, documentLabel, Thumbnail } from "./images";
import { FileViews } from "./Files";

// Opens or leaves chat mode, from the reading panel's top-left corner.
export function ExpandButton({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <button
      className="icon-button reading-expand"
      aria-label={expanded ? "Return to the side panel" : "Expand to chat"}
      title={expanded ? "Return to the side panel" : "Expand to chat with this branch"}
      aria-pressed={expanded}
      onClick={onToggle}
    >
      {expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
    </button>
  );
}

export function ReadingPanel({
  message,
  canEdit,
  onEdit,
  onClose,
  onExpand,
}: {
  message: Message;
  canEdit: boolean;
  onEdit: () => void;
  onClose: () => void;
  onExpand: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const assistant = message.role === "assistant";
  // Answers with an HTML page open on the rendered website.
  const website = useMemo(() => (assistant && message.status === "complete" ? extractWebsite(message.content) : undefined), [assistant, message.status, message.content]);
  const [view, setView] = useState<"website" | "text">("website");
  useEffect(() => { setCopied(false); setView("website"); }, [message.id]);
  const showWebsite = website && view === "website";
  return (
    <>
      <ExpandButton expanded={false} onToggle={onExpand} />
      <button
        className="icon-button reading-close"
        aria-label="Close reading panel"
        onClick={onClose}
      >
        <X size={18} />
      </button>
      <div className="reading-content" key={message.id} data-view={website ? view : undefined}>
        {website && (
          <div className="reading-tabs" role="tablist" aria-label="Answer view">
            <button role="tab" aria-selected={view === "website"} onClick={() => setView("website")}>Website</button>
            <button role="tab" aria-selected={view === "text"} onClick={() => setView("text")}>Text</button>
          </div>
        )}
        {showWebsite ? <WebsiteFrame page={website} title="Website from this answer" /> : <>
        {message.images?.length ? (
          <div className="reading-images">
            {groupAttachments(message.images).map(({ id, name, images }) => (
              name ? (
                <div className="reading-pdf" key={id}>
                  <p className="pdf-label">{documentLabel(name, images)}</p>
                  <div className="reading-images">
                    {images.map((image) => <Thumbnail key={image.id} image={image} />)}
                  </div>
                </div>
              ) : <Thumbnail key={id} image={images[0]} />
            ))}
          </div>
        ) : null}
        {message.files?.length ? <FileViews files={message.files} /> : null}
        {message.content && <Markdown content={message.content} />}
        {message.truncated && (
          <p className="truncation-note">
            The output token limit was reached. You can ask a follow-up from
            this answer.
          </p>
        )}
        </>}
      </div>
      <div className="reading-actions" role="group" aria-label="Message actions">
        <button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(message.content);
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "Copied" : "Copy"}
        </button>
        {website && (
          <button onClick={() => {
            const url = URL.createObjectURL(new Blob([website], { type: "text/html" }));
            const link = document.createElement("a");
            link.href = url;
            link.download = "website.html";
            document.body.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}>
            <Download size={14} /> Download .html
          </button>
        )}
        {!assistant && (
          <button disabled={!canEdit} onClick={onEdit}>
            <Pencil size={14} /> Edit prompt
          </button>
        )}
      </div>
    </>
  );
}
