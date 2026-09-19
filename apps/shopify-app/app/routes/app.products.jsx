import { boundary } from '@shopify/shopify-app-react-router/server'
import { redirect } from 'react-router'
import { authenticate } from '../shopify.server'

export const loader = async ({ request }) => {
  await authenticate.admin(request)
  return redirect('/app')
}

export default function ProductsRedirect() {
  return null
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs)
}
