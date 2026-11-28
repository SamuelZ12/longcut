'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';

function UnsubscribeContent() {
  const searchParams = useSearchParams();
  const userId = searchParams.get('uid');
  const token = searchParams.get('token');
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');

  useEffect(() => {
    if (!userId) {
      setStatus('error');
      return;
    }

    const unsubscribe = async () => {
      try {
        const response = await fetch('/api/newsletter/unsubscribe', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ userId, token }),
        });

        if (response.ok) {
          setStatus('success');
        } else {
          setStatus('error');
        }
      } catch (error) {
        console.error('Failed to unsubscribe:', error);
        setStatus('error');
      }
    };

    unsubscribe();
  }, [userId]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-zinc-900 px-4">
      <div className="max-w-md w-full space-y-8 p-8 bg-white dark:bg-zinc-800 rounded-lg shadow-lg">
        <div className="text-center">
          {status === 'loading' && (
            <>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
                Unsubscribing...
              </h2>
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto"></div>
            </>
          )}

          {status === 'success' && (
            <>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
                Unsubscribed Successfully
              </h2>
              <p className="text-gray-600 dark:text-gray-300 mb-8">
                You have been removed from our newsletter list. You won&apos;t receive any more monthly updates.
              </p>
              <Link
                href="/"
                className="inline-flex items-center justify-center px-5 py-3 border border-transparent text-base font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                Return to Home
              </Link>
            </>
          )}

          {status === 'error' && (
            <>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
                Something went wrong
              </h2>
              <p className="text-gray-600 dark:text-gray-300 mb-8">
                We couldn&apos;t process your unsubscribe request. Please try again or contact support if the problem persists.
              </p>
              <Link
                href="/"
                className="text-indigo-600 hover:text-indigo-500 font-medium"
              >
                Return to Home
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function UnsubscribePage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-zinc-900">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600"></div>
      </div>
    }>
      <UnsubscribeContent />
    </Suspense>
  );
}
