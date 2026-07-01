// ---------------------------------------------------------------------------
// Shared driver for the "send data to a lazily-created Worker running a
// transformers.js pipeline, get progress + a correlated result back" pattern
// used by transcribe.ts (Whisper) and autoReframe.ts (object detection), and
// by future worker-based AI jobs. Replaces the hand-rolled attach/detach-per-
// call Promise both files used to duplicate, and gives every job cooperative
// cancellation (transcribe had none before this).
//
// Worker message contract every worker on this helper follows:
//   -> {..., id}                         one call, always carries its id
//   <- {type:'progress', data}           model-load progress, NO id (broadcast
//                                        to every in-flight call's onProgress)
//   <- {type:'result', id, ...payload}   success, terminal
//   <- {type:'error', id, error}         failure, terminal
//   <- {type:<anything else>, id, ...}   job-specific interim status, forwarded
//                                        to that call's onStatus (non-terminal)
// ---------------------------------------------------------------------------

export class JobCancelled extends Error {
  constructor() {
    super('cancelled')
    this.name = 'JobCancelled'
  }
}

/** Raw shape of a transformers.js progress_callback payload. */
export interface ModelLoadProgress {
  status?: string
  file?: string
  progress?: number // 0..100
}

/** Normalized "loading a model" progress — the one thing every worker job
 *  shares, regardless of what it's actually computing. */
export interface LoadProgress {
  stage: 'loading'
  progress?: number // 0..1
  file?: string
}

/** Parse a raw transformers.js progress_callback payload into LoadProgress. */
export function parseModelProgress(data: ModelLoadProgress | undefined): LoadProgress {
  if (data?.status === 'progress') {
    return { stage: 'loading', progress: (data.progress ?? 0) / 100, file: data.file }
  }
  return { stage: 'loading', file: data?.file }
}

interface WorkerMessage {
  type: string
  id?: number
  [key: string]: unknown
}

interface PendingCall<TOut> {
  resolve: (v: TOut) => void
  reject: (e: Error) => void
  onProgress?: (p: LoadProgress) => void
  onStatus?: (msg: WorkerMessage) => void
  timeoutMs: number
  timer: ReturnType<typeof setTimeout>
}

export interface CallOptions<TOut> {
  onProgress?: (p: LoadProgress) => void
  /** Any non-terminal message the worker sends for this call's id (e.g. an
   *  interim "status" message), other than the built-in progress/result/error. */
  onStatus?: (msg: WorkerMessage) => void
  /** Checked BEFORE posting to the worker. A call already sent to the worker
   *  always runs to completion/error — cancellation only stops the NEXT call. */
  shouldCancel?: () => boolean
  transfer?: Transferable[]
  /** Rejects the call if no message at all (progress, status, result, or
   *  error) arrives for this long — a crashed/hung worker otherwise leaves
   *  the caller (and any "Stop" button relying on the promise settling)
   *  waiting forever, since a call already posted only settles via a worker
   *  message. Resets on every message, so a slow-but-progressing model
   *  download never times out. Default 60s. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 60_000

/**
 * One lazily-created Worker plus a correlation table for in-flight calls.
 * Construct ONE of these per worker module at the call site's module scope.
 */
export class WorkerJob<TIn extends object, TOut extends object> {
  private worker: Worker | null = null
  private nextId = 1
  private pending = new Map<number, PendingCall<TOut>>()

  constructor(private makeWorker: () => Worker) {}

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = this.makeWorker()
      this.worker.addEventListener('message', this.onMessage)
    }
    return this.worker
  }

  private bumpTimeout(id: number, entry: PendingCall<TOut>): void {
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => this.failTimeout(id), entry.timeoutMs)
  }

  /** No message at all arrived within the timeout window — the worker is
   *  presumed dead/hung. Terminate it so the NEXT call gets a fresh one
   *  instead of hanging against the same broken instance again. */
  private failTimeout(id: number): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    entry.reject(new Error('Worker job timed out — it may have crashed. Please try again.'))
    this.terminate()
  }

  private onMessage = (e: MessageEvent): void => {
    const msg = e.data as WorkerMessage
    if (msg.type === 'progress') {
      const p = parseModelProgress(msg.data as ModelLoadProgress | undefined)
      for (const [id, entry] of this.pending) {
        this.bumpTimeout(id, entry)
        entry.onProgress?.(p)
      }
      return
    }
    const id = msg.id
    if (id == null) return
    const entry = this.pending.get(id)
    if (!entry) return
    if (msg.type === 'error') {
      clearTimeout(entry.timer)
      this.pending.delete(id)
      entry.reject(new Error((msg.error as string) || 'Worker job failed.'))
    } else if (msg.type === 'result') {
      clearTimeout(entry.timer)
      this.pending.delete(id)
      const { type: _type, id: _id, ...payload } = msg
      entry.resolve(payload as unknown as TOut)
    } else {
      this.bumpTimeout(id, entry)
      entry.onStatus?.(msg)
    }
  }

  /** Make one call, correlated by an auto-incrementing id. */
  call(message: TIn, opts?: CallOptions<TOut>): Promise<TOut> {
    if (opts?.shouldCancel?.()) return Promise.reject(new JobCancelled())
    const w = this.ensureWorker()
    const id = this.nextId++
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    return new Promise<TOut>((resolve, reject) => {
      const timer = setTimeout(() => this.failTimeout(id), timeoutMs)
      this.pending.set(id, { resolve, reject, onProgress: opts?.onProgress, onStatus: opts?.onStatus, timeoutMs, timer })
      w.postMessage({ ...message, id }, opts?.transfer ?? [])
    })
  }

  /** Explicit teardown. Also invoked automatically after a call times out,
   *  since a worker that produced no message for that long is presumed dead —
   *  reusing it for the next call would likely just hang again. Rejects any
   *  OTHER still-pending calls too (not just the one that timed out): once
   *  the worker is gone, none of them can ever get a real answer. */
  terminate(): void {
    this.worker?.removeEventListener('message', this.onMessage)
    this.worker?.terminate()
    this.worker = null
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error('Worker was terminated before responding.'))
    }
    this.pending.clear()
  }
}
