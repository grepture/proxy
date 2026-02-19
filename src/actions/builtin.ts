import { registerAction } from "./registry";
import { executeRedactPii } from "./redact-pii";
import { executeFindReplace } from "./find-replace";
import { executeTokenize } from "./tokenize";
import { executeRedactField } from "./redact-field";
import { executeBlockRequest } from "./block-request";
import { executeLogOnly } from "./log-only";
import type { RuleAction, RequestContext } from "../types";
import type { TokenVault } from "../providers/types";

export function registerBuiltinActions(): void {
  registerAction({
    type: "redact_pii",
    execute: (ctx, action, vault) =>
      executeRedactPii(ctx, action as Parameters<typeof executeRedactPii>[1], vault),
  });

  registerAction({
    type: "find_replace",
    async execute(ctx, action) {
      return executeFindReplace(ctx, action as Parameters<typeof executeFindReplace>[1]);
    },
  });

  registerAction({
    type: "tokenize",
    execute: (ctx, action, vault) =>
      executeTokenize(ctx, action as Parameters<typeof executeTokenize>[1], vault),
  });

  registerAction({
    type: "redact_field",
    async execute(ctx, action) {
      return executeRedactField(ctx, action as Parameters<typeof executeRedactField>[1]);
    },
  });

  registerAction({
    type: "block_request",
    async execute(_ctx, action) {
      return executeBlockRequest(action as Parameters<typeof executeBlockRequest>[0]);
    },
  });

  registerAction({
    type: "log_only",
    async execute(_ctx, action) {
      return executeLogOnly(action as Parameters<typeof executeLogOnly>[0]);
    },
  });
}
