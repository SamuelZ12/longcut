'use client'

import { useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from '@/components/ui/card'
import { startCheckout, openBillingPortal } from '@/lib/stripe-actions'
import type { SubscriptionStatus, SubscriptionTier } from '@/lib/subscription-manager'
import { toast } from 'sonner'
import { CheckCircle2, Infinity, Layers, Loader2, Package2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface PricingContentProps {
  isAuthenticated: boolean
  tier: SubscriptionTier | 'anonymous'
  status: SubscriptionStatus
  cancelAtPeriodEnd: boolean
}

type BillingPeriod = 'monthly' | 'annual'

export default function PricingContent({ isAuthenticated, tier, status, cancelAtPeriodEnd }: PricingContentProps) {
  const router = useRouter()
  const [pendingAction, setPendingAction] = useState<'subscription' | 'topup' | 'portal' | null>(null)
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>('annual')

  const currentTier: SubscriptionTier | 'anonymous' = tier
  const isPro = currentTier === 'pro'
  const isFreeUser = currentTier === 'free'
  const isCanceled = status === 'canceled' || cancelAtPeriodEnd

  const freeFeatures = [
    '3 videos / month',
    'AI highlight reels',
    'Chat with transcripts',
    'Save notes',
    'Transcript translation',
  ]

  const proFeatures = [
    '100 videos / month',
    'Everything from basic',
    'Export transcripts',
  ]

  const topupFeatures = [
    '20 videos per pack',
    'Never expires',
    'Use alongside any plan',
  ]

  const heroDescription = (() => {
    if (!isAuthenticated) {
      return 'Create a free account to get started, or upgrade when you need more headroom.'
    }
    if (isPro) {
      return 'You’re currently on Pro. Manage billing or top up your credits below.'
    }
    if (isFreeUser) {
      return 'You’re currently on a free plan. Select any of the plans or top-up options that fits your needs.'
    }
    return 'Select the plan that fits your workflow.'
  })()

  const handleAuthRedirect = () => {
    router.push('/?auth=signup')
  }

  const handleUpgrade = async (period: BillingPeriod) => {
    if (!isAuthenticated) {
      handleAuthRedirect()
      return
    }

    try {
      setPendingAction('subscription')
      const priceType = period === 'annual' ? 'subscription_annual' : 'subscription'
      console.log('Starting checkout with:', { period, priceType })
      await startCheckout(priceType)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to start checkout'
      toast.error(message)
      console.error('Checkout error:', error)
    } finally {
      setPendingAction(null)
    }
  }

  const handleTopup = async () => {
    if (!isAuthenticated) {
      handleAuthRedirect()
      return
    }

    try {
      setPendingAction('topup')
      await startCheckout('topup')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to start checkout'
      toast.error(message)
    } finally {
      setPendingAction(null)
    }
  }

  const handlePortal = async () => {
    try {
      setPendingAction('portal')
      await openBillingPortal()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to open billing portal'
      toast.error(message)
    } finally {
      setPendingAction(null)
    }
  }

  return (
    <div className="space-y-12">
      <div className="space-y-3 text-center">
        <h1 className="text-[24px] font-bold">Plan</h1>
        <p className="mx-auto max-w-[494px] text-[14px] text-[#787878]">{heroDescription}</p>
      </div>

      <div className="mx-auto flex w-full flex-col items-center gap-[44px] md:flex-row md:items-start md:justify-center">
        {/* Free Plan Card */}
        <Card
          className="relative flex w-full flex-col overflow-hidden rounded-[32px] border border-border/60 bg-background/80 !gap-2 !pt-4 !pb-2 backdrop-blur md:h-[420px] md:w-[298px]"
          style={{ boxShadow: '2px 11px 40.4px 0 rgba(0, 0, 0, 0.06)' }}
        >
          <CardHeader className="!px-4 !pt-0 !pb-1">
            <div className="rounded-[24px] bg-[#f7f7f7] px-4 pt-2 pb-4 text-left">
              <div className="flex flex-col">
                <p className="text-[16px] font-medium text-black mb-10">Basic</p>
                <h2 className="text-[32px] font-semibold mb-0">Free</h2>
                <p className="text-[11px] text-muted-foreground mt-0">
                  Try Little universe for free, no card required
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex-1 px-8 pt-0 pb-4">
            <PlanFeaturesList
              features={freeFeatures}
              icons={[
                '/Video_On_Video.svg',
                '/enhance.svg',
                '/Pen_On_Doc.svg',
                '/Select_Text.svg',
                '/Languages.svg',
              ]}
            />
          </CardContent>
          <CardFooter className="mt-auto flex flex-col gap-2 px-4 pb-2 pt-0">
            <Button
              onClick={isAuthenticated ? undefined : handleAuthRedirect}
              disabled={isAuthenticated}
              variant={isFreeUser ? 'secondary' : 'outline'}
              size="lg"
              className={cn(
                'w-full rounded-full h-[42px] text-[14px] font-semibold shadow-none',
                isAuthenticated && 'cursor-not-allowed',
                isFreeUser && 'bg-[#e2e2e2]/80 text-foreground hover:bg-[#e2e2e2]/80',
                isAuthenticated && !isFreeUser && 'bg-[#f0f0f0] text-foreground hover:bg-[#f0f0f0]'
              )}
            >
              {isAuthenticated ? (isFreeUser ? 'Current plan' : 'Included with Pro') : 'Create free account'}
            </Button>
          </CardFooter>
        </Card>

        {/* Pro Plan Card */}
        <Card
          className="relative flex w-full flex-col overflow-hidden rounded-[32px] border border-border/60 bg-background/80 !gap-2 !pt-4 !pb-2 backdrop-blur md:h-[420px] md:w-[298px]"
          style={{ boxShadow: '2px 11px 40.4px 0 rgba(0, 0, 0, 0.06)' }}
        >
          <CardHeader className="!px-4 !pt-0 !pb-1">
            <div className="relative w-full rounded-[24px] bg-[linear-gradient(to_bottom_right,rgba(233,211,250,0.3),rgba(203,252,255,0.3),rgba(203,227,255,0.3))] pl-4 pr-2 pt-2 pb-4 text-left ring-1 ring-white/60 backdrop-blur-sm">
              <div className="flex flex-col">
                <div className="mb-10 flex items-center justify-between gap-3">
                  <p className="text-[16px] font-medium text-black">Pro</p>
                  <BillingToggle value={billingPeriod} onChange={setBillingPeriod} />
                </div>
                <div className="flex items-baseline gap-2 whitespace-nowrap mb-0">
                  {billingPeriod === 'annual' && (
                    <span className="text-[20px] font-semibold text-muted-foreground line-through">
                      $9.99
                    </span>
                  )}
                  <span className="text-[32px] font-semibold">
                    {billingPeriod === 'annual' ? '$8.33' : '$9.99'}
                  </span>
                  <span className="text-[14px] text-muted-foreground">
                    / month
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground whitespace-nowrap mt-0">
                  {billingPeriod === 'annual' ? 'Billed annually, get 2 months free' : 'Cancel anytime'}
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex-1 px-8 pt-0 pb-4">
            <PlanFeaturesList
              features={proFeatures}
              icons={[
                '/Video_On_Video.svg',
                '/Creator_Rewards.svg',
                '/Arrow_In_Right.svg',
              ]}
            />
          </CardContent>
          <CardFooter className="mt-auto flex flex-col gap-2 px-4 pb-2 pt-0">
            <Button
              onClick={isPro && !isCanceled ? handlePortal : () => handleUpgrade(billingPeriod)}
              disabled={pendingAction !== null}
              size="lg"
              className="w-full rounded-full h-[42px] text-[14px] font-semibold shadow-none"
            >
              {pendingAction === 'subscription' || pendingAction === 'portal' ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Redirecting...
                </>
              ) : (
                isPro && !isCanceled ? (status === 'past_due' ? 'Update payment method' : 'Manage billing') : 'Upgrade'
              )}
            </Button>
          </CardFooter>
        </Card>

        {/* Top-Up Card (New) */}
        <Card
          className="relative flex w-full flex-col overflow-hidden rounded-[32px] border border-border/60 bg-background/80 !gap-2 !pt-4 !pb-2 backdrop-blur md:h-[420px] md:w-[298px]"
          style={{ boxShadow: '2px 11px 40.4px 0 rgba(0, 0, 0, 0.06)' }}
        >
          <CardHeader className="!px-4 !pt-0 !pb-1">
            <div className="rounded-[24px] bg-gradient-to-br from-white to-blue-50 px-4 pt-2 pb-4 text-left border border-blue-50/40">
              <div className="flex flex-col">
                <div className="mb-10 flex items-center justify-between">
                  <p className="text-[16px] font-medium text-black">Top Up</p>
                </div>
                <div className="flex items-baseline gap-2 whitespace-nowrap mb-0">
                   <span className="text-[32px] font-semibold">
                    $2.99
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground mt-0">
                  Pay as you go, one-time payment
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex-1 px-8 pt-0 pb-4">
            <PlanFeaturesList
              features={topupFeatures}
              icons={[
                <Package2 key="package" className="h-4 w-4" />,
                <Infinity key="infinity" className="h-4 w-4" />,
                <Layers key="layers" className="h-4 w-4" />,
              ]}
            />
          </CardContent>
          <CardFooter className="mt-auto flex flex-col gap-2 px-4 pb-2 pt-0">
            <Button
              onClick={handleTopup}
              disabled={pendingAction === 'topup'}
              variant="outline"
              size="lg"
              className={cn(
                "w-full rounded-full h-[42px] text-[14px] font-semibold shadow-none border-blue-100 hover:bg-blue-50/30",
                pendingAction === 'topup' && "opacity-80"
              )}
            >
              {pendingAction === 'topup' ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Processing...
                </>
              ) : (
                'Buy Credits'
              )}
            </Button>
          </CardFooter>
        </Card>
      </div>
    </div>
  )
}

function PlanFeaturesList({
  features,
  icons,
  footer
}: {
  features: string[]
  icons?: (string | ReactNode)[]
  footer?: ReactNode
}) {
  return (
    <ul className="space-y-[10px] text-[12px] font-medium">
      {features.map((feature, index) => {
        const icon = icons?.[index]
        return (
          <li key={feature} className="flex items-center gap-3">
            {icon ? (
              typeof icon === 'string' ? (
                <Image
                  src={icon}
                  alt=""
                  width={16}
                  height={16}
                  className="h-4 w-4"
                />
              ) : (
                icon
              )
            ) : (
              <CheckCircle2 className="h-4 w-4 text-primary" />
            )}
            <span>{feature}</span>
          </li>
        )
      })}
      {footer}
    </ul>
  )
}

function BillingToggle({
  value,
  onChange,
}: {
  value: BillingPeriod
  onChange: (value: BillingPeriod) => void
}) {
  const isAnnual = value === 'annual'

  return (
    <div className="flex items-center gap-3 rounded-full bg-transparent px-3 py-1.5">
      <button
        type="button"
        onClick={() => onChange('annual')}
        className={cn(
          'text-[8px] font-medium transition uppercase',
          isAnnual ? 'text-muted-foreground/80' : 'text-muted-foreground/50'
        )}
        aria-pressed={isAnnual}
      >
        Annual
      </button>
      <button
        type="button"
        onClick={() => onChange(isAnnual ? 'monthly' : 'annual')}
        className={cn(
          'relative inline-flex h-5 w-10 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          isAnnual ? 'bg-[#007AFF]' : 'bg-muted-foreground/30'
        )}
        aria-label="Toggle annual billing"
        aria-pressed={isAnnual}
      >
        <span className="sr-only">Toggle annual billing</span>
        <span
          className={cn(
            'inline-block h-3.5 w-3.5 rounded-full bg-background shadow transition-transform',
            isAnnual ? 'translate-x-5' : 'translate-x-1'
          )}
        />
      </button>
    </div>
  )
}
