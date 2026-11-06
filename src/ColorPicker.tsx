import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Pipette, Plus } from "lucide-react";

// Custom bubble colors: a Grid of presets and a Wheel (hue ring around a
// saturation/brightness square), with the account's saved palette below.
// Dragging previews on the bubble; a color is saved once, when picked.

type Hsv = { h: number; s: number; v: number };
const clamp = (n: number, min = 0, max = 1) => Math.min(max, Math.max(min, n));
const hex2 = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, "0");
export function hsvToHex({ h, s, v }: Hsv) {
  const f = (n: number) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return `#${hex2(f(5) * 255)}${hex2(f(3) * 255)}${hex2(f(1) * 255)}`;
}
export function hexToHsv(hex: string): Hsv {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  const h = d === 0 ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: max === 0 ? 0 : d / max, v: max };
}
function hslToHex(h: number, s: number, l: number) {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return `#${hex2(f(0) * 255)}${hex2(f(8) * 255)}${hex2(f(4) * 255)}`;
}
// Relative luminance, to keep text readable on dark custom colors.
export function isDark(hex: string) {
  const [r, g, b] = [1, 3, 5].map(i => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.22;
}

// 12 columns: a greyscale row from white to black, then nine rows from deep to pale.
const HUES = [195, 215, 248, 280, 330, 0, 14, 30, 42, 54, 66, 100];
const SHADES: [number, number][] = [[100, 16], [100, 23], [100, 31], [100, 40], [100, 50], [100, 60], [100, 70], [100, 80], [90, 90]];
export const GRID = [
  Array.from({ length: 12 }, (_, i) => hslToHex(0, 0, Math.round(100 - (100 * i) / 11))),
  ...SHADES.map(([s, l]) => HUES.map(h => hslToHex(h, s, l))),
];

// Tabs stay where the person left them for the rest of the visit.
let lastTab: "grid" | "wheel" = "grid";

export function ColorPicker({ value, saved, onPreview, onPick, onSave }: {
  value?: string;
  saved: string[];
  onPreview: (hex: string | undefined) => void;
  onPick: (hex: string) => void;
  onSave: (hex: string) => void;
}) {
  const [tab, setTab] = useState(lastTab);
  const [hsv, setHsv] = useState<Hsv>(() => value ? hexToHsv(value) : { h: 210, s: 0.3, v: 0.95 });
  // A color picked as hex stays exact; converting through HSV can round it.
  const [exact, setExact] = useState(value?.toLowerCase());
  const current = exact ?? hsvToHex(hsv);
  const [hex, setHex] = useState(current);
  useEffect(() => setHex(current), [current]);
  // The picker follows colors chosen elsewhere (presets, other collaborators).
  useEffect(() => { if (value && value.toLowerCase() !== current) { setHsv(hexToHsv(value)); setExact(value.toLowerCase()); } }, [value]);
  useEffect(() => () => onPreview(undefined), []);
  // Saves only real changes, so leaving the hex field or a handle never resaves.
  const commit = (next: string) => { if (next.toLowerCase() !== value?.toLowerCase()) onPick(next.toLowerCase()); };
  const pick = (next: string) => { setHsv(hexToHsv(next)); setExact(next.toLowerCase()); commit(next); };
  const choose = (next: "grid" | "wheel") => { lastTab = next; setTab(next); };
  const picker = typeof window !== "undefined" && "EyeDropper" in window
    ? (window as unknown as { EyeDropper: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper : undefined;
  return (
    <div className="color-picker nodrag nopan nowheel" role="dialog" aria-label="Custom bubble color">
      <header>Color</header>
      {tab === "grid" ? (
        <div className="color-grid" role="grid" aria-label="Color grid">
          {GRID.map((row, r) => (
            <div key={r} role="row">
              {row.map(color => (
                <button key={color + r} role="gridcell" aria-label={color} aria-selected={color === value?.toLowerCase()}
                  style={{ background: color }} onClick={() => pick(color)} />
              ))}
            </div>
          ))}
        </div>
      ) : (
        <Wheel hsv={hsv} onChange={next => { setHsv(next); setExact(undefined); onPreview(hsvToHex(next)); }} onCommit={next => commit(hsvToHex(next))}
          eyedropper={picker && (async () => { try { pick((await new picker().open()).sRGBHex); } catch { /* cancelled */ } })}
          hex={hex} onHex={setHex} onHexCommit={() => {
            const next = hex.trim().replace(/^#?/, "#").toLowerCase();
            if (/^#[0-9a-f]{6}$/.test(next)) pick(next); else setHex(current);
          }} />
      )}
      <div className="color-palette">
        <span>Palette</span>
        <div>
          {saved.map(color => (
            <button key={color} className="palette-swatch" aria-label={`Saved color ${color}`} aria-pressed={color === value?.toLowerCase()}
              style={{ background: color }} onClick={() => pick(color)} />
          ))}
          <button className="palette-add" aria-label="Save this color to the palette" title="Save this color"
            onClick={() => onSave(value ?? current)}><Plus size={16} /></button>
        </div>
      </div>
      <div className="color-tabs" role="tablist" aria-label="Color picker mode">
        {(["grid", "wheel"] as const).map(name => (
          <button key={name} role="tab" aria-selected={tab === name} onClick={() => choose(name)}>{name === "grid" ? "Grid" : "Wheel"}</button>
        ))}
      </div>
    </div>
  );
}

const SIZE = 216, RING = 24, SQUARE = 104;
function Wheel({ hsv, onChange, onCommit, eyedropper, hex, onHex, onHexCommit }: {
  hsv: Hsv;
  onChange: (hsv: Hsv) => void;
  onCommit: (hsv: Hsv) => void;
  eyedropper?: () => void;
  hex: string;
  onHex: (hex: string) => void;
  onHexCommit: () => void;
}) {
  const area = useRef<HTMLDivElement>(null);
  const drag = useRef<"ring" | "square" | null>(null);
  const latest = useRef(hsv); latest.current = hsv;
  // Hue runs clockwise from chartreuse at the top: red right, violet bottom, cyan left.
  const angle = (90 - hsv.h + 360) % 360;
  const radius = SIZE / 2 - RING / 2;
  const ringHandle = { left: SIZE / 2 + radius * Math.sin(angle * Math.PI / 180), top: SIZE / 2 - radius * Math.cos(angle * Math.PI / 180) };
  const update = (event: PointerEvent, mode = drag.current) => {
    const box = area.current!.getBoundingClientRect();
    const x = event.clientX - box.left - SIZE / 2, y = event.clientY - box.top - SIZE / 2;
    let next = latest.current;
    if (mode === "ring") {
      const a = (Math.atan2(x, -y) * 180 / Math.PI + 360) % 360;
      next = { ...next, h: (90 - a + 360) % 360 };
    } else if (mode === "square") {
      next = { ...next, s: clamp((x + SQUARE / 2) / SQUARE), v: clamp(1 - (y + SQUARE / 2) / SQUARE) };
    }
    latest.current = next;
    onChange(next);
  };
  const key = (mode: "ring" | "square") => (event: KeyboardEvent) => {
    const step = event.shiftKey ? 10 : 1;
    const dx = event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0;
    const dy = event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0;
    if (!dx && !dy) return;
    event.preventDefault(); event.stopPropagation();
    const next = mode === "ring" ? { ...hsv, h: (hsv.h + dx + dy + 360) % 360 }
      : { ...hsv, s: clamp(hsv.s + dx / 100), v: clamp(hsv.v + dy / 100) };
    onChange(next);
  };
  const stops = Array.from({ length: 13 }, (_, i) => `hsl(${(90 - i * 30 + 360) % 360} 100% 50%) ${i * 30}deg`).join(", ");
  return (
    <div className="color-wheel">
      {eyedropper && <button className="eyedropper" aria-label="Pick a color from the screen" title="Pick from screen" onClick={eyedropper}><Pipette size={18} /></button>}
      <div ref={area} className="wheel-area" style={{ width: SIZE, height: SIZE }}
        onPointerDown={event => {
          const box = area.current!.getBoundingClientRect();
          const x = event.clientX - box.left - SIZE / 2, y = event.clientY - box.top - SIZE / 2;
          const distance = Math.hypot(x, y);
          const mode = Math.abs(x) <= SQUARE / 2 && Math.abs(y) <= SQUARE / 2 ? "square" : distance >= SIZE / 2 - RING - 4 && distance <= SIZE / 2 + 2 ? "ring" : null;
          if (!mode) return;
          drag.current = mode;
          event.currentTarget.setPointerCapture(event.pointerId);
          update(event, mode);
        }}
        onPointerMove={event => { if (drag.current) update(event); }}
        onPointerUp={() => { if (drag.current) { drag.current = null; onCommit(latest.current); } }}
        onPointerCancel={() => { drag.current = null; }}>
        <div className="wheel-ring" style={{ background: `conic-gradient(${stops})`, maskImage: `radial-gradient(circle, transparent ${SIZE / 2 - RING - 0.5}px, #000 ${SIZE / 2 - RING}px)`, WebkitMaskImage: `radial-gradient(circle, transparent ${SIZE / 2 - RING - 0.5}px, #000 ${SIZE / 2 - RING}px)` }} />
        <div className="wheel-square" style={{ width: SQUARE, height: SQUARE, left: (SIZE - SQUARE) / 2, top: (SIZE - SQUARE) / 2, background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))` }} />
        <span className="wheel-handle" role="slider" tabIndex={0} aria-label="Hue" aria-valuemin={0} aria-valuemax={359} aria-valuenow={Math.round(hsv.h)}
          style={{ left: ringHandle.left, top: ringHandle.top, background: `hsl(${hsv.h} 100% 50%)` }}
          onKeyDown={key("ring")} onKeyUp={event => { if (event.key.startsWith("Arrow")) onCommit(hsv); }} />
        <span className="wheel-handle" role="slider" tabIndex={0} aria-label="Saturation and brightness" aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={Math.round(hsv.v * 100)} aria-valuetext={`Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
          style={{ left: (SIZE - SQUARE) / 2 + hsv.s * SQUARE, top: (SIZE - SQUARE) / 2 + (1 - hsv.v) * SQUARE, background: hsvToHex(hsv) }}
          onKeyDown={key("square")} onKeyUp={event => { if (event.key.startsWith("Arrow")) onCommit(hsv); }} />
      </div>
      <input className="hex-input" aria-label="Hex color" value={hex} maxLength={7} spellCheck={false}
        onChange={event => onHex(event.target.value)} onBlur={onHexCommit}
        onKeyDown={event => { event.stopPropagation(); if (event.key === "Enter") { event.preventDefault(); onHexCommit(); } }} />
    </div>
  );
}
