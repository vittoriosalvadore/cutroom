import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WorkerJob, JobCancelled, parseModelProgress } from './workerJob'

/** Minimal Worker stand-in: records posted messages and lets a test emit a
 *  fake reply through the same 'message' listener WorkerJob subscribes to. */
class FakeWorker {
  private listeners: Array<(e: MessageEvent) => void> = []
  posted: unknown[] = []
  terminated = false

  addEventListener(type: string, cb: (e: MessageEvent) => void): void {
    if (type === 'message') this.listeners.push(cb)
  }
  removeEventListener(type: string, cb: (e: MessageEvent) => void): void {
    if (type === 'message') this.listeners = this.listeners.filter((l) => l !== cb)
  }
  postMessage(msg: unknown): void {
    this.posted.push(msg)
  }
  terminate(): void {
    this.terminated = true
  }
  emit(data: unknown): void {
    const event = { data } as MessageEvent
    for (const l of this.listeners) l(event)
  }
}

describe('parseModelProgress', () => {
  it('normalizes a progress-status payload to a 0..1 fraction', () => {
    expect(parseModelProgress({ status: 'progress', progress: 42, file: 'model.onnx' })).toEqual({
      stage: 'loading',
      progress: 0.42,
      file: 'model.onnx'
    })
  })
  it('falls back to a bare loading stage for other statuses', () => {
    expect(parseModelProgress({ status: 'download', file: 'model.onnx' })).toEqual({
      stage: 'loading',
      file: 'model.onnx'
    })
  })
})

describe('WorkerJob', () => {
  it('resolves with the payload when the worker posts a matching result', async () => {
    const fake = new FakeWorker()
    const job = new WorkerJob<{ type: string }, { value: number }>(() => fake as unknown as Worker)
    const p = job.call({ type: 'ping' })
    const sentId = (fake.posted[0] as { id: number }).id
    fake.emit({ type: 'result', id: sentId, value: 7 })
    await expect(p).resolves.toEqual({ value: 7 })
  })

  it('rejects when the worker posts a matching error', async () => {
    const fake = new FakeWorker()
    const job = new WorkerJob<{ type: string }, object>(() => fake as unknown as Worker)
    const p = job.call({ type: 'ping' })
    const sentId = (fake.posted[0] as { id: number }).id
    fake.emit({ type: 'error', id: sentId, error: 'boom' })
    await expect(p).rejects.toThrow('boom')
  })

  it('demuxes two concurrent calls by id without cross-resolving', async () => {
    const fake = new FakeWorker()
    const job = new WorkerJob<{ type: string }, { value: number }>(() => fake as unknown as Worker)
    const p1 = job.call({ type: 'ping' })
    const p2 = job.call({ type: 'ping' })
    const [id1, id2] = fake.posted.map((m) => (m as { id: number }).id)
    // Reply out of order — id2 first — to prove correlation isn't order-dependent.
    fake.emit({ type: 'result', id: id2, value: 200 })
    fake.emit({ type: 'result', id: id1, value: 100 })
    await expect(p1).resolves.toEqual({ value: 100 })
    await expect(p2).resolves.toEqual({ value: 200 })
  })

  it('broadcasts progress messages (no id) to every in-flight call', async () => {
    const fake = new FakeWorker()
    const job = new WorkerJob<{ type: string }, object>(() => fake as unknown as Worker)
    const onProgress = vi.fn()
    const p = job.call({ type: 'ping' }, { onProgress })
    fake.emit({ type: 'progress', data: { status: 'progress', progress: 50 } })
    expect(onProgress).toHaveBeenCalledWith({ stage: 'loading', progress: 0.5, file: undefined })
    const sentId = (fake.posted[0] as { id: number }).id
    fake.emit({ type: 'result', id: sentId })
    await p
  })

  it('forwards non-terminal, id-matched messages to onStatus', async () => {
    const fake = new FakeWorker()
    const job = new WorkerJob<{ type: string }, object>(() => fake as unknown as Worker)
    const onStatus = vi.fn()
    const p = job.call({ type: 'ping' }, { onStatus })
    const sentId = (fake.posted[0] as { id: number }).id
    fake.emit({ type: 'status', id: sentId, status: 'working' })
    expect(onStatus).toHaveBeenCalledWith({ type: 'status', id: sentId, status: 'working' })
    fake.emit({ type: 'result', id: sentId })
    await p
  })

  it('rejects with JobCancelled before posting when shouldCancel is already true', async () => {
    const fake = new FakeWorker()
    const job = new WorkerJob<{ type: string }, object>(() => fake as unknown as Worker)
    await expect(job.call({ type: 'ping' }, { shouldCancel: () => true })).rejects.toBeInstanceOf(JobCancelled)
    expect(fake.posted.length).toBe(0)
  })

  describe('timeout (a hung/crashed worker must not hang the caller forever)', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('rejects and terminates the worker if nothing arrives within timeoutMs', async () => {
      const fake = new FakeWorker()
      const job = new WorkerJob<{ type: string }, object>(() => fake as unknown as Worker)
      const p = job.call({ type: 'ping' }, { timeoutMs: 1000 })
      const assertion = expect(p).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(1000)
      await assertion
      expect(fake.terminated).toBe(true)
    })

    it('does not time out while progress keeps arriving (resets on activity)', async () => {
      const fake = new FakeWorker()
      const job = new WorkerJob<{ type: string }, object>(() => fake as unknown as Worker)
      const p = job.call({ type: 'ping' }, { timeoutMs: 1000 })
      // Two "almost timeout" progress pings, each resetting the clock.
      await vi.advanceTimersByTimeAsync(800)
      fake.emit({ type: 'progress', data: { status: 'progress', progress: 10 } })
      await vi.advanceTimersByTimeAsync(800)
      fake.emit({ type: 'progress', data: { status: 'progress', progress: 20 } })
      await vi.advanceTimersByTimeAsync(800)
      const sentId = (fake.posted[0] as { id: number }).id
      fake.emit({ type: 'result', id: sentId, value: 1 })
      await expect(p).resolves.toEqual({ value: 1 })
    })

    it('rejects other still-pending calls too when a timeout terminates the worker', async () => {
      const fake = new FakeWorker()
      const job = new WorkerJob<{ type: string }, object>(() => fake as unknown as Worker)
      const stuck = job.call({ type: 'ping' }, { timeoutMs: 1000 })
      const other = job.call({ type: 'ping' }, { timeoutMs: 100_000 }) // wouldn't time out on its own
      const assertion1 = expect(stuck).rejects.toThrow(/timed out/)
      const assertion2 = expect(other).rejects.toThrow(/terminated/)
      await vi.advanceTimersByTimeAsync(1000)
      await assertion1
      await assertion2
    })

    it('a call made after a timeout gets a fresh worker instance', async () => {
      let created = 0
      const workers: FakeWorker[] = []
      const job = new WorkerJob<{ type: string }, object>(() => {
        created++
        const w = new FakeWorker()
        workers.push(w)
        return w as unknown as Worker
      })
      const p1 = job.call({ type: 'ping' }, { timeoutMs: 1000 })
      const assertion = expect(p1).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(1000)
      await assertion
      expect(created).toBe(1)

      const p2 = job.call({ type: 'ping' })
      expect(created).toBe(2) // the dead worker was discarded; a new one was made
      const sentId = (workers[1].posted[0] as { id: number }).id
      workers[1].emit({ type: 'result', id: sentId, value: 9 })
      await expect(p2).resolves.toEqual({ value: 9 })
    })
  })
})
