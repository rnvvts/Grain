/**
 * Stat — a small labelled value for the summary row.
 *
 * Purely presentational: it formats nothing and computes nothing, it just
 * renders the strings it is handed with a real typographic hierarchy.
 * Numbers are rendered with tabular figures so a row of stats does not
 * jitter as values update during a batch.
 */

export interface StatProps {
  /** Short caption, e.g. "Files" or "Total saved". */
  label: string
  /** Already-formatted value, e.g. "12" or "4.1 MB". */
  value: string
  /** Optional secondary line, e.g. "of 18.2 MB in". */
  hint?: string
}

export function Stat({ label, value, hint }: StatProps) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-hairline bg-surface/70 px-4 py-3">
      <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-dim">
        {label}
      </span>
      <span className="truncate text-2xl font-semibold tabular-nums tracking-tight text-ink">
        {value}
      </span>
      {hint ? (
        <span className="truncate text-xs tabular-nums text-ink-dim">{hint}</span>
      ) : null}
    </div>
  )
}

export default Stat
