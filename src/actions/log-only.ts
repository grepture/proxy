import type { LogOnlyAction, ActionResult } from "../types";

export function executeLogOnly(action: LogOnlyAction): ActionResult {
  return {
    tags: [{ severity: action.severity, label: action.label }],
  };
}
