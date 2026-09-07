import { authenticate } from '../shopify.server'
import prisma from '../db.server'
import { finalizeUpload } from '../models.server'
import { presignModelUpload } from '../storage.server'
import { getActivePlanName } from '../billing.server'

// Resource route (no default export) for the presigned model-upload flow.
//
// This MUST be a resource route, not the app.models UI action: a raw fetch()
// POST to a UI route runs the action but returns the rendered HTML *document*
// (`<!DOCTYPE html>...`), not the action's data — so the client's response.json()
// failed with "Unexpected token '<'". A resource route returns the Response
// as-is, so fetch() + json() gets real JSON. (The map/unmap flows avoid this by
// going through useFetcher, which speaks Remix's data protocol.)
//
// Auth: App Bridge attaches the session token to same-origin relative fetches,
// so authenticate.admin succeeds here just as it does for the UI route.
export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request)

  // Same billing gate as every other mutating path (see app.models action).
  const activePlan = await getActivePlanName(admin, session.shop)
  if (!activePlan) {
    return Response.json({ error: 'No active subscription. Choose a plan to continue.' }, { status: 402 })
  }

  const form = await request.formData()
  const intent = form.get('intent')

  if (intent === 'upload-presign') {
    try {
      return Response.json(await presignModelUpload())
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500 })
    }
  }

  if (intent === 'upload-finalize') {
    const storageRef = form.get('storageRef')?.toString()
    const filename = form.get('filename')?.toString() || null
    try {
      const uploaded = await finalizeUpload(prisma, session.shop, storageRef, filename)
      return Response.json({ uploaded })
    } catch (e) {
      return Response.json({ error: e.message }, { status: 422 })
    }
  }

  return Response.json({ error: 'Unknown action.' }, { status: 400 })
}
