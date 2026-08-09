/**
 * OptionsPanel — the global conversion settings.
 *
 * Every control is conditional on the target format actually honouring it:
 * quality is inert for lossless targets, the matte colour only exists for
 * opaque targets, effort only for AVIF. A control that is visible, live and
 * ignored is a lie told to the user, so we either disable it with a reason
 * or remove it.
 */

import { useEffect, useId, useState, type ReactNode } from 'react'
import {
  LOSSLESS_FORMATS,
  OPAQUE_FORMATS,
  type ConvertOptions,
  type ImageFormat,
  type ResizeMode,
  type ResizeOptions,
} from '../types'
import { FormatPicker } from './FormatPicker'

const RESIZE_MODES: readonly { mode: ResizeMode; label: string }[] = [
  { mode: 'none', label: 'Original' },
  { mode: 'fit', label: 'Fit' },
  { mode: 'exact', label: 'Exact' },
  { mode: 'scale', label: 'Scale' },
]

/** Why quality is inert, worded per-format since "lossless" means something
 * different for a real codec (PNG) than for a wrapper that just carries one
 * (SVG). A generic message would be accurate for one and vague for the other. */
const LOSSLESS_NOTE: Partial<Record<ImageFormat, string>> = {
  png: 'PNG is lossless — every pixel is preserved, so quality has no effect on the output.',
  svg: 'The image is embedded losslessly inside the SVG wrapper, so quality has no effect on the output.',
}

const RESIZE_HINT: Record<ResizeMode, string> = {
  none: 'Keeps the source pixel dimensions.',
  fit: 'Scales down to fit inside the box, keeping the aspect ratio. Never upscales.',
  exact: 'Forces these exact dimensions. Aspect ratio is not preserved.',
  scale: 'Scales both dimensions by a percentage of the original.',
}

const INPUT_CLASS =
  'w-full rounded-lg border border-hairline bg-canvas px-3 py-2 text-sm tabular-nums text-ink placeholder:text-ink-dim/60 transition-colors hover:border-ink-dim/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'

const RANGE_CLASS =
  'h-1.5 w-full cursor-pointer appearance-none rounded-full bg-surface-2 accent-accent transition-opacity focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40'

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-dim">
      {children}
    </span>
  )
}

/** Hex text field with a local draft so typing never fights the parent state. */
function HexField({
  id,
  value,
  onCommit,
}: {
  id: string
  value: string
  onCommit: (hex: string) => void
}) {
  const [draft, setDraft] = useState(value)

  useEffect(() => {
    setDraft(value)
  }, [value])

  const valid = /^#[0-9a-f]{6}$/i.test(draft)

  return (
    <input
      id={id}
      type="text"
      inputMode="text"
      spellCheck={false}
      autoComplete="off"
      value={draft}
      aria-invalid={!valid}
      aria-label="Background colour hex value"
      className={`${INPUT_CLASS} font-mono uppercase ${valid ? '' : 'border-rose-500/60'}`}
      onChange={(event) => {
        const next = event.target.value
        setDraft(next)
        if (/^#[0-9a-f]{6}$/i.test(next)) onCommit(next.toLowerCase())
      }}
      onBlur={() => {
        if (!valid) setDraft(value)
      }}
    />
  )
}

export interface OptionsPanelProps {
  options: ConvertOptions
  onChange: (patch: Partial<ConvertOptions>) => void
  /** Distinguishes this panel's DOM ids from the per-file copies. */
  idPrefix?: string
}

export function OptionsPanel({ options, onChange, idPrefix }: OptionsPanelProps) {
  const reactId = useId()
  const prefix = idPrefix ?? `opts${reactId.replace(/[^a-zA-Z0-9]/g, '')}`

  const qualityId = `${prefix}-quality`
  const qualityNoteId = `${prefix}-quality-note`
  const effortId = `${prefix}-effort`
  const widthId = `${prefix}-width`
  const heightId = `${prefix}-height`
  const scaleId = `${prefix}-scale`
  const colorId = `${prefix}-bg`
  const hexId = `${prefix}-bg-hex`

  const lossless = LOSSLESS_FORMATS.includes(options.target)
  const opaque = OPAQUE_FORMATS.includes(options.target)
  const isAvif = options.target === 'avif'
  const resize = options.resize

  const patchResize = (patch: Partial<ResizeOptions>) => {
    onChange({ resize: { ...resize, ...patch } })
  }

  const setMode = (mode: ResizeMode) => {
    if (mode === resize.mode) return
    if (mode === 'none') {
      onChange({ resize: { mode: 'none' } })
      return
    }
    if (mode === 'scale') {
      onChange({ resize: { mode: 'scale', scale: resize.scale ?? 50 } })
      return
    }
    onChange({
      resize: {
        mode,
        width: resize.width ?? 1920,
        height: resize.height ?? 1080,
      },
    })
  }

  const dimension = (raw: string): number | undefined => {
    const n = Math.round(Number(raw))
    if (!Number.isFinite(n) || n <= 0) return undefined
    return Math.min(n, 20000)
  }

  return (
    <section
      aria-label="Conversion settings"
      className="flex flex-col gap-7 rounded-xl border border-hairline bg-surface/70 p-5"
    >
      {/* Target format ------------------------------------------------ */}
      <div className="flex flex-col gap-2.5">
        <SectionLabel>Convert to</SectionLabel>
        <FormatPicker
          value={options.target}
          onChange={(target: ImageFormat) => onChange({ target })}
          idPrefix={prefix}
          label="Target format"
        />
      </div>

      {/* Quality ------------------------------------------------------ */}
      <div className="flex flex-col gap-2.5">
        <div className="flex items-baseline justify-between gap-4">
          <label htmlFor={qualityId} className="text-sm font-medium text-ink">
            Quality
          </label>
          <span
            className={`text-sm tabular-nums ${lossless ? 'text-ink-dim/60' : 'text-accent'}`}
          >
            {lossless ? '—' : options.quality}
          </span>
        </div>
        <input
          id={qualityId}
          type="range"
          min={1}
          max={100}
          step={1}
          value={options.quality}
          disabled={lossless}
          aria-describedby={lossless ? qualityNoteId : undefined}
          className={RANGE_CLASS}
          onChange={(event) => onChange({ quality: Number(event.target.value) })}
        />
        <p
          id={lossless ? qualityNoteId : undefined}
          className="text-xs leading-relaxed text-ink-dim"
        >
          {lossless
            ? LOSSLESS_NOTE[options.target] ??
              'This format is lossless, so quality has no effect on the output.'
            : 'Lower means a smaller file and more visible artefacts. 75–85 is a good default.'}
        </p>
      </div>

      {/* SVG wrapper ---------------------------------------------------- */}
      {options.target === 'svg' ? (
        <p className="rounded-lg border border-hairline bg-canvas/60 px-3 py-2.5 text-xs leading-relaxed text-ink-dim">
          This isn't real vector art — no browser or encoder can trace a photo into
          paths. It embeds a PNG inside an SVG wrapper, so the file won't get
          smaller and resizing later still resamples the same pixels. Useful when a
          tool insists on an <span className="font-mono">.svg</span>, not for
          compression.
        </p>
      ) : null}

      {/* AVIF effort -------------------------------------------------- */}
      {isAvif ? (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-baseline justify-between gap-4">
            <label htmlFor={effortId} className="text-sm font-medium text-ink">
              AVIF effort
            </label>
            <span className="text-sm tabular-nums text-accent">{options.effort}</span>
          </div>
          <input
            id={effortId}
            type="range"
            min={0}
            max={9}
            step={1}
            value={options.effort}
            className={RANGE_CLASS}
            onChange={(event) => onChange({ effort: Number(event.target.value) })}
          />
          <p className="text-xs leading-relaxed text-ink-dim">
            How hard the encoder searches. Higher gives a smaller file for the same
            quality but is dramatically slower — 9 can take many seconds per megapixel
            in the browser.
          </p>
        </div>
      ) : null}

      {/* Resize ------------------------------------------------------- */}
      <div className="flex flex-col gap-2.5">
        <SectionLabel>Resize</SectionLabel>
        <div
          role="radiogroup"
          aria-label="Resize mode"
          className="inline-flex w-full items-center gap-1 rounded-xl border border-hairline bg-canvas/60 p-1"
          onKeyDown={(event) => {
            const index = RESIZE_MODES.findIndex((m) => m.mode === resize.mode)
            const last = RESIZE_MODES.length - 1
            let next: number
            switch (event.key) {
              case 'ArrowRight':
              case 'ArrowDown':
                next = index === last ? 0 : index + 1
                break
              case 'ArrowLeft':
              case 'ArrowUp':
                next = index <= 0 ? last : index - 1
                break
              case 'Home':
                next = 0
                break
              case 'End':
                next = last
                break
              default:
                return
            }
            event.preventDefault()
            const entry = RESIZE_MODES[next]
            if (!entry) return
            const el = document.getElementById(`${prefix}-resize-${entry.mode}`)
            if (el instanceof HTMLElement) el.focus()
            setMode(entry.mode)
          }}
        >
          {RESIZE_MODES.map(({ mode, label }) => {
            const checked = mode === resize.mode
            return (
              <button
                key={mode}
                id={`${prefix}-resize-${mode}`}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={checked ? 0 : -1}
                onClick={() => setMode(mode)}
                className={[
                  'flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors duration-150',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                  checked
                    ? 'border-accent/40 bg-accent/20 text-accent-hi'
                    : 'border-transparent text-ink-dim hover:bg-surface-2/70 hover:text-ink',
                ].join(' ')}
              >
                {label}
              </button>
            )
          })}
        </div>

        {resize.mode === 'fit' || resize.mode === 'exact' ? (
          <div className="grid grid-cols-2 gap-3 pt-1">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={widthId} className="text-xs text-ink-dim">
                Width (px)
              </label>
              <input
                id={widthId}
                type="number"
                min={1}
                max={20000}
                step={1}
                inputMode="numeric"
                placeholder="1920"
                value={resize.width ?? ''}
                className={INPUT_CLASS}
                onChange={(event) => patchResize({ width: dimension(event.target.value) })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={heightId} className="text-xs text-ink-dim">
                Height (px)
              </label>
              <input
                id={heightId}
                type="number"
                min={1}
                max={20000}
                step={1}
                inputMode="numeric"
                placeholder="1080"
                value={resize.height ?? ''}
                className={INPUT_CLASS}
                onChange={(event) =>
                  patchResize({ height: dimension(event.target.value) })
                }
              />
            </div>
          </div>
        ) : null}

        {resize.mode === 'scale' ? (
          <div className="flex flex-col gap-2 pt-1">
            <div className="flex items-baseline justify-between gap-4">
              <label htmlFor={scaleId} className="text-xs text-ink-dim">
                Scale
              </label>
              <span className="text-sm tabular-nums text-accent">
                {resize.scale ?? 100}%
              </span>
            </div>
            <input
              id={scaleId}
              type="range"
              min={1}
              max={200}
              step={1}
              value={resize.scale ?? 100}
              className={RANGE_CLASS}
              onChange={(event) => patchResize({ scale: Number(event.target.value) })}
            />
          </div>
        ) : null}

        <p className="text-xs leading-relaxed text-ink-dim">{RESIZE_HINT[resize.mode]}</p>
      </div>

      {/* Background matte --------------------------------------------- */}
      {opaque ? (
        <div className="flex flex-col gap-2.5">
          <label htmlFor={colorId} className="text-sm font-medium text-ink">
            Background
          </label>
          <div className="flex items-center gap-3">
            <input
              id={colorId}
              type="color"
              value={/^#[0-9a-f]{6}$/i.test(options.background) ? options.background : '#ffffff'}
              className="h-10 w-12 shrink-0 cursor-pointer rounded-lg border border-hairline bg-canvas p-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              onChange={(event) => onChange({ background: event.target.value.toLowerCase() })}
            />
            <div className="min-w-0 flex-1">
              <HexField
                id={hexId}
                value={options.background}
                onCommit={(hex) => onChange({ background: hex })}
              />
            </div>
          </div>
          <p className="text-xs leading-relaxed text-ink-dim">
            JPEG cannot store transparency. Transparent pixels are composited onto this
            colour instead of turning black.
          </p>
        </div>
      ) : null}
    </section>
  )
}

export default OptionsPanel
