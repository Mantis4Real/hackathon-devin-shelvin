"""Agent-written sources never run in the backend's process: routing reads their text, a scrape runs them in a child."""
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from server.kit import Kit

PROBE = '''"""A source that reports what it can see of the environment."""
import os

from kit import http, rows

SOURCE = "probe_mx"
ORIGIN = "http://127.0.0.1:{port}"
RETAILER = "Probe"
KIND = "third_party"
INTERVAL = 1
CURRENCY = "MXN"
SAMPLE_PAGE = ORIGIN + "/p/1"


def page(response):
    if response["url"].endswith("/p/gone"):
        raise http.NotListed("the store no longer lists this product")
    seen = os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("DEVIN_API_KEY") or "no key"
    return [rows.row("1", response["url"], title=seen, price={{"amount": 12.5, "currency": "MXN"}})]
'''


class Site(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"User-agent: *\nAllow: /\n" if self.path == "/robots.txt" else b"<html>Probe</html>"
        self.send_response(429 if self.path == "/p/slow" else 200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def test_routing_reads_text_and_the_scrape_child_gets_no_keys(kit_copy, monkeypatch):
    site = ThreadingHTTPServer(("127.0.0.1", 0), Site)
    threading.Thread(target=site.serve_forever, daemon=True).start()
    port = site.server_address[1]
    try:
        (kit_copy / "sources" / "probe_mx.py").write_text(PROBE.format(port=port), encoding="utf-8")
        (kit_copy / "sources" / "broken_mx.py").write_text("SOURCE = 'broken_mx'\nORIGIN = make_origin()\n", encoding="utf-8")
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-secret")
        monkeypatch.setenv("DEVIN_API_KEY", "devin-secret")
        kit = Kit(kit_copy)
        found = kit.source_for(f"http://127.0.0.1:{port}/p/1")
        assert (found.SOURCE, found.KIND, found.RETAILER) == ("probe_mx", "third_party", "Probe")
        assert "broken_mx" not in kit.sources()   # an ORIGIN that is not a literal routes nowhere
        assert "sources.probe_mx" not in sys.modules   # read, not imported

        got = kit.collect(found, f"http://127.0.0.1:{port}/p/1")
        assert got["catalog"] is False
        (row,) = got["rows"]
        assert row["title"] == "no key" and row["price"] == {"amount": 12.5, "currency": "MXN"}
        assert "sources.probe_mx" not in sys.modules
        # 429 is "slow down", not a refusal: retryable, never the permanent `blocked`.
        assert kit.collect(found, f"http://127.0.0.1:{port}/p/slow")["kind"] == "rate_limited"
        # A delisted product is the store's answer, not a scraper that can't read the page.
        assert kit.collect(found, f"http://127.0.0.1:{port}/p/gone")["kind"] == "not_listed"
    finally:
        site.shutdown()
