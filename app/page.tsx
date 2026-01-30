"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
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
    (url: string) => {
      const videoId = extractVideoId(url);
      if (!videoId) {
        toast.error("Please enter a valid YouTube URL");
        return;
      }

      const params = new URLSearchParams();
      params.set("url", url);

      router.push(`/analyze/${videoId}?${params.toString()}`);
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
      <div
        className="flex min-h-screen items-center justify-center bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: 'url(/背景.png)', backgroundColor: '#F5F5F5' }}
      >
        <div className="mx-auto flex w-full max-w-[480px] flex-col items-center gap-8 px-6 py-16">
          <UrlInput
            onSubmit={handleSubmit}
            mode={mode}
            onModeChange={setMode}
            onFeelingLucky={handleFeelingLucky}
            isFeelingLucky={isFeelingLucky}
          />
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
