"""Walmart (www.walmart.com.mx): generic jsonld reader, from `kit probe https://www.walmart.com.mx/ip/goma-de-mascar-trident-sin-azucar-sabor-a-menta-fresca-18-pzas/00750610560607`."""
from kit.generic import page as generic_page

SOURCE = "walmart_mx"
ORIGIN = "https://www.walmart.com.mx"
RETAILER = "Walmart"
KIND = "third_party"
BRANDS = ()
INTERVAL = 2
CURRENCY = "MXN"
SAMPLE_PAGE = "https://www.walmart.com.mx/ip/goma-de-mascar-trident-sin-azucar-sabor-a-menta-fresca-18-pzas/00750610560607"


def page(response):
    return generic_page.read(response, CURRENCY)
