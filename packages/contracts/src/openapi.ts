import { z } from 'zod';
import { ErrorBodySchema } from './errors.js';

export interface OpenApiRoute {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  summary: string;
  request?: z.ZodType;
  responses: Record<number, { description: string; schema?: z.ZodType }>;
}

/**
 * Builds an OpenAPI 3.1 document from the same Zod schemas the handlers use,
 * so the published contract cannot drift from validation.
 */
export function buildOpenApiDocument(info: {
  title: string;
  version: string;
  routes: OpenApiRoute[];
}): Record<string, unknown> {
  const json = (schema: z.ZodType) =>
    z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of info.routes) {
    const openApiPath = route.path.replace(/:(\w+)/g, '{$1}');
    const params = [...route.path.matchAll(/:(\w+)/g)].map((m) => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    const responses: Record<string, unknown> = {};
    for (const [status, r] of Object.entries(route.responses)) {
      responses[status] = r.schema
        ? {
            description: r.description,
            content: { 'application/json': { schema: json(r.schema) } },
          }
        : { description: r.description };
    }
    responses['default'] = {
      description: 'Error',
      content: { 'application/json': { schema: json(ErrorBodySchema) } },
    };
    (paths[openApiPath] ??= {})[route.method] = {
      summary: route.summary,
      ...(params.length > 0 ? { parameters: params } : {}),
      ...(route.request
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: json(route.request) } },
            },
          }
        : {}),
      responses,
    };
  }
  return { openapi: '3.1.0', info: { title: info.title, version: info.version }, paths };
}
