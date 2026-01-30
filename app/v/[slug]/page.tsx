import { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { VideoPageClient } from './video-page-client';
import { Topic, TranscriptSegment, VideoInfo } from '@/lib/types';
import { buildVideoSlug } from '@/lib/utils';

// Extract video ID from slug (format: "title-words-videoId")
function extractVideoIdFromSlug(slug: string): string | null {
  // Robustly grab the last 11 characters; YouTube IDs can contain hyphens/underscores
  const cleaned = slug.trim().replace(/\/$/, '');
  const potentialId = cleaned.slice(-11);

  return /^[A-Za-z0-9_-]{11}$/.test(potentialId) ? potentialId : null;
}

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

interface VideoAnalysisRow {
  youtube_id: string;
  title: string;
  author: string | null;
  duration: number | null;
  thumbnail_url: string | null;
  transcript: TranscriptSegment[] | null;
  topics: Topic[] | null;
  summary: string | Record<string, unknown> | null;
  suggested_questions?: string[] | null;
  slug?: string | null;
  created_at?: string;
  updated_at?: string;
}

async function resolveVideoFromSlug(
  supabase: SupabaseServerClient,
  slug: string
): Promise<{ video: VideoAnalysisRow; videoId: string; canonicalSlug: string } | null> {
  const videoIdFromSlug = extractVideoIdFromSlug(slug);

  // 1) Try by youtube_id if we could extract one
  if (videoIdFromSlug) {
    const { data, error } = await supabase
      .from('video_analyses')
      .select('*')
      .eq('youtube_id', videoIdFromSlug)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') {
      console.error('Error fetching video analysis by youtube_id', { slug, videoIdFromSlug, error });
    }

    if (data) {
      const canonicalSlug = buildVideoSlug(data.title, data.youtube_id);
      return { video: data, videoId: data.youtube_id, canonicalSlug };
    }
  }

  // 2) Try by stored slug (legacy rows may not include the videoId suffix)
  const { data, error } = await supabase
    .from('video_analyses')
    .select('*')
    .eq('slug', slug)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching video analysis by slug', { slug, error });
  }

  if (data) {
    const canonicalSlug = buildVideoSlug(data.title, data.youtube_id);
    return { video: data, videoId: data.youtube_id, canonicalSlug };
  }

  return null;
}

interface PageProps {
  params: Promise<{ slug: string }>;
}

// Generate metadata for SEO
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const supabase = await createClient();
  const resolved = await resolveVideoFromSlug(supabase, slug);

  if (!resolved) {
    return {
      title: 'Video Not Found - Little universe',
      description: 'This video analysis could not be found.'
    };
  }

  const { video, videoId, canonicalSlug } = resolved;
  const slugForMeta = canonicalSlug || slug;

  // Extract summary content
  const summary = typeof video.summary === 'string'
    ? video.summary
    : (video.summary as any)?.content || '';

  const description = summary
    ? summary.slice(0, 160).trim() + (summary.length > 160 ? '...' : '')
    : `Watch highlights, browse the full transcript, and get AI-generated insights for ${video.title}`;

  const thumbnailUrl = video.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;

  return {
    title: `${video.title} - Transcript & Analysis | Little universe`,
    description,
    keywords: [
      video.title,
      `${video.title} transcript`,
      video.author,
      `${video.author} videos`,
      'video transcript',
      'video summary',
      'AI analysis',
      'highlights'
    ].filter(Boolean).join(', '),
    openGraph: {
      title: video.title,
      description: description,
      type: 'video.other',
      url: `https://longcut.ai/v/${slugForMeta}`,
      siteName: 'Little universe',
      images: [
        {
          url: thumbnailUrl,
          width: 1280,
          height: 720,
          alt: video.title
        }
      ],
      videos: [
        {
          url: `https://www.youtube.com/watch?v=${videoId}`,
        }
      ]
    },
    twitter: {
      card: 'summary_large_image',
      title: video.title,
      description: description,
      images: [thumbnailUrl]
    },
    alternates: {
      canonical: `https://longcut.ai/v/${slugForMeta}`
    },
    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
        'max-video-preview': -1,
        'max-image-preview': 'large',
        'max-snippet': -1,
      },
    },
  };
}

// Main page component (Server Component)
export default async function VideoPage({ params }: PageProps) {
  const { slug } = await params;
  const supabase = await createClient();
  const resolved = await resolveVideoFromSlug(supabase, slug);

  if (!resolved) {
    const fallbackVideoId = extractVideoIdFromSlug(slug);
    const hasCanonicalSuffix = Boolean(
      fallbackVideoId &&
      slug.endsWith(fallbackVideoId) &&
      (slug.length === 11 || slug.slice(-12, -11) === '-')
    );

    if (fallbackVideoId && hasCanonicalSuffix) {
      redirect(`/analyze/${fallbackVideoId}`);
    }

    notFound();
  }

  const { video, videoId, canonicalSlug } = resolved;

  // Redirect old/non-canonical slugs (e.g., ones created before video IDs were appended)
  if (canonicalSlug && canonicalSlug !== slug) {
    redirect(`/v/${canonicalSlug}`);
  }

  // Parse JSON fields
  const transcript: TranscriptSegment[] = Array.isArray(video.transcript)
    ? video.transcript
    : [];

  const topics: Topic[] = Array.isArray(video.topics)
    ? video.topics
    : [];

  const videoInfo: VideoInfo = {
    videoId,
    title: video.title,
    author: video.author || '',
    duration: video.duration || 0,
    thumbnail: video.thumbnail_url || '',
    description: '',
    tags: []
  };

  // Extract summary
  const summary = typeof video.summary === 'string'
    ? video.summary
    : (video.summary as any)?.content || '';

  // Format duration for Schema.org (ISO 8601 duration format)
  const formatDuration = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    let duration = 'PT';
    if (hours > 0) duration += `${hours}H`;
    if (minutes > 0) duration += `${minutes}M`;
    if (secs > 0 || duration === 'PT') duration += `${secs}S`;

    return duration;
  };

  // Create full transcript text for search engines
  const fullTranscriptText = transcript
    .map(segment => segment.text)
    .join(' ')
    .slice(0, 5000); // Limit to first 5000 chars for structured data

  // JSON-LD structured data for rich results
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    "name": video.title,
    "description": summary || `Analysis and transcript of ${video.title}`,
    "thumbnailUrl": video.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    "uploadDate": video.created_at,
    "duration": formatDuration(video.duration || 0),
    "contentUrl": `https://www.youtube.com/watch?v=${videoId}`,
    "embedUrl": `https://www.youtube.com/embed/${videoId}`,
    "interactionStatistic": {
      "@type": "InteractionCounter",
      "interactionType": "https://schema.org/WatchAction",
      "userInteractionCount": 0
    },
    "publisher": {
      "@type": "Organization",
      "name": "Little universe",
      "url": "https://longcut.ai"
    },
    "author": {
      "@type": "Person",
      "name": video.author
    }
  };

  // Article structured data for the transcript/analysis
  const articleStructuredData = {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": `${video.title} - Transcript & Analysis`,
    "description": summary || `Full transcript and AI-generated highlights for ${video.title}`,
    "image": video.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    "datePublished": video.created_at,
    "dateModified": video.updated_at,
    "author": {
      "@type": "Person",
      "name": video.author
    },
    "publisher": {
      "@type": "Organization",
      "name": "Little universe",
      "url": "https://longcut.ai"
    },
    "mainEntityOfPage": {
      "@type": "WebPage",
      "@id": `https://longcut.ai/v/${canonicalSlug || slug}`
    },
    "articleBody": fullTranscriptText
  };

  return (
    <>
      {/* Structured Data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleStructuredData) }}
      />

      {/* Server-rendered content for SEO */}
      <div className="sr-only">
        <h1>{video.title}</h1>
        <p>By {video.author}</p>
        <h2>Summary</h2>
        <p>{summary}</p>
        <h2>Topics Covered</h2>
        <ul>
          {topics.slice(0, 10).map((topic, index) => (
            <li key={index}>{topic.title}</li>
          ))}
        </ul>
        <h2>Full Transcript</h2>
        <div>
          {transcript.map((segment, index) => (
            <p key={index}>{segment.text}</p>
          ))}
        </div>
      </div>

      {/* Client-side interactive component */}
      <VideoPageClient
        videoId={videoId}
        slug={slug}
        initialVideo={{
          ...video,
          author: video.author || '',
          created_at: video.created_at || '',
          updated_at: video.updated_at || '',
          transcript,
          topics,
          videoInfo,
          summary
        }}
      />
    </>
  );
}

// Enable ISR (Incremental Static Regeneration) - revalidate every 24 hours
export const revalidate = 86400;
