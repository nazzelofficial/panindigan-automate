/**
 * Sync-sequence lookup.
 *
 * The MQTT sync queue must be created with an `initial_titan_sequence_id`.
 * That id comes from the same GraphQL batch the web client uses for the thread
 * list: document `3336396659757871` (`MessengerGraphQLThreadlistFetcher`) with
 * `includeSeqID: true`. The transport calls this when it has no cursor (first
 * login) or after a queue-lost error.
 */

import { z } from "zod";
import { APIError } from "../errors/index.js";
import { DOC_IDS, FB_BASE_URL } from "../constants.js";
import type { HttpTransport } from "../transport/http/index.js";
import type { Logger } from "../logger/index.js";

/** Endpoint that accepts batched GraphQL documents. */
const GRAPHQL_BATCH_URL = `${FB_BASE_URL}/api/graphqlbatch/`;

/** One entry of the batch response: the named result or the error summary. */
const batchEntrySchema = z
  .object({
    o0: z
      .object({
        data: z
          .object({
            viewer: z
              .object({
                message_threads: z
                  .object({
                    sync_sequence_id: z.union([z.string(), z.number()]).nullable().optional(),
                  })
                  .passthrough()
                  .nullable()
                  .optional(),
              })
              .passthrough()
              .nullable()
              .optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
        errors: z.array(z.unknown()).optional(),
      })
      .passthrough()
      .optional(),
    error_results: z.number().optional(),
    successful_results: z.number().optional(),
  })
  .passthrough();

type BatchEntry = z.infer<typeof batchEntrySchema>;

/** Constructor dependencies. */
export interface SyncEndpointDeps {
  readonly http: HttpTransport;
  readonly userId: string;
  readonly logger: Logger;
}

/**
 * Reads `sync_sequence_id` from a parsed `graphqlbatch` response.
 *
 * Exported for tests: the batch endpoint wraps results in a named envelope and
 * appends a summary entry, so the error checks have to look at both ends.
 */
export function extractSequenceId(payload: unknown): number | null {
  if (!Array.isArray(payload) || payload.length === 0) {
    return null;
  }
  const entries: BatchEntry[] = [];
  for (const raw of payload) {
    const parsed = batchEntrySchema.safeParse(raw);
    if (!parsed.success) {
      return null;
    }
    entries.push(parsed.data);
  }
  const summary = entries[entries.length - 1];
  if (summary !== undefined && (summary.error_results ?? 0) > 0) {
    return null;
  }
  if (summary !== undefined && summary.successful_results === 0) {
    return null;
  }
  for (const entry of entries) {
    const sequenceId = entry.o0?.data?.viewer?.message_threads?.sync_sequence_id;
    if (typeof sequenceId === "number" && Number.isSafeInteger(sequenceId)) {
      return sequenceId;
    }
    if (typeof sequenceId === "string" && sequenceId.trim() !== "") {
      const parsed = Number(sequenceId);
      if (Number.isSafeInteger(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

/** Fetches sync sequence ids over the thread-list GraphQL batch. */
export class SyncEndpoint {
  readonly #http: HttpTransport;
  readonly #userId: string;
  readonly #logger: Logger;

  constructor(deps: SyncEndpointDeps) {
    this.#http = deps.http;
    this.#userId = deps.userId;
    this.#logger = deps.logger.child({ module: "sync" });
  }

  /**
   * Requests one thread with `includeSeqID: true` and returns the account's
   * current sync sequence id. Throws `APIError` when the response has no id —
   * the transport then falls back to a token-less queue creation.
   */
  async fetchSequenceId(): Promise<number> {
    const queries = {
      o0: {
        doc_id: DOC_IDS.threadList,
        query_params: {
          limit: 1,
          before: null,
          tags: ["INBOX"],
          includeDeliveryReceipts: false,
          includeSeqID: true,
        },
      },
    };
    const response = await this.#http.postForm(
      "getSyncSequenceId",
      GRAPHQL_BATCH_URL,
      { av: this.#userId, queries: JSON.stringify(queries) },
      { withDefaults: true },
    );
    const body = this.#http.check("getSyncSequenceId", response);
    const sequenceId = extractSequenceId(body);
    if (sequenceId === null) {
      throw new APIError(
        "The thread-list query returned no sync_sequence_id",
        "API_ERROR",
        { retryable: true, context: { docId: DOC_IDS.threadList } },
      );
    }
    this.#logger.debug({ sequenceId }, "fetched sync sequence id");
    return sequenceId;
  }
}
