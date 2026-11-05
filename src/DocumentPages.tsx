import { useEffect, useRef, useState } from "react";
function parsePages(input: string, total: number, slots: number) {
  const pages = new Set<number>();
  for (const part of input.split(",")) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    const first = Number(match?.[1]);
    const last = Number(match?.[2] ?? match?.[1]);
    if (!match || first < 1 || last < first || last > total)
      throw new Error(`Enter pages from 1 to ${total}, using commas and ranges such as 1, 3-5.`);
    for (let page = first; page <= last; page++) {
      pages.add(page);
      if (pages.size > slots)
        throw new Error(`Select at most ${slots} pages or remove other attachments to free slots.`);
    }
  }
  return [...pages].sort((a, b) => a - b);
}

export type PageSelection = {
  name: string;
  kind: "pdf" | "docx";
  total: number;
  slots: number;
  choose: (pages: number[]) => void;
};

export function DocumentPages({ selection, cancel }: { selection: PageSelection; cancel: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  useEffect(() => dialog.current?.showModal(), []);
  const { name, kind, total, slots } = selection;
  return (
    <dialog ref={dialog} className="pdf-dialog" aria-labelledby="pdf-heading" onCancel={(e) => {
      e.preventDefault();
      cancel();
    }}>
      <form onSubmit={(e) => {
        e.preventDefault();
        try {
          selection.choose(parsePages(input, total, slots));
        } catch (error) {
          setError((error as Error).message);
        }
      }}>
        <h2 id="pdf-heading">{kind === "pdf" ? "Choose PDF pages" : "Rendered pages"}</h2>
        {kind === "docx" && <p>Page breaks can differ from Word.</p>}
        <p>{name} · {total} pages</p>
        <p>{slots} image {slots === 1 ? "slot" : "slots"} remaining.</p>
        <label>
          Page numbers and ranges
          <input autoFocus value={input} placeholder="1, 3-5" onChange={(e) => {
            setInput(e.target.value);
            setError("");
          }} />
        </label>
        {error && <p role="alert">{error}</p>}
        <div className="pdf-dialog-actions">
          <button type="button" onClick={cancel}>Cancel</button>
          <button className="primary" type="submit">Attach pages</button>
        </div>
      </form>
    </dialog>
  );
}
