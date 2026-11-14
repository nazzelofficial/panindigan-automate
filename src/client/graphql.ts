/**
 * GraphQL transport helpers.
 *
 * Facebook exposes three GraphQL surfaces used by the client:
 * - `/api/graphqlbatch/` for the batched thread list/info/history queries,
 * - `/api/graphql/` for single-document mutations such as group creation,
 * - `/webgraphql/mutation/` for reaction mutations.
 *
 * The batch endpoint replies with concatenated JSON documents (one per batch
 * entry plus a summary), which `HttpTransport.check` already decodes. This
 * module wraps the request shapes and pulls the `o0.data` payload out of the
 * batch envelope.
 */

import { FB_BASE_URL } from "../constants.js";
import type { FormValue, HttpTransport } from "../transport/http/index.js";

/** Batched GraphQL endpoint. */
export const GRAPHQL_BATCH_URL = `${FB_BASE_URL}/api/graphqlbatch/`;

/** Single-document GraphQL endpoint. */
export const GRAPHQL_URL = `${FB_BASE_URL}/api/graphql/`;

/** Web GraphQL mutation endpoint used by reactions. */
export const WEBGRAPHQL_MUTATION_URL = `${FB_BASE_URL}/webgraphql/mutation/`;

/** A decoded batch response: every document, the first result payload, and the summary. */
export interface GraphQLBatchResult {
  readonly entries: readonly Record<string, unknown>[];
  /** The first `o0.data` (or bare `data`) payload found, when present. */
  readonly data: Record<string, unknown> | null;
  /** The trailing summary document, when the payload was a batch. */
  readonly summary: Record<string, unknown> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalizes a decoded `/api/graphqlbatch/` body into its documents.
 * Single-document responses are wrapped so callers always see a list.
 */
export function parseGraphQLBatch(payload: unknown): GraphQLBatchResult {
  const list = Array.isArray(payload) ? payload : [payload];
  const entries = list.filter(isRecord);
  const summary = entries.length > 0 ? (entries[entries.length - 1] ?? null) : null;

  let data: Record<string, unknown> | null = null;
  for (const entry of entries) {
    const o0 = isRecord(entry["o0"]) ? entry["o0"] : null;
    const candidate = o0 !== null ? o0["data"] : entry["data"];
    if (isRecord(candidate)) {
      data = candidate;
      break;
    }
  }

  return { entries, data, summary };
}

/**
 * Runs a batched GraphQL request. `queries` is the named-query map Facebook
 * expects (usually `{ o0: { doc_id, query_params } }`).
 */
export async function postGraphQLBatch(
  http: HttpTransport,
  operation: string,
  queries: Readonly<Record<string, unknown>>,
  batchName?: string | undefined,
): Promise<GraphQLBatchResult> {
  const form: Record<string, FormValue> = { queries: JSON.stringify(queries) };
  if (batchName !== undefined) {
    form["batch_name"] = batchName;
  }
  const response = await http.postForm(operation, GRAPHQL_BATCH_URL, form);
  return parseGraphQLBatch(http.check(operation, response));
}

/**
 * Runs a single-document GraphQL mutation at `/api/graphql/` and returns the
 * parsed JSON body.
 */
export async function postGraphQL(
  http: HttpTransport,
  operation: string,
  form: Readonly<Record<string, FormValue>>,
): Promise<unknown> {
  const response = await http.postForm(operation, GRAPHQL_URL, form);
  return http.check(operation, response);
}

/**
 * Runs a web GraphQL mutation (reactions) and returns the parsed JSON body.
 * The endpoint's response is not used beyond error detection, but returning it
 * keeps the helper honest and testable.
 */
export async function postWebGraphQLMutation(
  http: HttpTransport,
  operation: string,
  docId: string,
  variables: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const response = await http.postForm(operation, WEBGRAPHQL_MUTATION_URL, {
    doc_id: docId,
    variables: JSON.stringify(variables),
    dpr: 1,
  });
  return http.check(operation, response);
}
