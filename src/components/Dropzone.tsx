/**
 * Dropzone — the single entry point for files.
 *
 * Three input paths, because one is never enough:
 *   1. drag & drop (desktop, with a real active state)
 *   2. click / Enter / Space to open the native file picker (mobile + a11y)
 *   3. paste from the clipboard (screenshots)
 *
 * Non-image files are filtered out but never silently swallowed: they are
 * surfaced inline *and* handed to `onReject` so the page can report them.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from 'react'
import { FORMATS, MIME } from '../types'

const ACCEPTED_MIME = new Set<string>([
  ...FORMATS.map((f) => MIME[f]),
  'image/jpg', // some systems mislabel jpeg
])

const ACCEPTED_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'avif', 'svg'])

/** The `accept` attribute for the native picker. */
const ACCEPT_ATTR = 'image/png,image/jpeg,image/webp,image/avif,image/svg+xml'

function isSupportedImage(file: File): boolean {
  const type = file.type.toLowerCase()
  if (type) return ACCEPTED_MIME.has(type)
  // Some drag sources (and Safari paste) hand over an empty MIME type.
  const dot = file.name.lastIndexOf('.')
  const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : ''
  return ACCEPTED_EXT.has(ext)
}

export interface DropzoneProps {
  /** Called with every supported image the user supplied. Never called empty. */
  onFiles: (files: File[]) => void
  /** Called with the files that were filtered out, so nothing disappears quietly. */
  onReject?: (files: File[]) => void
  disabled?: boolean
}

export function Dropzone({ onFiles, onReject, disabled = false }: DropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const [dragging, setDragging] = useState(false)
  const [rejected, setRejected] = useState<string[]>([])

  const ingest = useCallback(
    (files: File[]) => {
      if (disabled || files.length === 0) return
      const accepted: File[] = []
      const skipped: File[] = []
      for (const file of files) {
        if (isSupportedImage(file)) accepted.push(file)
        else skipped.push(file)
      }
      setRejected(skipped.map((f) => f.name || 'unnamed file'))
      if (skipped.length > 0) onReject?.(skipped)
      if (accepted.length > 0) onFiles(accepted)
    },
    [disabled, onFiles, onReject],
  )

  // Keep a stable ref to the latest ingest so the document listener below is
  // attached exactly once instead of on every render.
  const ingestRef = useRef(ingest)
  useEffect(() => {
    ingestRef.current = ingest
  }, [ingest])

  useEffect(() => {
    if (disabled) return
    const onPaste = (event: ClipboardEvent) => {
      const data = event.clipboardData
      if (!data) return

      const files: File[] = Array.from(data.files)
      if (files.length === 0) {
        for (const item of Array.from(data.items)) {
          if (item.kind !== 'file') continue
          const file = item.getAsFile()
          if (file) files.push(file)
        }
      }
      if (files.length === 0) return

      if (files.some(isSupportedImage)) event.preventDefault()
      ingestRef.current(files)
    }

    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [disabled])

  const openPicker = () => {
    if (disabled) return
    inputRef.current?.click()
  }

  const hasFiles = (event: ReactDragEvent<HTMLButtonElement>) =>
    Array.from(event.dataTransfer.types).includes('Files')

  return (
    <div className="flex flex-col gap-3">
      {/* Sibling, not a child: a click() on a nested input would bubble back
          into the button and re-open the picker forever. */}
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT_ATTR}
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only absolute h-0 w-0 opacity-0"
        onChange={(event) => {
          ingest(Array.from(event.target.files ?? []))
          // Allow re-picking the exact same file.
          event.target.value = ''
        }}
      />

      <button
        type="button"
        onClick={openPicker}
        disabled={disabled}
        aria-label="Add images — drop them here, click to browse, or paste from the clipboard"
        onDragEnter={(event) => {
          if (disabled || !hasFiles(event)) return
          event.preventDefault()
          dragDepth.current += 1
          setDragging(true)
        }}
        onDragOver={(event) => {
          if (disabled || !hasFiles(event)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }}
        onDragLeave={(event) => {
          if (disabled) return
          event.preventDefault()
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (dragDepth.current === 0) setDragging(false)
        }}
        onDrop={(event) => {
          if (disabled) return
          event.preventDefault()
          dragDepth.current = 0
          setDragging(false)
          ingest(Array.from(event.dataTransfer.files))
        }}
        className={[
          'group relative flex w-full flex-col items-center justify-center gap-4 rounded-xl border border-dashed px-6 py-14 text-center transition-colors duration-150',
          'focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent',
          disabled
            ? 'cursor-not-allowed border-hairline bg-surface/40 opacity-50'
            : dragging
              ? 'cursor-copy border-accent bg-accent/10'
              : 'cursor-pointer border-hairline bg-surface/60 hover:border-ink-dim/60 hover:bg-surface',
        ].join(' ')}
      >
        <span
          aria-hidden="true"
          className={[
            'flex h-12 w-12 items-center justify-center rounded-xl border transition-colors duration-150',
            dragging
              ? 'border-accent/50 bg-accent/20 text-accent'
              : 'border-hairline bg-surface-2 text-ink-dim group-hover:text-ink',
          ].join(' ')}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-6 w-6"
          >
            <path d="M12 16V4" />
            <path d="m7.5 8.5 4.5-4.5 4.5 4.5" />
            <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
          </svg>
        </span>

        <span className="flex flex-col gap-1.5">
          <span className="text-base font-medium text-ink">
            {dragging ? 'Release to add images' : 'Drop images here'}
          </span>
          <span className="text-sm text-ink-dim">
            or <span className="text-accent underline underline-offset-4">browse</span>{' '}
            &middot; paste with{' '}
            <kbd className="rounded border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[11px] text-ink">
              Ctrl/⌘ V
            </kbd>
          </span>
        </span>

        <span className="text-[11px] uppercase tracking-[0.14em] text-ink-dim">
          PNG &middot; JPEG &middot; WebP &middot; AVIF &middot; SVG &middot; stays on your device
        </span>
      </button>

      {rejected.length > 0 ? (
        <div
          role="status"
          className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-left"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            className="mt-0.5 h-4 w-4 shrink-0 text-amber-400"
          >
            <path d="M12 8v5" />
            <path d="M12 16.5h.01" />
            <circle cx="12" cy="12" r="9" />
          </svg>
          <p className="min-w-0 flex-1 text-sm text-amber-200">
            <span className="font-medium">
              Skipped {rejected.length} {rejected.length === 1 ? 'file' : 'files'}
            </span>{' '}
            <span className="text-amber-200/70">
              — not a supported image: {rejected.slice(0, 4).join(', ')}
              {rejected.length > 4 ? ` and ${rejected.length - 4} more` : ''}
            </span>
          </p>
          <button
            type="button"
            onClick={() => setRejected([])}
            className="shrink-0 rounded-lg px-2 py-0.5 text-xs font-medium text-amber-200/80 transition-colors hover:bg-amber-500/15 hover:text-amber-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300"
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  )
}

export default Dropzone
