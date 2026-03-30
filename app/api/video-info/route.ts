import { NextRequest, NextResponse } from 'next/server';
import { extractVideoId } from '@/lib/utils';
import { withSecurity, SECURITY_PRESETS } from '@/lib/security-middleware';
import { getMockVideoInfo, shouldUseMockVideoInfo } from '@/lib/mock-data';
import { fetchYouTubeVideoInfo } from '@/lib/video-info-provider';

async function handler(request: NextRequest) {
  try {
    const { url } = await request.json();

    if (!url) {
      return NextResponse.json(
        { error: 'YouTube URL is required' },
        { status: 400 }
      );
    }

    const videoId = extractVideoId(url);

    if (!videoId) {
      return NextResponse.json(
        { error: 'Invalid YouTube URL' },
        { status: 400 }
      );
    }

    // Use mock data if enabled for local development.
    if (shouldUseMockVideoInfo()) {
      console.log(
        '[VIDEO-INFO] Using mock data (NEXT_PUBLIC_USE_MOCK_VIDEO_INFO=true)'
      );
      const mockData = getMockVideoInfo(videoId);
      return NextResponse.json({
        videoId,
        title: mockData.title,
        author: mockData.channel.name,
        thumbnail: mockData.thumbnail,
        duration: mockData.duration,
        description: mockData.description,
        tags: mockData.tags
      });
    }

    return NextResponse.json(await fetchYouTubeVideoInfo(videoId));
  } catch (error) {
    console.error('[VIDEO-INFO] Top-level error:', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    return NextResponse.json(
      { error: 'Failed to fetch video information' },
      { status: 500 }
    );
  }
}

export const POST = withSecurity(handler, SECURITY_PRESETS.PUBLIC);
