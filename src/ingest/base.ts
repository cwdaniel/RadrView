import { Redis } from 'ioredis';
import type { IngestResult } from '../types.js';
import { createLogger } from '../utils/logger.js';

export abstract class BaseIngester {
  abstract readonly source: string;
  abstract readonly pollIntervalMs: number;

  protected readonly queueKey: string = 'queue:normalize';
  protected redis: Redis;
  protected logger;
  private running = false;
  private currentOperation: Promise<void> | null = null;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl);
    this.logger = createLogger(`ingest:${this.constructor.name}`);
  }

  abstract poll(): Promise<IngestResult[]>;

  async start(): Promise<void> {
    this.running = true;
    this.logger.info({ source: this.source, pollIntervalMs: this.pollIntervalMs }, 'Starting ingester');

    // Handle graceful shutdown
    const shutdown = async () => {
      this.logger.info('SIGTERM received, finishing current operation...');
      this.running = false;
      if (this.currentOperation) {
        await this.currentOperation;
      }
      await this.redis.quit();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    let consecutiveErrors = 0;

    while (this.running) {
      try {
        // Track the full poll+publish cycle for graceful shutdown
        this.currentOperation = (async () => {
          const results = await this.poll();

          if (results.length > 0) {
            consecutiveErrors = 0;
            for (const result of results) {
              // Push to reliable queue for the tiler.
              // The tiler writes frames:* after tiles are generated.
              await this.redis.rpush(this.queueKey, JSON.stringify(result));
            }
            await this.redis.hset(`source:${this.source}`, 'lastSuccess', Date.now());
            await this.redis.hset(`source:${this.source}`, 'consecutiveErrors', 0);
            this.logger.info({ count: results.length }, 'Ingested new frames');
          }
        })();
        await this.currentOperation;
        this.currentOperation = null;
      } catch (error) {
        this.currentOperation = null;
        consecutiveErrors++;
        this.logger.error({ err: error, consecutiveErrors }, 'Ingest poll failed');
        await this.redis.hset(`source:${this.source}`, 'lastError', Date.now());
        await this.redis.hset(`source:${this.source}`, 'consecutiveErrors', consecutiveErrors);

        if (consecutiveErrors > 5) {
          const backoffMs = Math.min(
            this.pollIntervalMs * Math.pow(2, consecutiveErrors - 5),
            300_000,
          );
          this.logger.warn({ backoffMs }, 'Backing off after repeated failures');
          await this.sleep(backoffMs);
        }
      }

      await this.sleep(this.pollIntervalMs);
    }
  }

  stop(): void {
    this.running = false;
  }

  protected async isProcessed(key: string): Promise<boolean> {
    return (await this.redis.sismember(`processed:${this.source}`, key)) === 1;
  }

  protected async markProcessed(key: string): Promise<void> {
    await this.redis.sadd(`processed:${this.source}`, key);
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
