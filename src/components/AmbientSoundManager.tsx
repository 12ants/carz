import React, { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

interface AmbientSoundManagerProps {
  localPlayerRef: React.MutableRefObject<any>;
  weather: 'clear' | 'rain' | 'fog';
  settings: { volume: number };
}

const AmbientSoundManager: React.FC<AmbientSoundManagerProps> = ({ localPlayerRef, weather, settings }) => {
  const audioCtxRef = useRef<AudioContext | null>(null);
  
  // Nodes
  const masterGainRef = useRef<GainNode | null>(null);
  
  const windNodeRef = useRef<{ source: AudioBufferSourceNode, gain: GainNode, filter: BiquadFilterNode } | null>(null);
  const cityNodeRef = useRef<{ source: AudioBufferSourceNode, gain: GainNode, filter: BiquadFilterNode } | null>(null);
  const natureNodeRef = useRef<{ source: AudioBufferSourceNode, gain: GainNode, filter: BiquadFilterNode } | null>(null);
  const rainNodeRef = useRef<{ source: AudioBufferSourceNode, gain: GainNode, filter: BiquadFilterNode } | null>(null);

  // Initialize Audio Context
  useEffect(() => {
    const initAudio = async () => {
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContext) return;
      
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      
      const masterGain = ctx.createGain();
      masterGain.connect(ctx.destination);
      masterGainRef.current = masterGain;

      // Create Noise Buffers
      const createNoiseBuffer = () => {
        const bufferSize = ctx.sampleRate * 2;
        const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
          data[i] = Math.random() * 2 - 1;
        }
        return buffer;
      };
      
      const whiteNoise = createNoiseBuffer();
      
      // Pink Noise for Nature/Rain
      const createPinkNoiseBuffer = () => {
        const bufferSize = ctx.sampleRate * 2;
        const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        let b0, b1, b2, b3, b4, b5, b6;
        b0 = b1 = b2 = b3 = b4 = b5 = b6 = 0.0;
        for (let i = 0; i < bufferSize; i++) {
          const white = Math.random() * 2 - 1;
          b0 = 0.99886 * b0 + white * 0.0555179;
          b1 = 0.99332 * b1 + white * 0.0750759;
          b2 = 0.96900 * b2 + white * 0.1538520;
          b3 = 0.86650 * b3 + white * 0.3104856;
          b4 = 0.55000 * b4 + white * 0.5329522;
          b5 = -0.7616 * b5 - white * 0.0168980;
          data[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
          data[i] *= 0.11; // (roughly) compensate for gain
          b6 = white * 0.115926;
        }
        return buffer;
      };
      const pinkNoise = createPinkNoiseBuffer();

      // --- Wind Setup ---
      const windSource = ctx.createBufferSource();
      windSource.buffer = whiteNoise;
      windSource.loop = true;
      const windFilter = ctx.createBiquadFilter();
      windFilter.type = 'lowpass';
      windFilter.frequency.value = 400;
      const windGain = ctx.createGain();
      windGain.gain.value = 0;
      windSource.connect(windFilter).connect(windGain).connect(masterGain);
      windSource.start();
      windNodeRef.current = { source: windSource, gain: windGain, filter: windFilter };

      // --- City Hum Setup ---
      const citySource = ctx.createBufferSource();
      citySource.buffer = pinkNoise; // Pink noise is better for rumble
      citySource.loop = true;
      const cityFilter = ctx.createBiquadFilter();
      cityFilter.type = 'lowpass';
      cityFilter.frequency.value = 150; // Deep rumble
      const cityGain = ctx.createGain();
      cityGain.gain.value = 0;
      citySource.connect(cityFilter).connect(cityGain).connect(masterGain);
      citySource.start();
      cityNodeRef.current = { source: citySource, gain: cityGain, filter: cityFilter };

      // --- Nature Setup ---
      const natureSource = ctx.createBufferSource();
      natureSource.buffer = pinkNoise;
      natureSource.loop = true;
      const natureFilter = ctx.createBiquadFilter();
      natureFilter.type = 'highpass';
      natureFilter.frequency.value = 800; // Hiss/Leaves
      const natureGain = ctx.createGain();
      natureGain.gain.value = 0;
      natureSource.connect(natureFilter).connect(natureGain).connect(masterGain);
      natureSource.start();
      natureNodeRef.current = { source: natureSource, gain: natureGain, filter: natureFilter };

      // --- Rain Setup ---
      const rainSource = ctx.createBufferSource();
      rainSource.buffer = whiteNoise;
      rainSource.loop = true;
      const rainFilter = ctx.createBiquadFilter();
      rainFilter.type = 'lowpass';
      rainFilter.frequency.value = 800;
      const rainGain = ctx.createGain();
      rainGain.gain.value = 0;
      rainSource.connect(rainFilter).connect(rainGain).connect(masterGain);
      rainSource.start();
      rainNodeRef.current = { source: rainSource, gain: rainGain, filter: rainFilter };
    };

    // User interaction required to start audio context usually, 
    // but we'll try to init on mount and resume on first interaction if needed.
    const handleInteraction = () => {
      if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume();
      }
    };
    window.addEventListener('click', handleInteraction);
    window.addEventListener('keydown', handleInteraction);

    initAudio();

    return () => {
      window.removeEventListener('click', handleInteraction);
      window.removeEventListener('keydown', handleInteraction);
      if (audioCtxRef.current) {
        audioCtxRef.current.close();
      }
    };
  }, []);

  // Update Volumes based on Game State
  useFrame(() => {
    if (!localPlayerRef.current || !audioCtxRef.current) return;
    
    const p = localPlayerRef.current;
    const speed = Math.abs(p.speed);
    const altitude = p.z || 0;
    const x = p.x;
    const y = p.y; // Note: In game logic y is z (depth), and z is height (y in THREE), but let's check GameCanvas logic.
    // In GameCanvas: 
    // p.x, p.y are horizontal plane.
    // p.z is height (vertical).
    
    // City Center is roughly 250, 500 (Inner City zone)
    // Let's check DELIVERY_ZONES in GameCanvas.
    // Inner City: x: 250, y: 500.
    const distToCity = Math.sqrt((x - 250)**2 + (y - 500)**2);
    
    const masterVol = settings.volume / 100;
    if (masterGainRef.current) {
        masterGainRef.current.gain.setTargetAtTime(masterVol, audioCtxRef.current.currentTime, 0.1);
    }

    // 1. Wind Logic
    // Louder at high speed AND high altitude
    // Altitude range: 0 (ground) to ~100 (mountain peaks)
    const altitudeFactor = Math.min(1, Math.max(0, altitude / 80)); 
    const speedFactor = Math.min(1, speed / 5.0);
    
    const targetWindVol = (0.1 + speedFactor * 0.6 + altitudeFactor * 0.4) * 0.5;
    const targetWindFreq = 200 + speedFactor * 1000 + altitudeFactor * 500;
    
    if (windNodeRef.current) {
        windNodeRef.current.gain.gain.setTargetAtTime(targetWindVol, audioCtxRef.current.currentTime, 0.1);
        windNodeRef.current.filter.frequency.setTargetAtTime(targetWindFreq, audioCtxRef.current.currentTime, 0.1);
    }

    // 2. City Logic
    // Louder near city, quieter at altitude
    const cityDistFactor = 1 - Math.min(1, distToCity / 400); // 400 unit radius
    const cityAltFactor = 1 - altitudeFactor; // Quieter high up
    const targetCityVol = cityDistFactor * cityAltFactor * 0.3;
    
    if (cityNodeRef.current) {
        cityNodeRef.current.gain.gain.setTargetAtTime(targetCityVol, audioCtxRef.current.currentTime, 0.5);
    }

    // 3. Nature Logic
    // Louder away from city
    const natureDistFactor = Math.min(1, distToCity / 300);
    const targetNatureVol = natureDistFactor * 0.15;
    
    if (natureNodeRef.current) {
        natureNodeRef.current.gain.gain.setTargetAtTime(targetNatureVol, audioCtxRef.current.currentTime, 0.5);
    }

    // 4. Rain Logic
    const isRain = weather === 'rain';
    const targetRainVol = isRain ? 0.4 : 0;
    
    if (rainNodeRef.current) {
        rainNodeRef.current.gain.gain.setTargetAtTime(targetRainVol, audioCtxRef.current.currentTime, 1.0);
    }
  });

  return null;
};

export default AmbientSoundManager;
