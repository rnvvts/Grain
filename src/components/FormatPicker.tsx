/**
 * FormatPicker — segmented control over the canonical output formats.
 *
 * Implements the WAI-ARIA radiogroup pattern: one tab stop for the whole
 * group (roving tabindex), arrow keys move *and* select, Home/End jump to
 * the ends. `idPrefix` keeps DOM ids unique because this control is rendered
 * once globally and again inside every file card.
 */

import { useRef, type KeyboardEvent } from 'react'
import { FORMATS, type ImageFormat } from '../types'

const LABEL: Record<ImageFormat, string> = {
  png: 'PNG',
  jpeg: 'JPEG',
  webp: 'WebP',
  avif: 'AVIF',
  svg: 'SVG',
}

export interface FormatPickerProps {
  value: ImageFormat
  onChange: (f: ImageFormat) => void
  /** Unique per rendered instance — used to build the option element ids. */
  idPrefix: string
  /** Accessible name for the group. */
  label?: string
  size?: 'sm' | 'md'
  disabled?: boolean
}

export function FormatPicker({
  value,
  onChange,
  idPrefix,
  label = 'Target format',
  size = 'md',
  disabled = false,
}: FormatPickerProps) {
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([])

  const select = (index: number) => {
    if (disabled) return
    const next = FORMATS[index]
    if (!next) return
    optionRefs.current[index]?.focus()
    if (next !== value) onChange(next)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return
    const current = Math.max(0, FORMATS.indexOf(value))
    const last = FORMATS.length - 1
    let target: number

    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        target = current === last ? 0 : current + 1
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        target = current === 0 ? last : current - 1
        break
      case 'Home':
        target = 0
        break
      case 'End':
        target = last
        break
      default:
        return
    }

    event.preventDefault()
    select(target)
  }

  const pad = size === 'sm' ? 'px-2.5 py-1 text-[11px]' : 'px-3.5 py-1.5 text-xs'

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={[
        'inline-flex w-full items-center gap-1 rounded-xl border border-hairline bg-canvas/60 p-1',
        disabled ? 'opacity-50' : '',
      ].join(' ')}
    >
      {FORMATS.map((format, index) => {
        const checked = format === value
        return (
          <button
            key={format}
            id={`${idPrefix}-format-${format}`}
            ref={(el) => {
              optionRefs.current[index] = el
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={disabled}
            tabIndex={checked ? 0 : -1}
            onClick={() => select(index)}
            className={[
              'flex-1 rounded-lg border font-semibold uppercase tracking-[0.08em] transition-colors duration-150',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
              'disabled:cursor-not-allowed',
              pad,
              checked
                ? 'border-accent/40 bg-accent/20 text-accent-hi'
                : 'border-transparent text-ink-dim hover:bg-surface-2/70 hover:text-ink',
            ].join(' ')}
          >
            {LABEL[format]}
          </button>
        )
      })}
    </div>
  )
}

export default FormatPicker
