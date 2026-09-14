/* eslint-disable react/prop-types -- plain JSX component, no PropTypes lib in use elsewhere */

// Renders whatever tryonStatus.server.js decided. Deliberately dumb: the
// precedence rules live in one tested module, not spread across routes.
export default function StatusBadge({ status }) {
  return <s-badge tone={status.tone}>{status.label}</s-badge>;
}
