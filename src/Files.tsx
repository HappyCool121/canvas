import { useContext, useEffect, useState } from "react";
import { FileCode2, X } from "lucide-react";
import type { TextFileRef } from "../shared/types";
import { ImageLoaderContext } from "./images";

const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const lines = (file: TextFileRef) => `${file.lines.toLocaleString()} ${file.lines === 1 ? "line" : "lines"}`;

// Attached code and text files as compact chips; removable in the composer.
export function FileChips({ files, limit, onRemove, disabled }: {
  files: TextFileRef[];
  limit?: number;
  onRemove?: (id: string) => void;
  disabled?: boolean;
}) {
  const shown = limit ? files.slice(0, limit) : files;
  return (
    <div className="file-chips">
      {shown.map((file) => (
        <span className="file-chip" key={file.id} title={`${file.name} · ${lines(file)} · ${size(file.bytes)}`}>
          <FileCode2 size={13} />
          <span className="file-name">{file.name}</span>
          <small>{lines(file)}</small>
          {onRemove && (
            <button type="button" aria-label={`Remove ${file.name}`} disabled={disabled} onClick={() => onRemove(file.id)}>
              <X size={11} />
            </button>
          )}
        </span>
      ))}
      {files.length > shown.length && <span className="file-chip more">+{files.length - shown.length} more</span>}
    </div>
  );
}

function FileText({ file }: { file: TextFileRef }) {
  const load = useContext(ImageLoaderContext);
  const [text, setText] = useState<string>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let live = true;
    void load(file.id)
      .then((url) => (url ? fetch(url).then((response) => response.text()) : Promise.reject()))
      .then((value) => { if (live) setText(value); }, () => { if (live) setError(true); });
    return () => { live = false; };
  }, [file.id, load]);
  if (error) return <p className="file-missing">This file is missing from local storage.</p>;
  return text === undefined ? <p className="file-loading">Loading…</p> : <pre className="file-text"><code>{text}</code></pre>;
}

// The reader's view of each file, opened on demand.
export function FileViews({ files }: { files: TextFileRef[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  return (
    <div className="file-views">
      {files.map((file) => (
        <details key={file.id} className="file-view" onToggle={(event) => {
          const opened = (event.currentTarget as HTMLDetailsElement).open;
          setOpen((current) => { const next = new Set(current); if (opened) next.add(file.id); else next.delete(file.id); return next; });
        }}>
          <summary>
            <FileCode2 size={14} />
            <span className="file-name">{file.name}</span>
            <small>{lines(file)} · {size(file.bytes)}</small>
          </summary>
          {open.has(file.id) && <FileText file={file} />}
        </details>
      ))}
    </div>
  );
}
