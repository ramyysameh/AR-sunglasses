/**
 * HTTPS variant of the harness server, for testing on a real phone where
 * getUserMedia needs a secure context.
 *
 * A separate config rather than an inline env var in the npm script: npm runs
 * scripts through cmd.exe on Windows, where `VAR=1 vite` is a syntax error, so
 * the flag is set here where it is portable.
 *
 * Note the cert is self-signed -- a phone shows a warning to click through once,
 * and Claude's in-app browser refuses it outright, which is why the plain-HTTP
 * harness exists alongside this one.
 */
process.env.HARNESS_HTTPS = '1'

export { default } from './mock-server.config.mjs'
