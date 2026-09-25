"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { requestAnalysisIntent, storeAnalysisIntent } from '@/lib/initial-analysis-client';
import { AbortManager } from '@/lib/promise-utils';
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { UrlInput } from "@/components/url-input";
import { Card } from "@/components/ui/card";
import { extractVideoId } from "@/lib/utils";
import { toast } from "sonner";
import { AuthModal } from "@/components/auth-modal";
import { useModePreference } from "@/lib/hooks/use-mode-preference";

export default function Home() {
  return (
    <Suspense fallback={null}>
      <HomeContent />
    </Suspense>
  );
}

function HomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [pendingVideoId, setPendingVideoId] = useState<string | null>(null);
  const [isFeelingLucky, setIsFeelingLucky] = useState(false);
  const authPromptHandled = useRef(false);
  const { mode, setMode } = useModePreference();
  const submissionRequests = useRef(new AbortManager());
  const activeSubmission = useRef<AbortController | null>(null);
  useEffect(() => {
    const manager = submissionRequests.current;
    return () => {
      activeSubmission.current = null;
      manager.cleanup();
    };
  }, []);

  useEffect(() => {
    if (!searchParams) return;

    const videoIdParam = searchParams.get("v");
    if (!videoIdParam) return;

    const params = new URLSearchParams();
    const cachedParam = searchParams.get("cached");
    const urlParam = searchParams.get("url");

    if (cachedParam === "true") {
      params.set("cached", "true");
    }

    if (urlParam) {
      params.set("url", urlParam);
    }

    router.replace(
      `/analyze/${videoIdParam}${params.toString() ? `?${params.toString()}` : ""}`,
      { scroll: false }
    );
  }, [router, searchParams]);

  useEffect(() => {
    if (!searchParams) return;

    const authParam = searchParams.get("auth");
    if (authParam !== "limit" || authPromptHandled.current) {
      return;
    }

    authPromptHandled.current = true;

    let message = "You've used your free preview. Sign in to keep going.";
    try {
      const storedMessage = sessionStorage.getItem("limitRedirectMessage");
      if (storedMessage) {
        message = storedMessage;
        sessionStorage.removeItem("limitRedirectMessage");
      }

      const storedVideo = sessionStorage.getItem("pendingVideoId");
      if (storedVideo) {
        setPendingVideoId(storedVideo);
      }
    } catch (error) {
      console.error("Failed to read sessionStorage for auth redirect:", error);
    }

    toast.error(message);
    setAuthModalOpen(true);

    const params = new URLSearchParams(searchParams.toString());
    params.delete("auth");
    const queryString = params.toString();
    router.replace(queryString ? `/?${queryString}` : "/", { scroll: false });
  }, [searchParams, router]);

  useEffect(() => {
    if (!searchParams) return;

    const authError = searchParams.get('auth_error');
    const authStatus = searchParams.get('auth_status');

    if (authStatus === 'link_expired') {
      toast.info('Your verification link has expired or was already used. Please try signing in.', {
        duration: 5000,
      });
      setAuthModalOpen(true);

      const params = new URLSearchParams(searchParams.toString());
      params.delete('auth_status');
      const queryString = params.toString();
      router.replace(queryString ? `/?${queryString}` : '/', { scroll: false });
      return;
    }

    if (!authError) return;

    toast.error(`Authentication failed: ${decodeURIComponent(authError)}`);

    // Clean up the URL
    const params = new URLSearchParams(searchParams.toString());
    params.delete('auth_error');
    const queryString = params.toString();
    router.replace(queryString ? `/?${queryString}` : '/', { scroll: false });
  }, [searchParams, router]);

  useEffect(() => {
    if (!authModalOpen) {
      return;
    }

    try {
      const storedVideo = sessionStorage.getItem("pendingVideoId");
      if (storedVideo) {
        setPendingVideoId(storedVideo);
      }
    } catch (error) {
      console.error("Failed to sync pending video for auth modal:", error);
    }
  }, [authModalOpen]);

  const handleSubmit = useCallback(
    async (url: string) => {
      const videoId = extractVideoId(url);
      if (!videoId) {
        toast.error("Please enter a valid YouTube URL");
        return;
      }

      const params = new URLSearchParams();
      params.set("url", url);

      const manager = submissionRequests.current;
      const controller = manager.createController('submission', 10000,
        new DOMException('Starting analysis timed out. Please submit the video again.', 'TimeoutError'));
      activeSubmission.current = controller;
      try {
        const cache = await fetch('/api/check-video-cache', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }), signal: controller.signal });
        if (!cache.ok) throw new Error('Unable to check this video. Please try again.');
        const data = await cache.json();
        controller.signal.throwIfAborted();
        if (data.status === 'absent' && data.cached === false) {
          storeAnalysisIntent(videoId, await requestAnalysisIntent(videoId, controller.signal));
        } else if (data.status !== 'found' || data.cached !== true) {
          throw new Error('Unable to check this video. Please try again.');
        }
        router.push(`/analyze/${videoId}?${params.toString()}`);
      } catch (error) {
        if (activeSubmission.current === controller) {
          if (controller.signal.reason?.name === 'TimeoutError') toast.error(controller.signal.reason.message);
          else if (!controller.signal.aborted) toast.error(error instanceof Error ? error.message : 'Unable to start analysis.');
        }
      } finally {
        if (manager.getSignal('submission') === controller.signal) manager.cleanup('submission');
        if (activeSubmission.current === controller) activeSubmission.current = null;
      }
    },
    [router]
  );

  const handleFeelingLucky = useCallback(async () => {
    if (isFeelingLucky) {
      return;
    }

    setIsFeelingLucky(true);
    try {
      const response = await fetch("/api/random-video");
      let data: { youtubeId?: string; url?: string | null; error?: string } | null = null;

      try {
        data = await response.json();
      } catch {
        data = null;
      }

      if (!response.ok || !data) {
        const message =
          typeof data?.error === "string" && data.error.trim().length > 0
            ? data.error
            : "Failed to load a sample video. Please try again.";
        throw new Error(message);
      }

      if (!data.youtubeId) {
        throw new Error("No sample video is available right now. Please try again.");
      }

      const params = new URLSearchParams();
      params.set("cached", "true");
      params.set("source", "lucky");

      if (data.url) {
        params.set("url", data.url);
      }

      router.push(`/analyze/${data.youtubeId}?${params.toString()}`);
    } catch (error) {
      console.error("Failed to load random analyzed video:", error);
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to load a sample video. Please try again."
      );
    } finally {
      setIsFeelingLucky(false);
    }
  }, [isFeelingLucky, router]);

  return (
    <>
      <div className="flex min-h-screen items-center justify-center bg-white">
        <div className="mx-auto flex w-full max-w-[660px] -translate-y-[5vh] transform flex-col items-center gap-9 px-6 py-16 text-center sm:py-24">
          <header className="flex flex-col items-center gap-4">
            <div className="flex items-center gap-3">
              <h1 className="text-[21px] font-bold tracking-tight text-[#787878]">LongCut</h1>
            </div>
            <p className="text-[14px] leading-[15px] text-[#787878]">
              The best way to learn from long videos.
            </p>
          </header>
          <div className="flex w-full flex-col items-center gap-9">
            <UrlInput
              onSubmit={handleSubmit}
              mode={mode}
              onModeChange={setMode}
              onFeelingLucky={handleFeelingLucky}
              isFeelingLucky={isFeelingLucky}
            />

            <Card className="relative flex w-[425px] max-w-full flex-col gap-2.5 overflow-hidden rounded-[22px] border border-[#f0f1f1] bg-white p-6 text-left shadow-[2px_11px_40.4px_rgba(0,0,0,0.06)]">
              <div className="relative z-10 flex flex-col gap-2.5">
                <h3 className="text-[14px] font-medium leading-[15px] text-[#5c5c5c]">
                  Don&apos;t take the shortcut.
                </h3>
                <p className="max-w-[70%] text-[14px] leading-[1.5] text-[#8d8d8d]">
                  LongCut doesn&apos;t summarize. We show you where to look instead. Find the highlights. Take notes. Ask questions.
                </p>
              </div>
              <div className="pointer-events-none absolute right-[10px] top-[-00px] h-[110px] w-[110px]">
                <div className="absolute inset-0 overflow-hidden rounded-full opacity-100 [mask-image:radial-gradient(circle,black_30%,transparent_65%)]">
                  <Image
                    src="/gradient_person.jpg"
                    alt="Gradient silhouette illustration"
                    fill
                    sizes="100px"
                    className="object-cover"
                    priority
                  />
                </div>
              </div>
            </Card>
          </div>
        </div>
      </div>
      <AuthModal
        open={authModalOpen}
        onOpenChange={(open) => {
          setAuthModalOpen(open);
          if (!open) {
            setPendingVideoId(null);
          }
        }}
        trigger="generation-limit"
        currentVideoId={pendingVideoId}
      />
    </>
  );
}
