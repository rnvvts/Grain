/**
 * FileCard — one file, its lifecycle, and its result.
 *
 * Presentational only. It never touches the encoder; it renders whatever the
 * job says and hands intent back up through the callbacks.
 *
 * Three details that matter more than they look:
 *  - filenames truncate in the MIDDLE, because the extension is the single
 *    most informative part of an image filename;
 *  - folder paths truncate on the LEFT, because the deepest folder is the one
 *    that tells two identically-named files apart in a 300-file tree;
 *  - a size *increase* is coloured amber rather than hidden, because
 *    converting a photo to PNG legitimately makes it much bigger and the user
 *    deserves to notice immediately.
 *
 * Every accessible name here is built from the file's PATH, not its basename.
 * In a folder tree, duplicated basenames are the normal case — `icons/light/
 * logo.png` and `icons/dark/logo.png` — and naming both buttons "Remove
 * logo.png" leaves a screen-reader user with an undifferentiated list.
 *
 * The component is memoised. A folder ingest commits thousands of times as
 * dimensions and results stream in, and without memo every one of those
 * commits re-renders every card in the list.
 */

import { memo, useId, useMemo, useState, type ReactNode } from 'react'
import {
  LOSSLESS_FORMATS,
  SOURCE_LABEL,
  isSourceOnly,
  type ConvertOptions,
  type ImageFormat,
  type Job,
  type JobStatus,
} from '../types'
import { FormatPicker } from './FormatPicker'
import { formatBytes, formatDuration } from '../utils/format'
import { dirnameOf, sanitizeRelativePath } from '../utils/path'
import { losslessNote } from '../utils/lossless'
import { mergeOptions, outputPathOf } from '../state/useConverter'

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

/**
 * What a running job says while it is stalled on the HEIC decoder download.
 *
 * The chip is the only thing most people look at, and "Converting" on a card
 * that will not move for the length of a 1.4 MB fetch — half a minute on a slow
 * connection — reads as a hang. Naming the fetch is the difference between "it
 * is broken" and "it is downloading something, once".
 */
const FETCHING_DECODER_LABEL = 'Fetching decoder'

/** Decorative affordance for the folder line. Purely presentational. */
function FolderIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5 shrink-0 text-ink-dim/60"
    >
      <path d="M20 19a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-7.6a2 2 0 0 1-1.6-.8L9.7 4.8A2 2 0 0 0 8.1 4H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2Z" />
    </svg>
  )
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
  /**
   * The GLOBAL options, not this job's merged ones.
   *
   * Merging happens inside, memoised per card, precisely so this prop keeps a
   * stable identity across commits: a freshly merged object handed down from
   * the parent would defeat the memo on every render and reintroduce the
   * O(n) merge-the-whole-list cost the parent used to pay per commit.
   */
  options: ConvertOptions
  /**
   * True while this job is waiting on the one-off HEIC decoder download rather
   * than on any pixel work. A plain boolean on purpose: it keeps the memo
   * effective (only the one card that is actually fetching re-renders) and
   * keeps the frozen `Job` shape untouched.
   */
  fetchingDecoder?: boolean
  onRemove: (id: string) => void
  /** Pass null to drop the override and fall back to the global settings. */
  onOverride: (id: string, patch: Partial<ConvertOptions> | null) => void
  onDownload: (id: string) => void
}

export const FileCard = memo(function FileCard({
  job,
  options,
  fetchingDecoder = false,
  onRemove,
  onOverride,
  onDownload,
}: FileCardProps) {
  const uid = useId()
  const panelId = `${uid}-override`
  const qualityId = `${uid}-override-quality`
  const [open, setOpen] = useState(false)

  /**
   * True once the browser has told us it cannot paint this file's preview.
   *
   * HEIC is why this exists. The thumbnail is an `<img>` pointed at an object
   * URL for the original file, which works for every format the *browser* can
   * decode — and Chrome, Edge and Firefox decode no HEIC at all. (Grain still
   * converts it: the actual decode is libheif in a worker, which has nothing to
   * do with what `<img>` can display.) Left alone, every iPhone photo on those
   * browsers renders the broken-image glyph, which reads as "this file is
   * damaged" for a file that is about to convert perfectly well.
   *
   * Driven by the `error` event rather than by `isSourceOnly(job.sourceFormat)`,
   * because the question is what THIS browser can paint, not what format the
   * file is: Safari shows HEIC thumbnails fine and should keep them, and a
   * truncated PNG gets the same graceful treatment for free.
   */
  const [previewFailed, setPreviewFailed] = useState(false)

  const effectiveOptions = useMemo(
    () => mergeOptions(options, job.overrides),
    [options, job.overrides],
  )

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

  /**
   * Where this file sat in the folder the user dropped. '' for a loose
   * root-level file, in which case the whole line is omitted rather than
   * rendered empty — an empty element still costs a line of vertical rhythm.
   * Both strings come from the same splitPath pass, so the tooltip can never
   * disagree with the visible folder (e.g. backslashes in one, slashes in the
   * other).
   */
  const folder = dirnameOf(job.relativePath)
  const fullPath = sanitizeRelativePath(job.relativePath)

  const lossless = LOSSLESS_FORMATS.includes(effectiveOptions.target)

  /**
   * True for a format we can read but can never write — HEIC today, since its
   * HEVC payload has no shippable encoder. It earns a tooltip and nothing more.
   * A file that goes in as HEIC and comes out as WebP has done exactly what it
   * was supposed to do, so there is no warning colour and no icon here.
   */
  const sourceOnly = isSourceOnly(job.sourceFormat)

  /**
   * Running, but not on this file yet: the worker is still downloading libheif.
   * Guarded on `status` so a stale flag can never outlive the run it describes.
   */
  const waitingOnDecoder = status === 'running' && fetchingDecoder

  const patchOverride = (patch: Partial<ConvertOptions>) => {
    onOverride(job.id, { ...(job.overrides ?? {}), ...patch })
  }

  return (
    <article
      aria-label={fullPath}
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

      {/*
        Left-truncation for folder paths. A path's informative end is its tail
        (deep/nested/Iceland), so the ellipsis has to eat the *start*.
        direction:rtl puts the line's end edge — and with it the ellipsis — on
        the left. There is deliberately no text-align here: the span is a
        content-sized flex item, so its box never has spare room for alignment
        to act on, and the one property whose interaction with overflow differs
        between engines stays out of the picture.

        The inner <bdi> is load-bearing, not decoration. Under an rtl paragraph
        the neutral characters at a string's edges take the paragraph direction,
        so a folder named "Trip (2024)" would render as ")Trip (2024". Isolating
        the path in its own ltr paragraph keeps every character exactly where
        the user put it while the outer box keeps clipping from the left.
        direction is set explicitly rather than left to <bdi>'s dir=auto so a
        folder named in Hebrew or Arabic still reads root → leaf; only that
        segment's own glyphs run rtl, which is correct.

        Whatever bidi does, overflow:hidden is what guarantees a seven-level
        path cannot widen the card at 375px.
      */}
      <style href="fc-path" precedence="medium">{`
        .fc-path {
          direction: rtl;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .fc-path > bdi {
          direction: ltr;
          unicode-bidi: isolate;
        }
      `}</style>

      <div className="flex items-start gap-4">
        {/* Thumbnail */}
        <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-hairline bg-[repeating-conic-gradient(#171d28_0_25%,#10141c_0_50%)] bg-[length:12px_12px]">
          {previewFailed ? (
            // The format name, centred on the same checkerboard the real
            // thumbnail sits on. It says "this is a HEIC and we know it" where
            // the broken-image glyph said "this file is unreadable".
            <span
              title={`${SOURCE_LABEL[job.sourceFormat]} — this browser can't display a preview, but the file still converts`}
              className="flex h-full w-full items-center justify-center font-mono text-[10px] uppercase tracking-wide text-ink-dim"
            >
              {SOURCE_LABEL[job.sourceFormat]}
            </span>
          ) : (
            <img
              src={job.previewUrl}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setPreviewFailed(true)}
              className="h-full w-full object-contain"
            />
          )}
        </div>

        {/* Identity + status */}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {/*
            Below `sm` the status chip and the icon buttons drop onto their own
            row. Side by side they took 56% of a 375px card's identity column,
            squeezing the filename to 88px — narrow enough that the CSS
            truncation clipped off the very extension `middleTruncate` exists
            to protect.
          */}
          <div className="flex min-w-0 flex-col items-start justify-between gap-2 sm:flex-row sm:gap-3">
            <div className="w-full min-w-0">
              {folder ? (
                <p
                  title={fullPath}
                  className="mb-1 flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-ink-dim/80"
                >
                  <FolderIcon />
                  <span className="fc-path min-w-0">
                    <bdi>{folder}</bdi>
                  </span>
                </p>
              ) : null}
              <p
                title={file.name}
                className="truncate text-sm font-medium text-ink"
              >
                {middleTruncate(file.name)}
              </p>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-dim">
                {/*
                  SOURCE_LABEL, not a Record<ImageFormat, …>: `sourceFormat` is
                  a SourceFormat, which includes formats that have no output
                  representation at all, so an ImageFormat-keyed table would not
                  even type-check here. Rendering the raw union member happened
                  to look right only because of the `uppercase` class.
                */}
                <span
                  title={
                    sourceOnly
                      ? `${SOURCE_LABEL[job.sourceFormat]} input — read only, converted to the format you picked`
                      : undefined
                  }
                  className="rounded border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-ink-dim"
                >
                  {SOURCE_LABEL[job.sourceFormat]}
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

            <div className="flex shrink-0 items-center gap-2 sm:w-auto">
              <span
                className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${STATUS_STYLE[status]}`}
              >
                {waitingOnDecoder ? FETCHING_DECODER_LABEL : STATUS_LABEL[status]}
              </span>
              {status === 'done' && success ? (
                /* Named from `outputPathOf`, the same source of truth the
                   download itself uses. `success.outName` is the engine's
                   *normalised* name and disagrees with the bytes that get
                   saved — it would announce "Download leading.webp" for a file
                   that lands as " leading.webp". */
                <IconButton
                  label={`Download ${outputPathOf(job, success)}`}
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
              <IconButton label={`Remove ${fullPath}`} onClick={() => onRemove(job.id)}>
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
            <div className="flex flex-col gap-1.5">
              <div
                role="progressbar"
                aria-label={
                  waitingOnDecoder
                    ? `Downloading the HEIC decoder before converting ${fullPath}`
                    : `Converting ${fullPath}`
                }
                className="h-1 w-full overflow-hidden rounded-full bg-surface-2"
              >
                <div className="fc-indeterminate h-full w-1/4 rounded-full bg-accent" />
              </div>
              {/*
                Only ever shown for the first HEIC of a run, and only while the
                fetch is actually outstanding. The size is named because that is
                the number that explains the wait, and "once" because the second
                HEIC will not wait at all.
              */}
              {waitingOnDecoder ? (
                <p className="text-[11px] leading-relaxed text-ink-dim">
                  Downloading the HEIC decoder — 1.4 MB, fetched once. Converting starts as
                  soon as it lands.
                </p>
              ) : null}
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

        {/*
          Always rendered, so `aria-controls` above always resolves — mounting
          the panel only when open left every collapsed card (their default
          state) pointing at an element that does not exist. The Tailwind
          `hidden` class, not just the attribute: `display:flex` from the open
          class list would out-rank the UA rule for `[hidden]`.
        */}
        <div
          id={panelId}
          hidden={!open}
          className={
            open ? 'mt-3 flex flex-col gap-4 rounded-lg bg-canvas/50 p-3' : 'hidden'
          }
        >
          {/* The controls themselves stay conditional: N collapsed cards should
              not each mount a FormatPicker they are not showing. */}
          {open ? (
            <>
              <div className="flex flex-col gap-2">
                <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-dim">
                  Format
                </span>
                <FormatPicker
                  value={effectiveOptions.target}
                  onChange={(target: ImageFormat) => patchOverride({ target })}
                  idPrefix={`${uid}-job`}
                  label={`Target format for ${fullPath}`}
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
                    ? losslessNote(effectiveOptions.target)
                    : 'Applies to this file only. Everything else follows the global settings.'}
                </p>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </article>
  )
})

export default FileCard
