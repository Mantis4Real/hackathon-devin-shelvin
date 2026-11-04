"""VTEX stores (Chedraui and many Latin American grocers): the store's own public catalog JSON.

A retailer source reads one product, never the catalog: a product page `/<slug>/p` is read through
`/api/catalog_system/pub/products/search/<slug>/p`, the JSON the page itself loads (VTEX's legacy catalog API,
public, no key). One row per SKU, with the first seller's price and stock. A brand that sells on VTEX can also
list its catalog through `bind_catalog`, 50 products a page (VTEX's cap) up to its 2,500-result limit.

    from kit.generic import vtex
    page_request, page = vtex.bind(ORIGIN, "MXN")
"""
import json
from urllib.parse import quote, urlsplit

from .. import rows as kit_rows
from ..http import NotListed

API = "/api/catalog_system/pub/products/search"
PAGE = 50
LIMIT = 2500


def _products(response):
    try:
        data = json.loads(response["body"])
    except ValueError:
        raise ValueError(f"not VTEX catalog JSON: {response['url']}") from None
    if not isinstance(data, list) or any(not isinstance(p, dict) or "productId" not in p for p in data):
        raise ValueError(f"not VTEX catalog JSON: {response['url']}")
    return data


def _offer(item):
    for seller in item.get("sellers") or []:
        offer = seller.get("commertialOffer") or {}
        if offer:
            return seller, offer
    return {}, {}


def to_rows(origin, product, currency):
    out = []
    categories = [c for c in (product.get("categories") or [""])[0].strip("/").split("/") if c]
    base = kit_rows.flatten(product, skip={"items", "categories", "categoriesIds", "clusterHighlights",
                                           "productClusters", "searchableClusters", "skuSpecifications"})
    for item in product.get("items") or []:
        seller, offer = _offer(item)
        images = [i.get("imageUrl") for i in item.get("images") or [] if i.get("imageUrl")]
        name = item.get("nameComplete") or item.get("name") or product.get("productName")
        fields = {**base, **kit_rows.flatten(item, "item", skip={"images", "sellers", "Videos"}),
                  "seller_name": seller.get("sellerName"),
                  "list_price": offer.get("ListPrice"), "available_quantity": offer.get("AvailableQuantity")}
        out.append(kit_rows.row(
            item["itemId"], f"{origin}/{product['linkText']}/p", title=name, brand=product.get("brand"),
            barcode=item.get("ean") or None, sku=item.get("itemId"),
            price=kit_rows.money(offer.get("Price"), currency), image_url=images[0] if images else None,
            category_path=categories or None,
            available=offer.get("IsAvailable") if isinstance(offer.get("IsAvailable"), bool) else None,
            fields=fields))
    return out


def slug(url):
    """The product slug of a VTEX product page URL `/<slug>/p`."""
    parts = [p for p in urlsplit(url).path.split("/") if p]
    if len(parts) < 2 or parts[-1] != "p":
        raise ValueError(f"not a VTEX product page (/<slug>/p): {url}")
    return parts[-2]


def bind(origin, currency):
    """page_request and page for a retailer: one product page at a time."""

    def page_request(url):
        return {"url": f"{origin}{API}/{quote(slug(url))}/p"}

    def page(response):
        products = _products(response)
        if not products:
            # A delisted product's page still loads (an empty shell); the catalog API is what says it is gone.
            raise NotListed(f"the store no longer lists this product ({response['url']})")
        return [r for p in products for r in to_rows(origin, p, currency)]

    return page_request, page


def bind_catalog(origin, currency, query):
    """seeds, discover, check_detail and listings for a brand's catalog on VTEX (`query` such as "fq=B:2000")."""

    def seeds():
        return [{"url": f"{origin}{API}?{query}&_from=0&_to={PAGE - 1}"}]

    def discover(response, request):
        products = _products(response)
        items = [{"id": str(i["itemId"]), "request": None} for p in products for i in p.get("items") or []]
        start = int(request["url"].rsplit("_from=", 1)[1].split("&")[0])
        if len(products) < PAGE:
            return items, []
        if start + PAGE >= LIMIT:
            return items, [], f"VTEX {LIMIT}-result limit"
        return items, [{"url": f"{origin}{API}?{query}&_from={start + PAGE}&_to={start + 2 * PAGE - 1}"}]

    def check_detail(response, item):
        raise ValueError("a VTEX source fetches no details")

    def listings(capture):
        return [r for response in capture["pages"] for p in _products(response) for r in to_rows(origin, p, currency)]

    return seeds, discover, check_detail, listings
