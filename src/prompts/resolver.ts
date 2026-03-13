import type { PromptMessage } from "../types";

/**
 * Resolve Handlebars-style templates in prompt messages.
 * Supports: {{variable}}, {{#if var}}...{{else}}...{{/if}}, {{#each var}}...{{/each}}
 */
export function resolveMessages(
  messages: PromptMessage[],
  variables: Record<string, string>,
): PromptMessage[] {
  return messages.map((msg) => ({
    role: msg.role,
    content: resolveTemplate(msg.content, variables),
  }));
}

export function resolveTemplate(template: string, variables: Record<string, string>): string {
  let result = template;

  // Handle {{ #if var }}...{{ /if }} blocks
  result = result.replace(
    /\{\{\s*#if\s+(\w+)\s*\}\}([\s\S]*?)(?:\{\{\s*else\s*\}\}([\s\S]*?))?\{\{\s*\/if\s*\}\}/g,
    (_, varName, ifBlock, elseBlock) => {
      const value = variables[varName];
      if (value && value !== "false" && value !== "0") {
        return resolveTemplate(ifBlock, variables);
      }
      return elseBlock ? resolveTemplate(elseBlock, variables) : "";
    },
  );

  // Handle {{ #each var }}...{{ /each }} blocks
  result = result.replace(
    /\{\{\s*#each\s+(\w+)\s*\}\}([\s\S]*?)\{\{\s*\/each\s*\}\}/g,
    (_, varName, block) => {
      const value = variables[varName];
      if (!value) return "";
      try {
        const items = JSON.parse(value);
        if (!Array.isArray(items)) return "";
        return items
          .map((item) => {
            const itemVars =
              typeof item === "object"
                ? { ...variables, ...item, this: JSON.stringify(item) }
                : { ...variables, this: String(item) };
            return resolveTemplate(block, itemVars);
          })
          .join("");
      } catch {
        return "";
      }
    },
  );

  // Handle {{ variable }} interpolation
  result = result.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, varName) => {
    return variables[varName] ?? "";
  });

  return result;
}
