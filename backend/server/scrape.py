"""`POST /scrape`: run the kit's sources on the chosen pages and save the listings, one site's progress at a time.

Sites run in parallel, pages of one site in order (the kit paces each origin). A retailer page is read on its own
(page-only source); a brand site is read as its whole catalog, saved as the brand's catalog, and the scanned
product is matched in it.
"""
import threading
import urllib.error
from collections import defaultdict

from .jobs import JobFailed, now

STEPS = ["scrape", "taxonomy", "save"]
CATALOG_PAGES = 20
# A small keyword map onto Google Product Taxonomy paths; enough for the snack aisle.
TAXONOMY = [
    (("papas", "chips", "frituras", "totopos", "botana", "takis", "tostitos", "doritos", "chicharr"),
     ["Food, Beverages & Tobacco", "Food Items", "Snack Foods", "Chips"]),
    (("cacahuate", "nuez", "nuts", "semillas", "pistache", "almendra"), ["Food, Beverages & Tobacco", "Food Items", "Nuts & Seeds"]),
    (("galleta", "cookie"), ["Food, Beverages & Tobacco", "Food Items", "Bakery", "Cookies"]),
    (("dulce", "caramelo", "chocolate", "paleta", "chicle", "gomita"), ["Food, Beverages & Tobacco", "Food Items", "Candy & Chocolate"]),
    (("refresco", "soda"), ["Food, Beverages & Tobacco", "Beverages", "Soda"]),
    (("jugo", "juice"), ["Food, Beverages & Tobacco", "Beverages", "Juice"]),
]


def taxonomy(listing):
    text = " ".join([listing.get("title") or "", *(listing.get("categoryPath") or [])]).lower()
    for words, path in TAXONOMY:
        if any(w in text for w in words):
            return {"system": "Google Product Taxonomy", "path": path}
    return None


def to_listing(row, page, run_id, scraped_at, index=0):
    fields = {k: v for k, v in (row.get("fields") or {}).items() if v is None or isinstance(v, (str, int, float, bool))}
    for key in ("brand", "barcode", "sku", "available"):
        if row.get(key) is not None:
            fields[key] = row[key]
    listing = {"id": f"lst-{run_id}-{page['id']}-{index}", "pageId": page["id"], "url": row.get("url") or page["url"],
               "domain": page["domain"], "retailerName": page["retailerName"], "title": row.get("title"),
               "fields": fields, "scrapedAt": scraped_at}
    if row.get("image_url"):
        listing["imageUrl"] = row["image_url"]
    if row.get("price"):
        listing["price"] = row["price"]
    if row.get("category_path"):
        listing["categoryPath"] = row["category_path"]
    return listing


class Scrape:
    def __init__(self, kit, store, fetch_for=None, parallel=4):
        self.kit, self.store = kit, store
        self.fetch_for = fetch_for or (lambda module: None)   # tests hand in a fake fetch per source
        self.slots = threading.BoundedSemaphore(max(1, parallel))   # scrape jobs at once (spec 4)

    def run(self, job, request, run_id):
        job.step("scrape", "Waiting for a free scrape slot", 5)
        with self.slots:
            result = self._run(job, request, run_id)
        job.log.update(listings=len(result["listings"]), failures=len(result["failures"]))
        return result

    def _run(self, job, request, run_id):
        product = self.store.get("products", request["productId"]) or {"id": request["productId"]}
        pages, unknown = [], []
        for page_id in request["pageIds"]:
            page = self.store.get("pages", page_id)
            if page is None:
                unknown.append({"pageId": page_id, "url": "", "error": "This page is not known here; search again"})
            else:
                pages.append(page)
        if not pages:   # nothing could run (spec 5): fail the job; otherwise unknown pages are failures
            raise JobFailed("These pages are not known here; search again")
        sites = [{"pageId": p["id"], "domain": p["domain"], "retailerName": p["retailerName"], "state": "queued",
                  "message": "Waiting", "rows": 0} for p in pages]
        job.detail["sites"] = sites
        job.step("scrape", f"Scraping {len(pages)} page(s) on {len({p['domain'] for p in pages})} site(s)", 10)
        listings, failures, catalogs = [], list(unknown), []
        by_domain = defaultdict(list)
        for page, site in zip(pages, sites):
            by_domain[page["domain"]].append((page, site))
        lock = threading.Lock()

        def one_site(items):
            for page, site in items:
                got = self._page(page, site, product, run_id)
                with lock:
                    if "listing" in got:
                        listings.append(got["listing"])
                    if "catalog" in got:
                        catalogs.append(got["catalog"])
                    if "error" in got:
                        failures.append({"pageId": page["id"], "url": page["url"], "error": got["error"],
                                         **({"code": got["code"]} if got.get("code") else {}),
                                         "retailerName": page.get("retailerName") or page["domain"]})
                    done = sum(1 for s in sites if s["state"] in ("done", "failed", "refused", "blocked"))
                    job.step("scrape", f"{done} of {len(sites)} pages read", 10 + round(50 * done / len(sites)))

        threads = [threading.Thread(target=one_site, args=(items,), daemon=True) for items in by_domain.values()]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        job.step("taxonomy", "Mapping categories to Google Product Taxonomy", 70)
        for listing in listings + [l for c in catalogs for l in c["listings"]]:
            mapped = taxonomy(listing)
            if mapped:
                listing["standardTaxonomy"] = mapped
        job.step("save", f"Saving {len(listings)} listing(s)", 90)
        saved_at = now()
        if listings:
            self._save(product, listings, saved_at)
        self._save_failures(product["id"], listings, failures)
        for catalog in catalogs:
            self.store.put("catalogs", catalog["source"], catalog)
        return {"runId": run_id, "saved": bool(listings), "savedAt": saved_at, "listings": listings,
                "failures": failures, "catalogs": catalogs, "sites": sites}

    def _page(self, page, site, product, run_id):
        def state(value, message, rows=None):
            site.update(state=value, message=message, **({"rows": rows} if rows is not None else {}))

        access = self.kit.access(page["url"])
        if access["status"] != "allowed":
            state("refused", access["reason"])
            return {"error": f"Not collected: {access['reason']}", "code": access["code"]}
        module = self.kit.source_for(page["url"])
        if module is None:
            state("failed", "No scraper for this site yet")
            return {"error": "No scraper for this site yet", "code": "no_scraper"}
        state("fetching", f"Reading {page['domain']} with {module.SOURCE}")
        fetch = self.fetch_for(module)
        got = self._collect_here(module, page["url"], fetch) if fetch is not None else self.kit.collect(module, page["url"])
        if "error" in got:
            text = {"blocked": f"The site stopped us: {got['error']}",
                    "rate_limited": f"{page['domain']} asked us to slow down; try again later",
                    "unreachable": f"Could not reach {page['domain']}: {got['error']}",
                    "not_listed": f"{page['retailerName']} no longer sells this product"}.get(
                got["kind"], f"The scraper could not read the page: {got['error']}")
            state("blocked" if got["kind"] == "blocked" else "failed", text[:200])
            return {"error": text[:300], "code": got["kind"]}
        catalog, rows = got["catalog"], got["rows"]
        scraped_at = now()
        best = self.kit.match.matches(product, rows, threshold=0.6)
        if catalog and not best:
            # On the brand's own site every row is the owner's: the phone may name the maker (Barcel) where the
            # catalog names the product brand (Takis), so match on name and variant alone.
            best = self.kit.match.matches({**product, "brand": None}, rows, threshold=0.6)
        out = {}
        if catalog:
            out["catalog"] = {"pageId": page["id"], "domain": page["domain"], "retailerName": page["retailerName"],
                              "source": module.SOURCE, "count": len(rows), "scrapedAt": scraped_at,
                              "listings": [to_listing(r, page, run_id, scraped_at, i) for i, r in enumerate(rows)]}
        row = best[0][1] if best else (rows[0] if rows and not catalog else None)
        if row is None:
            state("done", f"Catalog of {len(rows)} products; the scanned product is not in it", len(rows))
            out["error"] = f"The brand's catalog ({len(rows)} products) does not list this product"
            out["code"] = "not_in_catalog"
            return out
        out["listing"] = to_listing(row, page, run_id, scraped_at)
        state("done", (f"Catalog of {len(rows)} products; matched {row['title']}" if catalog
                       else f"Read {row['title']}"), len(rows))
        return out

    def _collect_here(self, declared, url, fetch):
        """Tests only (they hand in a fake fetch): the source imported in this process, as server/collect.py runs it."""
        module = self.kit.import_source(declared)
        catalog = callable(getattr(module, "listings", None)) and module.KIND == "first_party"
        try:
            if callable(getattr(module, "page", None)) and not catalog:
                _, rows = self.kit.capture.collect_page(module, url, fetch=fetch)
            else:
                _, rows = self.kit.capture.collect(module, fetch=fetch, max_pages=CATALOG_PAGES)
        except self.kit.http.RateLimited as exc:
            return {"error": str(exc), "kind": "rate_limited"}
        except self.kit.http.Refused as exc:
            return {"error": str(exc), "kind": "blocked"}
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            return {"error": str(exc), "kind": "unreachable"}
        except self.kit.http.NotListed as exc:
            return {"error": str(exc), "kind": "not_listed"}
        except ValueError as exc:
            return {"error": str(exc), "kind": "parse_failed"}
        return {"catalog": catalog, "rows": rows}

    def _save_failures(self, product_id, listings, failures):
        """Per product: each page whose latest scrape failed, until a later scrape of it saves a listing."""
        def merge(saved):
            by_page = {f["pageId"]: f for f in (saved or {}).get("failures", [])}
            for listing in listings:
                by_page.pop(listing["pageId"], None)
            by_page.update({f["pageId"]: f for f in failures if f.get("url")})
            return {"failures": list(by_page.values())}
        self.store.update("failures", product_id, merge)

    def failures_for(self, product_id):
        return (self.store.get("failures", product_id) or {}).get("failures", [])

    def _save(self, product, listings, saved_at):
        def merge(saved):
            by_page = {l["pageId"]: l for l in (saved or {}).get("listings", [])}
            by_page.update({l["pageId"]: l for l in listings})
            return {"product": product, "listings": list(by_page.values())}
        record = self.store.update("listings", product["id"], merge)
        self.store.put("scans", product["id"], {"product": product, "lastScrapedAt": saved_at,
                                                "listingCount": len(record["listings"])})
