// Idempotently puts Cloudflare Access in front of the custom domain:
//   - ensures a One-time PIN identity provider exists,
//   - ensures a reusable "allow" policy for ACCESS_EMAILS,
//   - creates/updates a self-hosted Access application for the domain.
// Usage: ACCESS_EMAILS="you@example.com,other@example.com" npm run access:setup
import { cf, resolveZone, configuredDomain } from './cf.mjs';

const emails = (process.env.ACCESS_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!emails.length) {
  console.error('Set ACCESS_EMAILS to a comma-separated list of allowed emails.');
  process.exit(1);
}
const domain = process.env.ACCESS_DOMAIN || (await configuredDomain());
const zone = await resolveZone(domain);
const account = process.env.CLOUDFLARE_ACCOUNT_ID || zone.account.id;
const base = `/accounts/${account}/access`;
console.log(`Domain ${domain} (zone ${zone.name}), account ${account}`);

// 1. One-time PIN identity provider
const idps = await cf(`${base}/identity_providers`);
let otp = idps.find((p) => p.type === 'onetimepin');
if (!otp) {
  otp = await cf(`${base}/identity_providers`, { method: 'POST', body: { name: 'One-time PIN', type: 'onetimepin', config: {} } });
  console.log('Created One-time PIN identity provider');
} else console.log('One-time PIN identity provider exists');

// 2. Reusable allow policy
const policyName = `Allow ${domain} users`;
const policyBody = { name: policyName, decision: 'allow', include: emails.map((email) => ({ email: { email } })), session_duration: '24h' };
const policies = await cf(`${base}/policies`);
let policy = policies.find((p) => p.name === policyName);
if (policy) {
  policy = await cf(`${base}/policies/${policy.id}`, { method: 'PUT', body: policyBody });
  console.log(`Updated policy (${emails.length} email(s))`);
} else {
  policy = await cf(`${base}/policies`, { method: 'POST', body: policyBody });
  console.log(`Created policy (${emails.length} email(s))`);
}

// 3. Self-hosted application
const appBody = {
  name: 'Pelican Cutouts',
  domain,
  type: 'self_hosted',
  session_duration: '24h',
  allowed_idps: [otp.id],
  auto_redirect_to_identity: true,
  app_launcher_visible: false,
  policies: [{ id: policy.id, precedence: 1 }],
};
const apps = await cf(`${base}/apps`);
const existing = apps.find((a) => a.domain === domain || (a.self_hosted_domains || []).includes(domain));
if (existing) {
  await cf(`${base}/apps/${existing.id}`, { method: 'PUT', body: appBody });
  console.log(`Updated Access app ${existing.id}`);
} else {
  const app = await cf(`${base}/apps`, { method: 'POST', body: appBody });
  console.log(`Created Access app ${app.id}`);
}
console.log('Done. Run `npm run verify:access` to confirm the login page is enforced.');
