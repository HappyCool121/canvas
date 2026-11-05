import { useLayoutEffect, useRef, useState } from "react";

export function formatTokens(tokens: number) {
  const short = (value: number, unit: string) =>
    `${value.toFixed(value < 10 ? 1 : 0).replace(/\.0$/, "")}${unit}`;
  if (tokens >= 1_000_000) return short(tokens / 1_000_000, "M");
  if (tokens >= 1_000) return short(tokens / 1_000, "K");
  return String(tokens);
}

// Context sent with the next prompt from the selected bubble.
export function ContextMeter({
  tokens,
  limit,
  request,
}: {
  tokens: number | null;
  limit: number;
  request?: number;
}) {
  const previousRequest = useRef(request);
  const [turns, setTurns] = useState(0);
  useLayoutEffect(() => {
    if (request === previousRequest.current) return;
    previousRequest.current = request;
    if (request !== undefined) setTurns((count) => count + 1);
  }, [request]);
  const share = tokens ? Math.min(1, tokens / limit) : 0;
  return (
    <div
      className={`context-meter ${tokens === null ? "idle" : ""}`}
      role="meter"
      aria-label="Context used"
      aria-valuemin={0}
      aria-valuemax={limit}
      aria-valuenow={tokens ?? 0}
      title="Tokens in the selected branch. Exact where DeepSeek reported usage, estimated otherwise."
    >
      <span className="meter-capsule" aria-hidden="true">
        <span className="meter-shell" style={{ transform: `rotate(${turns * 180}deg)` }} />
        <span className="meter-liquid" key={turns}>
          <span
            className="meter-fill"
            style={{ height: share ? `max(4px, ${share * 100}%)` : 0 }}
          />
          {turns > 0 && (
            <span
              key={turns}
              className="meter-slosh"
              style={{ height: `max(8px, ${share * 100}%)` }}
            />
          )}
        </span>
        <span className="meter-ticks">
          {[10, 20, 30, 40, 50, 60, 70, 80, 90].map((percent) => <i key={percent} style={{ bottom: `${percent}%` }} />)}
        </span>
      </span>
      <small>
        {tokens === null
          ? "—"
          : `${formatTokens(tokens)} / ${formatTokens(limit)}`}
      </small>
    </div>
  );
}
