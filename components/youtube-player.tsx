"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Topic, TranscriptSegment, PlaybackCommand, TranslationRequestHandler } from "@/lib/types";
import { formatDuration } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { VideoProgressBar } from "@/components/video-progress-bar";

interface YouTubePlayerProps {
  videoId: string;
  selectedTopic: Topic | null;
  onTimeUpdate?: (seconds: number) => void;
  playbackCommand?: PlaybackCommand | null;
  onCommandExecuted?: () => void;
  onPlayerReady?: () => void;
  topics?: Topic[];
  onTopicSelect?: (topic: Topic, fromPlayAll?: boolean) => void;
  onPlayTopic?: (topic: Topic) => void;
  transcript?: TranscriptSegment[];
  isPlayingAll?: boolean;
  playAllIndex?: number;
  onTogglePlayAll?: () => void;
  setPlayAllIndex?: (index: number | ((prev: number) => number)) => void;
  setIsPlayingAll?: (playing: boolean) => void;
  renderControls?: boolean;
  onDurationChange?: (duration: number) => void;
  selectedLanguage?: string | null;
  onRequestTranslation?: TranslationRequestHandler;
}

export type YouTubePlayerHandle = {
  seekTo: (time: number) => boolean;
};

type YouTubePlayerVars = {
  autoplay: 0;
  controls: 1;
  modestbranding: 1;
  rel: 0;
  origin?: string;
};

export function getYouTubePlayerVars(origin?: string | null): YouTubePlayerVars {
  return {
    autoplay: 0,
    controls: 1,
    modestbranding: 1,
    rel: 0,
    ...(origin ? { origin } : {}),
  };
}

export function getYouTubePlayerElementId(videoId: string) {
  return `youtube-player-${videoId}`;
}

export function shouldRenderHighlightTimeline(videoDuration: number, topicCount: number) {
  return videoDuration > 0 && topicCount > 0;
}

function hasPlayerMethod(player: unknown, methodName: string) {
  return Boolean(
    player &&
    typeof (player as Record<string, unknown>)[methodName] === 'function'
  );
}

export function canExecutePlaybackCommand(
  player: unknown,
  playerReady: boolean,
  command?: PlaybackCommand | null
) {
  if (!player || !playerReady) return false;

  switch (command?.type) {
    case 'SEEK':
    case 'PLAY_TOPIC':
    case 'PLAY_SEGMENT':
    case 'PLAY_CITATIONS':
    case 'PLAY_ALL':
      return hasPlayerMethod(player, 'seekTo');
    case 'PLAY':
      return hasPlayerMethod(player, 'playVideo');
    case 'PAUSE':
      return hasPlayerMethod(player, 'pauseVideo');
    default:
      return true;
  }
}

export function shouldPollPlayerTime(player: unknown, playerReady: boolean) {
  return Boolean(
    playerReady &&
    player &&
    typeof (player as { getCurrentTime?: unknown }).getCurrentTime === 'function'
  );
}

export function shouldQueuePlaybackCommand(
  command: PlaybackCommand | null | undefined,
  playerReady: boolean,
  player: unknown
) {
  return Boolean(command && !canExecutePlaybackCommand(player, playerReady, command));
}

export function seekPlayerTo(
  player: unknown,
  playerReady: boolean,
  time: number,
  onSeeked?: (time: number) => void
) {
  if (!canExecutePlaybackCommand(player, playerReady, { type: 'SEEK', time })) {
    return false;
  }

  const seekablePlayer = player as {
    seekTo: (time: number, allowSeekAhead: boolean) => void;
    playVideo?: () => void;
  };
  seekablePlayer.seekTo(time, true);
  onSeeked?.(time);
  seekablePlayer.playVideo?.();
  return true;
}

function YouTubePlayerComponent({
  videoId,
  selectedTopic,
  onTimeUpdate,
  playbackCommand,
  onCommandExecuted,
  onPlayerReady,
  topics = [],
  onTopicSelect,
  transcript = [],
  isPlayingAll = false,
  playAllIndex = 0,
  setPlayAllIndex,
  setIsPlayingAll,
  renderControls = true,
  onDurationChange,
  selectedLanguage = null,
  onRequestTranslation,
}: YouTubePlayerProps, ref: Ref<YouTubePlayerHandle>) {
  const playerRef = useRef<any>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [citationReelSegmentIndex, setCitationReelSegmentIndex] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [playerReady, setPlayerReady] = useState(false);
  const playerReadyRef = useRef(false);
  const timeUpdateIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isPlayingAllRef = useRef(false);
  const playAllIndexRef = useRef(0);
  const topicsRef = useRef<Topic[]>([]);
  const pendingPlaybackCommandRef = useRef<PlaybackCommand | null>(null);
  const executePlaybackCommandRef = useRef<((command: PlaybackCommand) => boolean) | null>(null);
  const playerElementId = getYouTubePlayerElementId(videoId);

  const syncSeekTime = useCallback((time: number) => {
    setCurrentTime(time);
    onTimeUpdate?.(time);
  }, [onTimeUpdate]);

  useImperativeHandle(ref, () => ({
    seekTo: (time: number) => seekPlayerTo(playerRef.current, playerReadyRef.current, time, syncSeekTime),
  }), [syncSeekTime]);

  const executePlaybackCommand = useCallback((command: PlaybackCommand) => {
    if (!canExecutePlaybackCommand(playerRef.current, playerReadyRef.current, command)) {
      return false;
    }

    switch (command.type) {
      case 'SEEK':
        if (command.time !== undefined) {
          return seekPlayerTo(playerRef.current, playerReadyRef.current, command.time, syncSeekTime);
        }
        return false;

      case 'PLAY_TOPIC':
        if (command.topic) {
          const topic = command.topic;
          onTopicSelect?.(topic);
          if (topic.segments.length > 0) {
            const startTime = topic.segments[0].start;
            playerRef.current.seekTo(startTime, true);
            syncSeekTime(startTime);
            if (command.autoPlay) {
              playerRef.current.playVideo();
            }
            return true;
          }
        }
        return false;

      case 'PLAY_SEGMENT':
        if (command.segment) {
          playerRef.current.seekTo(command.segment.start, true);
          syncSeekTime(command.segment.start);
          playerRef.current.playVideo();
          return true;
        }
        return false;

      case 'PLAY_CITATIONS':
        if (command.citations && command.citations.length > 0) {
          // Create citation reel topic
          const citationReel: Topic = {
            id: `citation-reel-${Date.now()}`,
            title: "Cited Clips",
            description: "Playing all clips cited in the AI response",
            duration: command.citations.reduce((total, c) => total + (c.end - c.start), 0),
            segments: command.citations.map(c => ({
              start: c.start,
              end: c.end,
              text: c.text,
              startSegmentIdx: c.startSegmentIdx,
              endSegmentIdx: c.endSegmentIdx,
              startCharOffset: c.startCharOffset,
              endCharOffset: c.endCharOffset,
            })),
            isCitationReel: true,
            autoPlay: true,
          };
          onTopicSelect?.(citationReel);
          playerRef.current.seekTo(command.citations[0].start, true);
          syncSeekTime(command.citations[0].start);
          if (command.autoPlay) {
            playerRef.current.playVideo();
          }
          return true;
        }
        return false;

      case 'PLAY_ALL':
        if (topics.length > 0) {
          // Play All state is already set in requestPlayAll.
          // Just select the first topic and start playing.
          onTopicSelect?.(topics[0], true);
          const startTime = topics[0].segments[0].start;
          playerRef.current.seekTo(startTime, true);
          syncSeekTime(startTime);
          if (command.autoPlay) {
            playerRef.current.playVideo();
          }
          return true;
        }
        return false;

      case 'PLAY':
        playerRef.current.playVideo();
        return true;

      case 'PAUSE':
        playerRef.current.pauseVideo();
        return true;
    }
  }, [onTopicSelect, syncSeekTime, topics]);

  executePlaybackCommandRef.current = executePlaybackCommand;

  // Keep refs in sync with state
  useEffect(() => {
    isPlayingAllRef.current = isPlayingAll;
  }, [isPlayingAll]);

  useEffect(() => {
    playAllIndexRef.current = playAllIndex;
  }, [playAllIndex]);

  useEffect(() => {
    topicsRef.current = topics;
  }, [topics]);

  useEffect(() => {
    setVideoDuration(0);
    setCurrentTime(0);
    playerReadyRef.current = false;
    onDurationChange?.(0);

    if (!videoId) return;

    let mounted = true;

    const startTimeUpdateInterval = () => {
      if (timeUpdateIntervalRef.current) {
        clearInterval(timeUpdateIntervalRef.current);
      }

      let lastUpdateTime = 0;
      timeUpdateIntervalRef.current = setInterval(() => {
        if (!shouldPollPlayerTime(playerRef.current, true)) return;

        const time = playerRef.current.getCurrentTime();

        // Always update internal current time for progress bar and timer
        setCurrentTime(time);

        // Handle Play All mode auto-transitions
        if (isPlayingAllRef.current && topicsRef.current.length > 0) {
          const currentIndex = playAllIndexRef.current;
          const currentTopic = topicsRef.current[currentIndex];
          if (currentTopic && currentTopic.segments.length > 0) {
            const segment = currentTopic.segments[0];

            // Check if we've reached the end of the current segment
            if (time >= segment.end) {
              const isLastTopic = currentIndex >= topicsRef.current.length - 1;
              if (isLastTopic) {
                // End Play All mode
                setIsPlayingAll?.(false);
                isPlayingAllRef.current = false;
                playerRef.current.pauseVideo();
              } else {
                // Advance to the next topic
                const nextIndex = currentIndex + 1;
                playAllIndexRef.current = nextIndex;
                setPlayAllIndex?.(nextIndex);
              }
            }
          }
        }

        // Throttle external updates to reduce re-renders (update every 500ms instead of 100ms)
        const timeDiff = Math.abs(time - lastUpdateTime);
        if (timeDiff >= 0.5) {
          lastUpdateTime = time;
          onTimeUpdate?.(time);
        }
      }, 100);
    };

    const initializePlayer = () => {
      // Only create player if component still mounted and no player exists
      if (!mounted || playerRef.current) return;

      const nextPlayer = new (window as any).YT.Player(playerElementId, {
        videoId: videoId,
        playerVars: getYouTubePlayerVars(window.location.origin),
        events: {
          onReady: (event: { target: any }) => {
            if (!mounted) return;
            playerReadyRef.current = true;
            const duration = event.target.getDuration();
            setVideoDuration(duration);
            onDurationChange?.(duration);
            setPlayerReady(true);
            startTimeUpdateInterval();
            onPlayerReady?.();

            const pendingCommand = pendingPlaybackCommandRef.current;
            if (pendingCommand) {
              setTimeout(() => {
                if (!mounted || pendingPlaybackCommandRef.current !== pendingCommand) return;

                const executed = executePlaybackCommandRef.current?.(pendingCommand) ?? false;
                if (executed) {
                  pendingPlaybackCommandRef.current = null;
                  onCommandExecuted?.();
                }
              }, 50);
            }
          },
          onStateChange: (event: { data: number; target: any }) => {
            if (!mounted) return;
            const playing = event.data === 1;
            setIsPlaying(playing);
          },
          onError: (event: { data: number }) => {
            if (process.env.NODE_ENV !== 'production') {
              console.warn('YouTube player error', { code: event.data, videoId });
            }
          },
        },
      });
      playerRef.current = nextPlayer;
    };

    // Check if YouTube API is already loaded
    if ((window as any).YT && (window as any).YT.Player) {
      initializePlayer();
    } else {
      // Only add script if it doesn't exist and document.body is available
      if (typeof document !== 'undefined' && document.body && !document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
        const tag = document.createElement("script");
        tag.src = "https://www.youtube.com/iframe_api";
        document.body.appendChild(tag);
      }

      // Set up or use existing callback
      const existingCallback = (window as any).onYouTubeIframeAPIReady;
      (window as any).onYouTubeIframeAPIReady = () => {
        if (existingCallback) existingCallback();
        if (mounted) initializePlayer();
      };
    }

    // Cleanup: Always destroy player if it exists
    return () => {
      mounted = false;
      setPlayerReady(false);
      playerReadyRef.current = false;
      pendingPlaybackCommandRef.current = null;

      if (playerRef.current) {
        try {
          playerRef.current.destroy();
        } catch (e) {
          console.error('Error destroying player:', e);
        }
        playerRef.current = null;
      }
      if (timeUpdateIntervalRef.current) {
        clearInterval(timeUpdateIntervalRef.current);
        timeUpdateIntervalRef.current = null;
      }
    };
  }, [videoId, playerElementId, onCommandExecuted, onDurationChange, onTimeUpdate, setIsPlayingAll, setPlayAllIndex, onPlayerReady]);

  // Centralized command executor
  useEffect(() => {
    const command = playbackCommand ?? pendingPlaybackCommandRef.current;
    if (!command) return;

    if (shouldQueuePlaybackCommand(command, playerReadyRef.current, playerRef.current)) {
      pendingPlaybackCommandRef.current = command;
      return;
    }

    const executeCommand = () => {
      const executed = executePlaybackCommand(command);
      if (!executed) {
        pendingPlaybackCommandRef.current = command;
        return;
      }

      // Clear command after execution
      if (pendingPlaybackCommandRef.current === command) {
        pendingPlaybackCommandRef.current = null;
      }
      onCommandExecuted?.();
    };

    // Execute with small delay to ensure player stability
    const timeoutId = setTimeout(executeCommand, 50);
    return () => clearTimeout(timeoutId);
  }, [executePlaybackCommand, playbackCommand, playerReady, onCommandExecuted]);

  // Reset segment index when topic changes and auto-play if needed
  useEffect(() => {
    setCitationReelSegmentIndex(0);
    // Auto-play if the topic has the autoPlay flag
    if (selectedTopic?.autoPlay && playerRef.current) {
      // Small delay to ensure player is ready
      setTimeout(() => {
        if (playerRef.current?.playVideo) {
          playerRef.current.playVideo();
        }
      }, 100);
    }
  }, [selectedTopic]);

  // State-driven playback effect for Play All mode
  useEffect(() => {
    if (!isPlayingAll || !playerReady || !playerRef.current || topics.length === 0) return;

    const currentTopic = topics[playAllIndex];
    if (!currentTopic || currentTopic.segments.length === 0) return;

    // Select the topic in the UI (with fromPlayAll flag to prevent state reset)
    onTopicSelect?.(currentTopic, true);

    // Small delay to ensure player is ready
    setTimeout(() => {
      if (playerRef.current?.seekTo && playerRef.current?.playVideo) {
        // Seek to the start of the topic's segment and play
        const segment = currentTopic.segments[0];
        playerRef.current.seekTo(segment.start, true);
        syncSeekTime(segment.start);
        playerRef.current.playVideo();
      }
    }, 100);
  }, [isPlayingAll, playAllIndex, playerReady, topics, onTopicSelect, syncSeekTime]);

  // Monitor playback to handle citation reel transitions
  useEffect(() => {
    if (!selectedTopic || !isPlaying || !playerRef.current) return;

    // Don't set up monitoring during play-all mode (handled by time update logic)
    if (isPlayingAll) return;

    // Handle citation reels with multiple segments
    if (selectedTopic.isCitationReel && selectedTopic.segments.length > 0) {
      const monitoringInterval = setInterval(() => {
        if (!playerRef.current?.getCurrentTime) return;

        const currentTime = playerRef.current.getCurrentTime();
        const currentSegment = selectedTopic.segments[citationReelSegmentIndex];

        if (!currentSegment) return;

        // Check if we've reached the end of the current segment
        if (currentTime >= currentSegment.end) {
          // Check if there are more segments to play
          if (citationReelSegmentIndex < selectedTopic.segments.length - 1) {
            // Move to the next segment
            const nextIndex = citationReelSegmentIndex + 1;
            setCitationReelSegmentIndex(nextIndex);
            const nextSegment = selectedTopic.segments[nextIndex];

            // Seek to the start of the next segment
            playerRef.current.seekTo(nextSegment.start, true);
            syncSeekTime(nextSegment.start);
          } else {
            // This was the last segment, pause the video
            playerRef.current.pauseVideo();

            // Clear the monitoring interval
            clearInterval(monitoringInterval);

            // Reset the segment index for next playback
            setCitationReelSegmentIndex(0);
          }
        }
      }, 100); // Check every 100ms

      // Clean up on unmount or when dependencies change
      return () => {
        clearInterval(monitoringInterval);
      };
    }
  }, [selectedTopic, isPlaying, isPlayingAll, citationReelSegmentIndex, syncSeekTime]);

  const playTopic = (topic: Topic) => {
    if (!playerRef.current || !topic || topic.segments.length === 0) return;

    // If clicking a topic manually, exit play all mode
    if (isPlayingAll) {
      setIsPlayingAll?.(false);
    }

    // Seek to the start of the single segment and play
    const segment = topic.segments[0];
    playerRef.current.seekTo(segment.start, true);
    syncSeekTime(segment.start);
    playerRef.current.playVideo();
  };



  const handleSeek = (time: number) => {
    playerRef.current?.seekTo(time, true);
    syncSeekTime(time);
  };


  return (
    <div className="w-full">
      <Card className="overflow-hidden shadow-sm p-0">
        <div className="relative bg-black overflow-hidden aspect-video">
          <div
            id={playerElementId}
            className="absolute top-0 left-0 w-full h-full"
          />
        </div>

        {renderControls && (
          <div className="p-3 bg-background border-t flex-shrink-0">
            {shouldRenderHighlightTimeline(videoDuration, topics.length) && (
              <VideoProgressBar
                videoDuration={videoDuration}
                currentTime={currentTime}
                topics={topics}
                selectedTopic={selectedTopic}
                onSeek={handleSeek}
                onTopicSelect={onTopicSelect}
                onPlayTopic={playTopic}
                transcript={transcript}
                videoId={videoId}
                selectedLanguage={selectedLanguage}
                onRequestTranslation={onRequestTranslation}
              />
            )}

            <div className="mt-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="ml-3 flex items-center gap-2">
                  <span className="text-sm font-mono text-muted-foreground">
                    {formatDuration(currentTime)} / {formatDuration(videoDuration)}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2">
              </div>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

export const YouTubePlayer = forwardRef<YouTubePlayerHandle, YouTubePlayerProps>(YouTubePlayerComponent);
YouTubePlayer.displayName = 'YouTubePlayer';
