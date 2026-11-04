"""Chedraui (www.chedraui.com.mx): generic vtex reader, from `kit probe https://www.chedraui.com.mx/refresco-dr-pepper-regular-600ml-3094137/p`."""
from kit.generic import vtex

SOURCE = "chedraui_mx"
ORIGIN = "https://www.chedraui.com.mx"
RETAILER = "Chedraui"
KIND = "third_party"
BRANDS = ()
INTERVAL = 2
CURRENCY = "MXN"
SAMPLE_PAGE = "https://www.chedraui.com.mx/refresco-dr-pepper-regular-600ml-3094137/p"

page_request, page = vtex.bind(ORIGIN, CURRENCY)
