import { gitDiffTool, gitStatusTool } from './builtin/gitTools';
import { proposeChangesTool } from './builtin/proposeChanges';
import { listDirectoryTool, readFileTool, searchFilesTool } from './builtin/readTools';
import { runCommandTool } from './builtin/runCommand';
import { updatePlanTool } from './builtin/updatePlan';
import { ToolRegistry } from './registry';

/** The registry with every built-in tool. */
export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(readFileTool)
    .register(searchFilesTool)
    .register(listDirectoryTool)
    .register(gitStatusTool)
    .register(gitDiffTool)
    .register(proposeChangesTool)
    .register(runCommandTool)
    .register(updatePlanTool);
}

export { ToolRegistry } from './registry';
export type { PermissionClass, RunRecord, ToolContext, ToolDefinition } from './types';
