"""The backend's one door into scraper-kit: robots access, sources, scraping, and the gate.

The kit's own modules (robots, capture, match) are imported in-process. Sources are agent-written, so this process
never imports one: routing reads SOURCE, ORIGIN, RETAILER and KIND from each file's text (`kit.source.declared`,
as the gate does), and a scrape runs the source in a child process without credentials (`server/collect.py`). The
gate runs as a subprocess in a staged copy of the kit with only the candidate's two paths overlaid, so a builder
cannot pass the gate by editing the gate.
"""
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit

# Left out of every copy of the kit: local environments, caches and a builder's scratch files.
COPY_IGNORE = shutil.ignore_patterns(".venv", "__pycache__", ".pytest_cache", "captures", "progress.jsonl",
                                     "run-report.json", "capture.json", "uv.lock")


def origin_of(url):
    part = urlsplit(url)
    return f"{part.scheme}://{part.netloc}"


def domain_of(url):
    return (urlsplit(url if "//" in url else f"https://{url}").hostname or "").lower().removeprefix("www.")


class Kit:
    def __init__(self, kit_dir):
        self.dir = Path(kit_dir).resolve()
        if str(self.dir) not in sys.path:
            sys.path.insert(0, str(self.dir))
        self.lock = threading.RLock()
        self.robots_cache = {}
        from kit import capture, http, match, probe, robots, source
        self.capture, self.http, self.match, self.probe_mod, self.robots, self.source = (
            capture, http, match, probe, robots, source)
        self._sources = None

    # --- sources -------------------------------------------------------------------------------------------
    def sources(self, reload=False):
        """Every source by SOURCE, as its declared constants read from the file's text (never imported here).
        A file whose SOURCE, ORIGIN or KIND is not a valid literal is left out; the gate reports why."""
        with self.lock:
            if self._sources is None or reload:
                found = {}
                for path in sorted((self.dir / "sources").glob("[!_]*.py")):
                    try:
                        values = self.source.declared(path)
                    except (SyntaxError, ValueError, UnicodeDecodeError):
                        continue
                    origin = urlsplit(values.get("ORIGIN") or "") if isinstance(values.get("ORIGIN"), str) else None
                    if (values.get("SOURCE") != path.stem or not origin or not origin.hostname
                            or origin.scheme not in ("https", "http") or values.get("KIND") not in self.source.KINDS):
                        continue
                    found[path.stem] = SimpleNamespace(**values, path=path)
                self._sources = found
            return self._sources

    def source_for(self, url):
        """The source whose ORIGIN host, or one of its ALIASES (hosts that redirect to it), serves `url`."""
        wanted = (urlsplit(url).hostname or "").removeprefix("www.")
        found = [s for s in self.sources().values()
                 if wanted in {h.removeprefix("www.") for h in (urlsplit(s.ORIGIN).hostname, *(getattr(s, "ALIASES", None) or ()))}]
        return found[0] if found else None

    def import_source(self, declared):
        """Tests only: import a source in this process (they hand the scrape a fake fetch)."""
        import importlib.util
        spec = importlib.util.spec_from_file_location(f"sources.{declared.SOURCE}", declared.path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return self.source.check_source(module)

    def collect(self, source, url, timeout=300):
        """Run `source` on `url` (its page, or a first-party catalog) in a child process with no credentials.
        Returns {"catalog", "rows"} or {"error", "kind"} with kind blocked | rate_limited | unreachable | not_listed | parse_failed."""
        command = [sys.executable, "-m", "server.collect", str(self.dir), source.SOURCE, url]
        try:
            done = subprocess.run(command, cwd=Path(__file__).resolve().parents[1], capture_output=True,
                                  timeout=timeout, encoding="utf-8", errors="replace",
                                  env={**_env(), "PYTHONIOENCODING": "utf-8"})
        except subprocess.TimeoutExpired:
            return {"error": f"collecting took over {timeout} s", "kind": "unreachable"}
        try:
            return json.loads(done.stdout.strip().splitlines()[-1])
        except (json.JSONDecodeError, IndexError):
            return {"error": (done.stderr or done.stdout or "the scraper crashed")[-300:], "kind": "parse_failed"}

    # --- access ----------------------------------------------------------------------------------------------
    def fetch_robots(self, origin):
        """(status, body) of origin/robots.txt; a network failure counts as unavailable."""
        request = urllib.request.Request(origin + "/robots.txt", headers={"User-Agent": self.http.USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                return response.status, response.read(500_000).decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            return exc.code, ""
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            return 599, str(exc)

    def access(self, url):
        """kit.robots.access for `url`, robots.txt cached per origin for 10 minutes."""
        origin = origin_of(url)
        cached = self.robots_cache.get(origin)
        if cached is None or time.time() - cached[0] > 600:
            cached = (time.time(), *self.fetch_robots(origin))
            self.robots_cache[origin] = cached
        _, status, body = cached
        if status == 599:   # no robots.txt read, so no rules: a site that is really down fails when collected
            return {"status": "allowed", "code": "no_robots", "reason": f"robots.txt could not be fetched ({body[:80]}): no rules read"}
        return self.robots.access(status, body, url, self.http.USER_AGENT)

    def probe(self, url):
        return self.probe_mod.probe(url)

    # --- builds: workspace, staging, gate, merge ------------------------------------------------------------
    def copy_to(self, target):
        """A clean copy of the kit (no venv, caches or captures): a builder's workspace, or a gate's stage."""
        target = Path(target)
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(self.dir, target, ignore=COPY_IGNORE)
        return target

    @staticmethod
    def candidate_paths(source):
        return [f"sources/{source}.py", f"fixtures/{source}"]

    def changed_paths(self, workspace):
        """Files under `workspace` that differ from the kit, as kit-relative paths."""
        workspace, changed = Path(workspace), []
        def files(root):
            return {p.relative_to(root).as_posix(): p for p in root.rglob("*") if p.is_file()
                    and not any(part in {".venv", "__pycache__", ".pytest_cache", "captures"} for part in p.parts)
                    and p.name not in {"progress.jsonl", "run-report.json", "capture.json", "uv.lock"}}
        mine, theirs = files(self.dir), files(workspace)
        for rel in sorted(set(mine) | set(theirs)):
            if rel not in mine or rel not in theirs or mine[rel].read_bytes() != theirs[rel].read_bytes():
                changed.append(rel)
        return changed

    @staticmethod
    def disallowed(changed, source):
        allowed = (f"sources/{source}.py", f"fixtures/{source}/")
        return [p for p in changed if not (p == allowed[0] or p.startswith(allowed[1]))]

    def stage(self, candidate_root, source, target):
        """The trusted kit with only the candidate's source file and fixture folder overlaid."""
        target = self.copy_to(target)
        candidate_root = Path(candidate_root)
        src = candidate_root / "sources" / f"{source}.py"
        if src.is_file():
            shutil.copy2(src, target / "sources" / f"{source}.py")
        fixture = candidate_root / "fixtures" / source
        if fixture.is_dir():
            shutil.copytree(fixture, target / "fixtures" / source, dirs_exist_ok=True)
        return target

    def gate(self, staged, source, product=None, live=True, timeout=600):
        """`kit gate` in the staged kit, in a subprocess; the report plus its exit-code verdict."""
        command = [sys.executable, "-m", "kit", "gate", source]
        if live:
            command.append("--live")
        if product:
            command += ["--product", json.dumps(product, ensure_ascii=False)]
        try:
            done = subprocess.run(command, cwd=staged, capture_output=True, timeout=timeout, encoding="utf-8",
                                  errors="replace", env={**_env(), "PYTHONIOENCODING": "utf-8"})
        except subprocess.TimeoutExpired:
            return {"source": source, "verdict": "unreachable",
                    "checks": [{"name": "gate_time", "passed": False, "detail": f"gate ran over {timeout} s"}]}
        try:
            report = json.loads(done.stdout)
        except json.JSONDecodeError:
            report = {"source": source, "checks": [{"name": "gate_runs", "passed": False,
                                                    "detail": (done.stderr or done.stdout)[-400:]}]}
        report["verdict"] = {0: "pass", 1: "fail", 2: "unreachable"}.get(done.returncode, "fail")
        return report

    def merge(self, staged, source):
        """Copy a passed candidate's two paths into the live kit and reload the sources."""
        with self.lock:
            staged = Path(staged)
            shutil.copy2(staged / "sources" / f"{source}.py", self.dir / "sources" / f"{source}.py")
            shutil.copytree(staged / "fixtures" / source, self.dir / "fixtures" / source, dirs_exist_ok=True)
            return self.sources(reload=True)


def _env():
    # The gate runs a builder's code: it gets no credentials from this process.
    return {k: v for k, v in os.environ.items() if not k.startswith(("DEVIN_", "ANTHROPIC_", "AWS_"))}


def summary(report):
    """One line per failed check: what the builder is sent back."""
    failed = [c for c in report.get("checks", []) if not c["passed"]]
    total = len(report.get("checks", []))
    head = f"kit gate {report.get('source')}: {report['verdict']} ({total - len(failed)}/{total} checks passed)"
    return "\n".join([head] + [f"- {c['name']}: {c['detail']}" for c in failed])
