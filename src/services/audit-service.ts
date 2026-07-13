import type { AuditRecord } from "../domain"
import type { Page, Store } from "../persistence/store"

/** Read-only owner boundary over append-only mutation evidence. */
export class AuditService {
  constructor(private readonly store: Pick<Store, "listAuditPage">) {}

  list(
    ownerId: string,
    options: {
      limit: number
      before?: string
      resourceType?: AuditRecord["resourceType"]
      resourceId?: string
      action?: string
    },
  ): Page<AuditRecord> {
    return this.store.listAuditPage(ownerId, options)
  }
}
