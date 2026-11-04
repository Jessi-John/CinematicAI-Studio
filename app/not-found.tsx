'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Home, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { logger } from '@/lib/utils/logger';

export default function NotFound() {
  const router = useRouter();

  useEffect(() => {
    logger.warn('404 - Page not found: ' + window.location.pathname);
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="text-center max-w-md">
        <div className="mb-8">
          <span className="text-8xl font-bold gradient-text">404</span>
        </div>

        <h1 className="text-2xl font-bold mb-4">Page Not Found</h1>

        <p className="text-[var(--text-secondary)] mb-8">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
          Let&apos;s get you back on track.
        </p>

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Button
            variant="secondary"
            onClick={() => router.back()}
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Go Back
          </Button>

          <Button
            onClick={() => router.push('/')}
          >
            <Home className="w-4 h-4 mr-2" />
            Back to Dashboard
          </Button>
        </div>
      </div>
    </div>
  );
}