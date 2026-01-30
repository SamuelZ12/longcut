'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { resolveAppUrl } from '@/lib/utils'
import { useInAppBrowser } from '@/lib/hooks/use-in-app-browser'
import { Copy } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AlertCircle, Loader2, CheckCircle, Youtube } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { toast } from 'sonner'

interface AuthModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess?: () => void
  trigger?: 'generation-limit' | 'save-video' | 'manual' | 'save-note'
  currentVideoId?: string | null
}

export function AuthModal({ open, onOpenChange, onSuccess, trigger = 'manual', currentVideoId }: AuthModalProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const supabase = createClient()
  const appUrl = resolveAppUrl(typeof window !== 'undefined' ? window.location.origin : undefined)
  const isInApp = useInAppBrowser()

  const handleCopyLink = async () => {
    await navigator.clipboard.writeText(window.location.href)
    toast.success('Link copied! Paste it in Chrome, Safari, or Firefox.')
  }

  const handleSignUp = async () => {
    setLoading(true)
    setError(null)

    const redirectUrl = `${appUrl}/auth/callback`
    console.log('🔐 Starting signup process...')
    console.log('📧 Email:', email)
    console.log('🔗 Redirect URL:', redirectUrl)
    console.log('🌐 NEXT_PUBLIC_APP_URL:', process.env.NEXT_PUBLIC_APP_URL)
    console.log('🧭 Resolved App URL:', appUrl)

    const response = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: redirectUrl,
      },
    })

    console.log('📨 Full Supabase signup response:', JSON.stringify(response, null, 2))
    console.log('✅ User object:', response.data?.user)
    console.log('📬 Session object:', response.data?.session)
    console.log('❌ Error:', response.error)

    if (response.error) {
      console.error('❌ Signup error:', response.error.message)
      setError(response.error.message)
    } else {
      console.log('✅ Signup successful! User ID:', response.data?.user?.id)
      console.log('📧 Email confirmation sent to:', response.data?.user?.email)
      console.log('⚠️ Email confirmed?:', response.data?.user?.email_confirmed_at)
      console.log('ℹ️ Identities:', response.data?.user?.identities)
      setSuccess(true)
    }

    setLoading(false)
  }

  const handleSignIn = async () => {
    setLoading(true)
    setError(null)

    // Store current video ID in sessionStorage before signing in
    if (currentVideoId) {
      sessionStorage.setItem('pendingVideoId', currentVideoId)
      console.log('Stored video for post-auth linking:', currentVideoId)
    }

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (error) {
      setError(error.message)
      toast.error(error.message)
    } else {
      toast.success('Successfully signed in!')
      onSuccess?.()
      onOpenChange(false)
      // Delay reload slightly to allow auth state to update
      setTimeout(() => {
        window.location.reload()
      }, 100)
    }

    setLoading(false)
  }

  const handleGoogleSignIn = async () => {
    setLoading(true)
    setError(null)

    // Store current video ID in sessionStorage before OAuth redirect
    if (currentVideoId) {
      sessionStorage.setItem('pendingVideoId', currentVideoId)
      console.log('Stored video for post-auth linking:', currentVideoId)
    }

    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${appUrl}/auth/callback`,
      },
    })

    if (error) {
      setError(error.message)
    }

    setLoading(false)
  }

  const getModalContent = () => {
    switch (trigger) {
      case 'generation-limit':
        return {
          title: 'Sign up to continue',
          description: 'You\'ve used your free preview. Create a free account to unlock monthly credits.',
          benefits: [
            '5 video analyses every 30 days',
            'Save videos, notes, and highlights across devices',
            'Upgrade anytime for 100 videos/month + Top-Up credits',
          ],
          showBenefitsCard: true,
        }
      case 'save-note':
        return {
          title: 'Sign in to save notes',
          description: 'Capture key moments and keep your highlights in one place.',
          benefits: [
            'Save transcript snippets with one click',
            'Organize notes across every video',
            'Access your highlights from any device',
          ],
          showBenefitsCard: true,
        }
      default:
        return {
          title: 'Sign in to Little universe',
          description: 'Create an account or sign in to save your video analyses and access them anytime.',
          benefits: [
            'Save your analyzed videos',
            'Access your video library from any device',
            'Track your learning progress',
          ],
          showBenefitsCard: false,
        }
    }
  }

  const { title, description, benefits, showBenefitsCard } = getModalContent()

  if (success) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5 text-green-500" />
              Check your email
            </DialogTitle>
            <DialogDescription className="pt-2">
              We&apos;ve sent you a confirmation link to <strong>{email}</strong>.
              Please check your email and click the link to activate your account.
            </DialogDescription>
          </DialogHeader>
          <Button onClick={() => onOpenChange(false)} className="w-full">
            Got it
          </Button>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Youtube className="h-5 w-5" />
            {title}
          </DialogTitle>
          <DialogDescription className="pt-2">
            {description}
          </DialogDescription>
        </DialogHeader>

        {showBenefitsCard && (
          <div className="bg-muted/50 rounded-lg p-4 space-y-2">
            <p className="text-sm font-medium">What you get with a free account:</p>
            <ul className="text-sm text-muted-foreground space-y-1">
              {benefits.map((benefit, index) => (
                <li key={index} className="flex items-start gap-2">
                  <CheckCircle className="h-3 w-3 text-green-500 mt-0.5 shrink-0" />
                  <span>{benefit}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <Tabs defaultValue="signin" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="signin">Sign In</TabsTrigger>
            <TabsTrigger value="signup">Sign Up</TabsTrigger>
          </TabsList>

          <TabsContent value="signin" className="space-y-4">
            {isInApp && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                <p className="text-amber-800 text-sm">
                  <strong>Google sign-in won&apos;t work in this browser.</strong>
                  <br />
                  Please open this page in Chrome, Safari, or Firefox.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={handleCopyLink}
                >
                  <Copy className="mr-2 h-3 w-3" />
                  Copy link
                </Button>
              </div>
            )}

            <Button
              onClick={handleGoogleSignIn}
              disabled={loading || isInApp}
              className="inline-flex h-10 justify-center items-center w-full bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 shadow-sm"
            >
              <svg className="mr-2 h-5 w-5" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                />
              </svg>
              Continue with Google
            </Button>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="bg-background px-2 text-muted-foreground">or continue with email</span>
              </div>
            </div>

            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="signin-email">Email</Label>
                <Input
                  id="signin-email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={loading}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="signin-password">Password</Label>
                <Input
                  id="signin-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={loading}
                />
              </div>

              {error && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <Button
                onClick={handleSignIn}
                disabled={loading || !email || !password}
                variant="outline"
                className="inline-flex h-9 justify-center items-center w-full"
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Signing in...
                  </>
                ) : (
                  'Sign In'
                )}
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="signup" className="space-y-4">
            {isInApp && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                <p className="text-amber-800 text-sm">
                  <strong>Google sign-in won&apos;t work in this browser.</strong>
                  <br />
                  Please open this page in Chrome, Safari, or Firefox.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={handleCopyLink}
                >
                  <Copy className="mr-2 h-3 w-3" />
                  Copy link
                </Button>
              </div>
            )}

            <Button
              onClick={handleGoogleSignIn}
              disabled={loading || isInApp}
              className="inline-flex h-10 justify-center items-center w-full bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 shadow-sm"
            >
              <svg className="mr-2 h-5 w-5" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                />
              </svg>
              Continue with Google
            </Button>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="bg-background px-2 text-muted-foreground">or continue with email</span>
              </div>
            </div>

            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="signup-email">Email</Label>
                <Input
                  id="signup-email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={loading}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="signup-password">Password</Label>
                <Input
                  id="signup-password"
                  type="password"
                  placeholder="At least 6 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={loading}
                />
              </div>

              {error && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <Button
                onClick={handleSignUp}
                disabled={loading || !email || !password || password.length < 6}
                variant="outline"
                className="inline-flex h-9 justify-center items-center w-full"
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating account...
                  </>
                ) : (
                  'Create Account'
                )}
              </Button>

              <p className="text-xs text-muted-foreground text-center">
                By signing up, you agree to our Terms of Service and Privacy Policy
              </p>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
