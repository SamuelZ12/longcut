import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Privacy Policy | Little universe',
  description:
    'Learn how Little universe collects, uses, and protects your personal information and video analysis data.',
}

const supportEmail = 'zara@longcut.ai'

export default function PrivacyPage() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-10 px-4 pb-16 pt-24 text-base leading-relaxed text-[#3f3f3f] sm:px-6 lg:px-8">
      <header className="space-y-4">
        <h1 className="text-3xl font-bold tracking-tight text-[#3f3f3f]">Privacy Policy</h1>
        <p className="text-sm text-muted-foreground">Last updated: November 15, 2025</p>
        <p>
          This Privacy Policy describes how Little universe (&ldquo;we&rdquo;, &ldquo;us&rdquo;, or &ldquo;our&rdquo;) collects,
          uses, and protects your personal information when you use our service. We are committed to protecting your
          privacy and being transparent about our data practices.
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight text-[#3f3f3f]">Information We Collect</h2>

        <h3 className="text-xl font-medium text-[#3f3f3f]">Account Information</h3>
        <p>
          When you create an account, we collect your email address and password. Your password is securely hashed and
          we never store it in plain text. If you choose to sign in with a third-party provider (such as Google), we
          receive basic profile information from that provider.
        </p>

        <h3 className="text-xl font-medium text-[#3f3f3f]">Video Analysis Data</h3>
        <p>
          When you analyze YouTube videos, we store:
        </p>
        <ul className="list-disc space-y-2 pl-6">
          <li>YouTube video IDs and URLs you submit</li>
          <li>Video metadata (title, author, duration, thumbnail)</li>
          <li>Video transcripts obtained from third-party services</li>
          <li>AI-generated content (highlights, summaries, topics, questions)</li>
          <li>Your notes and chat conversations related to videos</li>
          <li>Videos you mark as favorites</li>
        </ul>

        <h3 className="text-xl font-medium text-[#3f3f3f]">Usage Information</h3>
        <p>
          We collect information about how you interact with our service, including:
        </p>
        <ul className="list-disc space-y-2 pl-6">
          <li>Rate limit and usage tracking for fair service distribution</li>
          <li>Timestamps of when you create or update video analyses</li>
          <li>Your subscription status and billing information (processed by Stripe)</li>
        </ul>

        <h3 className="text-xl font-medium text-[#3f3f3f]">Cookies and Session Data</h3>
        <p>
          We use cookies and similar technologies to maintain your authenticated session, remember your preferences,
          and improve your experience. You can control cookie settings through your browser, but some features may not
          function properly if cookies are disabled.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight text-[#3f3f3f]">How We Use Your Information</h2>
        <p>We use the information we collect to:</p>
        <ul className="list-disc space-y-2 pl-6">
          <li>Provide and improve our video analysis service</li>
          <li>Generate AI-powered highlights, summaries, and insights using your video data</li>
          <li>Maintain your account and authenticate your access</li>
          <li>Process payments and manage subscriptions</li>
          <li>Enforce rate limits and prevent abuse of our service</li>
          <li>Send important service updates and notifications about your account</li>
          <li>Respond to your questions and support requests</li>
          <li>Analyze usage patterns to improve our features and user experience</li>
        </ul>
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight text-[#3f3f3f]">Third-Party Services</h2>
        <p>
          We use trusted third-party services to provide and enhance our service. Your data may be processed by:
        </p>

        <h3 className="text-xl font-medium text-[#3f3f3f]">Supabase</h3>
        <p>
          We use Supabase for authentication, database storage, and user data management. Supabase hosts our data on
          secure servers and provides encryption at rest and in transit. Learn more at{' '}
          <a
            className="font-medium text-[#3f3f3f] underline underline-offset-4"
            href="https://supabase.com/privacy"
            target="_blank"
            rel="noopener noreferrer"
          >
            Supabase&apos;s Privacy Policy
          </a>
          .
        </p>

        <h3 className="text-xl font-medium text-[#3f3f3f]">Google Gemini</h3>
        <p>
          We use Google&apos;s Gemini AI models to generate video highlights, summaries, and chat responses. Video
          transcripts and your questions are sent to Gemini for processing. Google&apos;s AI services are subject to
          their{' '}
          <a
            className="font-medium text-[#3f3f3f] underline underline-offset-4"
            href="https://policies.google.com/privacy"
            target="_blank"
            rel="noopener noreferrer"
          >
            Privacy Policy
          </a>
          .
        </p>

        <h3 className="text-xl font-medium text-[#3f3f3f]">Supadata</h3>
        <p>
          We use Supadata&apos;s API to fetch YouTube video transcripts. When you analyze a video, we send the video
          ID to Supadata to retrieve the transcript data.
        </p>

        <h3 className="text-xl font-medium text-[#3f3f3f]">Stripe</h3>
        <p>
          Payment processing is handled by Stripe. We do not store your credit card information. Stripe collects and
          processes your payment details according to their{' '}
          <a
            className="font-medium text-[#3f3f3f] underline underline-offset-4"
            href="https://stripe.com/privacy"
            target="_blank"
            rel="noopener noreferrer"
          >
            Privacy Policy
          </a>
          . Stripe is PCI-DSS compliant and maintains strict security standards.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight text-[#3f3f3f]">Data Security</h2>
        <p>
          We take reasonable measures to protect your information from unauthorized access, alteration, disclosure, or
          destruction:
        </p>
        <ul className="list-disc space-y-2 pl-6">
          <li>All data transmission uses HTTPS encryption (SSL/TLS)</li>
          <li>Passwords are hashed using industry-standard encryption</li>
          <li>Our database is hosted on secure servers with encryption at rest</li>
          <li>We implement rate limiting and abuse prevention measures</li>
          <li>Access to user data is restricted to essential operations only</li>
        </ul>
        <p>
          However, no method of transmission over the internet is 100% secure. While we strive to protect your data,
          we cannot guarantee absolute security.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight text-[#3f3f3f]">Your Rights and Choices</h2>
        <p>You have the following rights regarding your personal information:</p>

        <h3 className="text-xl font-medium text-[#3f3f3f]">Access and Portability</h3>
        <p>
          You can access your video analyses, notes, and account information at any time through your Little universe account. If
          you would like to export your data in a portable format, please contact us.
        </p>

        <h3 className="text-xl font-medium text-[#3f3f3f]">Correction and Deletion</h3>
        <p>
          You can edit or delete your notes, video analyses, and favorites directly from your account. To delete your
          entire account and all associated data, please contact us at{' '}
          <a className="font-medium text-[#3f3f3f] underline underline-offset-4" href={`mailto:${supportEmail}`}>
            {supportEmail}
          </a>
          . We will process account deletion requests within 30 days.
        </p>

        <h3 className="text-xl font-medium text-[#3f3f3f]">Marketing Communications</h3>
        <p>
          We do not send marketing emails. We only send transactional emails related to your account and subscription.
          You cannot opt out of essential service communications.
        </p>

        <h3 className="text-xl font-medium text-[#3f3f3f]">California Residents (CCPA)</h3>
        <p>
          If you are a California resident, you have additional rights under the California Consumer Privacy Act
          (CCPA), including the right to request disclosure of information we collect and share, and the right to
          request deletion of your information. We do not sell your personal information.
        </p>

        <h3 className="text-xl font-medium text-[#3f3f3f]">European Residents (GDPR)</h3>
        <p>
          If you are located in the European Economic Area (EEA), you have rights under the General Data Protection
          Regulation (GDPR), including the right to access, rectify, erase, restrict processing, and data portability.
          Our legal basis for processing your data is your consent and our legitimate interest in providing the
          service.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight text-[#3f3f3f]">Data Retention</h2>
        <p>
          We retain your personal information for as long as your account is active or as needed to provide our
          services. If you delete your account, we will delete or anonymize your personal information within 30 days,
          except where we are required by law to retain certain information (such as for tax or legal compliance).
        </p>
        <p>
          Video analyses that were created while not signed in may be retained for caching purposes but are not linked
          to your identity.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight text-[#3f3f3f]">Children&apos;s Privacy</h2>
        <p>
          Little universe is not intended for children under the age of 13. We do not knowingly collect personal information from
          children under 13. If you believe we have collected information from a child under 13, please contact us
          immediately and we will delete it.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight text-[#3f3f3f]">International Data Transfers</h2>
        <p>
          Your information may be transferred to and processed in countries other than your country of residence. These
          countries may have data protection laws that are different from the laws of your country. By using Little universe, you
          consent to the transfer of your information to our facilities and third-party service providers.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight text-[#3f3f3f]">Changes to This Privacy Policy</h2>
        <p>
          We may update this Privacy Policy from time to time to reflect changes in our practices or for legal,
          regulatory, or operational reasons. If we make material changes, we will notify you via email or through a
          notice on our website. The &ldquo;Last updated&rdquo; date at the top of this policy indicates when it was
          last revised.
        </p>
        <p>
          Your continued use of Little universe after any changes to this Privacy Policy constitutes your acceptance of the
          updated policy.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight text-[#3f3f3f]">Contact Us</h2>
        <p>
          If you have questions or concerns about this Privacy Policy or our data practices, please contact us at:
        </p>
        <p>
          <a className="font-medium text-[#3f3f3f] underline underline-offset-4" href={`mailto:${supportEmail}`}>
            {supportEmail}
          </a>
        </p>
        <p>
          We will respond to privacy-related inquiries within 30 days. For urgent security concerns, please indicate
          that in your email subject line.
        </p>
      </section>
    </div>
  )
}
