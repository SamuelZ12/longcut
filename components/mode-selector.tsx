"use client";

import React from "react";
import { Zap, Brain } from "lucide-react";
import type { TopicGenerationMode } from "@/lib/types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface ModeSelectorProps {
  value: TopicGenerationMode;
  onChange: (mode: TopicGenerationMode) => void;
  className?: string;
}

const modes = [
  {
    value: "fast" as const,
    label: "Fast",
    icon: Zap,
    description: "Quick analysis (~30% faster)"
  },
  {
    value: "smart" as const,
    label: "Smart",
    icon: Brain,
    description: "Deeper analysis (better quality)"
  }
];

export function ModeSelector({ value, onChange }: ModeSelectorProps) {
  const currentMode = modes.find(m => m.value === value) || modes[0];
  const Icon = currentMode.icon;

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        className="h-8 w-[90px] rounded-lg border-0 bg-transparent text-[#b3b4b4] hover:text-[#787878] hover:bg-transparent focus:ring-0 focus-visible:ring-0 focus-visible:ring-offset-0 shadow-none px-0"
      >
        <SelectValue>
          <div className="flex items-center gap-2.5">
            <div className="w-5 flex items-center justify-end shrink-0">
              <Icon className="h-5 w-5" />
            </div>
            <span className="text-[14px] font-medium">{currentMode.label}</span>
          </div>
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="start" className="w-[90px] shadow-none">
        {modes.map((mode) => {
          const ModeIcon = mode.icon;
          return (
            <SelectItem
              key={mode.value}
              value={mode.value}
              className="cursor-pointer py-1.5 px-0"
            >
              <div className="flex items-center gap-2.5">
                <div className="w-5 flex items-center justify-end shrink-0">
                  <ModeIcon className="h-5 w-5 text-[#5c5c5c]" />
                </div>
                <span className="text-[14px] font-medium text-[#2c2c2c]">{mode.label}</span>
              </div>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
