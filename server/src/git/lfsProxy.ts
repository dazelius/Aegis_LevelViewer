/**
 * Local HTTP forward-proxy used to rescue git-lfs object downloads
 * when the GitLab batch API returns unreachable absolute URLs in
 * `actions.download.href`.
 *
 * Background
 * ----------
 * Project Aegis' GitLab instance is bound to an internal IP
 * (172.31.2.91) that deploy hosts can reach, but its `external_url`
 * is set to a different IP (13.209.114.157) that they CAN'T. The
 * batch API we hit on the internal IP still hands out download hrefs
 * pointing at the external one, and git-lfs then dials that address
 * directly — the connection times out and the fetch fails.
 *
 * We can't fix that with `url.<to>.insteadOf=<from>` because git-lfs's
 * HTTP client doesn't run the batch-returned URLs through git's
 * transport rewrite layer. It DOES, however, honour `http.<URL>.proxy`
 * for those URLs. So we run a tiny in-process HTTP proxy that simply
 * forwards everything it receives to the internal host, and wire each
 * rewrite pair's `<from>` URL to go through it via `http.<from>.proxy`.
 *
 * The proxy is deliberately minimal: it only understands HTTP (git-lfs
 * object downloads on this deploy are all `http://`), forwards the
 * request body as a stream, and rewrites the `Host` header to the
 * target's host:port so the destination GitLab routes correctly.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { URL } from 'node:url';

export interface LfsProxyPair {
  /** Unreachable URL prefix returned by GitLab, e.g. `http://13.209.114.157/`. */
  from: string;
  /** Reachable URL prefix on the same GitLab, e.g. `http://172.31.2.91/`. */
  to: string;
}

export interface LfsProxyInfo {
  /** Port the local proxy is listening on (127.0.0.1). */
  port: number;
  pairs: LfsProxyPair[];
}

let proxyServer: http.Server | null = null;
let proxyInfo: LfsProxyInfo | null = null;

function parsePairs(pairs: LfsProxyPair[]): Map<string, URL> {
  const map = new Map<string, URL>();
  for (const { from, to } of pairs) {
    try {
      const fromUrl = new URL(from);
      const toUrl = new URL(to);
      map.set(fromUrl.host, toUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[lfsProxy] ignoring malformed rewrite ${from} -> ${to}: ${msg}`);
    }
  }
  return map;
}

/**
 * Start the local HTTP proxy. Idempotent — returns the existing info
 * if already running. `null` when there are no rewrite pairs to
 * handle (caller should skip `http.<URL>.proxy` config entirely).
 */
export async function startLfsProxy(pairs: LfsProxyPair[]): Promise<LfsProxyInfo | null> {
  if (proxyInfo) return proxyInfo;
  if (pairs.length === 0) return null;

  const rewriteByHost = parsePairs(pairs);
  if (rewriteByHost.size === 0) return null;

  proxyServer = http.createServer((req, res) => {
    try {
      // For proxy-style requests the HTTP client puts the absolute
      // target URL on the request line, so `req.url` is something
      // like `http://13.209.114.157/some/path?q=1`.
      const rawUrl = req.url || '';
      let target: URL;
      try {
        target = new URL(rawUrl);
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end(`[lfsProxy] not an absolute URL: ${rawUrl}`);
        return;
      }

      const rewriteTo = rewriteByHost.get(target.host);
      if (!rewriteTo) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end(`[lfsProxy] no rewrite rule for ${target.host}`);
        return;
      }

      const upstreamHost = rewriteTo.hostname;
      const upstreamPort =
        rewriteTo.port.length > 0 ? Number(rewriteTo.port) : 80;
      const upstreamHostHeader = rewriteTo.port
        ? `${rewriteTo.hostname}:${rewriteTo.port}`
        : rewriteTo.hostname;

      // Clone request headers but swap `host` so the destination's
      // reverse-proxy / VHost routing matches what it actually serves.
      const forwardHeaders: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        // Drop proxy-specific hop-by-hop headers that shouldn't
        // propagate. `connection`/`proxy-connection` most importantly
        // — leaving `Proxy-Connection` on a forwarded request confuses
        // some origin servers.
        if (k === 'proxy-connection' || k === 'proxy-authorization') continue;
        forwardHeaders[k] = v;
      }
      forwardHeaders.host = upstreamHostHeader;

      const upstream = http.request(
        {
          host: upstreamHost,
          port: upstreamPort,
          method: req.method,
          path: `${target.pathname}${target.search}`,
          headers: forwardHeaders,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode || 500, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );

      upstream.on('error', (err) => {
        console.warn(`[lfsProxy] upstream error for ${target.host} -> ${upstreamHost}: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
        }
        res.end(err.message);
      });

      req.pipe(upstream);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[lfsProxy] handler error: ${msg}`);
      if (!res.headersSent) res.writeHead(500);
      res.end(msg);
    }
  });

  return new Promise((resolve, reject) => {
    proxyServer!.once('error', (err) => {
      console.warn(`[lfsProxy] listen error: ${err.message}`);
      proxyServer = null;
      reject(err);
    });
    // Bind to loopback only — this proxy exists purely for
    // in-process git-lfs subprocesses and must never accept external
    // traffic (it would happily forward anything to the internal
    // GitLab, auth-free).
    proxyServer!.listen(0, '127.0.0.1', () => {
      const addr = proxyServer!.address() as AddressInfo;
      proxyInfo = { port: addr.port, pairs };
      const rules = pairs.map((p) => `${p.from} -> ${p.to}`).join(', ');
      console.log(`[lfsProxy] listening on http://127.0.0.1:${addr.port} (rewrites: ${rules})`);
      resolve(proxyInfo);
    });
  });
}

export function getLfsProxyInfo(): LfsProxyInfo | null {
  return proxyInfo;
}
