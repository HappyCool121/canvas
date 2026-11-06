import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// A small popover menu under its trigger. It renders in a portal so scrolling
// lists don't clip it, closes on outside clicks and Escape, and moves focus
// with the arrow keys.
export function Popover({ anchor, onClose, label, align = "start", className = "", children }: {
  anchor: HTMLElement | null;
  onClose: () => void;
  label: string;
  align?: "start" | "end";
  className?: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>();
  const close = useRef(onClose); close.current = onClose;
  useLayoutEffect(() => {
    const place = () => {
      const element = panel.current;
      if (!anchor || !element) return;
      const box = anchor.getBoundingClientRect(), own = element.getBoundingClientRect();
      const below = box.bottom + 6, above = box.top - 6 - own.height;
      const top = below + own.height > innerHeight - 8 && above > 8 ? above : Math.min(below, innerHeight - own.height - 8);
      const left = align === "end" ? box.right - own.width : box.left;
      setPosition({ top: Math.max(8, top), left: Math.max(8, Math.min(left, innerWidth - own.width - 8)) });
    };
    place();
    const observer = new ResizeObserver(place);
    if (panel.current) observer.observe(panel.current);
    addEventListener("resize", place);
    addEventListener("scroll", place, true);
    return () => { observer.disconnect(); removeEventListener("resize", place); removeEventListener("scroll", place, true); };
  }, [anchor, align]);
  useEffect(() => {
    const items = () => [...(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled), input') ?? [])];
    if (!panel.current?.contains(document.activeElement)) items()[0]?.focus({ preventScroll: true });
    const pointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !anchor?.contains(target)) close.current();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation();
        close.current(); anchor?.focus({ preventScroll: true });
        return;
      }
      if (!panel.current?.contains(document.activeElement) || !["ArrowDown", "ArrowUp"].includes(event.key)) return;
      if ((document.activeElement as HTMLElement).tagName === "INPUT") return;
      event.preventDefault();
      const list = items(), index = list.indexOf(document.activeElement as HTMLElement);
      list[(index + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
    };
    document.addEventListener("pointerdown", pointer, true);
    addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", pointer, true); removeEventListener("keydown", key, true); };
  }, [anchor]);
  return createPortal(
    <div ref={panel} role="menu" aria-label={label} className={`popover-menu ${className}`}
      style={position ? { top: position.top, left: position.left } : { visibility: "hidden" }}
      onClick={event => event.stopPropagation()}>
      {children}
    </div>,
    document.body,
  );
}

export function MenuItem({ icon, children, onSelect, disabled, danger, hint, trailing }: {
  icon?: ReactNode;
  children: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  hint?: string;
  trailing?: ReactNode;
}) {
  return (
    <button type="button" role="menuitem" className={`menu-item ${danger ? "danger" : ""}`} disabled={disabled} onClick={onSelect}>
      {icon}
      <span className="menu-label">{children}{hint && <small>{hint}</small>}</span>
      {trailing}
    </button>
  );
}

// A button that toggles its popover menu.
export function useMenu() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return {
    open: !!anchor,
    anchor,
    toggle: (event: { currentTarget: HTMLElement }) => {
      const target = event.currentTarget;
      setAnchor(current => current ? null : target);
    },
    close: () => setAnchor(null),
  };
}
