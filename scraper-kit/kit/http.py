"""The only code that touches the network: one origin, paced, robots-checked, stopped by the site's refusals.

Rules:
- every request is on the source's origin; anything else is refused before it is sent;
- request starts are at least INTERVAL seconds apart;
- 401, 403 and 429 stop the run (the site said no; we do not retry around it), and so does a redirect off the
  origin; a redirect on the origin is followed, at most 3 times;
- a body over 8 MB stops the run;
- the body is saved as text with the sha256 of its bytes, so a test can replay exactly what the site sent
  (after a gzip or deflate Content-Encoding is undone).

robots.txt is fetched once per run, saved in the capture, and every URL is checked against it,
including the AI-agent opt-out rule in `kit.robots.access`.
"""
import hashlib
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from datetime import datetime, timezone

from . import robots

USER_AGENT = "ShelvinKit/0.1"
ACCEPT = "text/html,application/xhtml+xml,application/json,application/xml;q=0.9,*/*;q=0.8"
MAX_BYTES = 8_000_000
STOP = {401, 403, 429}


class Refused(ValueError):
    """The run must stop: the site refused, or the request is not ours to make."""


class RateLimited(Refused):
    """The site answered 429: the run stops too, but asking again later is fine (not a refusal of us)."""


class NotListed(ValueError):
    """The store answered, but it has no such product (delisted or never sold): the page is fine, the product is gone."""


def utc():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def inflate(raw, headers):
    """The body's bytes once the Content-Encoding is undone. Some CDNs (Chedraui's CloudFront in front of VTEX)
    gzip every response even when the request asks for none; the 8 MB cap holds after decompressing too."""
    encoding = {k.lower(): v for k, v in headers.items()}.get("content-encoding", "").strip().lower()
    if encoding not in ("gzip", "x-gzip", "deflate"):
        return raw
    # gzip has a header; deflate is meant to be zlib-wrapped, but some servers send it raw.
    for wbits in ((16 + zlib.MAX_WBITS,) if encoding != "deflate" else (zlib.MAX_WBITS, -zlib.MAX_WBITS)):
        try:
            body = zlib.decompressobj(wbits).decompress(raw, MAX_BYTES + 1)
            break
        except zlib.error as exc:
            failed = exc
    else:
        raise ValueError(f"body says Content-Encoding {encoding} but does not decompress: {failed}")
    if len(body) > MAX_BYTES:
        raise Refused("response exceeds 8 MB once decompressed")
    return body


def decode(data, headers):
    """Text of a body: UTF-8 when the bytes are UTF-8, else the charset the header declares."""
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        content_type = {k.lower(): v for k, v in headers.items()}.get("content-type", "")
        charset = next((p.split("=", 1)[1].strip(' "') for p in content_type.split(";") if "charset=" in p), None)
        if not charset or charset.lower() in ("utf-8", "utf8"):
            raise ValueError("body is not UTF-8 and declares no other charset")
        return data.decode(charset)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Http:
    def __init__(self, origin, interval, *, user_agent=USER_AGENT, headers=None, check_robots=True):
        self.origin, self.interval, self.user_agent = origin.rstrip("/"), float(interval), user_agent
        self.headers = dict(headers or {})
        self.opener = urllib.request.build_opener(_NoRedirect())
        self.last = 0.0
        self.robots = None
        if check_robots:
            self.robots = self._get(self.origin + "/robots.txt")

    def access(self, url):
        """kit.robots.access for `url`: allowed, or refused with a code (robots, AI-agent opt-out, unavailable)."""
        if self.robots is None:
            return {"status": "allowed", "code": "not_checked", "reason": "robots not checked"}
        return robots.access(self.robots["status"], self.robots["body"], url, self.user_agent)

    def allowed(self, url):
        decision = self.access(url)
        return decision["status"] == "allowed", decision["reason"]

    def _admit(self, url):
        part, base = urllib.parse.urlsplit(url), urllib.parse.urlsplit(self.origin)
        if (part.scheme, part.netloc) != (base.scheme, base.netloc):
            raise Refused(f"refused URL outside {self.origin}: {url}")
        wait = self.last + self.interval - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        self.last = time.monotonic()

    def _get(self, url, request=None):
        self._admit(url)
        headers = {"Accept": ACCEPT, **self.headers, "User-Agent": self.user_agent}
        data = None
        if request and "json" in request:
            data, headers["Content-Type"] = json.dumps(request["json"]).encode(), "application/json"
        elif request and "form" in request:
            data = urllib.parse.urlencode(request["form"]).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        try:
            response = self.opener.open(urllib.request.Request(url, data=data, headers=headers), timeout=30)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            raw = response.read(MAX_BYTES + 1)
            status, got = response.code, dict(response.headers)
        if len(raw) > MAX_BYTES:
            raise Refused(f"response exceeds 8 MB: {url}")
        raw = inflate(raw, got)
        saved ={"url": url, "final_url": url, "status": status, "sha256": hashlib.sha256(raw).hexdigest(),
                 "observed_at": utc(), "headers": got, "body": decode(raw, got) if raw else ""}
        if request:
            saved["request"] = request
        return saved

    def __call__(self, request):
        """The saved response to `request`, after robots allows it. Raises Refused when the run must stop."""
        url = request["url"]
        allowed, reason = self.allowed(url)
        if not allowed:
            raise Refused(f"{reason}: {url}")
        body = {k: v for k, v in request.items() if k != "url"} or None
        response = self._get(url, body)
        for _ in range(3):
            if not 300 <= response["status"] < 400:
                break
            location = {k.lower(): v for k, v in response["headers"].items()}.get("location")
            target = urllib.parse.urljoin(response["final_url"], location or "")
            if not location or urllib.parse.urlsplit(target).netloc != urllib.parse.urlsplit(self.origin).netloc:
                raise Refused(f"redirect off {self.origin}: {url} -> {location}")
            allowed, reason = self.allowed(target)
            if not allowed:
                raise Refused(f"{reason}: {target}")
            final = self._get(target, body)
            response = {**final, "url": url, "final_url": target}
        if 300 <= response["status"] < 400:
            raise Refused(f"too many redirects: {url}")
        if response["status"] == 429:
            raise RateLimited(f"site answered 429 (too many requests): {url}")
        if response["status"] in STOP:
            raise Refused(f"site answered {response['status']}: {url}")
        return response
