import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !key) {
  console.warn(
    '[Dashboard] Supabase env vars not set — falling back to mock data.\n' +
    'Copy .env.example to .env.local and add your credentials.',
  )
}

// Export null when credentials are missing; the data hook handles the fallback
export const supabase = url && key ? createClient(url, key) : null
