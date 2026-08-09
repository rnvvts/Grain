import { useMemo } from 'react'
import { Dropzone } from './components/Dropzone'
import { FileCard } from './components/FileCard'
import { OptionsPanel } from './components/OptionsPanel'
import { Stat } from './components/Stat'
import { mergeOptions, useConverter } from './state/useConverter'
import { formatBytes, formatPercent, formatSignedBytes } from './utils/format'
import type { ConvertOptions } from './types'

/* ---- shared class strings ------------------------------------------ */

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium ' +
  'transition-colors disabled:cursor-not-allowed disabled:opacity-40'

const PRIMARY = `${BUTTON_BASE} bg-accent text-accent-ink hover:bg-accent-hi`
const SECONDARY = `${BUTTON_BASE} border border-hairline bg-surface-2 text-ink hover:border-ink-dim`
const QUIET = `${BUTTON_BASE} text-ink-dim hover:text-ink`

/* ---- page ----------------------------------------------------------- */

export default function App() {
  const {
    jobs,
    options,
    summary,
    isConverting,
    isZipping,
    notices,
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

  // Resolve each job's effective settings once per render rather than inside
  // every card, so the list stays cheap with a few hundred rows.
  const effective = useMemo(() => {
    const map = new Map<string, ConvertOptions>()
    for (const job of jobs) map.set(job.id, mergeOptions(options, job.overrides))
    return map
  }, [jobs, options])

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
            Convert between PNG, JPEG, WebP, AVIF and SVG — resize, re-quantise and batch a
            whole folder at once.
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

        {notices.length > 0 && (
          <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium text-amber-200">
                  {notices.length} {notices.length === 1 ? 'file was' : 'files were'} skipped
                </p>
                <ul className="mt-1.5 space-y-0.5 text-amber-100/70">
                  {notices.slice(0, 6).map((notice, index) => (
                    <li key={`${notice.name}-${index}`} className="truncate">
                      <span className="font-medium">{notice.name}</span> — {notice.reason}
                    </li>
                  ))}
                  {notices.length > 6 && <li>and {notices.length - 6} more</li>}
                </ul>
              </div>
              <button
                type="button"
                onClick={dismissNotices}
                className="shrink-0 rounded px-2 py-1 text-xs text-amber-200/80 hover:text-amber-100"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* ---------------- body ---------------- */}
        <main className="mt-8 grid gap-8 lg:grid-cols-[19rem_minmax(0,1fr)] lg:items-start">
          <aside className="min-w-0 lg:sticky lg:top-6">
            <OptionsPanel options={options} onChange={updateOptions} />
          </aside>

          <section className="min-w-0">
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
                        effectiveOptions={effective.get(job.id) ?? options}
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
            No accounts, no cookies, no analytics, no network requests once the page has loaded.
            PNG, JPEG and WebP are encoded by the browser itself; AVIF is encoded by a WebAssembly
            build of libavif shipped with this page, because no browser can write AVIF natively.
            SVG output wraps a PNG in a vector container — it doesn't trace real vector paths.
          </p>
        </footer>
      </div>
    </div>
  )
}
