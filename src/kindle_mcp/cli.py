"""Command line: the scheduled job and the one-time login both live here.

    kindle-mcp login                     open a browser, sign in to Amazon once
    kindle-mcp sync [--full] [--book X]  pull the cloud notebook
    kindle-mcp import-clippings PATH     merge a My Clippings.txt from the device
    kindle-mcp export [--book X]         write/append Obsidian notes
    kindle-mcp status                    counts and last run
    kindle-mcp doctor [--asin X|--book T] dump live HTML to debug selectors
    kindle-mcp serve                     run the MCP server over stdio
"""
from __future__ import annotations

import argparse
import json
import sys

from .config import Config
from .store import Store


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="kindle-mcp", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("login")
    s = sub.add_parser("sync"); s.add_argument("--full", action="store_true"); s.add_argument("--book")
    s.add_argument("--export", action="store_true", help="also export to Obsidian afterwards")
    c = sub.add_parser("import-clippings"); c.add_argument("path")
    e = sub.add_parser("export"); e.add_argument("--book")
    sub.add_parser("status")
    d = sub.add_parser("doctor"); d.add_argument("--asin"); d.add_argument("--book", help="title fragment; resolved to an ASIN via the library page")
    sub.add_parser("serve")
    args = p.parse_args(argv)

    cfg = Config.load()
    cfg.ensure_dirs()

    if args.cmd == "serve":
        from .server import run
        run()
        return 0
    if args.cmd == "login":
        from .scraper import login
        print("A browser window will open. Sign in to Amazon; this window closes itself when your notebook loads.")
        ok = login(cfg)
        print("Logged in. Session saved." if ok else "Timed out waiting for login.")
        return 0 if ok else 1
    if args.cmd == "doctor":
        from .notebook_parser import parse_annotations, parse_library
        from .scraper import notebook_session
        with notebook_session(cfg) as nb:
            if args.book and not args.asin:
                hits = [b for b in nb.library() if args.book.lower() in b.title.lower()]
                if not hits:
                    print(f"No library book matches '{args.book}'."); return 1
                args.asin = hits[0].asin
                print(f"Resolved '{hits[0].title}' -> {args.asin}")
            html = nb.dump(args.asin)
        out = cfg.home / ("doctor-annotations.html" if args.asin else "doctor-library.html")
        out.write_text(html, encoding="utf-8")
        found = len(parse_annotations(html, args.asin)[0]) if args.asin else len(parse_library(html)[0])
        print(f"Saved {out}\nParser found {found} {'annotations' if args.asin else 'books'} with current selectors.")
        return 0

    store = Store(cfg.db_path)
    try:
        if args.cmd == "sync":
            from .sync import sync_cloud
            stats = sync_cloud(cfg, store, full=args.full, only=args.book)
            print(json.dumps(stats))
            if args.export:
                _export(cfg, store, None)
        elif args.cmd == "import-clippings":
            from .sync import import_clippings
            import_clippings(store, args.path)
        elif args.cmd == "export":
            _export(cfg, store, args.book)
        elif args.cmd == "status":
            print(json.dumps(store.status(), indent=2))
    except Exception as e:                       # actionable message, non-zero exit for cron
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    finally:
        store.close()
    return 0


def _export(cfg: Config, store: Store, book: str | None) -> None:
    from .obsidian import export_all, export_book
    if not cfg.obsidian_vault:
        raise RuntimeError("Set OBSIDIAN_VAULT to your vault path first.")
    results = [export_book(store, book, cfg.obsidian_vault, cfg.obsidian_folder)] if book else \
        export_all(store, cfg.obsidian_vault, cfg.obsidian_folder)
    print(f"Exported {len(results)} book(s), {sum(r['added'] for r in results)} new highlight(s).")


if __name__ == "__main__":
    raise SystemExit(main())
