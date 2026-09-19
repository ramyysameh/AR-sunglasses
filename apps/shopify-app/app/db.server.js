import { PrismaClient } from "@prisma/client";

// Prisma's own default pool is num_cpus * 2 + 1, but this app's DATABASE_URL
// pins connection_limit=1. That is the right default when a serverless function
// talks straight to Postgres, but this app's runtime URL is Neon's pooled
// (PgBouncer) endpoint -- see the datasource comment in prisma/schema.prisma --
// where the pooler, not Prisma, is what protects the database from connection
// storms. One connection per instance only serialized concurrent storefront
// requests behind a single socket, and any request that could not get it inside
// pool_timeout (10s) failed with PrismaClientInitializationError. That surfaced
// on /api/tryon-config in production.
//
// Raised here rather than in DATABASE_URL so the change is reviewable and
// version-controlled instead of living in an encrypted environment variable,
// and so local and preview environments get the same treatment. Set
// PRISMA_CONNECTION_LIMIT to tune it without a code deploy.
export const DEFAULT_CONNECTION_LIMIT = 5;

/**
 * Replace (not append) `connection_limit` on a database URL. Appending would
 * leave two copies of the parameter in a URL that already pins it to 1.
 *
 * Only the query string is rebuilt: the credential portion is copied through
 * byte for byte, because round-tripping the whole URL risks re-encoding a
 * password and breaking authentication.
 * @param {string} url
 * @param {number|string} limit
 * @returns {string}
 */
export function withConnectionLimit(url, limit = DEFAULT_CONNECTION_LIMIT) {
  if (typeof url !== "string" || url === "") return url;

  const queryStart = url.indexOf("?");
  if (queryStart === -1) return `${url}?connection_limit=${limit}`;

  const base = url.slice(0, queryStart);
  const params = new URLSearchParams(url.slice(queryStart + 1));
  params.set("connection_limit", String(limit));
  return `${base}?${params.toString()}`;
}

function createClient() {
  // eslint-disable-next-line no-undef
  const url = process.env.DATABASE_URL;
  // No URL configured (some unit tests import this module without a database):
  // let Prisma resolve the datasource itself rather than handing it undefined.
  if (!url) return new PrismaClient();

  // eslint-disable-next-line no-undef
  const limit = process.env.PRISMA_CONNECTION_LIMIT || DEFAULT_CONNECTION_LIMIT;
  return new PrismaClient({
    datasources: { db: { url: withConnectionLimit(url, limit) } },
  });
}

// eslint-disable-next-line no-undef
if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = createClient();
  }
}

const prisma = global.prismaGlobal ?? createClient();

export default prisma;
