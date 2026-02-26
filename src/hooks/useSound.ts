import { useRef, useEffect, useCallback } from 'react';

interface SoundOptions {
  loop?: boolean;
  volume?: number;
}

const useSound = (src: string, options?: SoundOptions) => {
  const soundRef = useRef<HTMLAudioElement | null>(null);
  const { loop = false, volume = 1 } = options || {};

  useEffect(() => {
    soundRef.current = new Audio(src);
    soundRef.current.loop = loop;
    soundRef.current.volume = Math.max(0, Math.min(1, volume));

    return () => {
      if (soundRef.current) {
        soundRef.current.pause();
        soundRef.current = null;
      }
    };
  }, [src, loop, volume]);

  const play = useCallback(() => {
    if (soundRef.current) {
      soundRef.current.currentTime = 0;
      const playPromise = soundRef.current.play();
      if (playPromise !== undefined) {
        playPromise.catch(e => {
          if (e.name !== 'AbortError' && e.name !== 'NotSupportedError') {
            console.error("Error playing sound:", e);
          }
        });
      }
    }
  }, []);

  const stop = useCallback(() => {
    if (soundRef.current) {
      soundRef.current.pause();
      soundRef.current.currentTime = 0;
    }
  }, []);

  const setVolume = useCallback((newVolume: number) => {
    if (soundRef.current) {
      soundRef.current.volume = Math.max(0, Math.min(1, newVolume));
    }
  }, []);

  return { play, stop, setVolume };
};

export default useSound;
