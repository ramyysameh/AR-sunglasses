import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  GENERATION_MODEL,
  buildGenerationRequest,
  startGeneration,
  checkGeneration,
  cancelGeneration,
  setGeneratorClient,
} from '../app/modelGenerator.server.js'
import { MAX_GLB_BYTES } from '../app/remoteGlb.server.js'

const apiError = (status) => Object.assign(new Error(`${status} status code`), { status })

function fakeClient({
  response = null,
  containerFiles = [],
  fileBytes = Buffer.from('glTF-bytes'),
  listError = null,
  downloadError = null,
  uploadError = null,
} = {}) {
  const calls = { created: [], downloaded: [], listed: [], cancelled: [], uploaded: [] }
  return {
    calls,
    files: {
      create: async (params) => {
        if (uploadError) throw uploadError
        calls.uploaded.push(params)
        return { id: `file_${calls.uploaded.length}` }
      },
    },
    responses: {
      create: async (body) => {
        calls.created.push(body)
        return { id: 'resp_1', status: 'queued' }
      },
      retrieve: async () => response,
      cancel: async (id) => {
        calls.cancelled.push(id)
        throw new Error('already finished')
      },
    },
    containers: {
      files: {
        list: (containerId) => {
          calls.listed.push(containerId)
          return (async function* () {
            if (listError) throw listError
            yield* containerFiles
          })()
        },
        content: {
          retrieve: async (fileId, { container_id }) => {
            calls.downloaded.push({ fileId, containerId: container_id })
            if (downloadError) throw downloadError
            return new Response(fileBytes)
          },
        },
      },
    },
  }
}

const citedMessage = {
  type: 'message',
  content: [{
    type: 'output_text',
    text: 'Saved the model.',
    annotations: [
      { type: 'container_file_citation', container_id: 'cntr_1', file_id: 'cfile_png', filename: 'preview.png' },
      { type: 'container_file_citation', container_id: 'cntr_1', file_id: 'cfile_glb', filename: 'model.glb' },
    ],
  }],
}

afterEach(() => {
  setGeneratorClient(null)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('buildGenerationRequest', () => {
  it('asks gpt-6.1-sol, in the background, with the code interpreter and every photo in order', () => {
    const body = buildGenerationRequest({ images: ['u1', 'u2', 'u3', 'u4'] })
    expect(body.model).toBe(GENERATION_MODEL)
    expect(GENERATION_MODEL).toBe('gpt-6.1-sol')
    expect(body.background).toBe(true)
    expect(body.tools).toEqual([{ type: 'code_interpreter', container: { type: 'auto' } }])
    expect(body.instructions).toMatch(/AR_bridge/)
    expect(body.instructions).toMatch(/\/mnt\/data\/model\.glb/)
    const parts = body.input[0].content
    expect(parts.filter((p) => p.type === 'input_image').map((p) => p.image_url)).toEqual(['u1', 'u2', 'u3', 'u4'])
  })

  it('keeps logos and asks for a detail inventory', () => {
    const { instructions } = buildGenerationRequest({ images: ['u1', 'u2', 'u3'] })
    expect(instructions).not.toMatch(/No logos/)
    expect(instructions).toMatch(/Logo_1/)
    expect(instructions).toMatch(/alphaMode MASK/)
    expect(instructions).toMatch(/inventory/)
  })

  it('gives the code interpreter the uploaded photo files and says where they are', () => {
    const body = buildGenerationRequest({ images: ['u1', 'u2', 'u3'], fileIds: ['file_1', 'file_2', 'file_3'] })
    expect(body.tools).toEqual([{ type: 'code_interpreter', container: { type: 'auto', file_ids: ['file_1', 'file_2', 'file_3'] } }])
    expect(body.input[0].content.at(-1)).toMatchObject({ type: 'input_text', text: expect.stringMatching(/\/mnt\/data/) })
  })

  it('appends retry feedback as a final text part', () => {
    const body = buildGenerationRequest({ images: ['a', 'b', 'c'], feedback: 'Fix the hinges.' })
    const last = body.input[0].content.at(-1)
    expect(last).toEqual({ type: 'input_text', text: 'A previous attempt was rejected. Fix this: Fix the hinges.' })
  })
})

describe('startGeneration', () => {
  const PHOTOS = [
    'https://bucket.example/generation-photos/s/one.jpg?X-Amz-Signature=x',
    'https://bucket.example/generation-photos/s/two.png?X-Amz-Signature=x',
    'https://bucket.example/generation-photos/s/three.webp?X-Amz-Signature=x',
  ]

  it('uploads each photo as an expiring file and hands the ids to the code interpreter', async () => {
    const fetched = []
    vi.stubGlobal('fetch', async (url) => {
      fetched.push(url)
      return new Response(Buffer.from('img'))
    })
    const client = fakeClient()
    setGeneratorClient(client)
    await expect(startGeneration({ images: PHOTOS })).resolves.toEqual({ providerJobId: 'resp_1' })
    expect(fetched).toEqual(PHOTOS)
    expect(client.calls.uploaded.map((u) => u.file.name)).toEqual(['photo_1.jpg', 'photo_2.png', 'photo_3.webp'])
    for (const upload of client.calls.uploaded) {
      expect(upload.purpose).toBe('user_data')
      expect(upload.expires_after).toEqual({ anchor: 'created_at', seconds: 86400 })
    }
    expect(client.calls.created[0].tools[0].container).toEqual({ type: 'auto', file_ids: ['file_1', 'file_2', 'file_3'] })
    // The model still sees the photos as images too.
    expect(client.calls.created[0].input[0].content.filter((p) => p.type === 'input_image')).toHaveLength(3)
  })

  it('still starts the job, without photo files, when an upload fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', async () => new Response(Buffer.from('img')))
    const client = fakeClient({ uploadError: new Error('upload refused') })
    setGeneratorClient(client)
    await expect(startGeneration({ images: PHOTOS })).resolves.toEqual({ providerJobId: 'resp_1' })
    expect(client.calls.created[0].tools[0].container).toEqual({ type: 'auto' })
    expect(console.warn).toHaveBeenCalled()
  })

  it('still starts the job when a photo cannot be downloaded', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', async () => new Response('gone', { status: 403 }))
    const client = fakeClient()
    setGeneratorClient(client)
    await expect(startGeneration({ images: PHOTOS })).resolves.toEqual({ providerJobId: 'resp_1' })
    expect(client.calls.uploaded).toEqual([])
    expect(client.calls.created[0].tools[0].container).toEqual({ type: 'auto' })
  })
})

describe('checkGeneration', () => {
  it('reports queued and in-progress jobs as running', async () => {
    for (const status of ['queued', 'in_progress']) {
      setGeneratorClient(fakeClient({ response: { id: 'resp_1', status } }))
      await expect(checkGeneration('resp_1')).resolves.toEqual({ state: 'running' })
    }
  })

  it('downloads the cited .glb from its container', async () => {
    const client = fakeClient({
      response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 10 }, output: [citedMessage] },
    })
    setGeneratorClient(client)
    const result = await checkGeneration('resp_1')
    expect(result.state).toBe('done')
    expect(result.glbBytes.toString()).toBe('glTF-bytes')
    expect(result.usage).toEqual({ input_tokens: 10 })
    expect(client.calls.downloaded).toEqual([{ fileId: 'cfile_glb', containerId: 'cntr_1' }])
  })

  it('falls back to listing the container when the model forgot to cite the file', async () => {
    const client = fakeClient({
      response: {
        id: 'resp_1',
        status: 'completed',
        output: [{ type: 'code_interpreter_call', container_id: 'cntr_2' }, { type: 'message', content: [] }],
      },
      containerFiles: [{ id: 'cfile_a', path: '/mnt/data/notes.txt' }, { id: 'cfile_b', path: '/mnt/data/model.glb' }],
    })
    setGeneratorClient(client)
    const result = await checkGeneration('resp_1')
    expect(result.state).toBe('done')
    expect(client.calls.listed).toEqual(['cntr_2'])
    expect(client.calls.downloaded).toEqual([{ fileId: 'cfile_b', containerId: 'cntr_2' }])
  })

  it('fails with no_glb_output when there is no GLB anywhere', async () => {
    setGeneratorClient(fakeClient({ response: { id: 'resp_1', status: 'completed', output: [] } }))
    await expect(checkGeneration('resp_1')).resolves.toEqual({ state: 'failed', error: 'no_glb_output' })
  })

  it('fails with openai_<status> for failed, incomplete and cancelled jobs, logging why', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (const status of ['failed', 'incomplete', 'cancelled']) {
        const error = status === 'failed' ? { code: 'server_error', message: 'boom' } : null
        const incomplete = status === 'incomplete' ? { reason: 'max_output_tokens' } : null
        setGeneratorClient(fakeClient({ response: { id: 'resp_1', status, error, incomplete_details: incomplete } }))
        await expect(checkGeneration('resp_1')).resolves.toEqual({ state: 'failed', error: `openai_${status}` })
        expect(warn).toHaveBeenLastCalledWith(expect.any(String), 'resp_1', status, error, incomplete)
      }
      expect(warn).toHaveBeenCalledTimes(3)
    } finally {
      warn.mockRestore()
    }
  })

  it('rejects a GLB over the upload size limit', async () => {
    setGeneratorClient(fakeClient({
      response: { id: 'resp_1', status: 'completed', output: [citedMessage] },
      fileBytes: Buffer.alloc(MAX_GLB_BYTES + 1),
    }))
    await expect(checkGeneration('resp_1')).resolves.toEqual({ state: 'failed', error: 'glb_too_large' })
  })

  it('fails with output_expired when the container (or its file) is gone', async () => {
    for (const status of [404, 410]) {
      setGeneratorClient(fakeClient({
        response: { id: 'resp_1', status: 'completed', output: [citedMessage] },
        downloadError: apiError(status),
      }))
      await expect(checkGeneration('resp_1')).resolves.toEqual({ state: 'failed', error: 'output_expired' })
    }
    setGeneratorClient(fakeClient({
      response: { id: 'resp_1', status: 'completed', output: [{ type: 'code_interpreter_call', container_id: 'cntr_2' }] },
      listError: apiError(404),
    }))
    await expect(checkGeneration('resp_1')).resolves.toEqual({ state: 'failed', error: 'output_expired' })
  })

  it('still throws on other download errors, so the next poll tries again', async () => {
    for (const error of [apiError(500), new Error('socket hang up')]) {
      setGeneratorClient(fakeClient({
        response: { id: 'resp_1', status: 'completed', output: [citedMessage] },
        downloadError: error,
      }))
      await expect(checkGeneration('resp_1')).rejects.toBe(error)
    }
  })
})

describe('cancelGeneration', () => {
  it('swallows errors (a job that already finished cannot be cancelled)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const client = fakeClient()
      setGeneratorClient(client)
      await expect(cancelGeneration('resp_1')).resolves.toBeUndefined()
      expect(client.calls.cancelled).toEqual(['resp_1'])
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('buildGenerationRequest by source', () => {
  it('keeps the labelled front/left/right wording for uploads', () => {
    const text = buildGenerationRequest({ images: ['a', 'b', 'c'] }).input[0].content[0].text
    expect(text).toMatch(/front, left side, right side/)
  })

  it('describes product photos as unordered angles and says to model only the glasses', () => {
    const text = buildGenerationRequest({ images: ['a', 'b', 'c', 'd'], source: 'product' }).input[0].content[0].text
    expect(text).not.toMatch(/left side, right side/)
    expect(text).toMatch(/4 product photos/)
    expect(text).toMatch(/different angles/)
    expect(text).toMatch(/only the glasses/)
  })

  it('passes the source through startGeneration', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client = fakeClient()
    setGeneratorClient(client)
    await startGeneration({ images: ['a', 'b', 'c'], source: 'product' })
    expect(client.calls.created[0].input[0].content[0].text).toMatch(/product photos/)
  })
})
