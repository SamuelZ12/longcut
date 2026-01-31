import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { withSecurity } from '@/lib/security-middleware'
import type { NextRequest } from 'next/server'

async function handler(req: NextRequest) {
  const supabase = await createClient()
  
  // Sign out server-side
  await supabase.auth.signOut()
  
  // Explicitly clear all Supabase auth cookies
  const cookieStore = await cookies()
  const allCookies = cookieStore.getAll()
  
  const response = NextResponse.json({ success: true })
  
  // Delete all sb-* cookies (Supabase auth cookies)
  allCookies
    .filter(cookie => cookie.name.startsWith('sb-'))
    .forEach(cookie => {
      response.cookies.delete(cookie.name)
    })
  
  return response
}

export const POST = withSecurity(handler, {
  requireAuth: true,
  csrfProtection: true,
  allowedMethods: ['POST']
})
