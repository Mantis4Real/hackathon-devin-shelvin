"""The gate's verdicts, the AI-agent robots rule, gzip bodies, and the VTEX and JSON:API readers."""
import gzip
import json
import types
import zlib

import pytest

from kit import capture, gate, http, robots, rows
from kit.generic import jsonapi, vtex
from kit.source import check_source
from tests.helpers import FakeFetch

O = "https://shop.example"

AMAZON_LIKE = """
User-agent: *
Disallow: /cart

User-agent: ClaudeBot
Disallow: /

User-agent: GPTBot
Disallow: /dp/
"""


def test_a_site_that_blocks_ai_agents_is_refused_with_its_own_code():
    found = robots.access(200, AMAZON_LIKE, f"{O}/dp/B000", "ShelvinKit/0.1")
    assert found["status"] == "refused" and found["code"] == "ai_opt_out"
    assert "ClaudeBot" in found["reason"] and "GPTBot" in found["reason"]
    assert robots.access(200, "User-agent: *\nDisallow: /cart\n", f"{O}/dp/B000", "ShelvinKit/0.1")["code"] == "allowed"
    # A robots.txt that can't be read sets no rules: the site is collected (its pages may still answer 403).
    for status in (403, 401, 402, 500, 503):
        assert robots.access(status, "", f"{O}/x", "ShelvinKit/0.1")["status"] == "allowed", status
        assert robots.access(status, "", f"{O}/x", "ShelvinKit/0.1")["code"] == "no_robots", status
    assert robots.access(200, "User-agent: *\nDisallow: /\n", f"{O}/x", "ShelvinKit/0.1")["code"] == "robots_disallow"
    assert robots.access(404, "", f"{O}/x", "ShelvinKit/0.1")["code"] == "no_robots"


VTEX_PRODUCT = [{
    "productId": "3090610", "productName": "Botana Barcel Takis Fuego 56g", "brand": "Takis", "linkText": "botana-barcel-takis-fuego-56g-3090610",
    "categories": ["/Despensa/Botanas/Papas y frituras/"], "productClusters": {"1": "x"},
    "items": [{"itemId": "3090610", "name": "Takis Fuego 56g", "nameComplete": "Botana Barcel Takis Fuego 56g", "ean": "0750103042453",
               "images": [{"imageUrl": "https://shop.example/arquivos/ids/1.jpg"}],
               "sellers": [{"sellerName": "Chedraui", "commertialOffer": {"Price": 18.5, "ListPrice": 19.0, "AvailableQuantity": 40, "IsAvailable": True}}]}],
}]


def vtex_source():
    page_request, page = vtex.bind(O, "MXN")
    return check_source(types.SimpleNamespace(SOURCE="shop_mx", ORIGIN=O, RETAILER="Shop", KIND="third_party", INTERVAL=1,
                                              SAMPLE_PAGE=f"{O}/botana-barcel-takis-fuego-56g-3090610/p",
                                              page_request=page_request, page=page))


def test_vtex_reads_one_product_through_the_store_json():
    module = vtex_source()
    api = f"{O}/api/catalog_system/pub/products/search/botana-barcel-takis-fuego-56g-3090610/p"
    saved, rows = capture.collect_page(module, module.SAMPLE_PAGE, fetch=FakeFetch({api: (200, json.dumps(VTEX_PRODUCT))}))
    (row,) = rows
    assert (row["title"], row["brand"], row["barcode"]) == ("Botana Barcel Takis Fuego 56g", "Takis", "0750103042453")
    assert row["price"] == {"amount": 18.5, "currency": "MXN"} and row["available"] is True
    assert row["category_path"] == ["Despensa", "Botanas", "Papas y frituras"]
    assert row["url"] == f"{O}/botana-barcel-takis-fuego-56g-3090610/p" and row["fields"]["list_price"] == 19.0
    assert capture.replay(saved, module) == rows


def test_vtex_a_delisted_product_is_not_listed_not_a_broken_scraper():
    # Chedraui delisted Takis Fuego 56 g: its page still loads, the catalog API answers [].
    module = vtex_source()
    api = f"{O}/api/catalog_system/pub/products/search/botana-barcel-takis-fuego-56g-3090610/p"
    with pytest.raises(http.NotListed):
        capture.collect_page(module, module.SAMPLE_PAGE, fetch=FakeFetch({api: (200, "[]")}))


def test_jsonapi_pages_through_next_links_with_brands_and_images():
    seeds, discover, _, listings, _ = jsonapi.bind(O, "productos", "field_marca")
    first = {"data": [{"attributes": {"drupal_internal__nid": 29, "title": "Takis Fuego", "path": {"alias": None}},
                       "relationships": {"field_marca": {"data": {"id": "m1"}}, "field_imagen_empaque": {"data": {"id": "f1"}}}}],
             "included": [{"id": "m1", "type": "taxonomy_term--marcas", "attributes": {"name": "Takis"}},
                          {"id": "f1", "type": "file--file", "attributes": {"uri": {"url": "/files/t.png"}}}],
             "links": {"next": {"href": f"{O}/jsonapi/node/productos?page%5Boffset%5D=1"}}}
    second = {"data": [{"attributes": {"drupal_internal__nid": 7, "title": "Chipotles", "path": {"alias": "/chipotles"}},
                        "relationships": {}}], "links": {}}
    module = types.SimpleNamespace(SOURCE="brand_mx", ORIGIN=O, RETAILER="Brand", KIND="first_party", BRANDS=("Brand",),
                                   INTERVAL=1, seeds=seeds, discover=discover, listings=listings)
    pages = {seeds()[0]["url"]: (200, json.dumps(first)), f"{O}/jsonapi/node/productos?page%5Boffset%5D=1": (200, json.dumps(second))}
    _, rows = capture.collect(check_source(module), fetch=FakeFetch(pages))
    takis, chipotles = rows
    assert (takis["native_id"], takis["brand"], takis["image_url"], takis["url"]) == ("29", "Takis", f"{O}/files/t.png", f"{O}/node/29")
    assert chipotles["url"] == f"{O}/chipotles"


def test_gate_fails_a_draft_fixture_and_says_why(tmp_path, monkeypatch):
    module = vtex_source()
    api = f"{O}/api/catalog_system/pub/products/search/botana-barcel-takis-fuego-56g-3090610/p"
    saved, rows = capture.collect_page(module, module.SAMPLE_PAGE, fetch=FakeFetch({api: (200, json.dumps(VTEX_PRODUCT))}))
    folder = tmp_path / "fixtures" / "shop_mx"
    capture.save(saved, folder / "capture.json")
    draft = {"rows": 1, "spot": [{"native_id": "3090610", "title": rows[0]["title"]}], "written_by": "DRAFT: replace"}
    (folder / "expected.json").write_text(json.dumps(draft), encoding="utf-8")
    monkeypatch.setattr(gate, "ROOT", tmp_path)
    report = gate.check("shop_mx", sources={"shop_mx": module})
    assert report["verdict"] == "fail"
    assert [c["name"] for c in report["checks"] if not c["passed"]] == ["expected_written"]
    assert "expected_written" in gate.summary(report)
    draft["written_by"], draft["spot"][0]["title"] = "test", "Wrong title"
    (folder / "expected.json").write_text(json.dumps(draft), encoding="utf-8")
    report = gate.check("shop_mx", sources={"shop_mx": module})
    assert [c["name"] for c in report["checks"] if not c["passed"]] == ["expected_values"]
    draft["spot"][0]["title"] = rows[0]["title"]
    (folder / "expected.json").write_text(json.dumps(draft), encoding="utf-8")
    assert gate.check("shop_mx", sources={"shop_mx": module})["verdict"] == "pass"


def test_gate_fails_a_source_that_does_not_exist():
    report = gate.check("nope", sources={})
    assert report["verdict"] == "fail" and report["checks"][0]["name"] == "source_declares"


API = f"{O}/api/catalog_system/pub/products/search/botana-barcel-takis-fuego-56g-3090610/p"
TITLE = "Botana Barcel Takis Fuego 56g"
SHOP_SOURCE = f'''"""A VTEX store, for the gate's child-process tests."""
from kit.generic import vtex

SOURCE = "shop_mx"
ORIGIN = "{O}"
RETAILER = "Shop"
KIND = "third_party"
INTERVAL = 1
SAMPLE_PAGE = "{O}/botana-barcel-takis-fuego-56g-3090610/p"

page_request, page = vtex.bind(ORIGIN, "MXN")
'''
# Rewrites the gate's checks when the source is imported: what a source could do while it ran in the gate's process.
PATCH_THE_GATE = '''
import kit.gate as _gate
_add = _gate._Checks.add
_gate._Checks.add = lambda self, name, passed, detail="": _add(self, name, True, detail)
'''
# Rows that are not read from the page, with an expected.json written to match them.
INVENTED = '''
from kit.rows import row


def page(response):
    return [row("3090610", ORIGIN + "/botana-barcel-takis-fuego-56g-3090610/p", title="Invented Snack Supreme",
                price={"amount": 18.5, "currency": "MXN"})]
'''


def kit_root(root, monkeypatch, source_text, title):
    """A kit root with sources/shop_mx.py, its saved capture and an expected.json naming `title`."""
    saved, _ = capture.collect_page(vtex_source(), vtex_source().SAMPLE_PAGE,
                                    fetch=FakeFetch({API: (200, json.dumps(VTEX_PRODUCT))}))
    capture.save(saved, root / "fixtures" / "shop_mx" / "capture.json")
    expected = {"rows": 1, "spot": [{"native_id": "3090610", "title": title}], "written_by": "test"}
    (root / "fixtures" / "shop_mx" / "expected.json").write_text(json.dumps(expected), encoding="utf-8")
    (root / "sources").mkdir()
    (root / "sources" / "__init__.py").write_text("", encoding="utf-8")
    (root / "sources" / "shop_mx.py").write_text(source_text, encoding="utf-8")
    monkeypatch.setattr(gate, "ROOT", root)


def failed(report):
    return [c["name"] for c in report["checks"] if not c["passed"]]


def test_the_source_runs_in_a_child_process_and_cannot_rewrite_the_checks(tmp_path, monkeypatch):
    kit_root(tmp_path / "honest", monkeypatch, SHOP_SOURCE, TITLE)
    assert gate.check("shop_mx")["verdict"] == "pass"
    kit_root(tmp_path / "patched", monkeypatch, SHOP_SOURCE + PATCH_THE_GATE, "Wrong title")
    report = gate.check("shop_mx")
    assert report["verdict"] == "fail" and failed(report) == ["expected_values"]


def test_rows_that_are_not_in_the_saved_page_fail(tmp_path, monkeypatch):
    kit_root(tmp_path, monkeypatch, SHOP_SOURCE + INVENTED, "Invented Snack Supreme")
    report = gate.check("shop_mx")
    assert report["verdict"] == "fail" and failed(report) == ["fixture_grounded"]


def test_live_rows_must_be_in_a_page_the_gate_fetched_itself(tmp_path, monkeypatch):
    kit_root(tmp_path, monkeypatch, SHOP_SOURCE, TITLE)
    honest, fetch = vtex_source(), FakeFetch({API: (200, json.dumps(VTEX_PRODUCT))})
    report = gate.check("shop_mx", live=True, sources={"shop_mx": honest}, fetch=fetch)
    assert report["verdict"] == "pass" and "live_grounded" in [c["name"] for c in report["checks"]]
    assert fetch.asked == [API, API]   # the source's live read, then the gate's own
    made_up = types.SimpleNamespace(**{**vars(honest), "page": lambda response: [rows.row(
        "3090610", honest.SAMPLE_PAGE, title=TITLE + " Supreme Extra", price={"amount": 18.5, "currency": "MXN"})]})
    report = gate.check("shop_mx", live=True, sources={"shop_mx": made_up}, fetch=fetch)
    assert {"expected_values", "fixture_grounded", "live_grounded"} <= set(failed(report))


def test_a_gzipped_body_is_inflated_and_capped():
    assert http.inflate(gzip.compress(b"<title>Takis</title>"), {"Content-Encoding": "gzip"}) == b"<title>Takis</title>"
    assert http.inflate(zlib.compress(b"x"), {"content-encoding": "deflate"}) == b"x"
    assert http.inflate(b"plain", {}) == b"plain"
    with pytest.raises(http.Refused):
        http.inflate(gzip.compress(b"0" * (http.MAX_BYTES + 1)), {"Content-Encoding": "gzip"})
