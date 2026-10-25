/**
 * LinkDownloader — the "From link" tab.
 *
 * Talks to the local helper in `server/` (proxied at /api). Nothing here works
 * on the public static deploy, so the tab probes /api/health first and shows
 * setup instructions instead of a dead form when the helper is not running.
 */

import { useCallback, useEffect, useState } from 'react'

const AUDIO_FORMATS = ['mp3', 'm4a', 'wav', 'opus'] as const
const VIDEO_FORMATS = ['mp4', 'webm', 'mkv'] as const
const AUDIO_BITRATES = [320, 256, 192, 160, 128, 96, 64]

type Kind = 'audio' | 'video'

interface VideoInfo {
  title: string
  uploader: string
  duration: number
  thumbnail: string
  heights: number[]
  tooLong?: boolean
  maxSeconds?: number
}

interface Health {
  ytdlp: boolean
  ffmpeg: boolean
  tokenRequired?: boolean
  maxSeconds?: number
}

type Helper = 'checking' | 'offline' | Health

/** Hosted helper address, baked in at build time. Empty = same-origin /api (local dev). */
const API = String(import.meta.env.VITE_HELPER_URL ?? '').replace(/\/$/, '')
const TOKEN_KEY = 'grain-helper-token'

function loadToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

const FIELD =
  'w-full rounded-lg border border-hairline bg-canvas px-3 py-2 text-sm text-ink placeholder:text-ink-dim/60 hover:border-ink-dim/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
const BUTTON =
  'inline-flex items-center justify-center rounded-lg px-4 py-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40'

function clock(seconds: number): string {
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

async function errorOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string }
    return body.error ?? `Request failed (${res.status})`
  } catch {
    return `Request failed (${res.status})`
  }
}

export function LinkDownloader() {
  const [helper, setHelper] = useState<Helper>('checking')
  const [url, setUrl] = useState('')
  const [info, setInfo] = useState<VideoInfo | null>(null)
  const [kind, setKind] = useState<Kind>('audio')
  const [format, setFormat] = useState<string>('mp3')
  const [quality, setQuality] = useState(192)
  const [height, setHeight] = useState(0)
  const [busy, setBusy] = useState<'info' | 'download' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState(loadToken)

  const probe = useCallback(() => {
    setHelper('checking')
    fetch(`${API}/api/health`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('offline'))))
      .then((h: Health) => setHelper(h))
      .catch(() => setHelper('offline'))
  }, [])

  useEffect(probe, [probe])

  const authHeaders = (): HeadersInit => (token ? { 'X-Grain-Token': token } : {})

  const changeToken = (value: string) => {
    setToken(value)
    try {
      localStorage.setItem(TOKEN_KEY, value)
    } catch {
      // Storage can be blocked; the code just won't be remembered.
    }
  }

  const pickKind = (next: Kind) => {
    setKind(next)
    setFormat(next === 'audio' ? 'mp3' : 'mp4')
  }

  const lookUp = async () => {
    setError(null)
    setInfo(null)
    setBusy('info')
    try {
      const res = await fetch(`${API}/api/info?url=${encodeURIComponent(url.trim())}`, {
        headers: authHeaders(),
      })
      if (!res.ok) throw new Error(await errorOf(res))
      const data = (await res.json()) as VideoInfo
      if (data.tooLong) {
        throw new Error(`That video is longer than the ${Math.round((data.maxSeconds ?? 0) / 60)}-minute limit on this server.`)
      }
      setInfo(data)
      setHeight(0)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not look that up')
    } finally {
      setBusy(null)
    }
  }

  const download = async () => {
    if (!info) return
    setError(null)
    setBusy('download')
    try {
      const q = kind === 'audio' ? quality : height
      const params = new URLSearchParams({ url: url.trim(), format, name: info.title })
      if (q > 0) params.set('quality', String(q))
      const res = await fetch(`${API}/api/download?${params}`, { headers: authHeaders() })
      if (!res.ok) throw new Error(await errorOf(res))
      const blob = await res.blob()
      const link = document.createElement('a')
      const disposition = res.headers.get('Content-Disposition') ?? ''
      const encoded = /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1]
      link.download = encoded ? decodeURIComponent(encoded) : `download.${format}`
      link.href = URL.createObjectURL(blob)
      link.click()
      setTimeout(() => URL.revokeObjectURL(link.href), 10_000)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Download failed')
    } finally {
      setBusy(null)
    }
  }

  if (helper === 'checking') {
    return <p className="mt-6 text-sm text-ink-dim">Looking for the local helper…</p>
  }

  if (helper === 'offline') {
    return (
      <div className="mt-6 rounded-xl border border-dashed border-hairline bg-surface/60 px-5 py-8 text-sm text-ink-dim">
        {API ? (
          <>
            <h2 className="text-base font-medium text-ink">The download server isn't reachable</h2>
            <p className="mt-2 max-w-xl leading-relaxed">
              It may be waking up or temporarily down. Give it a minute and check again.
            </p>
          </>
        ) : (
          <>
            <h2 className="text-base font-medium text-ink">The local helper isn't running</h2>
            <p className="mt-2 max-w-xl leading-relaxed">
              Downloading from a link needs <code>yt-dlp</code> and <code>ffmpeg</code>, which a
              web page can't run. Install both, then start Grain with:
            </p>
            <pre className="mt-3 w-fit rounded-lg border border-hairline bg-canvas px-3 py-2 text-ink">
              npm run dev:full
            </pre>
          </>
        )}
        <button
          type="button"
          onClick={probe}
          className={`${BUTTON} mt-4 border border-hairline bg-surface-2 text-ink hover:border-ink-dim`}
        >
          Check again
        </button>
      </div>
    )
  }

  const missing = [!helper.ytdlp && 'yt-dlp', !helper.ffmpeg && 'ffmpeg'].filter(Boolean)
  const formats = kind === 'audio' ? AUDIO_FORMATS : VIDEO_FORMATS

  return (
    <div className="mt-6 grid gap-5">
      {missing.length > 0 && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100/80">
          The helper is running but {missing.join(' and ')} {missing.length > 1 ? 'were' : 'was'} not
          found on your PATH. Install {missing.length > 1 ? 'them' : 'it'} and restart.
        </p>
      )}

      {helper.tokenRequired && (
        <input
          type="password"
          value={token}
          onChange={(e) => changeToken(e.target.value)}
          placeholder="Access code"
          aria-label="Access code"
          autoComplete="off"
          className={`${FIELD} sm:max-w-xs`}
        />
      )}

      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault()
          if (url.trim()) void lookUp()
        }}
      >
        <input
          type="url"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste a YouTube link"
          aria-label="YouTube link"
          className={FIELD}
        />
        <button
          type="submit"
          disabled={busy !== null || !url.trim()}
          className={`${BUTTON} shrink-0 bg-accent text-accent-ink hover:bg-accent-hi`}
        >
          {busy === 'info' ? 'Looking up…' : 'Look up'}
        </button>
      </form>

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200"
        >
          {error}
        </p>
      )}

      {info && (
        <div className="rounded-xl border border-hairline bg-surface p-4">
          <div className="flex gap-4">
            {info.thumbnail && (
              <img
                src={info.thumbnail}
                alt=""
                referrerPolicy="no-referrer"
                className="h-20 w-36 shrink-0 rounded-lg object-cover"
              />
            )}
            <div className="min-w-0">
              <p className="truncate font-medium" title={info.title}>
                {info.title}
              </p>
              <p className="mt-0.5 truncate text-sm text-ink-dim">
                {info.uploader}
                {info.duration > 0 && ` · ${clock(info.duration)}`}
              </p>
            </div>
          </div>

          <div className="mt-5 grid gap-4 sm:grid-cols-3">
            <label className="grid gap-1.5 text-xs text-ink-dim">
              Type
              <select
                className={FIELD}
                value={kind}
                onChange={(e) => pickKind(e.target.value as Kind)}
              >
                <option value="audio">Audio</option>
                <option value="video">Video</option>
              </select>
            </label>
            <label className="grid gap-1.5 text-xs text-ink-dim">
              Format
              <select className={FIELD} value={format} onChange={(e) => setFormat(e.target.value)}>
                {formats.map((f) => (
                  <option key={f} value={f}>
                    {f.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            {kind === 'audio' ? (
              <label className="grid gap-1.5 text-xs text-ink-dim">
                Bitrate
                <select
                  className={FIELD}
                  value={quality}
                  disabled={format === 'wav'}
                  onChange={(e) => setQuality(Number(e.target.value))}
                >
                  {AUDIO_BITRATES.map((b) => (
                    <option key={b} value={b}>
                      {b} kbps
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="grid gap-1.5 text-xs text-ink-dim">
                Max resolution
                <select
                  className={FIELD}
                  value={height}
                  onChange={(e) => setHeight(Number(e.target.value))}
                >
                  <option value={0}>Best available</option>
                  {info.heights.map((h) => (
                    <option key={h} value={h}>
                      {h}p
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <div className="mt-5 flex items-center gap-3">
            <button
              type="button"
              onClick={() => void download()}
              disabled={busy !== null || missing.length > 0}
              className={`${BUTTON} bg-accent text-accent-ink hover:bg-accent-hi`}
            >
              {busy === 'download' ? 'Preparing file…' : `Download ${format.toUpperCase()}`}
            </button>
            {busy === 'download' && (
              <span className="text-xs text-ink-dim">Long videos can take a few minutes.</span>
            )}
          </div>
        </div>
      )}

      <p className="text-xs leading-relaxed text-ink-dim">
        The link is sent to a helper that fetches it from YouTube for you. Only
        save videos you made or have permission to download — doing otherwise may break YouTube's
        Terms of Service or copyright law.
      </p>
    </div>
  )
}
