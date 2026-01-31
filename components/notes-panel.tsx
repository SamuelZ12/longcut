import { useMemo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Note, NoteSource, NoteMetadata } from "@/lib/types";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Trash2, Clock, Plus, Download, Edit, Search, Filter, X } from "lucide-react";
import { NoteEditor } from "@/components/note-editor";
import { cn } from "@/lib/utils";
import { exportNotesToMarkdown } from "@/lib/markdown-exporter";
import { getLocalNotes, type LocalNote } from "@/lib/local-notes";

function formatDateOnly(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

const markdownComponents = {
  p: ({ children }: any) => (
    <p className="mb-2 last:mb-0 whitespace-pre-wrap">{children}</p>
  ),
  ul: ({ children }: any) => (
    <ul className="list-disc list-inside space-y-1 mb-2 last:mb-0">{children}</ul>
  ),
  ol: ({ children }: any) => (
    <ol className="list-decimal list-inside space-y-1 mb-2 last:mb-0">{children}</ol>
  ),
  li: ({ children }: any) => (
    <li className="whitespace-pre-wrap">{children}</li>
  ),
  a: ({ children, href, ...props }: any) => (
    <a
      href={href}
      className="text-primary hover:text-primary/80 underline decoration-1 underline-offset-2"
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    >
      {children}
    </a>
  ),
  code: ({ inline, className, children, ...props }: any) => (
    inline ? (
      <code className="bg-background/80 px-1 py-0.5 rounded text-xs" {...props}>
        {children}
      </code>
    ) : (
      <pre className="bg-background/70 p-3 rounded-lg overflow-x-auto text-xs space-y-2">
        <code className={className} {...props}>
          {children}
        </code>
      </pre>
    )
  ),
  blockquote: ({ children }: any) => (
    <blockquote className="border-l-4 border-muted-foreground/30 pl-4 italic">{children}</blockquote>
  ),
  strong: ({ children }: any) => (
    <strong className="font-semibold">{children}</strong>
  ),
  em: ({ children }: any) => (
    <em className="italic">{children}</em>
  ),
  h1: ({ children }: any) => (
    <h1 className="text-base font-semibold mb-2">{children}</h1>
  ),
  h2: ({ children }: any) => (
    <h2 className="text-sm font-semibold mb-1">{children}</h2>
  ),
  h3: ({ children }: any) => (
    <h3 className="text-sm font-medium mb-1">{children}</h3>
  ),
};

export interface EditingNote {
  text: string;
  metadata?: NoteMetadata | null;
  source?: string;
  id?: string; // Note ID for editing existing note
}

interface NotesPanelProps {
  notes?: Note[];
  onDeleteNote?: (noteId: string) => Promise<void>;
  editingNote?: EditingNote | null;
  onSaveEditingNote?: (payload: { noteText: string; selectedText: string; metadata?: NoteMetadata }) => void;
  onCancelEditing?: () => void;
  onEditNote?: (note: Note) => void; // New: Edit existing note
  isAuthenticated?: boolean;
  onSignInClick?: () => void;
  currentTime?: number;
  onTimestampClick?: (seconds: number) => void;
  onAddNote?: () => void;
  // Export props
  videoInfo?: { youtubeId: string; title?: string; author?: string; duration?: number; description?: string; thumbnailUrl?: string } | null;
  topics?: any[]; // Topic array from video analysis
}

function getSourceLabel(source: NoteSource) {
  switch (source) {
    case "chat":
      return "💬 AI 对话";
    case "takeaways":
      return "🎯 关键要点";
    case "transcript":
      return "🎬 视频片段";
    default:
      return "✏️ 自定义笔记";
  }
}

type FilterType = 'all' | 'transcript' | 'chat' | 'custom' | 'takeaways';

export function NotesPanel({
  notes = [],
  onDeleteNote,
  editingNote,
  onSaveEditingNote,
  onCancelEditing,
  onEditNote,
  isAuthenticated = true,
  onSignInClick,
  currentTime,
  onTimestampClick,
  onAddNote,
  videoInfo,
  topics
}: NotesPanelProps) {
  const [isExporting, setIsExporting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<FilterType>('all');
  const [showFilters, setShowFilters] = useState(false);

  const handleExport = async () => {
    if (!videoInfo) return;

    setIsExporting(true);
    try {
      // Get local notes for this video
      const localNotes = getLocalNotes(videoInfo.youtubeId);

      // Convert cloud notes to LocalNote format
      const cloudNotesAsLocal: LocalNote[] = notes.map(note => ({
        id: note.id,
        youtubeId: videoInfo.youtubeId,
        source: note.source,
        sourceId: note.sourceId || undefined,
        text: note.text,
        metadata: note.metadata || undefined,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        synced: true
      }));

      // Combine with displayed notes (removing duplicates)
      const allNotes: LocalNote[] = [
        ...cloudNotesAsLocal,
        ...localNotes.filter(ln => !cloudNotesAsLocal.find(n => n.id === ln.id))
      ];

      // Export to markdown - convert videoInfo to VideoInfo format
      const exportVideoInfo = videoInfo ? {
        videoId: videoInfo.youtubeId,
        youtubeId: videoInfo.youtubeId,
        title: videoInfo.title || '未命名视频',
        author: videoInfo.author || '未知作者',
        thumbnail: videoInfo.thumbnailUrl || '',
        duration: videoInfo.duration || 0,
        description: videoInfo.description
      } : null;
      
      if (exportVideoInfo) {
        await exportNotesToMarkdown(exportVideoInfo, allNotes, topics);
      }
    } catch (error) {
      console.error('Export failed:', error);
    } finally {
      setIsExporting(false);
    }
  };

  const handleEditClick = (note: Note) => {
    if (onEditNote) {
      onEditNote(note);
    }
  };

  // Filter and search notes
  const filteredNotes = useMemo(() => {
    let filtered = notes;

    // Apply source filter
    if (filterType !== 'all') {
      filtered = filtered.filter(note => note.source === filterType);
    }

    // Apply search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(note =>
        note.text?.toLowerCase().includes(query) ||
        note.metadata?.selectedText?.toLowerCase().includes(query) ||
        note.metadata?.selectionContext?.toLowerCase().includes(query)
      );
    }

    return filtered;
  }, [notes, filterType, searchQuery]);

  // Group filtered notes by source
  const groupedNotes = useMemo(() => {
    return filteredNotes.reduce<Record<NoteSource, Note[]>>((acc, note) => {
      const list = acc[note.source] || [];
      list.push(note);
      acc[note.source] = list;
      return acc;
    }, {} as Record<NoteSource, Note[]>);
  }, [filteredNotes]);

  const noteCount = notes.length;
  const filteredCount = filteredNotes.length;

  if (!isAuthenticated) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="space-y-1.5">
          <h3 className="text-sm font-semibold text-foreground">登录以保存笔记</h3>
          <p className="text-xs text-muted-foreground">
            高亮字幕或聊天内容来记录笔记
          </p>
        </div>
        <Button
          size="sm"
          className="rounded-full px-4"
          onClick={() => onSignInClick?.()}
        >
          登录
        </Button>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-4 space-y-4 w-full max-w-full overflow-hidden">
        {/* Top Action Bar */}
        <div className="flex flex-col gap-2">
          {/* Search Bar */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              type="text"
              placeholder="搜索笔记..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 h-9 text-xs rounded-xl border-slate-200 bg-white/50 focus:bg-white"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 hover:bg-slate-100 rounded"
              >
                <X className="h-3 w-3 text-muted-foreground" />
              </button>
            )}
          </div>

          {/* Action Buttons Row */}
          <div className="flex items-center gap-2">
            {/* Export Button */}
            {videoInfo && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    onClick={handleExport}
                    disabled={isExporting || (!notes.length && !getLocalNotes(videoInfo.youtubeId).length)}
                    variant="outline"
                    size="sm"
                    className="rounded-xl bg-white/50 border-slate-200 text-slate-600 hover:bg-white hover:text-slate-900 h-8 text-xs font-medium gap-1.5 shrink-0"
                  >
                    <Download className="h-3.5 w-3.5" />
                    导出
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <span className="text-xs">导出为 Markdown 文件</span>
                </TooltipContent>
              </Tooltip>
            )}

            {/* Filter Toggle */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={() => setShowFilters(!showFilters)}
                  variant="outline"
                  size="sm"
                  className="rounded-xl bg-white/50 border-slate-200 text-slate-600 hover:bg-white hover:text-slate-900 h-8 w-8 p-0 shrink-0"
                >
                  <Filter className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <span className="text-xs">筛选笔记类型</span>
              </TooltipContent>
            </Tooltip>

            {/* Add Note Button */}
            {!editingNote && onAddNote && (
              <Button
                onClick={onAddNote}
                className="flex-1 gap-2 rounded-xl border border-dashed border-slate-300 bg-white/50 text-slate-600 shadow-sm hover:bg-white hover:text-slate-900 h-8 text-xs font-medium"
                variant="outline"
              >
                <Plus className="h-3.5 w-3.5" />
                添加笔记
              </Button>
            )}
          </div>

          {/* Filter Options (Expandable) */}
          {showFilters && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {[
                { value: 'all' as FilterType, label: '全部' },
                { value: 'transcript' as FilterType, label: '🎬 视频' },
                { value: 'chat' as FilterType, label: '💬 对话' },
                { value: 'custom' as FilterType, label: '✏️ 自定义' },
                { value: 'takeaways' as FilterType, label: '🎯 要点' },
              ].map((filter) => (
                <button
                  key={filter.value}
                  onClick={() => setFilterType(filter.value)}
                  className={cn(
                    "px-2.5 py-1 text-xs rounded-lg transition-colors",
                    filterType === filter.value
                      ? "bg-purple-100 text-purple-700 font-medium"
                      : "bg-white/50 text-slate-600 hover:bg-white"
                  )}
                >
                  {filter.label}
                </button>
              ))}
            </div>
          )}

          {/* Note Count */}
          {(searchQuery || filterType !== 'all') && (
            <div className="text-xs text-muted-foreground">
              {filteredCount} / {noteCount} 条笔记
            </div>
          )}
        </div>

        {/* Note Editor - shown when editing */}
        {editingNote && onSaveEditingNote && onCancelEditing && (
          <NoteEditor
            selectedText={editingNote.text}
            metadata={editingNote.metadata}
            currentTime={currentTime}
            onSave={onSaveEditingNote}
            onCancel={onCancelEditing}
          />
        )}

        {/* Empty State */}
        {!filteredNotes.length && !editingNote && (
          <div className="h-32 flex flex-col items-center justify-center text-sm text-muted-foreground text-center">
            {searchQuery || filterType !== 'all' ? (
              <p>没有找到匹配的笔记</p>
            ) : (
              <>
                <p>你的笔记将显示在这里</p>
                <p className="text-xs">高亮字幕或聊天内容来创建笔记</p>
              </>
            )}
          </div>
        )}

        {/* Saved Notes - grouped by source */}
        {Object.entries(groupedNotes).map(([source, sourceNotes]) => (
          <div key={source} className="space-y-3">
            <div className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-2">
              {getSourceLabel(source as NoteSource)}
              <span className="text-[10px] px-1.5 py-0.5 bg-slate-100 rounded-full">
                {sourceNotes.length}
              </span>
            </div>
            <div className="space-y-2.5">
              {sourceNotes.map((note) => {
                const selectedText = note.metadata?.selectedText?.trim();
                const text = note.text ?? "";

                let quoteText = "";
                let additionalText = "";

                if (selectedText) {
                  quoteText = selectedText;
                  if (text.startsWith(selectedText)) {
                    additionalText = text.slice(selectedText.length).trimStart();
                  } else if (text !== selectedText) {
                    additionalText = text;
                  }
                } else {
                  const parts = text.split(/\n{2,}/);
                  quoteText = parts[0] ?? "";
                  additionalText = parts.slice(1).join("\n\n");
                }

                const isTranscriptNote = note.source === "transcript";

                const inlineMetadata: ReactNode[] = [];

                if (!isTranscriptNote && note.metadata?.selectionContext) {
                  inlineMetadata.push(
                    <span key="context" className="truncate" title={note.metadata.selectionContext}>
                      {note.metadata.selectionContext}
                    </span>
                  );
                }

                if (!isTranscriptNote && note.metadata?.timestampLabel) {
                   const hasTimestamp = typeof note.metadata.transcript?.start === 'number';
                   inlineMetadata.push(
                    <span
                      key="timestamp"
                      className={cn(
                        "flex items-center gap-1",
                        hasTimestamp && onTimestampClick ? "cursor-pointer hover:text-primary transition-colors hover:underline" : ""
                      )}
                      onClick={() => {
                        if (hasTimestamp && onTimestampClick && note.metadata?.transcript?.start !== undefined) {
                           onTimestampClick(note.metadata.transcript.start);
                        }
                      }}
                    >
                      <Clock className="w-3 h-3" />
                      {note.metadata.timestampLabel}
                    </span>
                  );
                }

                inlineMetadata.push(
                  <span key="date">
                    {formatDateOnly(note.createdAt)}
                  </span>
                );

                const shouldShowSegmentInfo =
                  !isTranscriptNote && note.metadata?.transcript?.segmentIndex !== undefined;

                return (
                  <Card key={note.id} className="group relative p-3.5 bg-white hover:bg-neutral-50/60 border-none shadow-sm hover:shadow-md transition-all">
                    <div className="flex items-start justify-between gap-3">
                      <div
                        className="flex-1 space-y-2 pr-8 cursor-pointer"
                        onClick={() => handleEditClick(note)}
                      >
                        {quoteText && (
                          <div className="border-l-2 border-primary/40 pl-3 py-1 rounded-r text-sm text-foreground/90 leading-relaxed">
                            <ReactMarkdown
                              remarkPlugins={[remarkGfm]}
                              components={markdownComponents}
                            >
                              {quoteText}
                            </ReactMarkdown>
                          </div>
                        )}
                        {additionalText && (
                          <div className="text-sm leading-relaxed text-foreground">
                            <ReactMarkdown
                              remarkPlugins={[remarkGfm]}
                              components={markdownComponents}
                            >
                              {additionalText}
                            </ReactMarkdown>
                          </div>
                        )}
                        <div className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                          <div className="flex flex-wrap items-center gap-3">
                            {inlineMetadata}
                          </div>
                          {shouldShowSegmentInfo && note.metadata?.transcript && note.metadata.transcript.segmentIndex !== undefined && (
                            <span className="text-muted-foreground/80">
                              片段 #{note.metadata.transcript.segmentIndex + 1}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Action Buttons - Always visible on hover */}
                      <div className="absolute top-2 right-2 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        {onEditNote && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleEditClick(note);
                            }}
                            className="h-7 w-7 text-muted-foreground hover:text-primary hover:bg-slate-100"
                            title="编辑笔记"
                          >
                            <Edit className="w-3.5 h-3.5" />
                          </Button>
                        )}
                        {onDeleteNote && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeleteNote(note.id);
                            }}
                            className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-red-50"
                            title="删除笔记"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}
