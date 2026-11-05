import { useEffect, useState } from "react";
import { Check, Copy, Pencil, X } from "lucide-react";
import type { Message } from "../shared/types";
import { Markdown } from "./Markdown";
import { groupAttachments, documentLabel, Thumbnail } from "./images";

export function ReadingPanel({
  message,
  canEdit,
  onEdit,
  onClose,
}: {
  message: Message;
  canEdit: boolean;
  onEdit: () => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const assistant = message.role === "assistant";
  useEffect(() => setCopied(false), [message.id]);
  return (
    <>
      <button
        className="icon-button reading-close"
        aria-label="Close reading panel"
        onClick={onClose}
      >
        <X size={18} />
      </button>
      <div className="reading-content" key={message.id}>
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
        {message.content && <Markdown content={message.content} />}
        {message.truncated && (
          <p className="truncation-note">
            The output token limit was reached. You can ask a follow-up from
            this answer.
          </p>
        )}
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
        {!assistant && (
          <button disabled={!canEdit} onClick={onEdit}>
            <Pencil size={14} /> Edit prompt
          </button>
        )}
      </div>
    </>
  );
}
