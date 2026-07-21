import type { AuditRecord, RequestContext } from "../domain"
import { AppError } from "../errors"
import type { Page, Store } from "../persistence/store"

/** Read-only owner boundary over append-only mutation evidence. */
export class AuditService {
  constructor(private readonly store: Pick<Store, "listAuditPage">) {}

  list(
    scope: string | RequestContext,
    options: {
      limit: number
      before?: string
      resourceType?: AuditRecord["resourceType"]
      resourceId?: string
      action?: string
    },
  ): Page<AuditRecord> {
    if (typeof scope !== "string" && scope.ownerRole !== "admin") {
      throw new AppError({ code: "NOT_FOUND", message: "Audit records not found" })
    }
    return this.store.listAuditPage(typeof scope === "string" ? scope : scope.ownerId, options)
  }
}
