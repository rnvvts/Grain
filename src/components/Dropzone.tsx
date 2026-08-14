/**
 * Dropzone — the single entry point for files.
 *
 * Four input paths, because one is never enough:
 *   1. drag & drop of loose files (desktop, with a real active state)
 *   2. drag & drop of whole folders, walked recursively
 *   3. click / Enter / Space to open the native file picker, plus a second
 *      picker for choosing a directory (mobile + a11y + no-drag workflows)
 *   4. paste from the clipboard (screenshots)
 *
 * Every path emits `PickedFile`s: the File *and* where it sat in the tree the
 * user handed over. That pairing is the whole point — `File` cannot carry a
 * path on its own (`webkitRelativePath` is empty for drag-and-drop and is
 * read-only), and without it the export could not mirror the upload.
 *
 * Paths are built here from the names the filesystem reports, verbatim. No
 * lowercasing, no slugifying: `Holiday Photos/2024/Beach Day.PNG` stays exactly
 * that, so the ZIP can hand it back under the same name in the same folder.
 *
 * Non-image files are filtered out but never silently swallowed: they are
 * summarised in the inline notice below the zone.
 *
 * The busy affordance covers the WHOLE ingest, not just the walk: `onFiles`
 * returns a promise (it sniffs every file's header) and this component waits
 * for it before going idle. Clearing it when the walk resolved left a
 * multi-second window where a 1200-file drop looked ignored.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from 'react'
import { SOURCE_EXTENSIONS, SOURCE_FORMATS, SOURCE_LABEL, SOURCE_MIME } from '../types'
import type { PickedFile } from '../types'
import { createLimiter, type Limiter } from '../utils/limit'

/**
 * What we accept, derived from the one list in `types.ts` instead of restated
 * here. This file used to keep its own hand-written copies of the MIME set, the
 * extension set and the `accept` string, so adding a readable format meant
 * remembering four places; HEIC is the format that finally made that
 * unmaintainable, and it is now a one-line change in `types.ts`.
 */
const ACCEPTED_MIME = new Set<string>(
  SOURCE_FORMATS.flatMap((format) => SOURCE_MIME[format]),
)

const ACCEPTED_EXT = new Set<string>(
  SOURCE_FORMATS.flatMap((format) => SOURCE_EXTENSIONS[format]),
)

/**
 * The `accept` attribute for the native picker: MIME types *and* dotted
 * extensions.
 *
 * Both, because for HEIC neither is sufficient alone. iOS Safari filters its
 * photo picker on this list and can hide HEIC files outright when the entry it
 * matches on is missing, while plenty of desktop systems report a HEIC's type
 * as '' or `application/octet-stream`, where only the extension can match. The
 * list is a union, not an intersection — a file shows up if it matches any
 * entry — so naming both costs nothing.
 */
const ACCEPT_ATTR = [
  ...SOURCE_FORMATS.flatMap((format) => SOURCE_MIME[format]),
  ...SOURCE_FORMATS.flatMap((format) => SOURCE_EXTENSIONS[format].map((ext) => `.${ext}`)),
].join(',')

const SOURCE_LABELS = SOURCE_FORMATS.map((format) => SOURCE_LABEL[format])

/** "PNG · JPEG · WebP · AVIF · SVG · HEIC" — the footnote inside the zone. */
const SOURCE_LIST = SOURCE_LABELS.join(' · ')

/** The same set as prose, for the skipped-files notice. */
const SOURCE_PROSE =
  SOURCE_LABELS.length > 1
    ? `${SOURCE_LABELS.slice(0, -1).join(', ')} and ${SOURCE_LABELS[SOURCE_LABELS.length - 1]}`
    : SOURCE_LABELS.join('')

/** Lowercase extension without the dot, '' when the name has none. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/**
 * Accept on EITHER signal — never on `file.type` alone.
 *
 * `file.type` is a hint, not a fact, and HEIC is where that bites hardest: it
 * arrives as '' from most drag sources, as `application/octet-stream` from
 * several file managers, and occasionally as an outright wrong image type. The
 * old rule consulted the extension only when the type was *empty*, so a
 * non-empty unrecognised type was an immediate rejection — which silently threw
 * away real .heic photos before the magic-byte sniffer downstream ever got to
 * identify them. Falling through to the extension whenever the MIME doesn't
 * match cannot admit anything the sniffer won't reject a moment later, and it
 * stops a mislabelled file from being lost without a word.
 */
function isSupportedImage(file: File): boolean {
  if (ACCEPTED_MIME.has(file.type.toLowerCase())) return true
  return ACCEPTED_EXT.has(extensionOf(file.name))
}

/* ------------------------------------------------------------------ *
 * Folder traversal
 * ------------------------------------------------------------------ */

/**
 * Deepest nesting we will descend. Real photo libraries are a handful of levels
 * deep; anything approaching this is a symlink cycle or a hand-built pathology,
 * and stopping is the graceful answer.
 */
const MAX_DEPTH = 50

/**
 * How many filesystem reads may be in flight at once. A 5000-file tree walked
 * without a cap opens 5000 simultaneous file handles and stalls the tab; eight
 * keeps the disk busy without that.
 */
const READ_CONCURRENCY = 8

/**
 * Safety valve for a directory reader that never signals the end. Bounded
 * generously — a folder of 100k files is absurd, an infinite loop is worse.
 */
const MAX_ENTRIES_PER_DIR = 100_000

/** `FileSystemEntry` is a union in practice but not in the type system. */
function isFileEntry(entry: FileSystemEntry): entry is FileSystemFileEntry {
  return entry.isFile
}

function isDirectoryEntry(entry: FileSystemEntry): entry is FileSystemDirectoryEntry {
  return entry.isDirectory
}

/**
 * Read a directory to the end.
 *
 * *** The one thing this function exists for. *** `readEntries()` returns AT
 * MOST 100 entries per call in Chrome, and a short batch is NOT the end of the
 * directory — only an empty batch is. Calling it once truncates every folder
 * with more than 100 files in it, which is precisely the case this feature was
 * built for, and it looks perfectly healthy when tested with ten photos. So the
 * same reader is drained repeatedly until it yields nothing: a 250-file folder
 * takes four calls (100, 100, 50, 0).
 *
 * A read error resolves with whatever was collected rather than rejecting: one
 * unreadable subfolder should cost that subfolder, not the entire drop.
 */
function readAllEntries(directory: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  return new Promise((resolve) => {
    const reader = directory.createReader()
    const all: FileSystemEntry[] = []

    const readBatch = (): void => {
      reader.readEntries(
        (batch) => {
          if (batch.length === 0) {
            resolve(all)
            return
          }
          for (const entry of batch) all.push(entry)
          if (all.length >= MAX_ENTRIES_PER_DIR) {
            resolve(all)
            return
          }
          readBatch()
        },
        () => resolve(all),
      )
    }

    readBatch()
  })
}

/**
 * Promisified `entry.file()`. Resolves null rather than rejecting when the file
 * has gone (deleted or moved between the drop and the read) so one casualty
 * cannot hang or abort the walk.
 */
function entryToFile(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise((resolve) => {
    entry.file(
      (file) => resolve(file),
      () => resolve(null),
    )
  })
}

/**
 * Depth-first walk of one dropped entry, returning every image-or-not file
 * under it with the path it had inside the drop.
 *
 * Children are started concurrently (throttled by `limit`) but their results
 * are stitched back together in listing order, so the queue reads folder by
 * folder rather than in whatever order the disk answered.
 *
 * `ancestors` carries the `fullPath` of every directory on the current branch:
 * a directory that reappears inside itself is a symlink cycle and is skipped.
 * The depth cap catches the cycles that keep inventing new paths.
 */
async function walkEntry(
  entry: FileSystemEntry,
  parentPath: string,
  depth: number,
  ancestors: readonly string[],
  limit: Limiter,
): Promise<PickedFile[]> {
  const path = parentPath.length > 0 ? `${parentPath}/${entry.name}` : entry.name

  if (isFileEntry(entry)) {
    const file = await limit(() => entryToFile(entry))
    return file ? [{ file, relativePath: path }] : []
  }

  if (!isDirectoryEntry(entry) || depth >= MAX_DEPTH) return []

  const fullPath = entry.fullPath
  if (fullPath.length > 0 && ancestors.includes(fullPath)) return []
  const branch = fullPath.length > 0 ? [...ancestors, fullPath] : ancestors

  const children = await limit(() => readAllEntries(entry))
  const nested = await Promise.all(
    children.map((child) => walkEntry(child, path, depth + 1, branch, limit)),
  )
  return nested.flat()
}

/** Walk every dropped entry, root files first-come, in the order they arrived. */
async function walkEntries(entries: readonly FileSystemEntry[]): Promise<PickedFile[]> {
  const limit = createLimiter(READ_CONCURRENCY)
  const trees = await Promise.all(entries.map((entry) => walkEntry(entry, '', 0, [], limit)))
  return trees.flat()
}

interface DroppedEntries {
  entries: FileSystemEntry[]
  /** True when at least one dropped item is a directory. */
  sawDirectory: boolean
  /** False when this browser has no FileSystem entry API to offer. */
  supported: boolean
}

/**
 * MUST be called synchronously inside the drop handler: a DataTransfer's item
 * list is neutered the instant the handler yields, so a single `await` before
 * this runs turns a 500-file folder into an empty drop.
 */
function collectDroppedEntries(items: DataTransferItemList | undefined): DroppedEntries {
  const entries: FileSystemEntry[] = []
  let sawDirectory = false

  if (!items) return { entries, sawDirectory, supported: false }

  for (const item of Array.from(items)) {
    if (item.kind !== 'file') continue
    if (typeof item.webkitGetAsEntry !== 'function') {
      return { entries: [], sawDirectory: false, supported: false }
    }
    const entry = item.webkitGetAsEntry()
    if (!entry) continue
    if (entry.isDirectory) sawDirectory = true
    entries.push(entry)
  }

  return { entries, sawDirectory, supported: true }
}

/* ------------------------------------------------------------------ *
 * Plain file lists
 * ------------------------------------------------------------------ */

/**
 * Pair loose Files with a path.
 *
 * `webkitRelativePath` is populated by the directory picker (`MyFolder/sub/a.png`)
 * and empty everywhere else, where the bare filename is the correct path: the
 * file sits at the root of the archive.
 */
function toPickedFiles(files: ArrayLike<File> | null | undefined): PickedFile[] {
  return Array.from(files ?? []).map((file) => ({
    file,
    relativePath: file.webkitRelativePath || file.name,
  }))
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

/** How many rejected names are worth spelling out before they become noise. */
const NAMES_SHOWN = 4

interface RejectionNotice {
  /** Total files skipped. 0 means a folder held no images at all. */
  count: number
  /** The first few names, for the loose-file case where naming them helps. */
  names: string[]
  /** Files came from a folder, where stray .txt/.DS_Store files are normal. */
  fromFolder: boolean
}

export interface DropzoneProps {
  /**
   * Called with every supported image the user supplied, each carrying the path
   * it had inside the dropped folder. Never called empty.
   *
   * May return a promise; the zone stays visibly busy until it settles, so the
   * header-sniffing phase is covered by the same affordance as the walk.
   */
  onFiles: (files: PickedFile[]) => void | Promise<void>
  disabled?: boolean
}

/** What the zone is doing, when it is doing anything. */
type Phase = 'scanning' | 'adding'

const PHASE_LABEL: Record<Phase, string> = {
  scanning: 'Reading folder…',
  adding: 'Adding images…',
}

export function Dropzone({ onFiles, disabled = false }: DropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const [dragging, setDragging] = useState(false)
  const [phase, setPhase] = useState<Phase | null>(null)
  /** Last completed outcome, for the live region only. */
  const [announcement, setAnnouncement] = useState('')
  const [rejected, setRejected] = useState<RejectionNotice | null>(null)

  /**
   * `webkitdirectory` cannot be written as a JSX prop (React forwards unknown
   * props but TypeScript rejects it, and the DOM property is the documented
   * way), so it is set on the element itself. It lives on its *own* input:
   * putting it on the multi-file input would turn that picker into a
   * folders-only picker and make loose files unselectable.
   */
  useEffect(() => {
    const el = folderInputRef.current
    if (el) el.webkitdirectory = true
  }, [])

  const ingest = useCallback(
    async (picked: PickedFile[], fromFolder: boolean): Promise<void> => {
      if (disabled) return
      setAnnouncement('')

      if (picked.length === 0) {
        // A folder that held nothing we can convert is a real outcome the user
        // needs told about — and it arrives here from BOTH entry points, the
        // walk and the `webkitdirectory` picker, which used to bail silently.
        // An empty loose-file pick is just a cancelled dialog, and deserves
        // silence.
        if (fromFolder) setRejected({ count: 0, names: [], fromFolder: true })
        return
      }

      const accepted: PickedFile[] = []
      const skipped: File[] = []
      for (const item of picked) {
        if (isSupportedImage(item.file)) accepted.push(item)
        else skipped.push(item.file)
      }

      setRejected(
        skipped.length > 0
          ? {
              count: skipped.length,
              names: skipped.slice(0, NAMES_SHOWN).map((f) => f.name || 'unnamed file'),
              fromFolder,
            }
          : null,
      )
      if (accepted.length === 0) return

      // Stay busy for the whole ingest, not just up to this call: `onFiles`
      // reads a header off every accepted file, which for a folder of a few
      // thousand images is the longest part of the drop.
      setPhase('adding')
      try {
        await onFiles(accepted)
        setAnnouncement(
          `Added ${accepted.length} ${accepted.length === 1 ? 'image' : 'images'}`,
        )
      } finally {
        setPhase(null)
      }
    },
    [disabled, onFiles],
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
      // A pasted screenshot has no folder of its own: its name is its path.
      void ingestRef.current(toPickedFiles(files), false)
    }

    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [disabled])

  const openPicker = () => {
    if (disabled) return
    inputRef.current?.click()
  }

  const openFolderPicker = () => {
    if (disabled) return
    folderInputRef.current?.click()
  }

  const hasFiles = (event: ReactDragEvent<HTMLButtonElement>) =>
    Array.from(event.dataTransfer.types).includes('Files')

  const handleDrop = (event: ReactDragEvent<HTMLButtonElement>) => {
    if (disabled) return
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)

    // Read the DataTransfer NOW. Both of these are dead the moment this handler
    // yields, so nothing above them may await.
    const loose = toPickedFiles(event.dataTransfer.files)
    const { entries, sawDirectory, supported } = collectDroppedEntries(event.dataTransfer.items)

    // No folders involved (or a browser without the entry API): the flat file
    // list is complete and correct, and walking would only add latency.
    if (!supported || entries.length === 0 || !sawDirectory) {
      void ingest(loose, false)
      return
    }

    setPhase('scanning')
    void (async () => {
      try {
        const picked = await walkEntries(entries)
        // An empty walk falls through to `ingest`, which reports "no images in
        // that folder". `loose` is useless in that case: a dropped folder
        // appears in `dataTransfer.files` as a directory masquerading as a
        // file, and queueing it would report the folder as an unsupported file.
        await ingest(picked, true)
      } catch {
        // The walk failed outright (permissions, a revoked drop). Anything the
        // browser already flattened is better than losing the drop entirely.
        await ingest(loose, true)
      } finally {
        // `ingest` owns the 'adding' phase and clears it; this is the backstop
        // for the walk itself and for a throw before ingest ever ran.
        setPhase(null)
      }
    })()
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Siblings, not children: a click() on a nested input would bubble back
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
          void ingest(toPickedFiles(event.target.files), false)
          // Allow re-picking the exact same file.
          event.target.value = ''
        }}
      />

      {/* Deliberately no `accept`: a directory pick hands over everything inside
          it, and filtering here (rather than in the dialog) is what lets the
          notice below say how many non-images were passed over. */}
      <input
        ref={folderInputRef}
        type="file"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only absolute h-0 w-0 opacity-0"
        onChange={(event) => {
          // Deliberately called even when the FileList is empty: picking a
          // folder with nothing in it must say so, not do nothing.
          void ingest(toPickedFiles(event.target.files), true)
          event.target.value = ''
        }}
      />

      <button
        type="button"
        onClick={openPicker}
        disabled={disabled}
        aria-busy={phase !== null}
        /*
          Deliberately NO aria-label. One would override the button's own text,
          hiding the three states it cycles through ("Release to add them" /
          "Reading folder…" / "Drop images or folders here") from every screen
          reader — the states are the whole point of the copy. The visible text
          is the accessible name; the live region below announces changes.
        */
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
        onDrop={handleDrop}
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
            {dragging
              ? 'Release to add them'
              : phase !== null
                ? PHASE_LABEL[phase]
                : 'Drop images or folders here'}
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
          {SOURCE_LIST} &middot; stays on your device
        </span>
      </button>

      {/* The button's own text changes silently for assistive tech (its
          accessible name is only recomputed on focus), so the progress of a
          long folder ingest is announced from here instead. */}
      <p role="status" aria-live="polite" className="sr-only">
        {phase !== null ? PHASE_LABEL[phase] : announcement}
      </p>

      <p className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-center text-xs text-ink-dim">
        <button
          type="button"
          onClick={openFolderPicker}
          disabled={disabled}
          className="rounded px-1 py-0.5 font-medium text-accent underline underline-offset-4 transition-colors hover:text-accent-hi disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Select a folder
        </button>
        <span>subfolders included — the export keeps your names and folders</span>
      </p>

      {rejected !== null ? (
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
            {rejected.count === 0 ? (
              <>
                <span className="font-medium">No images in that folder</span>{' '}
                <span className="text-amber-200/70">— nothing to convert</span>
              </>
            ) : rejected.fromFolder ? (
              /* Stray .DS_Store / .txt / video files are ordinary in a photo
                 folder — summarise them instead of reciting 200 names. */
              <>
                <span className="font-medium">
                  Skipped {rejected.count} non-image {rejected.count === 1 ? 'file' : 'files'}
                </span>{' '}
                <span className="text-amber-200/70">
                  — only {SOURCE_PROSE} are converted
                </span>
              </>
            ) : (
              <>
                <span className="font-medium">
                  Skipped {rejected.count} {rejected.count === 1 ? 'file' : 'files'}
                </span>{' '}
                <span className="text-amber-200/70">
                  — not a supported image: {rejected.names.join(', ')}
                  {rejected.count > rejected.names.length
                    ? ` and ${rejected.count - rejected.names.length} more`
                    : ''}
                </span>
              </>
            )}
          </p>
          <button
            type="button"
            onClick={() => setRejected(null)}
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
