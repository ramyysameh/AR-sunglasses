import { afterEach, describe, expect, it, vi } from 'vitest'

// MediaPipe only fetches the model after it has downloaded and compiled its
// WASM runtime. These tests stand in for that: createFromOptions stays pending
// ("still compiling WASM") until the test releases it.
const wasm = vi.hoisted(() => ({ release: null, options: null }))

vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: {
    forVisionTasks: vi.fn(async (root) => ({ wasmLoaderPath: `${root}/loader.js`, wasmBinaryPath: `${root}/bin.wasm` })),
  },
  FaceLandmarker: {
    createFromOptions: vi.fn((fileset, options) => {
      wasm.options = options
      return new Promise((resolve) => {
        wasm.release = () => resolve({ close: vi.fn() })
      })
    }),
  },
}))

const { FaceTracker } = await import('../../src/tracking/FaceTracker.js')

async function readAll(reader) {
  const chunks = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(...value)
  }
  return chunks
}

afterEach(() => {
  vi.unstubAllGlobals()
  wasm.release = null
  wasm.options = null
})

describe('FaceTracker model download', () => {
  it('starts downloading the model before MediaPipe has finished loading its WASM', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])))
    vi.stubGlobal('fetch', fetchMock)

    const tracker = new FaceTracker({ modelAssetPath: 'https://models.test/face.task' })
    const ready = tracker.init()
    await vi.waitFor(() => expect(wasm.release).toBeTypeOf('function'))

    // WASM is still "compiling" -- the model must already be in flight.
    expect(fetchMock).toHaveBeenCalledWith('https://models.test/face.task')

    wasm.release()
    await ready
    expect(tracker.faceLandmarker).not.toBeNull()
  })

  it('hands MediaPipe the downloaded bytes instead of a URL to fetch again', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([7, 8, 9]))))

    const ready = new FaceTracker({ modelAssetPath: 'https://models.test/face.task' }).init()
    await vi.waitFor(() => expect(wasm.options).not.toBeNull())

    const { baseOptions } = wasm.options
    expect(baseOptions.modelAssetPath).toBeUndefined()
    expect(baseOptions.delegate).toBe('GPU')
    expect(await readAll(baseOptions.modelAssetBuffer)).toEqual([7, 8, 9])

    wasm.release()
    await ready
  })

  it('surfaces a failed model download as the reason MediaPipe could not read its model', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gone', { status: 404 })))

    const ready = new FaceTracker({ modelAssetPath: 'https://models.test/face.task' }).init()
    await vi.waitFor(() => expect(wasm.options).not.toBeNull())

    await expect(readAll(wasm.options.baseOptions.modelAssetBuffer)).rejects.toThrow(/status 404/)
    wasm.release()
    await ready
  })
})
