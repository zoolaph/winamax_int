# CloudFront — Deep Dive

## What CloudFront is

CloudFront is AWS's CDN (Content Delivery Network). It has 450+ edge locations (Points of Presence) worldwide. When a user requests content, CloudFront serves it from the PoP geographically closest to them — reducing latency and offloading traffic from your origin.

But CloudFront is not just for static files. It is a programmable proxy at the edge.

---

## Core concepts

### Distribution

A CloudFront distribution is the top-level configuration. It has:
- One or more **origins** (where to fetch content when cache misses)
- One or more **behaviors** (rules for how to handle requests to different paths)
- A domain name (`dxxxxx.cloudfront.net`) or a custom domain (via Route 53 + ACM cert)

### Origins

An origin is where CloudFront fetches content on a cache miss.

| Origin type | Example |
|--|--|
| S3 bucket | Static assets, JS bundles, images |
| ALB | Dynamic API, SSR frontend |
| EC2 instance | Custom origin |
| API Gateway | Serverless API |
| Any HTTP endpoint | On-premises, other clouds |

**Origin Access Control (OAC):** For S3 origins, use OAC to ensure the S3 bucket is only accessible via CloudFront — not directly. CloudFront signs requests to S3 using SigV4. The S3 bucket policy allows only the CloudFront service principal.

### Behaviors (Cache Behaviors)

A behavior is a path pattern + set of rules. CloudFront matches the request path against behaviors in order and applies the first match.

```
Distribution behaviors (evaluated in order):

Path: /static/*
  Origin: s3-bucket-winamax-static
  Cache Policy: CachingOptimized (TTL: 86400s)
  Viewer Protocol Policy: Redirect HTTP to HTTPS

Path: /api/live/odds
  Origin: alb-odds-live
  Cache Policy: CachingDisabled        ← never cache live odds
  Origin Request Policy: forward all headers
  Viewer Protocol Policy: HTTPS only

Path: /api/*
  Origin: alb-api-prod
  Cache Policy: CachingOptimized (TTL: 5s)   ← short TTL for semi-dynamic API
  
Default (*):
  Origin: alb-frontend
  Cache Policy: CachingDisabled
```

### Cache policies

Cache policies control what CloudFront uses as the cache key and how long it caches responses.

- **CachingOptimized** — built-in, caches for a long time, only uses URL as cache key. Good for immutable static assets.
- **CachingDisabled** — built-in, never caches. Good for dynamic APIs.
- **Custom** — define TTL (min, max, default) and what to include in cache key (headers, cookies, query strings).

**Cache key considerations:**
- Including the `Authorization` header in the cache key = authenticated responses are cached per-user. This can cause cache thrashing (each user gets a cache miss).
- For public content: URL only in cache key, long TTL.
- For user-specific content: disable caching or include session identifier in cache key.

### Origin request policies

Controls what CloudFront forwards to the origin on a cache miss (headers, cookies, query strings). This is separate from the cache key — you might forward the `Authorization` header to the origin without including it in the cache key.

---

## TLS at the edge

CloudFront terminates TLS at the edge, close to the user. The certificate must be in **ACM in us-east-1** (global region for CloudFront), not in the regional ACM.

- User ↔ CloudFront: TLS with your custom certificate.
- CloudFront ↔ Origin (ALB): TLS with ALB's certificate. CloudFront can verify the origin's certificate.

---

## CloudFront Functions and Lambda@Edge

CloudFront allows code execution at the edge, close to users.

| | CloudFront Functions | Lambda@Edge |
|--|--|--|
| Trigger | Viewer request/response | Viewer + origin request/response |
| Runtime | JS (subset) | Node.js, Python |
| Max duration | 1ms | 5s (viewer) / 30s (origin) |
| Max memory | 2MB | 128MB–10GB |
| Use cases | URL rewrites, header manipulation, simple auth | A/B testing, SSR, auth with external calls, image resizing |
| Cost | Very cheap (~$0.0000001/invocation) | More expensive |

**Common use cases for Winamax:**
- CloudFront Functions: redirect `/` to the French locale, add security headers (`X-Frame-Options`, `Content-Security-Policy`) at the edge.
- Lambda@Edge: validate JWT tokens at the edge before proxying to the API origin, reducing load on the origin for unauthenticated requests.

---

## Cache invalidation

When you deploy a new version of a file, CloudFront might still serve the old cached version until TTL expires.

Two strategies:
1. **Invalidation** — explicitly expire cached objects by path (`/static/app.js` or `/static/*`). Cost: first 1,000 paths/month free, then $0.005/path.
2. **Versioned filenames** — include a hash in the filename (`app.abc123.js`). Deploy new file with new hash. Old URL stays cached (harmless), new URL is a cache miss on first request. Zero cost, zero delay.

**Best practice:** Use versioned filenames for immutable assets (JS, CSS, images). Use invalidation only for mutable content (HTML index files, API responses).

---

## Winamax use case

At 900k bets/day with a global player base:

1. **Static frontend assets** — served from CloudFront/S3. Hash-versioned filenames, long TTL (1 year). New deploy = new hashes, no invalidation needed. Players worldwide get sub-50ms load times for assets.

2. **Live odds API** — caching disabled for the `/api/live/*` path. CloudFront still helps here as a TCP termination layer (TLS handshake at the edge PoP, not Paris), reducing connection overhead for international players.

3. **Sports data (non-live)** — short TTL (5–30s). Pre-match odds, tournament schedules. Cached at edge, dramatically reduces origin load during pre-match period (when millions of users check odds before a game starts).

4. **Security headers** — CloudFront Functions add `Content-Security-Policy`, `X-Frame-Options`, `Strict-Transport-Security` to every response, without modifying the origin application.

---

## K8s bridge

In Kubernetes, an Ingress controller (NGINX, Traefik) handles routing at the cluster edge. CloudFront sits further upstream — before traffic ever reaches AWS (or your Kubernetes cluster). 

The mental model: CloudFront is like a globally distributed Ingress that has a massive shared cache and 450 edge locations. Your Kubernetes Ingress or AWS ALB is the "origin" that CloudFront proxies to on cache misses.
