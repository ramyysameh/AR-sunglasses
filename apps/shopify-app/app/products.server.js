const PRODUCTS_QUERY = `#graphql
  query ProductsByIds($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        featuredImage { url altText }
      }
    }
  }`

export async function fetchProductsByIds(admin, ids) {
  const unique = [...new Set(ids)]
  const result = new Map()
  if (unique.length === 0) return result

  const res = await admin.graphql(PRODUCTS_QUERY, { variables: { ids: unique } })
  const body = await res.json()
  const nodes = body?.data?.nodes ?? []
  for (const node of nodes) {
    if (!node || !node.id) continue
    result.set(node.id, {
      id: node.id,
      title: node.title,
      imageUrl: node.featuredImage?.url ?? null,
      imageAlt: node.featuredImage?.altText ?? null,
    })
  }
  return result
}
