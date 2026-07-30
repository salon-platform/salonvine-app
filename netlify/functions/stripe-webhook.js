/* Stripe webhook — server-to-server, so no CORS. The raw body is read before
   any parsing because the signature covers the exact bytes Stripe sent.

   Grace policy: a failed payment marks the salon past_due and stamps
   graceStartedAt, but nothing is suspended here — suspension only happens on
   customer.subscription.deleted (i.e. after Stripe's own retry schedule gives
   up). TODO: a scheduled function can later hard-suspend any salon still
   past_due at graceStartedAt + 14 days; graceStartedAt is already persisted
   for exactly that. */

import { json, relayMail } from './_lib.js';
import {
  stripeFetch, verifyStripeSig,
  readBilling, writeBilling, readBillingIndex, writeBillingIndex
} from './_stripe.js';

const GRACE_DAYS = 14;

async function founderAlert(subject, text) {
  const founders = String(process.env.FOUNDER_ALERT_EMAILS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  await Promise.all(founders.map(to =>
    relayMail({ to, subject, text }).catch(() => null)
  ));
}

/* Push a status to the salon registry (Apps Script is the source of truth).
   Whitelist there: live / live-free / pending / suspended / cancelled. */
async function setRegistryStatus(slug, status) {
  const exec = process.env.SV_EXEC;
  const token = process.env.SV_TOKEN;
  if (!exec || !token) return { ok: false };
  try {
    const res = await fetch(exec, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token, type: 'salonStatus', slug, status }),
      redirect: 'follow'
    });
    const j = await res.json().catch(() => null);
    return { ok: Boolean(j && j.ok) };
  } catch (e) {
    return { ok: false };
  }
}

/* subscriptionId -> slug: the blob index first (written at checkout), then a
   live fetch of the subscription's metadata as a fallback. */
async function slugForSubscription(subscriptionId, metadataSlug) {
  if (metadataSlug) return metadataSlug;
  if (!subscriptionId) return null;
  const idx = await readBillingIndex(subscriptionId);
  if (idx && idx.slug) return idx.slug;
  try {
    const sub = await stripeFetch(`subscriptions/${subscriptionId}`);
    const slug = sub && sub.metadata && sub.metadata.slug;
    if (slug) await writeBillingIndex(subscriptionId, slug); // heal the index
    return slug || null;
  } catch (e) {
    return null;
  }
}

/* An invoice's subscription id lives at .subscription on classic API versions
   and under .parent.subscription_details on newer ones — check both. */
function invoiceSubscription(inv) {
  if (!inv) return { id: null, metaSlug: null };
  const parentDetails = inv.parent && inv.parent.subscription_details;
  const raw = inv.subscription
    || (parentDetails && parentDetails.subscription)
    || null;
  const id = typeof raw === 'string' ? raw : (raw && raw.id) || null;
  const metaSlug =
    (inv.subscription_details && inv.subscription_details.metadata && inv.subscription_details.metadata.slug)
    || (parentDetails && parentDetails.metadata && parentDetails.metadata.slug)
    || null;
  return { id, metaSlug };
}

export default async (req, context) => {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return json(503, { error: 'Webhook is not configured.' });

  const rawBody = await req.text(); // exact bytes — must precede any parsing
  const sig = req.headers.get('stripe-signature') || '';
  if (!verifyStripeSig(rawBody, sig, secret)) {
    return json(400, { error: 'Invalid signature.' });
  }

  let event;
  try { event = JSON.parse(rawBody); } catch (e) { event = null; }
  if (!event || !event.type) return json(200, { received: true });

  const obj = (event.data && event.data.object) || {};
  const now = Date.now();

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const slug = obj.metadata && obj.metadata.slug;
        if (!slug) break;
        const customerId = typeof obj.customer === 'string' ? obj.customer : (obj.customer && obj.customer.id) || null;
        const subscriptionId = typeof obj.subscription === 'string' ? obj.subscription : (obj.subscription && obj.subscription.id) || null;

        /* The session payload has no line items — read the price off the
           subscription (best-effort; billing works without it). */
        let planPrice = null;
        if (subscriptionId) {
          try {
            const sub = await stripeFetch(`subscriptions/${subscriptionId}`);
            planPrice = (sub.items && sub.items.data && sub.items.data[0]
              && sub.items.data[0].price && sub.items.data[0].price.id) || null;
          } catch (e) { /* keep null */ }
        }

        const existing = await readBilling(slug);
        await writeBilling(slug, {
          ...(existing || {}),
          slug,
          customerId,
          subscriptionId,
          ownerEmail: obj.customer_email
            || (obj.customer_details && obj.customer_details.email)
            || (existing && existing.ownerEmail) || null,
          status: 'trialing',
          trialStartedAt: now,
          planPrice,
          graceStartedAt: null,
          updatedAt: now
        });
        if (subscriptionId) await writeBillingIndex(subscriptionId, slug);

        await setRegistryStatus(slug, 'live');
        await founderAlert(
          `Salon Vine: trial activated — ${slug}`,
          `Salon:        ${slug}\nStatus:       trialing (30-day free trial)\nCustomer:     ${customerId || '—'}\nSubscription: ${subscriptionId || '—'}\nPrice:        ${planPrice || '—'}\nPortal:       https://salonvine-app.netlify.app/p/${slug}`
        );
        break;
      }

      case 'invoice.payment_failed': {
        const { id: subId, metaSlug } = invoiceSubscription(obj);
        const slug = await slugForSubscription(subId, metaSlug);
        if (!slug) break;
        const billing = await readBilling(slug);
        if (!billing) break;
        const graceStartedAt = billing.graceStartedAt || now; // only stamp once
        await writeBilling(slug, {
          ...billing, status: 'past_due', graceStartedAt, updatedAt: now
        });
        const graceEnds = new Date(graceStartedAt + GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        await founderAlert(
          `Salon Vine: payment FAILED — ${slug}`,
          `Salon:  ${slug}\nStatus: past_due\n\nStripe will retry the card on its own schedule. Our ${GRACE_DAYS}-day grace window started ${new Date(graceStartedAt).toISOString().slice(0, 10)} and runs through ${graceEnds} — the salon stays live until then (hard suspension currently only happens if Stripe cancels the subscription).\n\nPortal: https://salonvine-app.netlify.app/p/${slug}`
        );
        break;
      }

      case 'invoice.paid': {
        const { id: subId, metaSlug } = invoiceSubscription(obj);
        const slug = await slugForSubscription(subId, metaSlug);
        if (!slug) break;
        const billing = await readBilling(slug);
        if (!billing || billing.status !== 'past_due') break; // routine renewals need no action

        /* Recovered. Back to 'active' — or 'trialing' if the trial is still
           running (checked against Stripe, falling back to our own clock). */
        let recovered = 'active';
        try {
          if (subId) {
            const sub = await stripeFetch(`subscriptions/${subId}`);
            if (sub && sub.status === 'trialing') recovered = 'trialing';
          }
        } catch (e) {
          if (billing.trialStartedAt && now < billing.trialStartedAt + 30 * 24 * 60 * 60 * 1000) {
            recovered = 'trialing';
          }
        }
        await writeBilling(slug, {
          ...billing, status: recovered, graceStartedAt: null, updatedAt: now
        });
        await setRegistryStatus(slug, 'live'); // no-op if already live; revives a suspended salon
        await founderAlert(
          `Salon Vine: payment recovered — ${slug}`,
          `Salon:  ${slug}\nStatus: ${recovered}\n\nThe card went through — grace window cleared, salon is live.\nPortal: https://salonvine-app.netlify.app/p/${slug}`
        );
        break;
      }

      case 'customer.subscription.updated': {
        const subId = obj.id;
        const slug = await slugForSubscription(subId, obj.metadata && obj.metadata.slug);
        if (!slug) break;
        const billing = await readBilling(slug);
        if (!billing) break;
        const mapped = { trialing: 'trialing', active: 'active', past_due: 'past_due', canceled: 'canceled' }[obj.status];
        if (!mapped || mapped === billing.status) break;
        await writeBilling(slug, {
          ...billing,
          status: mapped,
          graceStartedAt: mapped === 'past_due' ? (billing.graceStartedAt || now) : null,
          updatedAt: now
        });
        break;
      }

      case 'customer.subscription.deleted': {
        const subId = obj.id;
        const slug = await slugForSubscription(subId, obj.metadata && obj.metadata.slug);
        if (!slug) break;
        const billing = await readBilling(slug);
        await writeBilling(slug, {
          ...(billing || { slug, subscriptionId: subId }),
          status: 'canceled', updatedAt: now
        });
        await setRegistryStatus(slug, 'suspended');
        await founderAlert(
          `Salon Vine: subscription canceled — ${slug}`,
          `Salon:  ${slug}\nStatus: canceled — salon suspended in the registry.\n\nIf this was a mistake, the owner can restart from the portal (Activate banner) and the salon goes live again on checkout.\nPortal: https://salonvine-app.netlify.app/p/${slug}`
        );
        break;
      }

      default:
        break; // unhandled types are acknowledged so Stripe stops retrying
    }
  } catch (e) {
    /* Deliberately still 200 — Stripe retries on non-2xx, and a poison event
       would otherwise hammer us. Founder alerts + blobs are best-effort. */
  }

  return json(200, { received: true });
};
