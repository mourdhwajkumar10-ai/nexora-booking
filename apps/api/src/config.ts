function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  port: Number(env('PORT', '4000')),
  databaseUrl: env('DATABASE_URL', 'postgres://localhost:5432/nexora'),
  webOrigin: env('WEB_ORIGIN', 'http://localhost:3000'),
  jwtSecret: env('JWT_SECRET', 'nexora-dev-secret-change-me-32-characters'),
  wifiDeviceMasterKey: env('WIFI_DEVICE_MASTER_KEY', 'nexora-wifi-device-master-key-secret-32-chars-long'),
  posWebhookSecret: env('POS_WEBHOOK_SECRET', 'pos-dev-secret'),
  workersEnabled: env('WORKERS', '1') === '1',
  isTest: process.env.VITEST === 'true' || process.env.NODE_ENV === 'test',
  cookieName: 'nexora_session',
};
