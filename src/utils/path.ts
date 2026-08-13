/**
 * Relative-path handling for nested-folder conversion.
 *
 * Guiding rule: the exported tree must mirror the uploaded tree. Filenames and
 * folder names are preserved *verbatim* — same casing, same spaces, same
 * punctuation — and only the extension changes, to match the target format.
 *
 * So this module deliberately does NOT "clean up" names. The only things
 * stripped are those that cannot occur in a real file on disk and would make
 * the archive unsafe or malformed: C0 control characters and `..` traversal
 * segments. Everything else survives untouched.
 *
 * A path is treated as a *sequence of segments*, never a string with slashes
 * in it. The single-string `sanitizeName` this replaces mapped `/` to `_`,
 * which flattened `photos/2024/a.png` into `photos_2024_a.png` — fine for one
 * download, wrong for an archive meant to mirror a folder tree.
 */

/**
 * C0 control characters. Built with the RegExp constructor and \u escapes so
 * the source file itself never contains raw control bytes.
 *
 * Note this does NOT include `\/:*?"<>|`: those are illegal on Windows, but a
 * file that reached us already exists on the user's disk, so rewriting them
 * would rename a file the user expects back unchanged.
 */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F]+', 'g')

/**
 * Preserve a path segment as-is, minus anything unrepresentable.
 * Never returns an empty string, so a segment cannot silently collapse and
 * shorten the path.
 */
export function sanitizeSegment(segment: string): string {
  const cleaned = segment.replace(CONTROL_CHARS, '')
  return cleaned.length > 0 ? cleaned : '_'
}

/**
 * Split a relative path into its directory segments and basename, normalising
 * separators and dropping anything that could escape the archive root.
 *
 * `..` is stripped rather than resolved: a folder genuinely named `..` cannot
 * exist, so its only source is a hand-crafted path, and resolving it would let
 * an entry write outside the extraction directory (zip-slip).
 */
export function splitPath(path: string): { dir: string[]; base: string } {
  const segments = path
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s.length > 0 && s !== '.' && s !== '..')
    .map(sanitizeSegment)

  const base = segments.pop() ?? 'image'
  return { dir: segments, base }
}

/** Normalise a whole relative path, preserving its `/` structure and names. */
export function sanitizeRelativePath(path: string): string {
  const { dir, base } = splitPath(path)
  return [...dir, base].join('/')
}

/** The directory portion of a relative path, '' when the file sits at the root. */
export function dirnameOf(path: string): string {
  return splitPath(path).dir.join('/')
}

/** Swap a path's basename, keeping its directory prefix. */
export function withBase(path: string, base: string): string {
  const dir = dirnameOf(path)
  const safeBase = sanitizeSegment(base)
  return dir.length > 0 ? `${dir}/${safeBase}` : safeBase
}

/**
 * Disambiguate a full path against those already used.
 *
 * Only ever triggers on a genuine collision — most notably `a.png` and `a.jpg`
 * in one folder both converting to `a.webp`, where one would otherwise
 * silently overwrite the other. Untouched paths keep their exact original name.
 *
 * Matching is case-insensitive because Windows and macOS extract onto
 * case-insensitive filesystems by default: `A.webp` and `a.webp` are distinct
 * ZIP entries that clobber each other on extract, losing a file with no error.
 * The returned string keeps its original casing; only the collision *test* is
 * folded.
 */
export function uniquePath(path: string, used: Set<string>): string {
  const claim = (candidate: string): string => {
    used.add(candidate.toLowerCase())
    return candidate
  }

  if (!used.has(path.toLowerCase())) return claim(path)

  const slash = path.lastIndexOf('/')
  const dir = slash >= 0 ? path.slice(0, slash + 1) : ''
  const base = slash >= 0 ? path.slice(slash + 1) : path
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''

  let n = 1
  let candidate = `${dir}${stem}-${n}${ext}`
  while (used.has(candidate.toLowerCase())) {
    n += 1
    candidate = `${dir}${stem}-${n}${ext}`
  }
  return claim(candidate)
}

/**
 * The shared leading folder across every path, used to name the ZIP after the
 * folder the user actually dropped. Returns '' when the files came from
 * different roots or sit loose at the top level.
 */
export function commonRootFolder(paths: readonly string[]): string {
  if (paths.length === 0) return ''
  let root: string | null = null
  for (const path of paths) {
    const { dir } = splitPath(path)
    if (dir.length === 0) return ''
    if (root === null) root = dir[0]
    else if (root !== dir[0]) return ''
  }
  return root ?? ''
}
