/**
 * Local helper for Grain's "From link" tab.
 *
 * Grain itself is a static site and cannot fetch YouTube streams (CORS, signed
 * URLs), so this tiny server wraps yt-dlp + ffmpeg. It binds to 127.0.0.1 only
 * and refuses requests whose Host header is not a loopback name, so a web page
 * on another origin cannot reach it through DNS rebinding.
 *
 * Intended for personal use on content you have the right to save.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.env.GRAIN_HELPER_PORT ?? 8787)
const HOST = '127.0.0.1'

const AUDIO = { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', opus: 'audio/ogg' }
const VIDEO = { mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska' }
const ALLOWED_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be',
])

function has(cmd) {
  return !spawnSync(cmd, ['--version'], { stdio: 'ignore', shell: false }).error
}

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

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(lastLine(err) || `yt-dlp exited ${code}`)),
    )
  })
}

function lastLine(text) {
  const lines = text.trim().split('\n').filter(Boolean)
  return (lines.findLast((l) => l.startsWith('ERROR')) ?? lines.at(-1) ?? '').replace(/^ERROR: /, '')
}

function safeName(title, ext) {
  const base = title.replace(/[\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 120) || 'download'
  return `${base}.${ext}`
}

async function info(url) {
  const raw = await run(['--no-playlist', '--no-warnings', '-J', '--', url])
  const data = JSON.parse(raw)
  const heights = [...new Set((data.formats ?? []).map((f) => f.height).filter(Boolean))]
  return {
    title: data.title ?? 'video',
    uploader: data.uploader ?? '',
    duration: data.duration ?? 0,
    thumbnail: data.thumbnail ?? '',
    heights: heights.sort((a, b) => b - a),
  }
}

async function download(url, query, req, res) {
  const format = query.get('format') ?? 'mp4'
  const isAudio = format in AUDIO
  if (!isAudio && !(format in VIDEO)) return json(res, 400, { error: 'Unsupported format' })

  const quality = Number(query.get('quality'))
  const dir = await mkdtemp(join(tmpdir(), 'grain-'))
  const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => {})
  const args = ['--no-playlist', '--no-warnings', '--no-progress', '-o', join(dir, 'out.%(ext)s')]

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
    if (!res.headersSent) json(res, 502, { error: lastLine(err) || 'Download failed' })
    return
  }

  const file = (await readdir(dir)).find((f) => f.startsWith('out.'))
  if (!file) {
    await cleanup()
    return json(res, 502, { error: 'No output was produced' })
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

const server = createServer(async (req, res) => {
  try {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '')
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return json(res, 403, { error: 'Forbidden' })
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' })

    const { pathname, searchParams } = new URL(req.url ?? '/', `http://${HOST}`)
    if (pathname === '/api/health') {
      return json(res, 200, { ok: true, ytdlp: has('yt-dlp'), ffmpeg: has('ffmpeg') })
    }
    if (pathname === '/api/info' || pathname === '/api/download') {
      const url = parseVideoUrl(searchParams.get('url') ?? '')
      if (!url) return json(res, 400, { error: 'Paste a valid YouTube link' })
      if (pathname === '/api/info') return json(res, 200, await info(url))
      return await download(url, searchParams, req, res)
    }
    json(res, 404, { error: 'Not found' })
  } catch (cause) {
    if (!res.headersSent) json(res, 500, { error: cause instanceof Error ? cause.message : 'Server error' })
  }
})

server.listen(PORT, HOST, () => {
  const missing = ['yt-dlp', 'ffmpeg'].filter((c) => !has(c))
  console.log(`Grain helper on http://${HOST}:${PORT}`)
  if (missing.length) console.warn(`Missing on PATH: ${missing.join(', ')} — install them first.`)
})
