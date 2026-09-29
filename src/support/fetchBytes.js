/**
 * Downloads a URL into memory, for assets the try-on starts fetching before the
 * code that consumes them is ready to ask.
 * @param {string} url
 * @param {string} what names the asset in the error, e.g. "face tracker model"
 * @returns {Promise<ArrayBuffer>}
 */
export async function fetchBytes(url, what) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`${what} request failed with status ${response.status}`)
  }
  return response.arrayBuffer()
}
