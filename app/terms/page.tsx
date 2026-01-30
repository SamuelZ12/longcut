import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Terms of Service | Little universe',
  description:
    'Understand how Little universe subscriptions, billing, and the 48-hour refund window for the annual Pro plan work.',
}

const supportEmail = 'zara@longcut.ai'

export default function TermsPage() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-10 px-4 pb-16 pt-24 text-base leading-relaxed text-[#3f3f3f] sm:px-6 lg:px-8">
      <header className="space-y-4">
        <h1 className="text-3xl font-bold tracking-tight text-[#3f3f3f]">Terms of Service</h1>
        <p className="text-sm text-muted-foreground">Last updated: November 11, 2025</p>
        <p>
          These Terms of Service (&ldquo;Terms&rdquo;) govern your access to and use of Little universe (&ldquo;we&rdquo;,
          &ldquo;us&rdquo;, or &ldquo;our&rdquo;). By creating an account or using the product, you agree to these
          Terms. If you do not agree, please do not use Little universe.
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight text-[#3f3f3f]">Account &amp; Eligibility</h2>
        <p>
          You are responsible for maintaining the security of your Little universe account and the credentials associated with it.
          You must provide accurate information when you sign up and keep your contact details up to date so we can send
          important notices about your subscription.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight text-[#3f3f3f]">Subscriptions &amp; Billing</h2>
        <p>
          Little universe offers both free access and paid Pro subscriptions that deliver additional features and higher usage
          limits. When you activate a paid plan, Stripe securely processes your payment information on our behalf. You
          authorize us to charge the applicable subscription fees (and any related taxes) at the start of each billing
          period until you cancel.
        </p>
        <p>
          Unless otherwise stated during checkout, subscriptions renew automatically at the end of each billing cycle.
          If we update our pricing, we will notify you in advance and give you a chance to cancel before the change
          takes effect.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight text-[#3f3f3f]">Annual Pro Refund Policy</h2>
        <p>
          We offer a full refund on the annual Pro subscription if you cancel within 48 hours of the initial purchase.
          To qualify:
        </p>
        <ul className="list-disc space-y-2 pl-6">
          <li>The refund request must be submitted within 48 hours of your annual upgrade.</li>
          <li>The request must come from the account holder or the billing contact on file.</li>
          <li>Only the first annual charge in a given subscription term is eligible; renewals are not covered.</li>
        </ul>
        <p>
          To request a refund, email us at{' '}
          <a className="font-medium text-[#3f3f3f] underline underline-offset-4" href={`mailto:${supportEmail}`}>
            {supportEmail}
          </a>{' '}
          with your account email and Stripe receipt. Once approved, refunds are processed through Stripe and typically
          appear on your statement within 5&ndash;10 business days. Beyond this 48-hour window, refunds are handled at
          our discretion and are generally not issued for partial periods.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight text-[#3f3f3f]">Cancellation</h2>
        <p>
          You can cancel your subscription at any time from your Little universe account settings. Navigate to{' '}
          <Link className="font-medium text-[#3f3f3f] underline underline-offset-4" href="/settings">
            Settings &rarr; Manage billing
          </Link>{' '}
          to open the Stripe customer portal, where you can cancel effective at the end of your current billing cycle.
          You will retain access to Pro features until the subscription expires.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight text-[#3f3f3f]">Acceptable Use</h2>
        <p>
          You agree not to misuse Little universe, interfere with other users, or attempt to access the service using automated
          scripts at a rate that would degrade performance. We may suspend or terminate accounts that violate these
          Terms or applicable law.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight text-[#3f3f3f]">Changes to These Terms</h2>
        <p>
          We may update these Terms from time to time. If we make material changes, we will notify you via email or an
          in-app message and indicate the effective date. Your continued use of Little universe after the update becomes effective
          means you accept the revised Terms.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight text-[#3f3f3f]">Contact</h2>
        <p>
          If you have questions about these Terms, your subscription, or the 48-hour refund policy, please reach out to
          us at{' '}
          <a className="font-medium text-[#3f3f3f] underline underline-offset-4" href={`mailto:${supportEmail}`}>
            {supportEmail}
          </a>
          .
        </p>
      </section>
    </div>
  )
}

