# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability**. Please do not open a public issue for anything that could expose a
reader's Amazon session or highlights. You will get an acknowledgement within a week.

## Supported versions

The latest release on GitHub receives fixes. Versions that were published to npm (up to 1.3.3) are no longer
updated; use the release's Claude Desktop bundle or the plugin instead.

## What this tool handles

- `kindle-mcp login` saves Amazon session cookies to `~/.kindle-mcp/session.json` (owner-only
  permissions). Your password is never seen or stored. Treat that file, the browser profile next
  to it, and `kindle.db` (your highlights) as private data.
- The MCP server runs over stdio on the machine that holds the store and exposes no network port.
- Sync makes plain GET requests to `read.amazon.com` with those cookies and nothing else; there
  is no telemetry.

Fixtures under `tests/fixtures` hold placeholder text only: the page markup Amazon uses, with invented titles,
authors, highlights and notes, fake ASINs and no account ids or tokens. A check (`scripts/privacy-check.mjs`)
refuses anything else, in CI and in the git hooks. Please keep new fixtures the same way.
