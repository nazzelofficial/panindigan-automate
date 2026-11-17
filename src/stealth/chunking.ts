/**
 * Adaptive Message Chunking (G3)
 * 
 * Long messages auto-split at sentence boundaries into ≤2000-char chunks
 * with realistic inter-chunk delays. Solves the "wall of text" bot tell.
 */

import type { Logger } from "../logger/index.js";

/** Chunking configuration */
export interface ChunkingConfig {
  /** Enable adaptive chunking (default: true) */
  readonly enabled: boolean;
  /** Maximum chunk size in characters (default: 2000) */
  readonly maxChunkSize: number;
  /** Minimum delay between chunks in ms (default: 1500) */
  readonly minDelayMs: number;
  /** Maximum delay between chunks in ms (default: 3500) */
  readonly maxDelayMs: number;
  /** Delay per character in ms (default: 20ms per char = 50 chars/sec reading speed) */
  readonly delayPerChar: number;
}

/** Default chunking configuration */
export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  enabled: true,
  maxChunkSize: 2000,
  minDelayMs: 1500,
  maxDelayMs: 3500,
  delayPerChar: 20, // ~50 chars/sec reading speed
};

/** Chunk with natural delay */
export interface MessageChunk {
  readonly text: string;
  readonly delayMs: number;
  readonly index: number;
  readonly total: number;
}

/**
 * Adaptive Message Chunker
 * 
 * Splits long messages at natural boundaries with human-like delays.
 */
export class MessageChunker {
  readonly #config: ChunkingConfig;
  readonly #logger: Logger;

  constructor(deps: {
    config?: Partial<ChunkingConfig> | undefined;
    logger: Logger;
  }) {
    this.#config = { ...DEFAULT_CHUNKING_CONFIG, ...deps.config };
    this.#logger = deps.logger.child({ module: "chunking" });
  }

  /** Check if message needs chunking */
  needsChunking(text: string): boolean {
    if (!this.#config.enabled) {
      return false;
    }
    return text.length > this.#config.maxChunkSize;
  }

  /** Split message into natural chunks */
  chunk(text: string): MessageChunk[] {
    if (!this.needsChunking(text)) {
      return [{
        text,
        delayMs: 0,
        index: 0,
        total: 1,
      }];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > this.#config.maxChunkSize) {
      const chunk = this.#findBreakPoint(remaining, this.#config.maxChunkSize);
      chunks.push(chunk.text);
      remaining = chunk.remaining;
    }

    if (remaining.length > 0) {
      chunks.push(remaining);
    }

    const total = chunks.length;
    
    this.#logger.debug(
      { originalLength: text.length, chunks: total },
      "Split message into chunks"
    );

    return chunks.map((text, index) => ({
      text,
      delayMs: index === 0 ? 0 : this.#calculateDelay(text),
      index,
      total,
    }));
  }

  /** Find natural break point in text */
  #findBreakPoint(text: string, maxLength: number): { text: string; remaining: string } {
    if (text.length <= maxLength) {
      return { text, remaining: "" };
    }

    // Try sentence boundaries first (. ! ?)
    const sentenceEnd = this.#findLastSentence(text, maxLength);
    if (sentenceEnd > maxLength * 0.7) {
      return {
        text: text.slice(0, sentenceEnd).trim(),
        remaining: text.slice(sentenceEnd).trim(),
      };
    }

    // Try paragraph boundary (\n\n)
    const paragraphEnd = text.lastIndexOf("\n\n", maxLength);
    if (paragraphEnd > maxLength * 0.6) {
      return {
        text: text.slice(0, paragraphEnd).trim(),
        remaining: text.slice(paragraphEnd).trim(),
      };
    }

    // Try line boundary (\n)
    const lineEnd = text.lastIndexOf("\n", maxLength);
    if (lineEnd > maxLength * 0.6) {
      return {
        text: text.slice(0, lineEnd).trim(),
        remaining: text.slice(lineEnd).trim(),
      };
    }

    // Try word boundary (space)
    const wordEnd = text.lastIndexOf(" ", maxLength);
    if (wordEnd > maxLength * 0.5) {
      return {
        text: text.slice(0, wordEnd).trim(),
        remaining: text.slice(wordEnd).trim(),
      };
    }

    // Hard break at maxLength
    this.#logger.warn(
      { maxLength },
      "Forced to hard-break message (no natural boundary found)"
    );
    
    return {
      text: text.slice(0, maxLength),
      remaining: text.slice(maxLength),
    };
  }

  /** Find last sentence boundary within limit */
  #findLastSentence(text: string, limit: number): number {
    const searchText = text.slice(0, limit);
    
    // Look for sentence endings with optional whitespace
    const patterns = [
      /\.\s+/g,   // Period + space
      /!\s+/g,    // Exclamation + space
      /\?\s+/g,   // Question + space
      /\.\n/g,    // Period + newline
      /!\n/g,     // Exclamation + newline
      /\?\n/g,    // Question + newline
    ];

    let lastEnd = -1;
    
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(searchText)) !== null) {
        lastEnd = Math.max(lastEnd, pattern.lastIndex);
      }
    }

    return lastEnd;
  }

  /** Calculate natural delay for chunk */
  #calculateDelay(chunkText: string): number {
    const { minDelayMs, maxDelayMs, delayPerChar } = this.#config;
    
    // Base delay on text length (reading time)
    const readingDelay = chunkText.length * delayPerChar;
    
    // Add random jitter (±20%)
    const jitter = readingDelay * 0.2 * (Math.random() * 2 - 1);
    
    // Clamp to min/max
    const delay = readingDelay + jitter;
    return Math.round(
      Math.max(minDelayMs, Math.min(maxDelayMs, delay))
    );
  }

  /** Format chunk for display (adds indicators) */
  formatChunk(chunk: MessageChunk, showIndicator: boolean = false): string {
    if (!showIndicator || chunk.total === 1) {
      return chunk.text;
    }

    // Add subtle indicator at the end
    return `${chunk.text}\n\n(${chunk.index + 1}/${chunk.total})`;
  }
}

/** Helper function to sleep with cancellation */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(new Error("Aborted"));
    };

    signal?.addEventListener("abort", onAbort);
  });
}
