"""Runs one source on one URL and prints {"catalog", "rows"} or {"error", "kind"} as its last line.

`Kit.collect` starts this as a child process with no DEVIN_/ANTHROPIC_/AWS_ variables, so a source's code (written by
a builder) never runs in the backend's process, which holds those keys.

    python -m server.collect <KIT_DIR> <SOURCE> <URL>
"""
import importlib
import json
import re
import sys
import urllib.error

CATALOG_PAGES = 20


def main(argv=None):
    kit_dir, source, url = (argv or sys.argv[1:])[:3]
    sys.path.insert(0, kit_dir)
    from kit import capture
    from kit.http import NotListed, RateLimited, Refused
    from kit.source import check_source, on_origin
    try:
        if not re.fullmatch(r"[a-z][a-z0-9_]*", source):
            raise ValueError("SOURCE must match [a-z][a-z0-9_]*")
        module = check_source(importlib.import_module(f"sources.{source}"))
        catalog = callable(getattr(module, "listings", None)) and module.KIND == "first_party"
        if callable(getattr(module, "page", None)) and not catalog:
            _, rows = capture.collect_page(module, on_origin(module, url))   # an ALIASES host reads on ORIGIN
        else:
            _, rows = capture.collect(module, max_pages=CATALOG_PAGES)
        out = {"catalog": catalog, "rows": rows}
    except RateLimited as exc:   # before Refused, its parent: slowing down is temporary
        out = {"error": str(exc)[:300], "kind": "rate_limited"}
    except Refused as exc:
        out = {"error": str(exc)[:300], "kind": "blocked"}
    except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
        out = {"error": str(exc)[:300], "kind": "unreachable"}
    except NotListed as exc:
        out = {"error": str(exc)[:300], "kind": "not_listed"}
    except Exception as exc:   # anything in the source's code is that scraper's failure
        out = {"error": f"{type(exc).__name__}: {exc}"[:300], "kind": "parse_failed"}
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdout.write("\n" + json.dumps(out, ensure_ascii=False, default=str) + "\n")


if __name__ == "__main__":
    main()
