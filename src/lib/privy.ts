import { PrivyClient } from '@privy-io/node';

// Initialize Privy client
const privyAppId = process.env.PRIVY_APP_ID;
const privyAppSecret = process.env.PRIVY_APP_SECRET;

if (!privyAppId || !privyAppSecret) {
  console.warn('[Privy] Warning: PRIVY_APP_ID or PRIVY_APP_SECRET not set. Auth will fail.');
}

export const privy = new PrivyClient({
  appId: privyAppId || '',
  appSecret: privyAppSecret || ''
});

export default privy;
