import { Redis } from 'ioredis';
import { CloudflareStateRedis } from './cloudflare.redis';

// Create a mock Redis implementation for testing environments
class MockRedis {
  private data: Map<string, any> = new Map();

  async get(key: string) {
    return this.data.get(key);
  }

  async set(key: string, value: any) {
    this.data.set(key, value);
    return 'OK';
  }

  async del(key: string) {
    this.data.delete(key);
    return 1;
  }

  async rpush(key: string, value: any) {
    this.data.set(key, [...(this.data.get(key) || []), value]);
    return this.data.get(key).length;
  }

  async lrange(key: string, start: number, end: number) {
    const list = this.data.get(key) || [];
    return list.slice(start, end === -1 ? undefined : end + 1);
  }

  async expire() {
    return 1;
  }

  // Add other Redis methods as needed for your tests
}

const useCloudflareState =
  process.env.REDIS_DRIVER === 'cloudflare' ||
  (!process.env.REDIS_URL && !!process.env.CLOUDFLARE_INTERNAL_URL);

// Use real Redis if REDIS_URL is defined, Cloudflare DO state when configured,
// otherwise fall back to MockRedis for isolated test environments.
export const ioRedis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      connectTimeout: 10000,
    })
  : useCloudflareState
    ? (new CloudflareStateRedis() as unknown as Redis)
    : (new MockRedis() as unknown as Redis); // Type cast to Redis to maintain interface compatibility
