import type { Result } from "../shared/bridge.ts";
import { userErrorMessage } from "./user-error.ts";

class UserFacingError extends Error {
  override toString(): string {
    return this.message;
  }
}

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new UserFacingError(userErrorMessage(result.error), { cause: result.error });
  return result.value;
}
