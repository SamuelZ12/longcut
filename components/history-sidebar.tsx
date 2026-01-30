"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { History, ChevronLeft, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";
import Link from "next/link";

const HISTORY_STORAGE_KEY = "longcut-watch-history";
const MAX_HISTORY_ITEMS = 50;

export interface WatchHistoryItem {
  videoId: string;
  title: string;
  thumbnail: string;
  watchedAt: number; // timestamp
  duration?: number;
  lastPosition?: number; // seconds
}

interface HistorySidebarProps {
  currentVideoId?: string;
  onCollapsedChange?: (collapsed: boolean) => void;
  defaultCollapsed?: boolean;
}

export function useWatchHistory() {
  const [history, setHistory] = useState<WatchHistoryItem[]>([]);

  useEffect(() => {
    const stored = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (stored) {
      try {
        setHistory(JSON.parse(stored));
      } catch {
        setHistory([]);
      }
    }
  }, []);

  const addToHistory = useCallback(
    (item: Omit<WatchHistoryItem, "watchedAt">) => {
      setHistory((prev) => {
        // Remove existing entry for same video
        const filtered = prev.filter((h) => h.videoId !== item.videoId);
        const newHistory = [
          { ...item, watchedAt: Date.now() },
          ...filtered,
        ].slice(0, MAX_HISTORY_ITEMS);

        localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(newHistory));
        return newHistory;
      });
    },
    [],
  );

  const removeFromHistory = useCallback((videoId: string) => {
    setHistory((prev) => {
      const filtered = prev.filter((h) => h.videoId !== videoId);
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(filtered));
      return filtered;
    });
  }, []);

  const clearHistory = useCallback(() => {
    localStorage.removeItem(HISTORY_STORAGE_KEY);
    setHistory([]);
  }, []);

  return { history, addToHistory, removeFromHistory, clearHistory };
}

export function HistorySidebar({
  currentVideoId,
  onCollapsedChange,
  defaultCollapsed = false,
}: HistorySidebarProps) {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
  const { history, removeFromHistory } = useWatchHistory();

  const toggleCollapsed = () => {
    const newState = !isCollapsed;
    setIsCollapsed(newState);
    onCollapsedChange?.(newState);
  };

  // Format relative time
  const formatRelativeTime = (timestamp: number) => {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes}分钟前`;
    if (hours < 24) return `${hours}小时前`;
    if (days < 7) return `${days}天前`;
    return new Date(timestamp).toLocaleDateString("zh-CN");
  };

  if (isCollapsed) {
    return (
      <div className="h-full flex flex-col items-center py-4 bg-muted/30 border-r">
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleCollapsed}
          className="mb-4"
          title="展开历史记录"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        <History className="h-5 w-5 text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-muted/30 border-r">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4" />
          <span className="font-medium text-sm">观看历史</span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleCollapsed}
          className="h-7 w-7"
          title="折叠"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
      </div>

      {/* History List */}
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {history.length === 0 ? (
            <div className="text-center text-muted-foreground text-sm py-8">
              暂无观看记录
            </div>
          ) : (
            history.map((item) => (
              <div
                key={item.videoId}
                className={cn(
                  "group relative rounded-lg overflow-hidden",
                  currentVideoId === item.videoId && "ring-2 ring-primary",
                )}
              >
                <Link href={`/analyze/${item.videoId}`} className="block">
                  <div className="aspect-video relative">
                    <img
                      src={item.thumbnail}
                      alt={item.title}
                      className="w-full h-full object-cover"
                    />
                    {currentVideoId === item.videoId && (
                      <div className="absolute inset-0 bg-primary/20 flex items-center justify-center">
                        <span className="text-xs bg-primary text-primary-foreground px-2 py-0.5 rounded">
                          当前
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="p-2">
                    <p className="text-xs font-medium line-clamp-2 leading-tight">
                      {item.title}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {formatRelativeTime(item.watchedAt)}
                    </p>
                  </div>
                </Link>
                {/* Delete button */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute top-1 right-1 h-6 w-6 opacity-0 group-hover:opacity-100 bg-black/50 hover:bg-black/70 text-white"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    removeFromHistory(item.videoId);
                  }}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
