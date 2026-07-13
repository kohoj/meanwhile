import { lstat, realpath } from "node:fs/promises"
import { resolve, sep } from "node:path"
import { normalizeArtifactPath } from "../services/artifact-collector"

export interface LocalStaticServerOptions {
  root: string
  hostname?: string
  port?: number
  /** Browser-facing origin when the bind address is not itself reachable. */
  publicOrigin?: string
}

/** Serves immutable previews on an origin separate from the authenticated API. */
export class LocalStaticServer {
  readonly #root: string
  readonly #hostname: string
  readonly #port: number
  readonly #publicOrigin: string | undefined
  #server: ReturnType<typeof Bun.serve> | null = null

  constructor(options: LocalStaticServerOptions) {
    if (options.root.trim().length === 0) {
      throw new Error("Local static root must not be empty.")
    }
    this.#root = resolve(options.root)
    this.#hostname = options.hostname ?? "127.0.0.1"
    this.#port = options.port ?? 0
    this.#publicOrigin =
      options.publicOrigin === undefined ? undefined : normalizePublicOrigin(options.publicOrigin)
    if (isWildcardHost(this.#hostname) && this.#publicOrigin === undefined) {
      throw new Error("A public preview origin is required when binding all interfaces.")
    }
  }

  start(): URL {
    if (this.#server === null) {
      this.#server = Bun.serve({
        hostname: this.#hostname,
        port: this.#port,
        fetch: (request) => this.#fetch(request),
      })
    }
    return new URL(`${this.origin}/`)
  }

  async stop(): Promise<void> {
    const server = this.#server
    this.#server = null
    if (server !== null) await server.stop(true)
  }

  get origin(): string {
    if (this.#server === null) {
      throw new Error("Local static server has not been started.")
    }
    return this.#publicOrigin ?? this.#server.url.origin
  }

  /** Internal publication root shared with the local-static adapter. */
  get root(): string {
    return this.#root
  }

  deploymentUrl(deploymentId: string): string {
    assertDeploymentId(deploymentId)
    return new URL(`/d/${deploymentId}/`, `${this.origin}/`).toString()
  }

  async #fetch(request: Request): Promise<Response> {
    const headers = securityHeaders()
    if (request.method !== "GET" && request.method !== "HEAD") {
      headers.set("Allow", "GET, HEAD")
      return new Response("Method Not Allowed", { status: 405, headers })
    }

    let pathname: string
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname)
    } catch {
      return new Response("Not Found", { status: 404, headers })
    }

    const match = /^\/d\/([^/]+)(?:\/(.*))?$/.exec(pathname)
    if (match === null || !isPreviewDeploymentId(match[1] ?? "")) {
      return new Response("Not Found", { status: 404, headers })
    }

    const deploymentId = match[1] as string
    const requested = match[2] === undefined || match[2] === "" ? "index.html" : match[2]
    let relativePath: string
    try {
      relativePath = normalizeArtifactPath(requested)
    } catch {
      return new Response("Not Found", { status: 404, headers })
    }

    const publicRoot = resolve(this.#root, deploymentId, "public")
    if (!isContained(this.#root, publicRoot)) {
      return new Response("Not Found", { status: 404, headers })
    }

    const filePath = await findStaticFile(publicRoot, relativePath)
    if (filePath === null) {
      return new Response("Not Found", { status: 404, headers })
    }

    const file = Bun.file(filePath)
    headers.set("Content-Type", file.type || "application/octet-stream")
    headers.set("Content-Length", String(file.size))
    headers.set("Cache-Control", "public, max-age=31536000, immutable")
    return new Response(request.method === "HEAD" ? null : file, { headers })
  }
}

function normalizePublicOrigin(value: string): string {
  const url = new URL(value)
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(
      "The public preview URL must be an HTTP(S) origin without credentials or a path.",
    )
  }
  return url.origin
}

function isWildcardHost(hostname: string): boolean {
  return hostname === "0.0.0.0" || hostname === "::" || hostname === "0:0:0:0:0:0:0:0"
}

export function isPreviewDeploymentId(value: string): boolean {
  // UUID/ULID/nanoid-like IDs; long enough to be unguessable when generated well.
  return /^[A-Za-z0-9_-]{16,128}$/.test(value)
}

function assertDeploymentId(value: string): void {
  if (!isPreviewDeploymentId(value)) {
    throw new Error("Deployment identity is invalid for local preview.")
  }
}

async function findStaticFile(publicRoot: string, relativePath: string): Promise<string | null> {
  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(publicRoot)
  } catch {
    return null
  }

  let candidate = resolve(publicRoot, relativePath)
  if (!isContained(publicRoot, candidate)) return null

  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(candidate)
    if (info.isDirectory()) {
      candidate = resolve(candidate, "index.html")
      info = await lstat(candidate)
    }
    if (!info.isFile() || info.isSymbolicLink()) return null
  } catch {
    return null
  }

  let canonicalFile: string
  try {
    canonicalFile = await realpath(candidate)
  } catch {
    return null
  }
  return isContained(canonicalRoot, canonicalFile) ? canonicalFile : null
}

function isContained(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

function securityHeaders(): Headers {
  return new Headers({
    "Content-Security-Policy":
      "default-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  })
}
