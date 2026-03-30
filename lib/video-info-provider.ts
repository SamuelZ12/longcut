export interface VideoInfoResponse {
  videoId: string;
  title: string;
  author: string;
  thumbnail: string;
  duration: number;
  description?: string;
  tags?: string[];
}

function getFallbackVideoInfo(videoId: string): VideoInfoResponse {
  return {
    videoId,
    title: 'YouTube Video',
    author: 'Unknown',
    thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    duration: 0,
  };
}

export async function fetchYouTubeVideoInfo(
  videoId: string,
  fetchImpl: typeof fetch = fetch
): Promise<VideoInfoResponse> {
  try {
    const response = await fetchImpl(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
    );

    if (!response.ok) {
      return getFallbackVideoInfo(videoId);
    }

    const data = await response.json() as {
      title?: string;
      author_name?: string;
      thumbnail_url?: string;
    };

    return {
      videoId,
      title: data.title || 'YouTube Video',
      author: data.author_name || 'Unknown',
      thumbnail:
        data.thumbnail_url ||
        `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      duration: 0,
    };
  } catch (fetchError) {
    console.error('[VIDEO-INFO] oEmbed fetch error:', fetchError);
    return getFallbackVideoInfo(videoId);
  }
}
