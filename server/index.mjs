/**
 * Download helper for Grain's "From link" tab.
 *
 * Grain itself is a static site and cannot fetch YouTube streams (CORS, signed
 * URLs), so this small server wraps yt-dlp + ffmpeg. It runs in two modes:
 *
 *  - Local (default): binds 127.0.0.1 and refuses any Host header that is not
 *    a loopback name, so a web page on another origin cannot reach it through
 *    DNS rebinding.
 *  - Public (GRAIN_PUBLIC=1): binds 0.0.0.0 for hosting. Browsers on the Grain
 *    site are let in through CORS (ALLOWED_ORIGINS), and the server enforces an
 *    optional access code, a concurrency cap, a per-IP rate limit and a maximum
 *    video length.
 *
 * Environment:
 *   PORT / GRAIN_HELPER_PORT  listen port (default 8787)
 *   GRAIN_PUBLIC              "1" for public mode
 *   ALLOWED_ORIGINS           comma-separated origins allowed by CORS
 *   ACCESS_TOKEN              if set, info/download require it
 *   MAX_CONCURRENT            simultaneous downloads (default 2)
 *   RATE_PER_HOUR             requests per IP per hour in public mode (default 30)
 *   MAX_SECONDS               longest video accepted, 0 = no limit (default 3600 public, 0 local)
 *   YTDLP_COOKIES_FILE        Netscape cookies file passed to yt-dlp
 *
 * Intended for content you have the right to save.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const env = process.env
const PUBLIC = env.GRAIN_PUBLIC === '1'
const PORT = Number(env.PORT ?? env.GRAIN_HELPER_PORT ?? 8787)
const HOST = PUBLIC ? '0.0.0.0' : '127.0.0.1'
const ORIGINS = new Set(
  (env.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean),
)
const TOKEN = env.ACCESS_TOKEN ?? ''
const MAX_CONCURRENT = Number(env.MAX_CONCURRENT ?? 2)
const RATE_PER_HOUR = Number(env.RATE_PER_HOUR ?? 30)
const MAX_SECONDS = Number(env.MAX_SECONDS ?? (PUBLIC ? 3600 : 0))
const COOKIES = env.YTDLP_COOKIES_FILE ?? ''

const AUDIO = { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', opus: 'audio/ogg' }
const VIDEO = { mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska' }
const ALLOWED_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be',
])

let active = 0
const hits = new Map()

function has(cmd) {
  return !spawnSync(cmd, ['--version'], { stdio: 'ignore', shell: false }).error
}

function clientIp(req) {
  const forwarded = PUBLIC ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : ''
  return forwarded || req.socket.remoteAddress || 'unknown'
}

/** Sliding one-hour window per IP. Public mode only. */
function rateLimited(ip) {
  if (!PUBLIC || RATE_PER_HOUR <= 0) return false
  const now = Date.now()
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 3_600_000)
  recent.push(now)
  hits.set(ip, recent)
  return recent.length > RATE_PER_HOUR
}

setInterval(() => {
  const now = Date.now()
  for (const [ip, times] of hits) {
    if (times.every((t) => now - t >= 3_600_000)) hits.delete(ip)
  }
}, 600_000).unref()

function parseVideoUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  return ALLOWED_HOSTS.has(url.hostname.toLowerCase()) ? url.toString() : null
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function lastLine(text) {
  const lines = text.trim().split('\n').filter(Boolean)
  return (lines.findLast((l) => l.startsWith('ERROR')) ?? lines.at(-1) ?? '').replace(/^ERROR: /, '')
}

/** YouTube blocks many datacenter IPs; say so instead of echoing yt-dlp's wall of text. */
function friendly(message) {
  if (/sign in to confirm|not a bot/i.test(message)) {
    return 'YouTube is blocking this server right now. Try again later, or run Grain locally.'
  }
  return message
}

function baseArgs() {
  const args = ['--no-playlist', '--no-warnings']
  if (COOKIES) args.push('--cookies', COOKIES)
  return args
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(friendly(lastLine(err)) || `yt-dlp exited ${code}`)),
    )
  })
}

function safeName(title, ext) {
  const base = title.replace(/[\\/:*?"<>|\p{Cc}]/gu, '_').trim().slice(0, 120) || 'download'
  return `${base}.${ext}`
}

async function info(url) {
  const data = JSON.parse(await run([...baseArgs(), '-J', '--', url]))
  const heights = [...new Set((data.formats ?? []).map((f) => f.height).filter(Boolean))]
  return {
    title: data.title ?? 'video',
    uploader: data.uploader ?? '',
    duration: data.duration ?? 0,
    thumbnail: data.thumbnail ?? '',
    heights: heights.sort((a, b) => b - a),
    tooLong: MAX_SECONDS > 0 && (data.duration ?? 0) > MAX_SECONDS,
    maxSeconds: MAX_SECONDS,
  }
}

async function download(url, query, res) {
  const format = query.get('format') ?? 'mp4'
  const isAudio = format in AUDIO
  if (!isAudio && !(format in VIDEO)) return json(res, 400, { error: 'Unsupported format' })

  const quality = Number(query.get('quality'))
  const dir = await mkdtemp(join(tmpdir(), 'grain-'))
  const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => {})
  const args = [...baseArgs(), '--no-progress', '-o', join(dir, 'out.%(ext)s')]
  if (MAX_SECONDS > 0) args.push('--match-filters', `duration<=${MAX_SECONDS}`)

  if (isAudio) {
    // quality = kbps for lossy formats; ignored for wav.
    const kbps = [64, 96, 128, 160, 192, 256, 320].includes(quality) ? `${quality}K` : '0'
    args.push('-f', 'ba/b', '-x', '--audio-format', format, '--audio-quality', kbps)
  } else {
    const h = Number.isInteger(quality) && quality > 0 ? quality : 4320
    const sort = format === 'mp4' ? `res:${h},vcodec:h264,acodec:aac` : `res:${h}`
    args.push('-f', 'bv*+ba/b', '-S', sort, '--merge-output-format', format)
  }
  args.push('--', url)

  const child = spawn('yt-dlp', args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  child.stderr.on('data', (d) => (err += d))
  // Client gone (cancelled / tab closed): stop the download and tidy up.
  res.on('close', () => {
    if (child.exitCode === null) child.kill()
  })

  const code = await new Promise((resolve) => {
    child.on('error', () => resolve(-1))
    child.on('close', resolve)
  })
  if (code !== 0) {
    await cleanup()
    if (!res.headersSent) json(res, 502, { error: friendly(lastLine(err)) || 'Download failed' })
    return
  }

  const file = (await readdir(dir)).find((f) => f.startsWith('out.'))
  if (!file) {
    await cleanup()
    const why = MAX_SECONDS > 0 ? ` (videos over ${Math.round(MAX_SECONDS / 60)} minutes are not allowed)` : ''
    return json(res, 502, { error: `No output was produced${why}` })
  }
  const path = join(dir, file)
  const ext = file.split('.').pop()
  const { size } = await stat(path)
  const name = safeName(query.get('name') ?? 'download', ext)
  res.writeHead(200, {
    'Content-Type': AUDIO[ext] ?? VIDEO[ext] ?? 'application/octet-stream',
    'Content-Length': size,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'no-store',
  })
  const stream = createReadStream(path)
  stream.pipe(res)
  res.on('close', () => {
    stream.destroy()
    cleanup()
  })
}

function applyCors(req, res) {
  const origin = String(req.headers.origin ?? '').replace(/\/$/, '')
  if (!origin || !ORIGINS.has(origin)) return
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Headers', 'X-Grain-Token')
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition')
}

const server = createServer(async (req, res) => {
  let counted = false
  try {
    applyCors(req, res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      return res.end()
    }
    if (!PUBLIC) {
      const host = (req.headers.host ?? '').replace(/:\d+$/, '')
      if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return json(res, 403, { error: 'Forbidden' })
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' })

    const { pathname, searchParams } = new URL(req.url ?? '/', `http://${HOST}`)
    if (pathname === '/api/health') {
      return json(res, 200, {
        ok: true,
        ytdlp: has('yt-dlp'),
        ffmpeg: has('ffmpeg'),
        tokenRequired: TOKEN !== '',
        maxSeconds: MAX_SECONDS,
      })
    }
    if (pathname === '/api/info' || pathname === '/api/download') {
      if (TOKEN && req.headers['x-grain-token'] !== TOKEN) {
        return json(res, 401, { error: 'Wrong or missing access code' })
      }
      if (rateLimited(clientIp(req))) {
        return json(res, 429, { error: 'Too many requests. Try again in a while.' })
      }
      const url = parseVideoUrl(searchParams.get('url') ?? '')
      if (!url) return json(res, 400, { error: 'Paste a valid YouTube link' })
      if (active >= MAX_CONCURRENT) {
        return json(res, 503, { error: 'The server is busy. Try again in a minute.' })
      }
      active += 1
      counted = true
      if (pathname === '/api/info') return json(res, 200, await info(url))
      return await download(url, searchParams, res)
    }
    json(res, 404, { error: 'Not found' })
  } catch (cause) {
    if (!res.headersSent) json(res, 500, { error: cause instanceof Error ? cause.message : 'Server error' })
  } finally {
    if (counted) {
      // A download keeps its slot until the response is fully sent or aborted.
      if (res.writableEnded || res.destroyed) active -= 1
      else res.on('close', () => (active -= 1))
    }
  }
})

server.requestTimeout = 0
server.listen(PORT, HOST, () => {
  const missing = ['yt-dlp', 'ffmpeg'].filter((c) => !has(c))
  console.log(`Grain helper (${PUBLIC ? 'public' : 'local'}) on http://${HOST}:${PORT}`)
  if (missing.length) console.warn(`Missing on PATH: ${missing.join(', ')} — install them first.`)
  if (PUBLIC && ORIGINS.size === 0) console.warn('ALLOWED_ORIGINS is empty: no browser site can call this server.')
})
