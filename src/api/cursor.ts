import { AppError } from "../errors"

export const parseLastEventId = (value: string | undefined): number => {
  if (value === undefined || value.length === 0) return 0
  if (!/^\d+$/.test(value)) {
    throw new AppError({ code: "INVALID_REQUEST", message: "Last-Event-ID must be an integer" })
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new AppError({ code: "INVALID_REQUEST", message: "Last-Event-ID is out of range" })
  }
  return parsed
}
