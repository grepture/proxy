import type { ActionPlugin } from "../providers/types";

const plugins = new Map<string, ActionPlugin>();

export function registerAction(plugin: ActionPlugin): void {
  if (plugins.has(plugin.type)) {
    console.warn(`Action plugin "${plugin.type}" already registered, overwriting`);
  }
  plugins.set(plugin.type, plugin);
}

export function getAction(type: string): ActionPlugin | undefined {
  return plugins.get(type);
}

export function hasAction(type: string): boolean {
  return plugins.has(type);
}

export function listActions(): string[] {
  return Array.from(plugins.keys());
}
