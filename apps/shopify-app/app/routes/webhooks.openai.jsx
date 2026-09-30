import prisma from '../db.server'
import { unwrapWebhook } from '../modelGenerator.server'
import { advanceByProviderJob } from '../generations.server'

// OpenAI calls this when a background job ends. Code-interpreter containers
// expire 20 minutes after their last activity, so the GLB has to be collected
// now, not whenever the merchant next opens the Models page.
const FINISHED = new Set(['response.completed', 'response.failed', 'response.incomplete', 'response.cancelled'])

export const action = async ({ request }) => {
  // The signature covers the raw body; read it as text before anything parses it.
  const body = await request.text()
  let event
  try {
    event = await unwrapWebhook(body, Object.fromEntries(request.headers))
  } catch {
    return new Response('invalid signature', { status: 400 })
  }
  if (!FINISHED.has(event.type)) return new Response('ignored')
  try {
    await advanceByProviderJob(prisma, event.data.id)
  } catch (error) {
    // Non-2xx makes OpenAI retry the delivery.
    console.error('OpenAI webhook: advancing generation failed', event.data.id, error)
    return new Response('retry', { status: 500 })
  }
  return new Response('ok')
}
