import {
  createMcpHandler, fromJsonSchema, hostHeaderValidationResponse,
  McpServer, originValidationResponse,
  type JSONValue as McpJsonValue, type JsonSchemaType,
} from '@modelcontextprotocol/server';
import type { OntologyToolRegistry, ToolContext } from './registry.js';

export interface OntologyMcpHttpOptions {
  /** Hostnames, without scheme or port, accepted by this mounted endpoint. */
  allowedHosts: readonly string[];
  /** Hostnames, without scheme or port, accepted in an Origin header. */
  allowedOriginHostnames: readonly string[];
}

/**
 * Thin 2026-07-28 SDK Streamable HTTP adapter for tool discovery, pure queries,
 * and action previews. The caller must authenticate each request and pass its
 * resulting ToolContext. No connector write is exposed here.
 */
export function createOntologyMcpHttpAdapter(registry: OntologyToolRegistry, options: OntologyMcpHttpOptions) {
  if (!options.allowedHosts.length || !options.allowedOriginHostnames.length) {
    throw new TypeError('explicit Host and Origin allowlists are required');
  }
  return {
    async fetch(request: Request, context: ToolContext): Promise<Response> {
      const rejected = hostHeaderValidationResponse(request, [...options.allowedHosts])
        ?? originValidationResponse(request, [...options.allowedOriginHostnames]);
      if (rejected) return rejected;
      if (!context?.tenantId || !context.actorId || !context.releaseId) {
        return new Response('Authenticated ontology context required', { status: 401 });
      }

      // The handler and server are scoped to one request, so no tool list or
      // tenant identity can leak across connections or authentication changes.
      const handler = createMcpHandler(async () => {
        const server = new McpServer({ name: 'onto-planet-ontology', version: '0.1.0' }, {
          capabilities: { tools: {} },
        });
        for (const tool of await registry.listTools(context)) {
          server.registerTool(tool.name, {
            title: tool.title,
            description: tool.description,
            inputSchema: fromJsonSchema(tool.inputSchema as JsonSchemaType),
            annotations: tool.annotations,
          }, async (args) => {
            const result = await registry.callTool(context, tool.name, args);
            return {
              content: result.content,
              ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent as McpJsonValue }),
              ...(result.isError === undefined ? {} : { isError: result.isError }),
            };
          });
        }
        return server;
      }, { legacy: 'reject' });
      try {
        return await handler.fetch(request);
      } finally {
        await handler.close();
      }
    },
  };
}
