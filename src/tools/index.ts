import { proposeChangesTool } from './builtin/proposeChanges';
import { listDirectoryTool, readFileTool, searchFilesTool } from './builtin/readTools';
import { ToolRegistry } from './registry';

/** The registry with every built-in tool. */
export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry().register(readFileTool).register(searchFilesTool).register(listDirectoryTool).register(proposeChangesTool);
}

export { ToolRegistry } from './registry';
export type { PermissionClass, RunRecord, ToolContext, ToolDefinition } from './types';
