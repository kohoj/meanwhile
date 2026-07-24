import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi"
import type { TaskAnnotationService } from "../services/task-annotation-service"
import {
  type ApiEnv,
  CreateTaskAnnotationRequestSchema,
  createApiRouter,
  errorResponses,
  IdentifierSchema,
  jsonResponse,
  TaskAnnotationPageSchema,
  TaskAnnotationResponseSchema,
  TaskAnnotationSchema,
} from "./schemas"

const ProjectParamSchema = z.object({ projectId: IdentifierSchema }).strict()
const AnnotationParamSchema = z
  .object({ projectId: IdentifierSchema, annotationId: IdentifierSchema })
  .strict()
const TaskAnnotationQuerySchema = z
  .object({ taskKind: z.enum(["run", "session"]), taskId: IdentifierSchema })
  .strict()

const createAnnotationRoute = createRoute({
  method: "post",
  path: "/projects/{projectId}/annotations",
  operationId: "createTaskAnnotation",
  tags: ["Task Annotations"],
  request: {
    params: ProjectParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: CreateTaskAnnotationRequestSchema } },
    },
  },
  responses: {
    201: jsonResponse(TaskAnnotationResponseSchema, "Annotation created"),
    ...errorResponses,
  },
})

const listAnnotationsRoute = createRoute({
  method: "get",
  path: "/projects/{projectId}/annotations",
  operationId: "listTaskAnnotations",
  tags: ["Task Annotations"],
  request: { params: ProjectParamSchema, query: TaskAnnotationQuerySchema },
  responses: {
    200: jsonResponse(TaskAnnotationPageSchema, "Task annotations"),
    ...errorResponses,
  },
})

const resolveAnnotationRoute = createRoute({
  method: "post",
  path: "/projects/{projectId}/annotations/{annotationId}/resolve",
  operationId: "resolveTaskAnnotation",
  tags: ["Task Annotations"],
  request: { params: AnnotationParamSchema },
  responses: {
    200: jsonResponse(TaskAnnotationResponseSchema, "Annotation resolved"),
    ...errorResponses,
  },
})

export const createTaskAnnotationRoutes = (service: TaskAnnotationService): OpenAPIHono<ApiEnv> => {
  const routes = createApiRouter()
  routes.openapi(createAnnotationRoute, (context) =>
    context.json(
      {
        annotation: TaskAnnotationSchema.parse(
          service.create(
            context.get("requestContext"),
            context.req.valid("param").projectId,
            context.req.valid("json"),
          ),
        ),
      },
      201,
    ),
  )
  routes.openapi(listAnnotationsRoute, (context) => {
    const params = context.req.valid("param")
    const query = context.req.valid("query")
    return context.json(
      {
        items: service
          .list(context.get("requestContext"), params.projectId, {
            kind: query.taskKind,
            id: query.taskId,
          })
          .map((annotation) => TaskAnnotationSchema.parse(annotation)),
      },
      200,
    )
  })
  routes.openapi(resolveAnnotationRoute, (context) => {
    const params = context.req.valid("param")
    return context.json(
      {
        annotation: TaskAnnotationSchema.parse(
          service.resolve(context.get("requestContext"), params.projectId, params.annotationId),
        ),
      },
      200,
    )
  })
  return routes
}
