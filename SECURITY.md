# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability**. Please do not open a public issue for anything that could expose a
reader's Amazon session or highlights. You will get an acknowledgement within a week.

## Supported versions

The latest published `kindle-mcp-server` release on npm receives fixes.

## What this tool handles

- `kindle-mcp login` saves Amazon session cookies to `~/.kindle-mcp/session.json` (owner-only
  permissions). Your password is never seen or stored. Treat that file, the browser profile next
  to it, and `kindle.db` (your highlights) as private data.
- The MCP server runs over stdio on the machine that holds the store and exposes no network port.
- Sync makes plain GET requests to `read.amazon.com` with those cookies and nothing else; there
  is no telemetry.

Fixtures under `tests/fixtures` are scrubbed copies of real pages: placeholder text, account ids
and tokens replaced. Please keep new fixtures the same way.
