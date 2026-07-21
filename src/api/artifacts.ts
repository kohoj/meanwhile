import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi"
import type { ArtifactService } from "../services/artifact-service"
import {
  type ApiEnv,
  ArtifactDetailSchema,
  ArtifactIdParamSchema,
  createApiRouter,
  errorResponses,
  jsonResponse,
  RelativeWorkspacePathSchema,
} from "./schemas"

const getArtifactRoute = createRoute({
  method: "get",
  path: "/artifacts/{id}",
  operationId: "getArtifact",
  tags: ["Artifacts"],
  summary: "Inspect one immutable artifact manifest",
  request: { params: ArtifactIdParamSchema },
  responses: {
    200: jsonResponse(ArtifactDetailSchema, "Artifact metadata and immutable entries"),
    ...errorResponses,
  },
})

const downloadArtifactRoute = createRoute({
  method: "get",
  path: "/artifacts/{id}/content",
  operationId: "downloadArtifactContent",
  tags: ["Artifacts"],
  summary: "Download one immutable artifact entry",
  request: {
    params: ArtifactIdParamSchema,
    query: z.object({ path: RelativeWorkspacePathSchema.optional() }).strict(),
  },
  responses: {
    200: {
      description: "Immutable artifact entry bytes",
      content: { "application/octet-stream": { schema: z.string() } },
    },
    ...errorResponses,
  },
})

export const createArtifactRoutes = (
  service: Pick<ArtifactService, "get" | "read">,
): OpenAPIHono<ApiEnv> => {
  const routes = createApiRouter()

  routes.openapi(getArtifactRoute, async (context) => {
    const request = context.get("requestContext")
    const { id } = context.req.valid("param")
    return context.json(ArtifactDetailSchema.parse(await service.get(request, id)), 200)
  })

  routes.openapi(downloadArtifactRoute, async (context) => {
    const request = context.get("requestContext")
    const { id } = context.req.valid("param")
    const { path } = context.req.valid("query")
    const content = await service.read(request, id, path)
    const filename = content.path.split("/").at(-1) ?? "artifact"
    return new Response(Uint8Array.from(content.bytes).buffer, {
      headers: {
        "Cache-Control": "private, immutable, max-age=31536000",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Content-Length": String(content.bytes.byteLength),
        "Content-Type": "application/octet-stream",
        ETag: `"sha256-${content.digest}"`,
        "X-Content-Type-Options": "nosniff",
        "X-Meanwhile-Artifact-Digest": content.digest,
        "X-Meanwhile-Media-Type": content.mediaType,
      },
    })
  })

  return routes
}
