// ---------------------------------------------------------------------------
// HTTP Range header parsing for the cutroom:// media protocol. Pure, so it is
// unit-testable in plain Node.
// ---------------------------------------------------------------------------

/**
 * Parse a single `bytes=` range against a file of `size` bytes. Returns the
 * inclusive byte span to serve, `null` to ignore the header (serve the whole
 * file with 200), or 'unsatisfiable' (answer 416). Supports `a-b`, `a-` and
 * the suffix form `-n` (the last n bytes).
 */
export function parseRange(header: string, size: number): { start: number; end: number } | null | 'unsatisfiable' {
  const m = /^\s*bytes=(\d*)-(\d*)\s*$/.exec(header)
  if (!m || (m[1] === '' && m[2] === '')) return null // malformed or multi-range
  let start: number
  let end: number
  if (m[1] === '') {
    // Suffix range: the last n bytes.
    const n = parseInt(m[2], 10)
    if (n === 0) return 'unsatisfiable'
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = parseInt(m[1], 10)
    end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1)
  }
  if (start >= size || start > end) return 'unsatisfiable'
  return { start, end }
}
