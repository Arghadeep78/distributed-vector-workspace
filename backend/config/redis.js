import { createClient } from 'redis';

export function parseRedisUrl(url) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port) || 6379,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    username: parsed.username || undefined,
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null, // required by BullMQ
  };
}

// Managed providers like Upstash reject CONFIG SET/GET ("ERR Unsupported
// CONFIG parameter"), so the policy can only be read via INFO — and can only
// be changed from the provider's dashboard, not from application code.
async function ensureRedisNoEviction(client) {
  try {
    const info = await client.info('memory');
    const match = info.match(/maxmemory_policy:(\S+)/);
    const policy = match?.[1];

    if (policy === 'noeviction') {
      console.log('✅ Redis maxmemory-policy is noeviction');
    } else {
      console.warn(
        `⚠️  Redis maxmemory-policy is "${policy ?? 'unknown'}", expected "noeviction". ` +
        'Change this from your Redis provider\'s dashboard/config — it cannot be set from application code on managed Redis.'
      );
    }
  } catch (err) {
    console.warn('⚠️  Unable to read Redis maxmemory-policy:', err?.message || err);
  }
}

export async function createRedisClients() {
  const pubClient = createClient({ url: process.env.REDIS_URL });
  const subClient = pubClient.duplicate();

  pubClient.on('error', (err) => console.error('Redis pubClient Error:', err));
  subClient.on('error', (err) => console.error('Redis subClient Error:', err));

  await Promise.all([pubClient.connect(), subClient.connect()]);
  await ensureRedisNoEviction(pubClient);

  return { pubClient, subClient };
}
