import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

/**
 * Recursively extracts top-level property names from a Zod schema,
 * handling ZodObject, ZodIntersection, ZodOptional, ZodDefault, ZodNullable
 */
function extractPropertyNames(schema: unknown): string[] {
  if (!schema || typeof schema !== 'object') {
    return [];
  }

  const schemaDef = (schema as any)._def;
  if (!schemaDef) {
    return [];
  }

  const typeName = schemaDef.typeName || schemaDef.type;

  // Handle ZodObject - extract shape keys
  if (typeName === 'ZodObject' || typeName === 'object') {
    const shape = typeof schemaDef.shape === 'function'
      ? schemaDef.shape()
      : schemaDef.shape || {};
    return Object.keys(shape);
  }

  // Handle ZodIntersection - merge properties from both sides
  if (typeName === 'ZodIntersection' || typeName === 'intersection') {
    const leftKeys = extractPropertyNames(schemaDef.left);
    const rightKeys = extractPropertyNames(schemaDef.right);
    return [...new Set([...leftKeys, ...rightKeys])];
  }

  // Handle wrapper types - unwrap and recurse
  if (typeName === 'ZodOptional' || typeName === 'ZodDefault' ||
      typeName === 'ZodNullable' || typeName === 'optional') {
    return extractPropertyNames(schemaDef.innerType);
  }

  // Handle ZodEffects (refinements, transforms)
  if (typeName === 'ZodEffects') {
    return extractPropertyNames(schemaDef.schema);
  }

  return [];
}

/**
 * Creates a Claude-safe schema with z.unknown() for all properties
 */
function createSafeSchema(propertyNames: string[]) {
  const shape: Record<string, z.ZodUnknown> = {};
  for (const name of propertyNames) {
    shape[name] = z.unknown();
  }
  return z.object(shape);
}

/**
 * Wraps MCP tools with Claude-safe schemas
 */
export function wrapMcpToolsForClaude(
  mcpTools: Record<string, any>
): Record<string, any> {
  const wrappedTools: Record<string, any> = {};

  for (const [toolName, tool] of Object.entries(mcpTools)) {
    const propertyNames = extractPropertyNames(tool.inputSchema);
    const safeSchema = createSafeSchema(propertyNames);

    wrappedTools[toolName] = createTool({
      id: tool.id || toolName,
      description: tool.description || '',
      inputSchema: safeSchema,
      outputSchema: tool.outputSchema || z.unknown(),
      execute: async (params) => {
        // Pass through to original tool's execute
        return tool.execute(params);
      },
    });
  }

  return wrappedTools;
}
