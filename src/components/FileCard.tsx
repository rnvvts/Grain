/**
 * FileCard — one file, its lifecycle, and its result.
 *
 * Presentational only. It never touches the encoder; it renders whatever the
 * job says and hands intent back up through the callbacks.
 *
 * Two details that matter more than they look:
 *  - filenames truncate in the MIDDLE, because the extension is the single
 *    most informative part of an image filename;
 *  - a size *increase* is coloured amber rather than hidden, because
 *    converting a photo to PNG legitimately makes it much bigger and the user
 *    deserves to notice immediately.
 */

import { useId, useState, type ReactNode } from 'react'
import {
  LOSSLESS_FORMATS,
  type ConvertOptions,
  type ImageFormat,
  type Job,
  type JobStatus,
} from '../types'
import { FormatPicker } from './FormatPicker'
import { formatBytes, formatDuration } from '../utils/format'

/** Truncates the stem, never the extension. */
function middleTruncate(name: string, max = 34): string {
  if (name.length <= max) return name
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot) : ''
  const stem = dot > 0 ? name.slice(0, dot) : name
  const budget = Math.max(6, max - ext.length - 1)
  if (stem.length <= budget) return `${stem}${ext}`
  const head = Math.ceil(budget * 0.62)
  const tail = budget - head
  const tailPart = tail > 0 ? stem.slice(stem.length - tail) : ''
  return `${stem.slice(0, head)}…${tailPart}${ext}`
}

/** One legible sentence. Never a stack trace. */
function readableError(raw: string): string {
  const line =
    raw
      .split('\n')
      .map((part) => part.trim())
      .find((part) => part.length > 0 && !part.startsWith('at ')) ?? ''
  const message = line.replace(/^[A-Za-z]*(Error|Exception):\s*/, '').trim()
  if (!message) return 'Conversion failed for an unknown reason.'
  return message.length > 220 ? `${message.slice(0, 219)}…` : message
}

/* ------------------------------------------------------------------ chips */

const STATUS_STYLE: Record<JobStatus, string> = {
  queued: 'border-hairline bg-surface-2/60 text-ink-dim',
  running: 'border-accent/40 bg-accent/15 text-accent',
  done: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300',
  error: 'border-rose-400/30 bg-rose-500/10 text-rose-300',
}

const STATUS_LABEL: Record<JobStatus, string> = {
  queued: 'Queued',
  running: 'Converting',
  done: 'Done',
  error: 'Failed',
}

function IconButton({
  label,
  onClick,
  tone = 'neutral',
  children,
}: {
  label: string
  onClick: () => void
  tone?: 'neutral' | 'accent'
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={[
        'flex h-8 w-8 items-center justify-center rounded-lg border transition-colors duration-150',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        tone === 'accent'
          ? 'border-accent/40 bg-accent/15 text-accent hover:bg-accent/25 hover:text-accent-hi'
          : 'border-hairline bg-surface-2 text-ink-dim hover:border-ink-dim/40 hover:text-ink',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

/* ------------------------------------------------------------------- card */

export interface FileCardProps {
  job: Job
  /** Global options already merged with this job's overrides. */
  effectiveOptions: ConvertOptions
  onRemove: (id: string) => void
  /** Pass null to drop the override and fall back to the global settings. */
  onOverride: (id: string, patch: Partial<ConvertOptions> | null) => void
  onDownload: (id: string) => void
}

export function FileCard({
  job,
  effectiveOptions,
  onRemove,
  onOverride,
  onDownload,
}: FileCardProps) {
  const uid = useId()
  const panelId = `${uid}-override`
  const qualityId = `${uid}-override-quality`
  const [open, setOpen] = useState(false)

  const { file, result, status } = job
  const overridden = job.overrides !== null
  const success = result && result.ok ? result : null
  const failure = result && !result.ok ? result : null

  const inputBytes = success ? success.inputBytes : file.size
  const deltaPct =
    success && success.inputBytes > 0
      ? ((success.outputBytes - success.inputBytes) / success.inputBytes) * 100
      : null
  const smaller = deltaPct !== null && deltaPct < 0

  const dims =
    job.sourceWidth !== null && job.sourceHeight !== null
      ? `${job.sourceWidth} × ${job.sourceHeight}`
      : null

  const lossless = LOSSLESS_FORMATS.includes(effectiveOptions.target)

  const patchOverride = (patch: Partial<ConvertOptions>) => {
    onOverride(job.id, { ...(job.overrides ?? {}), ...patch })
  }

  return (
    <article
      aria-label={file.name}
      className="flex flex-col gap-4 rounded-xl border border-hairline bg-surface/70 p-4 transition-colors duration-150 hover:border-ink-dim/40"
    >
      {/* React 19 hoists and de-duplicates this by href, so N cards ship one copy. */}
      <style href="fc-indeterminate" precedence="medium">{`
        @keyframes fc-indeterminate {
          0%   { transform: translateX(-110%); }
          100% { transform: translateX(360%); }
        }
        .fc-indeterminate {
          animation: fc-indeterminate 1.15s cubic-bezier(.45,.05,.55,.95) infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .fc-indeterminate { animation-duration: 2.6s; }
        }
      `}</style>

      <div className="flex items-start gap-4">
        {/* Thumbnail */}
        <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-hairline bg-[repeating-conic-gradient(#171d28_0_25%,#10141c_0_50%)] bg-[length:12px_12px]">
          <img
            src={job.previewUrl}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-full w-full object-contain"
          />
        </div>

        {/* Identity + status */}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <p
                title={file.name}
                className="truncate text-sm font-medium text-ink"
              >
                {middleTruncate(file.name)}
              </p>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-dim">
                <span className="rounded border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-ink-dim">
                  {job.sourceFormat}
                </span>
                <span aria-hidden="true" className="text-ink-dim/50">
                  →
                </span>
                <span className="rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-accent">
                  {effectiveOptions.target}
                </span>
                {dims ? <span className="tabular-nums">{dims}</span> : null}
                <span className="tabular-nums">{formatBytes(inputBytes)}</span>
                {overridden ? (
                  <span className="rounded border border-amber-400/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300">
                    Custom
                  </span>
                ) : null}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <span
                className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${STATUS_STYLE[status]}`}
              >
                {STATUS_LABEL[status]}
              </span>
              {status === 'done' && success ? (
                <IconButton
                  label={`Download ${success.outName}`}
                  tone="accent"
                  onClick={() => onDownload(job.id)}
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-4 w-4"
                  >
                    <path d="M12 4v11" />
                    <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
                    <path d="M5 19h14" />
                  </svg>
                </IconButton>
              ) : null}
              <IconButton label={`Remove ${file.name}`} onClick={() => onRemove(job.id)}>
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  className="h-4 w-4"
                >
                  <path d="m6 6 12 12" />
                  <path d="m18 6-12 12" />
                </svg>
              </IconButton>
            </div>
          </div>

          {/* Progress / result line */}
          {status === 'running' ? (
            <div
              role="progressbar"
              aria-label={`Converting ${file.name}`}
              className="h-1 w-full overflow-hidden rounded-full bg-surface-2"
            >
              <div className="fc-indeterminate h-full w-1/4 rounded-full bg-accent" />
            </div>
          ) : null}

          {status === 'done' && success ? (
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
              <span className="tabular-nums text-ink-dim">
                {formatBytes(success.inputBytes)}
                <span aria-hidden="true" className="mx-1.5 text-ink-dim/60">
                  →
                </span>
                <span className="font-medium text-ink">
                  {formatBytes(success.outputBytes)}
                </span>
              </span>
              {deltaPct !== null ? (
                <span
                  className={[
                    'rounded-full px-2 py-0.5 font-medium tabular-nums',
                    smaller
                      ? 'bg-emerald-500/10 text-emerald-300'
                      : 'bg-amber-500/10 text-amber-300',
                  ].join(' ')}
                >
                  {smaller ? '−' : '+'}
                  {Math.abs(deltaPct).toFixed(1)}% {smaller ? 'smaller' : 'larger'}
                </span>
              ) : null}
              <span className="tabular-nums text-ink-dim">
                {success.width} × {success.height} · {formatDuration(success.durationMs)}
              </span>
            </div>
          ) : null}

          {status === 'error' && failure ? (
            <p className="rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-xs leading-relaxed text-rose-200">
              {readableError(failure.error)}
            </p>
          ) : null}

          {status === 'error' && !failure ? (
            <p className="rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-xs leading-relaxed text-rose-200">
              Conversion failed for an unknown reason.
            </p>
          ) : null}
        </div>
      </div>

      {/* Per-file override --------------------------------------------- */}
      <div className="border-t border-hairline/80 pt-3">
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-xs font-medium text-ink-dim transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`h-3.5 w-3.5 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
            >
              <path d="m9 6 6 6-6 6" />
            </svg>
            Override settings for this file
          </button>

          {overridden ? (
            <button
              type="button"
              onClick={() => onOverride(job.id, null)}
              className="rounded-lg px-2 py-1 text-xs font-medium text-amber-300 transition-colors hover:bg-amber-500/10 hover:text-amber-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300"
            >
              Use global settings
            </button>
          ) : null}
        </div>

        {open ? (
          <div id={panelId} className="mt-3 flex flex-col gap-4 rounded-lg bg-canvas/50 p-3">
            <div className="flex flex-col gap-2">
              <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-dim">
                Format
              </span>
              <FormatPicker
                value={effectiveOptions.target}
                onChange={(target: ImageFormat) => patchOverride({ target })}
                idPrefix={`${uid}-job`}
                label={`Target format for ${file.name}`}
                size="sm"
              />
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-4">
                <label htmlFor={qualityId} className="text-xs text-ink-dim">
                  Quality
                </label>
                <span
                  className={`text-xs tabular-nums ${lossless ? 'text-ink-dim/60' : 'text-accent'}`}
                >
                  {lossless ? '—' : effectiveOptions.quality}
                </span>
              </div>
              <input
                id={qualityId}
                type="range"
                min={1}
                max={100}
                step={1}
                value={effectiveOptions.quality}
                disabled={lossless}
                className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-surface-2 accent-accent focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40"
                onChange={(event) => patchOverride({ quality: Number(event.target.value) })}
              />
              <p className="text-[11px] leading-relaxed text-ink-dim">
                {lossless
                  ? 'PNG is lossless, so quality does nothing for this file.'
                  : 'Applies to this file only. Everything else follows the global settings.'}
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </article>
  )
}

export default FileCard
