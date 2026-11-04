"""Which rows of a capture are the scanned product: the app's ProductIdentity against kit rows.

A barcode that matches (as a 14-digit GTIN) is an exact match. Otherwise the words of brand, name and variant
are compared with the row's title and brand, and a stated size that differs (62 g against 150 g) rules the row
out. Words in parentheses are an aside the page may leave out ("Freshmint (Menta Fresca)"): the better of the scores
with and without them counts. The score is 0..1; `matches` keeps rows at or above `threshold`, best first.
"""
import re
import unicodedata

UNITS = {"g": 1, "gr": 1, "grs": 1, "gramos": 1, "kg": 1000, "ml": 1, "l": 1000, "lt": 1000, "oz": 28.35}
SIZE = re.compile(r"(\d+(?:[.,]\d+)?)\s*(kg|grs|gramos|gr|g|ml|lt|l|oz)\b")
STOP = {"de", "la", "el", "con", "sabor", "the", "and", "y", "en", "a"}


def plain(text):
    text = unicodedata.normalize("NFKD", str(text or "")).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9.,]+", " ", text).strip()


def words(text):
    return {w for w in re.split(r"[\s.,]+", SIZE.sub(" ", plain(text))) if w and w not in STOP}


def size(text):
    """The first size in the text in grams or millilitres, or None."""
    found = SIZE.search(plain(text))
    if not found:
        return None
    return round(float(found[1].replace(",", ".")) * UNITS[found[2]], 1)


def gtin(code):
    digits = re.sub(r"\D", "", str(code or ""))
    return digits.zfill(14) if 8 <= len(digits) <= 14 else None


def _check_digit(body):
    """The GS1 check digit of the digits before it."""
    return str(-sum(int(d) * (3 if n % 2 == 0 else 1) for n, d in enumerate(reversed(body))) % 10)


def same_gtin(a, b):
    """Two barcodes are one product: equal as 14-digit GTINs, or one is the other without its check digit
    (Walmart México sends 00750103042453 for the EAN 7501030424536)."""
    x, y = gtin(a), gtin(b)
    if not x or not y:
        return False
    if x == y:
        return True
    for full, short in ((x, y), (y, x)):
        body = short.lstrip("0")
        # Only a short code that is not a valid barcode itself: two valid codes are two products.
        if len(body) >= 7 and body[-1] != _check_digit(body[:-1]) and full.lstrip("0") == body + _check_digit(body):
            return True
    return False


ASIDE = re.compile(r"\([^)]*\)")


def score(product, row):
    if same_gtin(product.get("barcode"), row.get("barcode")):
        return 1.0
    named = " ".join(filter(None, (product.get("brand"), product.get("productName"), product.get("variant"))))
    if ASIDE.search(named):
        return max(_score(product, row, named), _score(product, row, ASIDE.sub(" ", named)))
    return _score(product, row, named)


def _score(product, row, named):
    wanted = words(named)
    have = words(" ".join(filter(None, (row.get("brand"), row.get("title")))))
    if not wanted or not have:
        return 0.0
    overlap = len(wanted & have) / len(wanted)
    want_size = size(product.get("size")) or size(product.get("productName"))
    row_size = size(row.get("title")) or size(row.get("fields", {}).get("variant_title"))
    if want_size and row_size:
        if abs(want_size - row_size) > 0.05 * want_size:
            return 0.0
        overlap = min(1.0, overlap + 0.1)
    brand = plain(product.get("brand"))
    if brand and brand not in plain(f"{row.get('brand')} {row.get('title')}"):
        overlap *= 0.5
    return round(overlap * 0.95, 3)   # below an exact barcode match


def matches(product, found_rows, threshold=0.6):
    scored = [(score(product, r), r) for r in found_rows]
    return [(s, r) for s, r in sorted(scored, key=lambda pair: -pair[0]) if s >= threshold]
