import { join, isAbsolute } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'

// Normalized GLBs are written under <app>/storage/ during upload+calibrate (Task 5).
// storageRef is a filename within that dir; an absolute ref passes through unchanged.
// NOTE: dev-slice local-disk storage only; production hosting swaps this for a CDN/object store (sub-project D).
export const STORAGE_DIR = join(process.cwd(), 'storage')

export function resolveStoragePath(storageRef) {
  return isAbsolute(storageRef) ? storageRef : join(STORAGE_DIR, storageRef)
}

export async function saveModelGlb(storageRef, bytes) {
  await mkdir(STORAGE_DIR, { recursive: true })
  await writeFile(resolveStoragePath(storageRef), bytes)
}
