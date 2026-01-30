"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";

const PROVIDERS = [
  { value: "grok", label: "Grok", description: "xAI Grok - Fast & capable" },
  { value: "gemini", label: "Gemini", description: "Google Gemini AI" },
  { value: "deepseek", label: "DeepSeek", description: "DeepSeek with web search" },
] as const;

type ProviderValue = typeof PROVIDERS[number]["value"];

const STORAGE_KEY = "ai-provider-preference";

export function AIProviderSelector() {
  const [currentProvider, setCurrentProvider] = useState<ProviderValue>("grok");
  const [isOpen, setIsOpen] = useState(false);

  // Load saved preference on mount
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && PROVIDERS.some(p => p.value === saved)) {
      setCurrentProvider(saved as ProviderValue);
    } else {
      // Check current environment
      const checkProvider = async () => {
        try {
          const res = await fetch("/api/ai/provider");
          if (res.ok) {
            const data = await res.json();
            if (data.provider) {
              setCurrentProvider(data.provider);
            }
          }
        } catch {
          // Ignore error, use default
        }
      };
      void checkProvider();
    }
  }, []);

  const handleProviderChange = async (value: ProviderValue) => {
    setIsOpen(false);

    // Call API to switch provider
    try {
      const res = await fetch("/api/ai/provider", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: value }),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(`切换失败: ${data.error || '未知错误'}`);
        return;
      }

      // Success - update local state and storage
      setCurrentProvider(value);
      localStorage.setItem(STORAGE_KEY, value);
      toast.success(`已切换到 ${PROVIDERS.find(p => p.value === value)?.label}`);
    } catch (error) {
      console.error("Error switching provider:", error);
      toast.error("切换提供商时发生错误");
    }
  };

  const current = PROVIDERS.find(p => p.value === currentProvider) || PROVIDERS[0];

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs font-medium gap-1"
        >
          <span>{current.label}</span>
          <ChevronDown className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[200px]">
        {PROVIDERS.map((provider) => (
          <DropdownMenuItem
            key={provider.value}
            onClick={() => handleProviderChange(provider.value)}
            className="flex flex-col items-start gap-1 py-2"
          >
            <div className="flex items-center gap-2">
              <span className="font-medium">{provider.label}</span>
              {provider.value === currentProvider && (
                <span className="text-[10px] text-muted-foreground">(Active)</span>
              )}
            </div>
            <span className="text-xs text-muted-foreground">
              {provider.description}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
