// Thin client for the V3 backend's admin HTTP surface.
// Only the "V3 Testing" tab uses this — legacy tabs still read Supabase directly.

const BASE = import.meta.env.VITE_V3_ADMIN_URL || ''
const TOKEN = import.meta.env.VITE_V3_ADMIN_TOKEN || ''

export const v3Configured = Boolean(BASE && TOKEN)

async function call(path, init = {}) {
  if (!v3Configured) {
    throw new Error('V3 admin API not configured — set VITE_V3_ADMIN_URL and VITE_V3_ADMIN_TOKEN in .env.local')
  }
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      ...(init.headers || {}),
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`V3 ${path} → ${res.status} ${body}`)
  }
  return res.json()
}

export const v3api = {
  health: () => call('/health'),
  listThreads: () => call('/admin/threads'),
  getThread: (conversationId) => call(`/admin/threads/${conversationId}`),
  injectMessage: ({ subscriberExternalId, text, subscriberName }) =>
    call('/admin/test/inject', {
      method: 'POST',
      body: JSON.stringify({ subscriberExternalId, text, subscriberName }),
    }),
  setTakeover: (conversationId, on) =>
    call(`/admin/conversations/${conversationId}/takeover/${on ? 'on' : 'off'}`, {
      method: 'POST',
    }),
  getTakeover: (conversationId) => call(`/admin/conversations/${conversationId}/takeover`),
  why: (conversationId) => call(`/admin/conversations/${conversationId}/why`),
  // Simulates a fan purchasing a PPV. Backend fires a synthetic ppv.unlocked
  // event through the same handler a real webhook would — so the learning
  // loop, purchases_onlyfans, and ladder progression all advance.
  buyPpv: ({ conversationId, messageId }) =>
    call('/admin/test/ppv-unlock', {
      method: 'POST',
      body: JSON.stringify({ conversationId, messageId }),
    }),
}
