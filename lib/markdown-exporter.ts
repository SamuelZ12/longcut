import { LocalNote } from './local-notes';
import { VideoInfo, Topic } from './types';
import { formatDuration } from './utils';

export interface ExportData {
  videoInfo: VideoInfo;
  notes: LocalNote[];
  topics?: Topic[];
  exportDate: string;
}

export function generateMarkdown(data: ExportData): string {
  const { videoInfo, notes, topics, exportDate } = data;
  const lines: string[] = [];

  // Header
  lines.push(`# 📹 视频笔记：${videoInfo.title || '未命名视频'}`);
  lines.push('');

  // Metadata section
  lines.push('---');
  lines.push('');
  lines.push('## 📋 视频信息');
  lines.push('');
  lines.push(`| 项目 | 内容 |`);
  lines.push(`|------|------|`);
  lines.push(`| **🎬 视频标题** | ${videoInfo.title || 'N/A'} |`);
  lines.push(`| **👤 作者/频道** | ${videoInfo.author || 'N/A'} |`);
  lines.push(`| **⏱️ 总时长** | ${formatDuration(videoInfo.duration || 0)} |`);
  lines.push(`| **🔗 视频链接** | [https://youtube.com/watch?v=${videoInfo.videoId}](https://youtube.com/watch?v=${videoInfo.videoId}) |`);
  lines.push(`| **📝 导出时间** | ${new Date(exportDate).toLocaleString('zh-CN')} |`);
  lines.push(`| **📌 笔记数量** | ${notes.length} 条 |`);
  lines.push('');

  // Group notes by source
  const transcriptNotes = notes.filter(n => n.source === 'transcript');
  const chatNotes = notes.filter(n => n.source === 'chat');
  const customNotes = notes.filter(n => n.source === 'custom');
  const takeawayNotes = notes.filter(n => n.source === 'takeaways');

  // Notes section
  if (notes.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## 📌 我的笔记');
    lines.push('');

    // Transcript quotes
    if (transcriptNotes.length > 0) {
      lines.push('### 🎬 来自视频片段');
      lines.push('');

      transcriptNotes.forEach((note, index) => {
        const timestamp = note.metadata?.transcript?.start
          ? `(${formatDuration(note.metadata.transcript.start)})`
          : '';
        const segmentStart = note.metadata?.transcript?.end
          ? ` [${formatDuration(note.metadata.transcript.end)}]`
          : '';

        lines.push(`#### ${index + 1}. ${timestamp}${segmentStart}`);

        if (note.metadata?.originalText) {
          lines.push('');
          lines.push(`> ${note.metadata.originalText}`);
          lines.push('');
        }

        if (note.text) {
          lines.push(note.text);
          lines.push('');
        }

        lines.push('---');
        lines.push('');
      });
    }

    // Chat notes
    if (chatNotes.length > 0) {
      lines.push('### 💬 来自 AI 对话');
      lines.push('');

      chatNotes.forEach((note, index) => {
        const question = note.metadata?.question || '问题';
        lines.push(`**Q:** ${question}`);
        lines.push('');
        lines.push(`**A:** ${note.text}`);
        lines.push('');
        lines.push('---');
        lines.push('');
      });
    }

    // Custom notes
    if (customNotes.length > 0) {
      lines.push('### ✏️ 自定义笔记');
      lines.push('');

      customNotes.forEach((note, index) => {
        const timeStr = note.metadata?.transcript?.start
          ? `[${formatDuration(note.metadata.transcript.start)}]`
          : `[${new Date(note.createdAt).toLocaleString('zh-CN')}]`;

        lines.push(`#### ${index + 1}. ${timeStr}`);
        lines.push('');
        lines.push(note.text);
        lines.push('');
        lines.push('---');
        lines.push('');
      });
    }

    // Takeaways
    if (takeawayNotes.length > 0) {
      lines.push('### 🎯 关键要点');
      lines.push('');

      takeawayNotes.forEach((note, index) => {
        lines.push(`${index + 1}. ${note.text}`);
      });
      lines.push('');
    }
  }

  // Topics section (if available)
  if (topics && topics.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## 🏷️ 话题回顾');
    lines.push('');

    const colorLabels: Record<string, string> = {
      '#FF8A80': '🌸 珊瑚色',
      '#80CBC4': '🌿 薄荷绿',
      '#F48FB1': '🌺 浅粉色',
      '#B39DDB': '💜 淡紫色',
      '#81D4FA': '💙 浅蓝色',
    };

    topics.forEach((topic, index) => {
      const color = (topic as any).color || '#81D4FA';
      const label = colorLabels[color as keyof typeof colorLabels] || '📌';

      lines.push(`${index + 1}. **${label} [${formatDuration(topic.segments[0]?.start || 0)} - ${formatDuration(topic.segments[topic.segments.length - 1]?.end || 0)}]** ${topic.title}`);

      if (topic.quote) {
        lines.push(`   > "${topic.quote.text}"`);
      }

      if (topic.keywords && topic.keywords.length > 0) {
        lines.push(`   *关键词: ${topic.keywords.join(', ')}*`);
      }

      lines.push('');
    });
  }

  // Summary section (if available in videoInfo)
  if (videoInfo.description) {
    lines.push('---');
    lines.push('');
    lines.push('## 📝 视频简介');
    lines.push('');
    lines.push(videoInfo.description);
    lines.push('');
  }

  // Footer
  lines.push('---');
  lines.push('');
  lines.push('*📤 本笔记由 [Little universe](https://github.com/yourusername/longcut) 自动生成*');

  return lines.join('\n');
}

export function downloadMarkdownFile(markdown: string, filename: string): void {
  // Create blob with markdown content
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });

  // Create download link
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;

  // Trigger download
  document.body.appendChild(link);
  link.click();

  // Cleanup
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function generateNoteFilename(videoInfo: VideoInfo): string {
  // Sanitize video title for filename
  const sanitizedTitle = (videoInfo.title || 'video')
    .replace(/[<>:"/\\|?*]/g, '') // Remove invalid filename chars
    .replace(/\s+/g, '_') // Replace spaces with underscores
    .substring(0, 50); // Limit length

  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  return `Little universe_笔记_${sanitizedTitle}_${date}.md`;
}

// Export notes with all data
export async function exportNotesToMarkdown(
  videoInfo: VideoInfo,
  notes: LocalNote[],
  topics?: Topic[]
): Promise<void> {
  const exportData: ExportData = {
    videoInfo,
    notes,
    topics,
    exportDate: new Date().toISOString(),
  };

  const markdown = generateMarkdown(exportData);
  const filename = generateNoteFilename(videoInfo);

  downloadMarkdownFile(markdown, filename);
}
