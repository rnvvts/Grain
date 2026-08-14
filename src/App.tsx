import { Dropzone } from './components/Dropzone'
import { FileCard } from './components/FileCard'
import { OptionsPanel } from './components/OptionsPanel'
import { Stat } from './components/Stat'
import { useConverter, type Notice, type NoticeTone } from './state/useConverter'
import { isSourceOnly } from './types'
import { formatBytes, formatPercent, formatSignedBytes } from './utils/format'

/* ---- shared class strings ------------------------------------------ */

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium ' +
  'transition-colors disabled:cursor-not-allowed disabled:opacity-40'

const PRIMARY = `${BUTTON_BASE} bg-accent text-accent-ink hover:bg-accent-hi`
const SECONDARY = `${BUTTON_BASE} border border-hairline bg-surface-2 text-ink hover:border-ink-dim`
const QUIET = `${BUTTON_BASE} text-ink-dim hover:text-ink`

/* ---- skipped-file report -------------------------------------------- */

/** How many skipped files are worth naming before the list becomes noise. */
const NOTICES_SHOWN = 6

const NOTICE_STYLE: Record<NoticeTone, { box: string; title: string; body: string; dismiss: string }> = {
  warn: {
    box: 'border-amber-500/30 bg-amber-500/10',
    title: 'text-amber-200',
    body: 'text-amber-100/70',
    dismiss: 'text-amber-200/80 hover:text-amber-100',
  },
  // Re-adding files you already queued is an ordinary, harmless thing to do.
  // Reported in the page's neutral surface colours, not the warning amber.
  info: {
    box: 'border-hairline bg-surface',
    title: 'text-ink',
    body: 'text-ink-dim',
    dismiss: 'text-ink-dim hover:text-ink',
  },
}

function NoticeBlock({
  tone,
  title,
  notices,
  onDismiss,
}: {
  tone: NoticeTone
  title: string
  notices: Notice[]
  onDismiss: (tone: NoticeTone) => void
}) {
  const style = NOTICE_STYLE[tone]
  // Every neutral notice shares one reason, and the heading already says it —
  // repeating it on all six rows is noise.
  const showReason = new Set(notices.map((notice) => notice.reason)).size > 1
  return (
    <div className={`mt-4 rounded-lg border px-4 py-3 text-sm ${style.box}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={`font-medium ${style.title}`}>{title}</p>
          <ul className={`mt-1.5 space-y-0.5 ${style.body}`}>
            {notices.slice(0, NOTICES_SHOWN).map((notice, index) => (
              <li key={`${notice.name}-${index}`} className="truncate">
                <span className="font-medium">{notice.name}</span>
                {showReason ? ` — ${notice.reason}` : ''}
              </li>
            ))}
            {notices.length > NOTICES_SHOWN && (
              <li>and {notices.length - NOTICES_SHOWN} more</li>
            )}
          </ul>
        </div>
        <button
          type="button"
          onClick={() => onDismiss(tone)}
          className={`shrink-0 rounded px-2 py-1 text-xs ${style.dismiss}`}
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}

/* ---- page ----------------------------------------------------------- */

export default function App() {
  const {
    jobs,
    options,
    summary,
    isConverting,
    isZipping,
    notices,
    rootFolder,
    decoderFetchIds,
    addFiles,
    updateOptions,
    setOverride,
    convertAll,
    cancelAll,
    downloadOne,
    downloadAllZip,
    removeJob,
    clearAll,
    dismissNotices,
  } = useConverter()

  /*
   * Each card merges the global options with its own overrides internally, and
   * is memoised on them. Doing it here instead — one Map of N merged option
   * objects per render — cost O(N) on every one of the thousands of commits a
   * folder ingest produces, and handed each card a fresh object that defeated
   * memoisation anyway.
   *
   * `rootFolder` comes from the hook for the same reason: it is only
   * recomputed when the list's membership changes.
   */

  const warnings = notices.filter((notice) => notice.tone === 'warn')
  const duplicates = notices.filter((notice) => notice.tone === 'info')

  /*
   * Derived here rather than asked of the hook: every job already carries its
   * own source format, so the one-line HEIC explanation needs no new API. The
   * scan short-circuits on the first match and is a rounding error beside
   * rendering the cards it sits next to.
   */
  const hasSourceOnlyInput = jobs.some((job) => isSourceOnly(job.sourceFormat))

  const settled = summary.done + summary.error
  const progress = summary.total > 0 ? (settled / summary.total) * 100 : 0

  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <div className="mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6">
        {/* ---------------- header ---------------- */}
        <header className="pt-10 pb-8 sm:pt-14">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Grain</h1>
            <p className="text-sm text-ink-dim">image format converter</p>
          </div>

          <p className="mt-3 max-w-2xl text-base text-ink-dim sm:text-lg">
            Convert between PNG, JPEG, WebP, AVIF and SVG, and read the HEIC photos an
            iPhone shoots — resize, re-quantise and batch a whole folder at once.
          </p>

          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-dim">
            Folders are handled whole: drop one and every image inside it is converted, however
            deep the nesting. The ZIP comes back with the same folders and the same filenames you
            dropped in — only the extension changes, to match the format you picked.
          </p>

          <p className="mt-5 flex max-w-2xl items-start gap-2.5 rounded-lg border border-hairline bg-surface px-3.5 py-3 text-sm leading-relaxed">
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              className="mt-0.5 size-4 shrink-0 fill-accent"
            >
              <path d="M10 1.5 3.5 4v5.2c0 4 2.7 7.6 6.5 8.8 3.8-1.2 6.5-4.8 6.5-8.8V4L10 1.5Zm2.8 6.6-3.4 4.2a.8.8 0 0 1-1.2.05L6.4 10.5a.8.8 0 1 1 1.15-1.1l1.2 1.25 2.85-3.5a.8.8 0 1 1 1.2 1Z" />
            </svg>
            <span className="text-ink-dim">
              <strong className="font-medium text-ink">
                Your images never leave this device.
              </strong>{' '}
              There is no server and no upload — every file is decoded and re-encoded by your own
              CPU, inside this browser tab. Close the tab and nothing is left behind.
            </span>
          </p>
        </header>

        {/* ---------------- dropzone ---------------- */}
        <Dropzone onFiles={addFiles} disabled={isConverting} />

        {warnings.length > 0 && (
          <NoticeBlock
            tone="warn"
            title={`${warnings.length} ${warnings.length === 1 ? 'file was' : 'files were'} skipped`}
            notices={warnings}
            onDismiss={dismissNotices}
          />
        )}

        {duplicates.length > 0 && (
          <NoticeBlock
            tone="info"
            title={`${duplicates.length} ${duplicates.length === 1 ? 'file was' : 'files were'} already in the list`}
            notices={duplicates}
            onDismiss={dismissNotices}
          />
        )}

        {/* ---------------- body ---------------- */}
        <main className="mt-8 grid gap-8 lg:grid-cols-[19rem_minmax(0,1fr)] lg:items-start">
          <aside className="min-w-0 lg:sticky lg:top-6">
            <OptionsPanel options={options} onChange={updateOptions} />

            {/*
              Shown only once a HEIC is actually in the queue, in the panel's own
              quiet colours. It answers the question the picker provokes — "where
              is HEIC?" — rather than warning about anything: converting a HEIC
              to WebP is the ordinary, intended outcome.
            */}
            {hasSourceOnlyInput && (
              <p className="mt-3 px-1 text-xs leading-relaxed text-ink-dim">
                HEIC goes in, but never comes out. Your iPhone photos are read and converted
                to whichever format you pick above; HEIC itself isn't offered as an output,
                because its HEVC encoder is patent-encumbered and no browser or WASM build
                ships one.
              </p>
            )}
          </aside>

          <section className="min-w-0">
            {rootFolder.length > 0 && (
              <p className="mb-3 flex items-center gap-2 text-xs text-ink-dim">
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="size-3.5 shrink-0"
                >
                  <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17V7.5Z" />
                </svg>
                <span className="truncate text-ink" title={`${rootFolder}/`}>
                  {rootFolder}/
                </span>
                <span aria-hidden="true" className="shrink-0 text-hairline">
                  ·
                </span>
                <span className="num shrink-0">
                  {summary.total} {summary.total === 1 ? 'file' : 'files'}
                </span>
              </p>
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat
                label="Files"
                value={String(summary.total)}
                hint={summary.pending > 0 ? `${summary.pending} to convert` : 'nothing queued'}
              />
              <Stat
                label="Converted"
                value={String(summary.done)}
                hint={summary.error > 0 ? `${summary.error} failed` : undefined}
              />
              <Stat
                label="Output"
                value={formatBytes(summary.outputBytes)}
                hint={
                  summary.done > 0 ? `from ${formatBytes(summary.convertedInputBytes)}` : undefined
                }
              />
              <Stat
                label="Saved"
                value={formatPercent(summary.savedPercent)}
                hint={summary.done > 0 ? formatSignedBytes(summary.savedBytes) : undefined}
              />
            </div>

            {jobs.length === 0 ? (
              <div className="mt-6 rounded-xl border border-dashed border-hairline bg-surface/60 px-5 py-12 text-center">
                <h2 className="text-base font-medium">Nothing queued yet</h2>
                <ol className="mx-auto mt-4 max-w-sm space-y-2 text-left text-sm text-ink-dim">
                  <li>
                    <span className="num mr-2 text-accent">1.</span>
                    Drop images above, or pick them from your device.
                  </li>
                  <li>
                    <span className="num mr-2 text-accent">2.</span>
                    Choose an output format and quality on the left. Any file can override the
                    defaults on its own card.
                  </li>
                  <li>
                    <span className="num mr-2 text-accent">3.</span>
                    Hit convert, then save the results one by one or as a single ZIP.
                  </li>
                </ol>
              </div>
            ) : (
              <>
                <ul className="mt-6 grid gap-3">
                  {jobs.map((job) => (
                    <li key={job.id} className="min-w-0">
                      <FileCard
                        job={job}
                        options={options}
                        /* A boolean, not the Set: the cards that are not
                           fetching keep the same `false` across commits and
                           stay memoised. */
                        fetchingDecoder={decoderFetchIds.has(job.id)}
                        onRemove={removeJob}
                        onOverride={setOverride}
                        onDownload={downloadOne}
                      />
                    </li>
                  ))}
                </ul>

                {/* ---------------- action bar ---------------- */}
                <div className="sticky bottom-0 z-10 mt-4 border-t border-hairline bg-canvas/90 py-3 backdrop-blur-md">
                  {isConverting && (
                    <div className="mb-3">
                      <div
                        className="h-1 w-full overflow-hidden rounded-full bg-surface-2"
                        role="progressbar"
                        aria-valuenow={settled}
                        aria-valuemin={0}
                        aria-valuemax={summary.total}
                        aria-label="Conversion progress"
                      >
                        <div
                          className="h-full bg-accent transition-[width] duration-300"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                      <p className="num mt-1.5 text-xs text-ink-dim">
                        Converting — {settled} of {summary.total} done
                      </p>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    {isConverting ? (
                      <button type="button" className={SECONDARY} onClick={cancelAll}>
                        Cancel
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={PRIMARY}
                        onClick={convertAll}
                        disabled={summary.pending === 0}
                      >
                        {summary.pending === 0
                          ? 'Convert all'
                          : `Convert ${summary.pending} ${summary.pending === 1 ? 'file' : 'files'}`}
                      </button>
                    )}

                    <button
                      type="button"
                      className={SECONDARY}
                      onClick={downloadAllZip}
                      disabled={summary.done === 0 || isZipping}
                    >
                      {isZipping ? 'Building ZIP…' : 'Download all as ZIP'}
                    </button>

                    <button
                      type="button"
                      className={`${QUIET} ml-auto`}
                      onClick={clearAll}
                      disabled={jobs.length === 0}
                    >
                      Clear
                    </button>
                  </div>
                </div>
              </>
            )}
          </section>
        </main>

        {/* ---------------- footer ---------------- */}
        <footer className="mt-16 border-t border-hairline pt-6 text-xs leading-relaxed text-ink-dim">
          <p>
            No accounts, no cookies, no analytics. The only thing this page ever fetches is more
            of its own code, and your images are never part of it. PNG, JPEG and WebP are encoded
            by the browser itself; AVIF is encoded by a WebAssembly build of libavif shipped with
            this page, because no browser can write AVIF natively.
          </p>
          <p className="mt-2">
            HEIC is read by a WebAssembly build of libheif, downloaded from this site the first
            time you actually convert one and never before — it's 1.4 MB, and most people never
            touch a HEIC. Reading is all it will ever do: a HEIC holds an HEVC image, and the HEVC
            encoder is patent-encumbered, so there is none to ship and HEIC cannot be an output
            format. SVG output wraps a PNG in a vector container — it doesn't trace real vector
            paths.
          </p>
        </footer>
      </div>
    </div>
  )
}
