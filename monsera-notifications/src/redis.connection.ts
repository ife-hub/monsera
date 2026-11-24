import { Redis } from 'ioredis';

export const REDIS = Symbol('REDIS');

/** BullMQ queue/key prefix; must match the services publishing events (default 'bull'). */
export const BULLMQ_PREFIX = process.env.BULLMQ_PREFIX || 'bull';

export function createRedisConnection(): Redis {
  // Only needed if you get a certificate error. Paste the cluster's CA
  // certificate with its line breaks written as \n.
  const caCert = process.env.REDIS_CA_CERT?.replace(/\\n/g, '\n');

  return new Redis(process.env.REDIS_URL!, {
    maxRetriesPerRequest: null, // required by BullMQ
    ...(caCert ? { tls: { ca: caCert } } : {}),
  });
}
