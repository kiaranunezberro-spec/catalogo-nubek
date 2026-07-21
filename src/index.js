const ABSOLUTE_ORIGIN_PATTERN =
  /https:\/\/catalogo-nubek\.kiaranunezberro\.chatgpt\.site/gi;

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

export default {
  async fetch(request, env) {
    const incomingUrl = new URL(request.url);
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

      const contentType = upstream.headers.get("content-type") ?? "";
      if (contentType.includes("text/html")) {
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

        return rewriter.transform(
          new Response(upstream.body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: responseHeaders,
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
