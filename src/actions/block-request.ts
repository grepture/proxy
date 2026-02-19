import type { BlockRequestAction, ActionResult } from "../types";

export function executeBlockRequest(action: BlockRequestAction): ActionResult {
  return {
    blocked: true,
    statusCode: action.status_code,
    message: action.message,
  };
}
