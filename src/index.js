import {
  getCatalogEnhancementCss,
  getCatalogEnhancementScript,
} from "./catalog-enhancements.js";
const ABSOLUTE_ORIGIN_PATTERN =
  /https:\/\/catalogo-nubek\.kiaranunezberro\.chatgpt\.site/gi;
const ENHANCEMENT_VERSION = "20260727-1";
const MAX_REWRITABLE_JSON_BYTES = 256 * 1024;
const FIXED_IMAGE_SOURCES = Object.freeze({
  "/nubek-fixes/ceramica-20x20.webp": {
    url: "https://cdn.awsli.com.br/600x1000/866/866032/produto/340110649/20x20-com-medidas-rqwgmbhnot-vj8ac4qlrr.webp",
    contentType: "image/webp",
    referer: "https://www.unicabrasiltransfer.com.br/",
  },
  "/nubek-fixes/jarra-cervecera-blanca.jpg": {
    url: "https://euroland.pl/hpeciai/d7d1a5e0ade7e6d82d3537ff28864a4c/pol_pm_Kufel-do-piwa-590ml-wysoki-627_1.jpg",
    contentType: "image/jpeg",
    referer: "https://euroland.pl/",
  },
});
const NORMAL_WEEKLY_DEAL = Object.freeze({
  productCode: "NB-101",
  name: "Taza transparente",
  discountPercent: 20,
  originalPrice: 2500,
  discountedPrice: 2000,
});

function rewriteLocation(location, publicOrigin, originUrl) {
  if (!location) return location;

  try {
    const resolved = new URL(location, originUrl);
    if (resolved.origin === new URL(originUrl).origin) {
      return `${publicOrigin}${resolved.pathname}${resolved.search}${resolved.hash}`;
    }
  } catch {
    return location;
  }

  return location;
}

function copyResponseHeaders(sourceHeaders, publicOrigin, originUrl) {
  const headers = new Headers(sourceHeaders);
  const location = headers.get("location");

  if (location) {
    headers.set("location", rewriteLocation(location, publicOrigin, originUrl));
  }

  const setCookies = sourceHeaders.getSetCookie?.() ?? [];
  if (setCookies.length > 0) {
    headers.delete("set-cookie");
    for (const cookie of setCookies) {
      headers.append("set-cookie", cookie.replace(/;\s*Domain=[^;]+/i, ""));
    }
  }

  return headers;
}

function serveStaticText(content, contentType, request) {
  return new Response(request.method === "HEAD" ? null : content, {
    status: 200,
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=300, must-revalidate",
      "x-content-type-options": "nosniff",
    },
  });
}

async function serveFixedImage(pathname, request) {
  const image = FIXED_IMAGE_SOURCES[pathname];
  if (!image) return null;

  try {
    const upstream = await fetch(image.url, {
      headers: {
        accept: "image/avif,image/webp,image/jpeg,image/*,*/*;q=0.8",
        referer: image.referer,
        "user-agent":
          "Mozilla/5.0 (compatible; NubekCatalogImageProxy/1.0; +https://catalogo-nubek.kiaranunezberro.workers.dev)",
      },
      cf: {
        cacheEverything: true,
        cacheTtl: 604800,
      },
    });

    if (!upstream.ok || !upstream.body) {
      throw new Error(`Image source returned ${upstream.status}`);
    }

    return new Response(request.method === "HEAD" ? null : upstream.body, {
      status: 200,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? image.contentType,
        "cache-control": "public, max-age=604800, immutable",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "fixed_image_fetch_failed",
        path: pathname,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return new Response("Imagen no disponible", {
      status: 502,
      headers: {
        "content-type": "text/plain; charset=UTF-8",
        "cache-control": "no-store",
      },
    });
  }
}

function shouldInjectEnhancements(pathname) {
  return (
    pathname === "/catalogo" ||
    pathname === "/cajas" ||
    pathname === "/producto" ||
    pathname.startsWith("/producto/")
  );
}

function looksLikeDealObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.productCode === "string" &&
    ("discountPercent" in value || "discountedPrice" in value)
  );
}

function isNormalCatalogDeal(value) {
  const code = String(value.productCode ?? "").trim();
  const descriptor = [
    value.category,
    value.catalog,
    value.collection,
    value.source,
    value.origin,
    value.name,
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase("es");

  return (
    /^NB-\d+$/.test(code) &&
    !/(día de la madre|dia de la madre|madre|mamá|mama|temporada)/i.test(
      descriptor,
    )
  );
}

function replaceSeasonalDeals(value) {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const result = replaceSeasonalDeals(item);
      changed ||= result.changed;
      return result.value;
    });
    return { value: changed ? next : value, changed };
  }

  if (value === null || typeof value !== "object") {
    return { value, changed: false };
  }

  if (looksLikeDealObject(value) && !isNormalCatalogDeal(value)) {
    return {
      value: {
        ...value,
        ...NORMAL_WEEKLY_DEAL,
        category: "Catálogo normal",
        source: "catalogo-normal",
      },
      changed: true,
    };
  }

  let changed = false;
  const next = {};
  for (const [key, child] of Object.entries(value)) {
    const result = replaceSeasonalDeals(child);
    next[key] = result.value;
    changed ||= result.changed;
  }
  return { value: changed ? next : value, changed };
}

function mayContainWeeklyDeal(pathname, headers) {
  if (!pathname.startsWith("/api/")) return false;
  if (/(weekly|week|deal|offer|oferta|discount|descuento|setting|config)/i.test(pathname)) {
    return true;
  }

  const length = Number(headers.get("content-length") ?? 0);
  return length > 0 && length <= MAX_REWRITABLE_JSON_BYTES;
}

async function maybeRewriteJsonResponse(
  upstream,
  responseHeaders,
  incomingUrl,
  request,
) {
  const contentType = upstream.headers.get("content-type") ?? "";
  if (
    request.method !== "GET" ||
    !contentType.includes("application/json") ||
    !mayContainWeeklyDeal(incomingUrl.pathname, upstream.headers)
  ) {
    return null;
  }

  const contentLength = Number(upstream.headers.get("content-length") ?? 0);
  if (contentLength > MAX_REWRITABLE_JSON_BYTES) return null;

  const body = await upstream.text();
  if (body.length > MAX_REWRITABLE_JSON_BYTES || !body.includes("productCode")) {
    return new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  }

  try {
    const parsed = JSON.parse(body);
    const rewritten = replaceSeasonalDeals(parsed);
    if (!rewritten.changed) {
      return new Response(body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    }

    const headers = new Headers(responseHeaders);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.set("cache-control", "no-store");
    headers.set("x-nubek-weekly-deal-source", "catalogo-normal");
    return new Response(JSON.stringify(rewritten.value), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "weekly_deal_rewrite_failed",
        path: incomingUrl.pathname,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  }
}

function buildHtmlRewriter(incomingUrl, injectEnhancements) {
  const rewriter = new HTMLRewriter()
    .on("a", {
      element(element) {
        const href = element.getAttribute("href");
        if (href) {
          element.setAttribute(
            "href",
            href.replace(ABSOLUTE_ORIGIN_PATTERN, incomingUrl.origin),
          );
        }
      },
    })
    .on("form", {
      element(element) {
        const action = element.getAttribute("action");
        if (action) {
          element.setAttribute(
            "action",
            action.replace(ABSOLUTE_ORIGIN_PATTERN, incomingUrl.origin),
          );
        }
      },
    });

  if (!injectEnhancements) return rewriter;

  return rewriter
    .on("head", {
      element(element) {
        element.append(
          `<link rel="stylesheet" href="/nubek-enhancements.css?v=${ENHANCEMENT_VERSION}">`,
          { html: true },
        );
      },
    })
    .on("body", {
      element(element) {
        element.setAttribute("data-nubek-catalog-enhanced", ENHANCEMENT_VERSION);
        element.append(
          `<script src="/nubek-enhancements.js?v=${ENHANCEMENT_VERSION}" defer></script>`,
          { html: true },
        );
      },
    });
}

export default {
  async fetch(request, env) {
    const incomingUrl = new URL(request.url);

    if (
      request.method === "GET" ||
      request.method === "HEAD"
    ) {
      if (incomingUrl.pathname === "/nubek-enhancements.js") {
        return serveStaticText(
          await getCatalogEnhancementScript(),
          "application/javascript; charset=UTF-8",
          request,
        );
      }
      if (incomingUrl.pathname === "/nubek-enhancements.css") {
        return serveStaticText(
          await getCatalogEnhancementCss(),
          "text/css; charset=UTF-8",
          request,
        );
      }
      const fixedImage = await serveFixedImage(incomingUrl.pathname, request);
      if (fixedImage) return fixedImage;
    }

    const targetUrl = new URL(env.ORIGIN_URL);
    targetUrl.pathname = incomingUrl.pathname;
    targetUrl.search = incomingUrl.search;

    const requestHeaders = new Headers(request.headers);
    requestHeaders.delete("host");
    requestHeaders.set("x-forwarded-host", incomingUrl.host);
    requestHeaders.set("x-forwarded-proto", incomingUrl.protocol.replace(":", ""));

    const init = {
      method: request.method,
      headers: requestHeaders,
      redirect: "manual",
    };

    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
    }

    try {
      const upstream = await fetch(new Request(targetUrl, init));
      const responseHeaders = copyResponseHeaders(
        upstream.headers,
        incomingUrl.origin,
        env.ORIGIN_URL,
      );

      const rewrittenJson = await maybeRewriteJsonResponse(
        upstream,
        responseHeaders,
        incomingUrl,
        request,
      );
      if (rewrittenJson) return rewrittenJson;

      const contentType = upstream.headers.get("content-type") ?? "";
      if (contentType.includes("text/html")) {
        const headers = new Headers(responseHeaders);
        if (shouldInjectEnhancements(incomingUrl.pathname)) {
          headers.delete("content-length");
          headers.set("cache-control", "no-cache");
        }
        return buildHtmlRewriter(
          incomingUrl,
          shouldInjectEnhancements(incomingUrl.pathname),
        ).transform(
          new Response(upstream.body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers,
          }),
        );
      }

      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "upstream_fetch_failed",
          path: incomingUrl.pathname,
          message: error instanceof Error ? error.message : String(error),
        }),
      );

      return new Response(
        "La tienda Nubek no está disponible temporalmente. Inténtalo de nuevo en unos minutos.",
        {
          status: 502,
          headers: {
            "content-type": "text/plain; charset=UTF-8",
            "cache-control": "no-store",
          },
        },
      );
    }
  },
};
