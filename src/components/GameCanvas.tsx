/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { socket } from '../services/socket';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { PerspectiveCamera, Environment, Text, OrbitControls, Sky } from '@react-three/drei';
import { EffectComposer, Bloom, N8AO } from '@react-three/postprocessing';
import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';
import { Player, PowerUp, PowerUpType } from '../types';
import useSound from '../hooks/useSound';

const noise2D = createNoise2D();

const TRACK_WIDTH = 1200;
const TRACK_HEIGHT = 850;

// Car physics constants
const ACCELERATION = 0.2;
const MAX_SPEED = 4.0;
const MAX_SPEED_BOOST = 6.0;
const NITRO_SPEED = 7.0;
const NITRO_ACCEL = 0.4;
const FRICTION = 0.96;
const TURN_SPEED = 0.07;
const DRIFT_FACTOR = 0.95;
const GRAVITY = 0.35; // Even floatier
const JUMP_FORCE = 2.0;
const SUSPENSION_STIFFNESS = 0.4; // Very bouncy
const SUSPENSION_DAMPING = 0.1;
const SUSPENSION_REST_LENGTH = 2.0;
const TIRE_GRIP_LATERAL = 0.92;
const TIRE_GRIP_LONGITUDINAL = 0.98;
const ROLL_STIFFNESS = 0.08;
const PITCH_STIFFNESS = 0.08;

// Track Geometry
const TRACK_RADIUS = 50; // Slightly narrower for more technical turns
const TRACK_SEGMENTS = [
    // Start / Main Straight
    { start: {x: 100, y: 750}, end: {x: 600, y: 750}, angle: 0 },
    
    // The "Big Jump" Ramp Section
    { start: {x: 600, y: 750}, end: {x: 900, y: 750}, angle: 0 },
    
    // East Downhill
    { start: {x: 900, y: 750}, end: {x: 900, y: 500}, angle: -Math.PI/2 },
    
    // "The Snake" Chicane
    { start: {x: 900, y: 500}, end: {x: 700, y: 500}, angle: Math.PI },
    { start: {x: 700, y: 500}, end: {x: 700, y: 350}, angle: -Math.PI/2 },
    { start: {x: 700, y: 350}, end: {x: 900, y: 350}, angle: 0 },
    
    // South Straight
    { start: {x: 900, y: 350}, end: {x: 900, y: 100}, angle: -Math.PI/2 },
    
    // "Canyon Run" (Low elevation)
    { start: {x: 900, y: 100}, end: {x: 400, y: 100}, angle: Math.PI },
    
    // "Mountain Climb" (High elevation)
    { start: {x: 400, y: 100}, end: {x: 100, y: 100}, angle: Math.PI },
    
    // West Side Return
    { start: {x: 100, y: 100}, end: {x: 100, y: 400}, angle: Math.PI/2 },
    
    // Inner Loop
    { start: {x: 100, y: 400}, end: {x: 400, y: 400}, angle: 0 },
    { start: {x: 400, y: 400}, end: {x: 400, y: 600}, angle: Math.PI/2 },
    { start: {x: 400, y: 600}, end: {x: 100, y: 600}, angle: Math.PI },
    { start: {x: 100, y: 600}, end: {x: 100, y: 750}, angle: Math.PI/2 },
];

const DELIVERY_ZONES = [
  { x: 200, y: 750, name: 'Start Line', color: '#ff00ff' },
  { x: 800, y: 750, name: 'Jump Zone', color: '#00ffff' },
  { x: 800, y: 425, name: 'Chicane', color: '#ffff00' },
  { x: 900, y: 150, name: 'Canyon', color: '#ff8800' },
  { x: 250, y: 100, name: 'Summit', color: '#00ff00' },
  { x: 250, y: 500, name: 'Inner City', color: '#ff0000' },
];

// Math helpers for collision
function getClosestPointOnSegment(p: {x: number, y: number}, v: {x: number, y: number}, w: {x: number, y: number}) {
  const l2 = (v.x - w.x)**2 + (v.y - w.y)**2;
  if (l2 === 0) return v;
  let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
  t = Math.max(0, Math.min(1, t));
  return { x: v.x + t * (w.x - v.x), y: v.y + t * (w.y - v.y) };
}

function distToSegmentSquared(p: {x: number, y: number}, v: {x: number, y: number}, w: {x: number, y: number}) {
  const l2 = (v.x - w.x)**2 + (v.y - w.y)**2;
  if (l2 === 0) return (p.x - v.x)**2 + (p.y - v.y)**2;
  let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
  t = Math.max(0, Math.min(1, t));
  return (p.x - (v.x + t * (w.x - v.x)))**2 + (p.y - (v.y + t * (w.y - v.y)))**2;
}

function distToSegment(p: {x: number, y: number}, v: {x: number, y: number}, w: {x: number, y: number}) {
  return Math.sqrt(distToSegmentSquared(p, v, w));
}

const isPointOnTrackMath = (x: number, y: number, buffer: number = 0): boolean => {
  const p = {x, y};
  let minDist = Infinity;
  
  for (const seg of TRACK_SEGMENTS) {
    const d = distToSegment(p, seg.start, seg.end);
    if (d < minDist) minDist = d;
  }

  return minDist <= (TRACK_RADIUS + buffer);
};

const getTerrainHeight = (x: number, y: number): number => {
  // Special Track Features (Ramps)
  // Jump Ramp (Top Right Straight)
  if (y > 700 && y < 800 && x > 600 && x < 900) {
      const progress = (x - 600) / 300;
      if (progress < 0.85) {
          return Math.pow(progress, 2) * 60; 
      } else {
          return 0; 
      }
  }

  // Biome Logic
  const isMountain = x < 400;
  const isDesert = x > 600 && y < 400;
  const isCanyon = y < 200 && x > 400 && x < 900;
  
  let biomeHeight = 0;
  
  if (isMountain) {
      // High frequency, jagged noise
      const n1 = noise2D(x * 0.005, y * 0.005) * 80;
      const n2 = Math.abs(noise2D(x * 0.02, y * 0.02)) * 30;
      biomeHeight = n1 + n2 + 20;
  } else if (isDesert) {
      // Rolling dunes
      const n1 = Math.sin(x * 0.01) * Math.cos(y * 0.01) * 15;
      const n2 = noise2D(x * 0.005, y * 0.005) * 10;
      biomeHeight = n1 + n2 + 5;
  } else if (isCanyon) {
      // Deep cut
      const n1 = noise2D(x * 0.01, y * 0.01) * 5;
      biomeHeight = -20 + n1;
  } else {
      // Plains / City (Flat with slight roll)
      biomeHeight = noise2D(x * 0.002, y * 0.002) * 10;
  }

  // Track Flattening
  const p = {x, y};
  let minDist = Infinity;
  for (const seg of TRACK_SEGMENTS) {
    const d = distToSegment(p, seg.start, seg.end);
    if (d < minDist) minDist = d;
  }
  
  if (minDist <= TRACK_RADIUS) return 0; // Flat track
  
  const distFromEdge = minDist - TRACK_RADIUS;
  const blendDist = 60;
  const blend = Math.min(1, Math.pow(distFromEdge / blendDist, 2));
  
  // Kicker Lip
  let kicker = 0;
  if (distFromEdge < 15) {
      kicker = (distFromEdge / 15) * 3;
  }
  
  return biomeHeight * blend + kicker;
};

// Generate Decorations once
const DECORATIONS = (() => {
    const items: { type: 'tree' | 'rock' | 'house' | 'building' | 'lamp' | 'billboard' | 'guardrail' | 'tire' | 'cone' | 'cactus', pos: [number, number, number], scale: number, rotation: number, color?: string, length?: number, radius: number }[] = [];
    const count = 800; 
    const seed = 42;
    const rng = (s: number) => {
        const x = Math.sin(s) * 10000;
        return x - Math.floor(x);
    };
    let s = seed;

    for (let i = 0; i < count; i++) {
      const x = rng(s++) * 3000 - 900; 
      const z = rng(s++) * 3000 - 1075;
      
      if (!isPointOnTrackMath(x, z, 30)) {
        const rand = rng(s++);
        let type: 'tree' | 'rock' | 'house' | 'building' | 'lamp' | 'cactus' = 'tree';
        let scale = 1;
        let rotation = rng(s++) * Math.PI * 2;
        let color = undefined;
        let radius = 2; // Collision radius
        
        const distFromCenter = Math.sqrt((x-600)*(x-600) + (z-400)*(z-400));
        
        // Biome Logic
        const isMountain = x < 400;
        const isDesert = x > 600 && z < 400;
        const isCanyon = z < 200 && x > 400 && x < 900;
        
        if (isDesert) {
            if (rand > 0.6) {
                type = 'cactus';
                scale = 1 + rng(s++) * 1.5;
                radius = 1.5;
            } else {
                type = 'rock';
                scale = 1 + rng(s++) * 2;
                color = '#d4b483'; 
                radius = 3 * scale;
            }
        } else if (isMountain) {
            if (rand > 0.5) {
                type = 'tree'; 
                color = '#0f172a'; 
                scale = 3 + rng(s++) * 4;
                radius = 1.5;
            } else {
                type = 'rock';
                scale = 4 + rng(s++) * 6;
                color = '#475569'; 
                radius = 4 * scale;
            }
        } else if (isCanyon) {
             type = 'rock';
             scale = 2 + rng(s++) * 3;
             color = '#78350f'; 
             radius = 3 * scale;
        } else if (distFromCenter < 600) {
             if (rand > 0.8) {
                 type = 'building';
                 scale = 1 + rng(s++) * 0.5;
                 color = ['#64748b', '#475569', '#334155'][Math.floor(rng(s++) * 3)];
                 radius = 12 * scale;
             } else if (rand > 0.6) {
                 type = 'house';
                 scale = 1 + rng(s++) * 0.2;
                 color = ['#e2e8f0', '#cbd5e1', '#f1f5f9'][Math.floor(rng(s++) * 3)];
                 radius = 8 * scale;
             } else {
                 type = 'tree';
                 scale = 1.5 + rng(s++) * 2;
                 radius = 1.5;
             }
        } else {
             if (rand > 0.3) {
                 type = 'tree';
                 scale = 2 + rng(s++) * 3;
                 radius = 1.5;
             } else {
                 type = 'rock';
                 scale = 1 + rng(s++) * 2;
                 radius = 2 * scale;
             }
        }

        const y = getTerrainHeight(x, z);
        items.push({ type, pos: [x, y, z], scale, rotation, color, radius });
      }
    }
    
    // Add street lamps along the track
    TRACK_SEGMENTS.forEach(seg => {
        const dx = seg.end.x - seg.start.x;
        const dy = seg.end.y - seg.start.y;
        const len = Math.sqrt(dx*dx + dy*dy);
        const angle = Math.atan2(dy, dx);
        const lampCount = Math.floor(len / 120); 
        
        for(let i=1; i<lampCount; i++) {
            const t = i / lampCount;
            const x = seg.start.x + dx * t;
            const z = seg.start.y + dy * t;
            
            const offsetX = Math.cos(angle + Math.PI/2) * (TRACK_RADIUS + 8);
            const offsetZ = Math.sin(angle + Math.PI/2) * (TRACK_RADIUS + 8);
            
            const y = getTerrainHeight(x + offsetX, z + offsetZ);
            items.push({ type: 'lamp', pos: [x + offsetX, y, z + offsetZ], scale: 1, rotation: -angle + Math.PI, color: undefined, radius: 1.0 });
        }
    });

    return items;
})();

// 3D Components
const CarModel = ({ color, isLocal, drifting, powerUp }: { color: string, isLocal?: boolean, drifting?: boolean, powerUp?: PowerUpType }) => {
  return (
    <group scale={[2, 2, 2]}>
      {/* Shield Effect */}
      {powerUp === 'shield' && (
        <mesh position={[0, 1, 0]}>
            <sphereGeometry args={[2.5, 16, 16]} />
            <meshBasicMaterial color="#3b82f6" transparent opacity={0.3} wireframe />
        </mesh>
      )}
      
      {/* Speed Trail Effect */}
      {powerUp === 'speed' && (
        <mesh position={[0, 0.5, -3]} rotation={[Math.PI/2, 0, 0]}>
            <coneGeometry args={[1, 4, 8]} />
            <meshBasicMaterial color="#ef4444" transparent opacity={0.4} />
        </mesh>
      )}

      {/* Main Body Chassis */}
      <mesh position={[0, 0.6, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.9, 0.8, 4.2]} />
        <meshStandardMaterial color={color} metalness={0.6} roughness={0.4} />
      </mesh>

      {/* Upper Cabin / Roof */}
      <mesh position={[0, 1.3, -0.4]} castShadow>
        <boxGeometry args={[1.6, 0.7, 2.2]} />
        <meshStandardMaterial color="#111" metalness={0.9} roughness={0.1} />
      </mesh>
      
      {/* Windshield */}
      <mesh position={[0, 1.3, 0.75]} rotation={[Math.PI / 8, 0, 0]}>
        <boxGeometry args={[1.55, 0.65, 0.1]} />
        <meshStandardMaterial color="#88ccff" metalness={0.9} roughness={0.1} transparent opacity={0.7} />
      </mesh>

      {/* Rear Window */}
      <mesh position={[0, 1.3, -1.55]} rotation={[-Math.PI / 8, 0, 0]}>
        <boxGeometry args={[1.55, 0.65, 0.1]} />
        <meshStandardMaterial color="#88ccff" metalness={0.9} roughness={0.1} transparent opacity={0.7} />
      </mesh>

      {/* Side Mirrors */}
      <mesh position={[0.9, 1.2, 0.5]} rotation={[0, -0.2, 0]}>
        <boxGeometry args={[0.3, 0.2, 0.1]} />
        <meshStandardMaterial color={color} />
      </mesh>
      <mesh position={[-0.9, 1.2, 0.5]} rotation={[0, 0.2, 0]}>
        <boxGeometry args={[0.3, 0.2, 0.1]} />
        <meshStandardMaterial color={color} />
      </mesh>

      {/* Door Handles */}
      <mesh position={[0.96, 0.8, -0.2]}>
        <boxGeometry args={[0.05, 0.05, 0.3]} />
        <meshStandardMaterial color="#333" />
      </mesh>
      <mesh position={[-0.96, 0.8, -0.2]}>
        <boxGeometry args={[0.05, 0.05, 0.3]} />
        <meshStandardMaterial color="#333" />
      </mesh>

      {/* Hood Scoop */}
      <mesh position={[0, 1.05, 1.2]}>
        <boxGeometry args={[0.8, 0.1, 0.8]} />
        <meshStandardMaterial color="#111" />
      </mesh>

      {/* Side Skirts */}
      <mesh position={[1, 0.3, 0]}>
        <boxGeometry args={[0.2, 0.4, 3]} />
        <meshStandardMaterial color="#111" />
      </mesh>
      <mesh position={[-1, 0.3, 0]}>
        <boxGeometry args={[0.2, 0.4, 3]} />
        <meshStandardMaterial color="#111" />
      </mesh>

      {/* Rear Diffuser */}
      <mesh position={[0, 0.3, -2.15]}>
        <boxGeometry args={[1.6, 0.4, 0.2]} />
        <meshStandardMaterial color="#111" />
      </mesh>
      {[0.4, 0, -0.4].map((x, i) => (
          <mesh key={i} position={[x, 0.2, -2.25]}>
              <boxGeometry args={[0.05, 0.4, 0.1]} />
              <meshStandardMaterial color="#333" />
          </mesh>
      ))}

      {/* Exhaust Pipes */}
      <mesh position={[0.6, 0.3, -2.2]} rotation={[Math.PI/2, 0, 0]}>
        <cylinderGeometry args={[0.1, 0.1, 0.4]} />
        <meshStandardMaterial color="#555" metalness={1} roughness={0.2} />
      </mesh>
      <mesh position={[-0.6, 0.3, -2.2]} rotation={[Math.PI/2, 0, 0]}>
        <cylinderGeometry args={[0.1, 0.1, 0.4]} />
        <meshStandardMaterial color="#555" metalness={1} roughness={0.2} />
      </mesh>

      {/* Spoiler */}
      <group position={[0, 1.25, -2.1]}>
        <mesh position={[0, 0.3, 0]} castShadow>
          <boxGeometry args={[2.2, 0.1, 0.6]} />
          <meshStandardMaterial color={color} metalness={0.7} roughness={0.3} />
        </mesh>
        <mesh position={[0.8, 0, 0]}>
          <boxGeometry args={[0.1, 0.6, 0.4]} />
          <meshStandardMaterial color="#111" />
        </mesh>
        <mesh position={[-0.8, 0, 0]}>
          <boxGeometry args={[0.1, 0.6, 0.4]} />
          <meshStandardMaterial color="#111" />
        </mesh>
        {/* Spoiler Winglets */}
        <mesh position={[1.15, 0.4, 0]} rotation={[0, 0, Math.PI/4]}>
             <boxGeometry args={[0.1, 0.4, 0.6]} />
             <meshStandardMaterial color={color} />
        </mesh>
        <mesh position={[-1.15, 0.4, 0]} rotation={[0, 0, -Math.PI/4]}>
             <boxGeometry args={[0.1, 0.4, 0.6]} />
             <meshStandardMaterial color={color} />
        </mesh>
      </group>

      {/* Wheels with Rims & Brake Calipers */}
      {[
        [1.1, 0.4, 1.3],
        [-1.1, 0.4, 1.3],
        [1.1, 0.4, -1.3],
        [-1.1, 0.4, -1.3]
      ].map((pos, i) => (
        <group key={i} position={pos as [number, number, number]} rotation={[0, 0, Math.PI/2]}>
          <mesh castShadow>
            <cylinderGeometry args={[0.45, 0.45, 0.4, 24]} />
            <meshStandardMaterial color="#111" roughness={0.8} />
          </mesh>
          <mesh position={[0, 0.21, 0]}>
            <cylinderGeometry args={[0.25, 0.25, 0.05, 12]} />
            <meshStandardMaterial color="#ccc" metalness={0.8} roughness={0.2} />
          </mesh>
          {/* Brake Caliper */}
          <mesh position={[0.2, -0.1, 0]} rotation={[0, 0, 0]}>
              <boxGeometry args={[0.3, 0.2, 0.15]} />
              <meshStandardMaterial color="#ef4444" />
          </mesh>
        </group>
      ))}

      {/* Headlights */}
      <mesh position={[0.6, 0.7, 2.15]}>
        <boxGeometry args={[0.5, 0.25, 0.1]} />
        <meshStandardMaterial color="#ffffaa" emissive="#ffffaa" emissiveIntensity={5} />
      </mesh>
      <mesh position={[-0.6, 0.7, 2.15]}>
        <boxGeometry args={[0.5, 0.25, 0.1]} />
        <meshStandardMaterial color="#ffffaa" emissive="#ffffaa" emissiveIntensity={5} />
      </mesh>

      {/* Taillights */}
      <mesh position={[0.6, 0.8, -2.15]}>
        <boxGeometry args={[0.5, 0.2, 0.1]} />
        <meshStandardMaterial color="#ff0000" emissive="#ff0000" emissiveIntensity={3} />
      </mesh>
      <mesh position={[-0.6, 0.8, -2.15]}>
        <boxGeometry args={[0.5, 0.2, 0.1]} />
        <meshStandardMaterial color="#ff0000" emissive="#ff0000" emissiveIntensity={3} />
      </mesh>
      
      {/* License Plate */}
      <mesh position={[0, 0.4, -2.16]}>
          <planeGeometry args={[0.6, 0.2]} />
          <meshStandardMaterial color="#fff" />
      </mesh>
      <Text position={[0, 0.4, -2.17]} fontSize={0.1} color="black" rotation={[0, Math.PI, 0]}>
          RACE-01
      </Text>
      
      {/* Drift Smoke Particles */}
      {drifting && (
        <group>
          <mesh position={[1.2, 0.2, -1.5]}>
             <sphereGeometry args={[0.35, 8, 8]} />
             <meshBasicMaterial color="#ddd" transparent opacity={0.5} />
          </mesh>
          <mesh position={[-1.2, 0.2, -1.5]}>
             <sphereGeometry args={[0.35, 8, 8]} />
             <meshBasicMaterial color="#ddd" transparent opacity={0.5} />
          </mesh>
        </group>
      )}

      {isLocal && (
        <pointLight position={[0, 2, 4]} intensity={10} distance={25} color="white" />
      )}
    </group>
  );
};

const Cactus = ({ position, scale = 1 }: { position: [number, number, number], scale?: number }) => {
  return (
    <group position={position} scale={scale}>
      <mesh position={[0, 2, 0]} castShadow>
        <cylinderGeometry args={[0.5, 0.5, 4]} />
        <meshStandardMaterial color="#2d6a4f" roughness={0.8} />
      </mesh>
      <mesh position={[1, 3, 0]} rotation={[0, 0, -Math.PI/4]}>
        <cylinderGeometry args={[0.3, 0.3, 2]} />
        <meshStandardMaterial color="#2d6a4f" roughness={0.8} />
      </mesh>
      <mesh position={[1.5, 4, 0]}>
        <cylinderGeometry args={[0.3, 0.3, 1.5]} />
        <meshStandardMaterial color="#2d6a4f" roughness={0.8} />
      </mesh>
      <mesh position={[-1, 2, 0]} rotation={[0, 0, Math.PI/4]}>
        <cylinderGeometry args={[0.3, 0.3, 2]} />
        <meshStandardMaterial color="#2d6a4f" roughness={0.8} />
      </mesh>
      <mesh position={[-1.5, 3, 0]}>
        <cylinderGeometry args={[0.3, 0.3, 1.5]} />
        <meshStandardMaterial color="#2d6a4f" roughness={0.8} />
      </mesh>
    </group>
  );
};

const Tree = ({ position, scale = 1, color = '#166534' }: { position: [number, number, number], scale?: number, color?: string }) => {
  return (
    <group position={position} scale={scale}>
      {/* Trunk */}
      <mesh position={[0, 3, 0]} castShadow>
        <cylinderGeometry args={[0.6, 0.8, 6, 8]} />
        <meshStandardMaterial color="#4d2926" />
      </mesh>
      {/* Leaves */}
      <mesh position={[0, 9, 0]} castShadow>
        <coneGeometry args={[4, 10, 8]} />
        <meshStandardMaterial color={color} />
      </mesh>
      <mesh position={[0, 13, 0]} castShadow>
        <coneGeometry args={[3, 7, 8]} />
        <meshStandardMaterial color={color} />
      </mesh>
    </group>
  );
};

const Rock = ({ position, scale = 1, color = '#666' }: { position: [number, number, number], scale?: number, color?: string }) => {
  return (
    <mesh position={position} scale={scale} castShadow receiveShadow>
      <dodecahedronGeometry args={[1.5, 0]} />
      <meshStandardMaterial color={color} roughness={0.9} />
    </mesh>
  );
};

const CharacterModel = ({ color }: { color: string }) => {
  return (
    <group scale={[1, 1, 1]}>
      <mesh position={[0, 1, 0]} castShadow receiveShadow>
        <capsuleGeometry args={[0.4, 0.8, 4, 8]} />
        <meshStandardMaterial color={color} />
      </mesh>
      <mesh position={[0, 2.2, 0]} castShadow receiveShadow>
        <sphereGeometry args={[0.4, 16, 16]} />
        <meshStandardMaterial color="#ffccaa" />
      </mesh>
      <mesh position={[0, 2.2, 0.4]}>
        <boxGeometry args={[0.2, 0.1, 0.4]} />
        <meshStandardMaterial color="black" />
      </mesh>
    </group>
  );
};

// Procedural Texture Generation
const generateTerrainTextures = () => {
  const size = 512; // Reduced from 1024
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  
  // Diffuse / Noise Map
  const imgData = ctx.createImageData(size, size);
  const data = imgData.data;
  
  for (let i = 0; i < size * size; i++) {
    const x = i % size;
    const y = Math.floor(i / size);
    
    // Multi-layered noise for dirt/grass detail
    const n1 = noise2D(x * 0.05, y * 0.05);
    const n2 = noise2D(x * 0.2, y * 0.2) * 0.5;
    const n3 = Math.random() * 0.2; // High freq grain
    
    const val = 0.5 + (n1 + n2 + n3) * 0.3;
    const c = Math.floor(Math.max(0, Math.min(255, val * 255)));
    
    data[i * 4] = c;
    data[i * 4 + 1] = c;
    data[i * 4 + 2] = c;
    data[i * 4 + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
  
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(40, 40); // High repeat for detail
  
  // Normal Map Generation (Sobel filter approximation)
  const normalCanvas = document.createElement('canvas');
  normalCanvas.width = size;
  normalCanvas.height = size;
  const normalCtx = normalCanvas.getContext('2d')!;
  const normalImgData = normalCtx.createImageData(size, size);
  const normalData = normalImgData.data;
  
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      
      // Get neighbors
      const x1 = (x - 1 + size) % size;
      const x2 = (x + 1) % size;
      const y1 = (y - 1 + size) % size;
      const y2 = (y + 1) % size;
      
      const hL = data[(y * size + x1) * 4] / 255;
      const hR = data[(y * size + x2) * 4] / 255;
      const hU = data[(y1 * size + x) * 4] / 255;
      const hD = data[(y2 * size + x) * 4] / 255;
      
      // Sobel gradients
      const dx = (hR - hL) * 2.0; // Strength
      const dy = (hD - hU) * 2.0;
      
      const nz = 1.0;
      const len = Math.sqrt(dx*dx + dy*dy + nz*nz);
      
      // Pack into RGB [0, 255]
      normalData[i] = ((dx/len) * 0.5 + 0.5) * 255;
      normalData[i+1] = ((dy/len) * 0.5 + 0.5) * 255;
      normalData[i+2] = (nz/len) * 255;
      normalData[i+3] = 255;
    }
  }
  normalCtx.putImageData(normalImgData, 0, 0);
  
  const normalMap = new THREE.CanvasTexture(normalCanvas);
  normalMap.wrapS = THREE.RepeatWrapping;
  normalMap.wrapT = THREE.RepeatWrapping;
  normalMap.repeat.set(40, 40);
  
  return { map: texture, normalMap: normalMap };
};

const GrassMesh = React.memo(() => {
  const geomRef = useRef<THREE.PlaneGeometry>(null);
  const textures = useMemo(() => generateTerrainTextures(), []);
  
  useEffect(() => {
    if (geomRef.current) {
      const pos = geomRef.current.attributes.position;
      const colors = new Float32Array(pos.count * 3);
      const colorObj = new THREE.Color();
      
      for (let i = 0; i < pos.count; i++) {
        const localX = pos.getX(i);
        const localY = pos.getY(i);
        // Adjust for mesh position to get world coordinates
        const worldX = localX + TRACK_WIDTH/2;
        const worldY = localY + TRACK_HEIGHT/2;
        
        const h = getTerrainHeight(worldX, worldY);
        pos.setZ(i, h);
        
        // Biome Coloring
        // Desert (South East)
        const isDesert = worldX > 600 && worldY < 400;
        // Mountain (West)
        const isMountain = worldX < 400;
        // Canyon (South)
        const isCanyon = worldY < 200 && worldX > 400 && worldX < 900;
        
        if (isCanyon && h < 5) {
             // Canyon floor / River bed
             colorObj.set('#78350f'); // Dark earth
        } else if (isDesert) {
             // Sand
             colorObj.set('#d4b483');
        } else if (isMountain) {
             if (h > 60) colorObj.set('#f8fafc'); // Snow
             else if (h > 30) colorObj.set('#64748b'); // Rock
             else colorObj.set('#57534e'); // Base rock
        } else {
             // Grassland
             if (h < 5) colorObj.set('#4ade80'); // Lush grass
             else colorObj.set('#166534'); // Darker grass
        }
        
        // Noise variation
        const noise = noise2D(worldX * 0.05, worldY * 0.05) * 0.1;
        colorObj.offsetHSL(0, 0, noise);
        
        // Track proximity (Dirt/Gravel near track)
        const p = {x: worldX, y: worldY};
        let minDist = Infinity;
        for (const seg of TRACK_SEGMENTS) {
            const d = distToSegment(p, seg.start, seg.end);
            if (d < minDist) minDist = d;
        }
        if (minDist < TRACK_RADIUS + 15 && minDist > TRACK_RADIUS) {
            colorObj.lerp(new THREE.Color('#a8a29e'), 0.7); // Gravel edge
        }

        colors[i * 3] = colorObj.r;
        colors[i * 3 + 1] = colorObj.g;
        colors[i * 3 + 2] = colorObj.b;
      }
      
      geomRef.current.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geomRef.current.computeVertexNormals();
      pos.needsUpdate = true;
    }
  }, []);

  return (
    <mesh position={[TRACK_WIDTH/2, TRACK_HEIGHT/2, -0.1]} receiveShadow castShadow>
      <planeGeometry ref={geomRef} args={[3000, 3000, 128, 128]} />
      <meshStandardMaterial 
        vertexColors 
        map={textures.map}
        normalMap={textures.normalMap}
        roughness={0.9} 
        metalness={0.1}
        normalScale={new THREE.Vector2(1.5, 1.5)}
      />
    </mesh>
  );
});

const TrackMesh = React.memo(() => {
  const segments = useMemo(() => {
    return TRACK_SEGMENTS.map((seg, i) => {
      const dx = seg.end.x - seg.start.x;
      const dy = seg.end.y - seg.start.y;
      const length = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.atan2(dy, dx);
      const centerX = (seg.start.x + seg.end.x) / 2;
      const centerY = (seg.start.y + seg.end.y) / 2;
      return { length, angle, centerX, centerY, id: i };
    });
  }, []);

  const corners = useMemo(() => {
    return TRACK_SEGMENTS.map((seg) => seg.start);
  }, []);

  return (
    <group rotation={[-Math.PI / 2, 0, 0]} scale={[1, -1, 1]}>
      {/* Grass/Off-track */}
      <GrassMesh />
      
      {/* Track Segments */}
      {segments.map((seg) => (
        <group key={seg.id} position={[seg.centerX, seg.centerY, 0.1]} rotation={[0, 0, seg.angle]}>
            <mesh receiveShadow>
                <planeGeometry args={[seg.length, TRACK_RADIUS * 2]} />
                <meshStandardMaterial color="#333" roughness={0.8} metalness={0.1} />
            </mesh>
            {/* Road Markings (Center Line) */}
            <mesh position={[0, 0, 0.1]}>
                <planeGeometry args={[seg.length, 2]} />
                <meshBasicMaterial color="#fbbf24" />
            </mesh>
            {/* Side Lines */}
            <mesh position={[0, TRACK_RADIUS - 2, 0.1]}>
                <planeGeometry args={[seg.length, 1]} />
                <meshBasicMaterial color="#fff" />
            </mesh>
            <mesh position={[0, -TRACK_RADIUS + 2, 0.1]}>
                <planeGeometry args={[seg.length, 1]} />
                <meshBasicMaterial color="#fff" />
            </mesh>
        </group>
      ))}

      {/* Smooth Corners */}
      {corners.map((pos, i) => (
        <mesh key={i} position={[pos.x, pos.y, 0.1]} receiveShadow>
          <circleGeometry args={[TRACK_RADIUS, 32]} />
          <meshStandardMaterial color="#333" roughness={0.8} metalness={0.1} />
        </mesh>
      ))}
      
      {/* Start Line */}
      <mesh position={[625, 750, 0.12]} rotation={[0, 0, 0]}>
        <planeGeometry args={[10, TRACK_RADIUS * 2]} />
        <meshStandardMaterial color="white" emissive="white" emissiveIntensity={0.5} />
      </mesh>
    </group>
  );
});

const CompassArrow = ({ localPlayerRef }: { localPlayerRef: React.MutableRefObject<any> }) => {
  const arrowRef = useRef<THREE.Group>(null);
  
  useFrame(() => {
    if (!arrowRef.current || !localPlayerRef.current) return;
    const p = localPlayerRef.current;
    const targetZone = DELIVERY_ZONES[p.targetZoneIndex];
    if (targetZone) {
      const dx = targetZone.x - p.x;
      const dy = targetZone.y - p.y;
      const angleToTarget = Math.atan2(dy, dx);
      
      // Position above player
      const h = getTerrainHeight(p.x, p.y);
      arrowRef.current.position.set(p.x, h + 15, p.y);
      // Rotate to point at target (Y axis rotation in 3D)
      arrowRef.current.rotation.y = -angleToTarget + Math.PI / 2;
    }
  });

  return (
    <group ref={arrowRef}>
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <coneGeometry args={[3, 10, 8]} />
        <meshBasicMaterial color="#00ff00" transparent opacity={0.8} />
      </mesh>
    </group>
  );
};

const AnimatedFlag = ({ position, color }: { position: [number, number, number], color: string }) => {
  const flagRef = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    if (flagRef.current) {
      const t = state.clock.elapsedTime;
      flagRef.current.rotation.y = Math.sin(t * 3) * 0.3;
      flagRef.current.rotation.z = Math.cos(t * 2) * 0.1;
    }
  });
  return (
    <group position={position}>
      <mesh position={[0, 10, 0]}>
        <cylinderGeometry args={[0.3, 0.3, 20]} />
        <meshStandardMaterial color="#888" metalness={0.8} roughness={0.2} />
      </mesh>
      <mesh ref={flagRef} position={[3, 18, 0]}>
        <planeGeometry args={[6, 4, 10, 10]} />
        <meshStandardMaterial color={color} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
};

const SpinningTire = ({ position, speed = 0.05 }: { position: [number, number, number], speed?: number }) => {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(() => {
    if (ref.current) ref.current.rotation.z += speed;
  });
  return (
    <mesh ref={ref} position={position} rotation={[0, Math.PI/2, 0]} castShadow>
      <torusGeometry args={[2, 0.8, 16, 32]} />
      <meshStandardMaterial color="#111" roughness={0.9} />
    </mesh>
  );
};

const Rain = () => {
  const count = 3000;
  const mesh = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const particles = useMemo(() => {
    return new Array(count).fill(0).map(() => ({
      x: Math.random() * 2000 - 500,
      y: Math.random() * 200 + 50,
      z: Math.random() * 2000 - 500,
      speed: Math.random() * 3 + 3
    }));
  }, [count]);

  useFrame(() => {
    if (!mesh.current) return;
    particles.forEach((particle, i) => {
      particle.y -= particle.speed;
      if (particle.y < 0) particle.y = 200;
      dummy.position.set(particle.x, particle.y, particle.z);
      dummy.scale.set(0.05, 1.5, 0.05);
      dummy.updateMatrix();
      mesh.current!.setMatrixAt(i, dummy.matrix);
    });
    mesh.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, count]}>
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial color="#88ccff" transparent opacity={0.3} />
    </instancedMesh>
  );
};

const WeatherSystem = ({ weather }: { weather: 'clear' | 'rain' | 'fog' }) => {
  const { scene } = useThree();
  
  useEffect(() => {
    if (!scene.fog) {
      scene.fog = new THREE.Fog('#0f172a', 100, 900);
    }
  }, [scene]);

  useFrame(() => {
    const targetNear = weather === 'fog' ? 20 : 100;
    const targetFar = weather === 'fog' ? 200 : (weather === 'rain' ? 400 : 900);
    const targetColor = new THREE.Color(
        weather === 'fog' ? '#94a3b8' : 
        (weather === 'rain' ? '#334155' : '#0f172a')
    );
    
    if (scene.fog instanceof THREE.Fog) {
      scene.fog.near = THREE.MathUtils.lerp(scene.fog.near, targetNear, 0.02);
      scene.fog.far = THREE.MathUtils.lerp(scene.fog.far, targetFar, 0.02);
      scene.fog.color.lerp(targetColor, 0.02);
    }
    
    if (scene.background instanceof THREE.Color) {
        scene.background.lerp(targetColor, 0.02);
    } else {
        scene.background = targetColor.clone();
    }
  });

  const skyProps = useMemo(() => {
    switch (weather) {
      case 'rain':
        return { 
          turbidity: 10, 
          rayleigh: 0.5, 
          mieCoefficient: 0.005, 
          mieDirectionalG: 0.7, 
          sunPosition: [0, 0, -100] as [number, number, number] 
        };
      case 'fog':
        return { 
          turbidity: 20, 
          rayleigh: 0.1, 
          mieCoefficient: 0.01, 
          mieDirectionalG: 0.9, 
          sunPosition: [0, 10, -100] as [number, number, number] 
        };
      case 'clear':
      default:
        return { 
          turbidity: 0.5, 
          rayleigh: 0.5, 
          mieCoefficient: 0.005, 
          mieDirectionalG: 0.7, 
          sunPosition: [100, 20, 100] as [number, number, number] 
        };
    }
  }, [weather]);

  return (
    <>
      <Sky {...skyProps} />
      {weather === 'rain' ? <Rain /> : null}
    </>
  );
};

const House = ({ position, rotation = 0, scale = 1, color = '#e2e8f0' }: { position: [number, number, number], rotation?: number, scale?: number, color?: string }) => {
  return (
    <group position={position} rotation={[0, rotation, 0]} scale={scale}>
      {/* Base */}
      <mesh position={[0, 5, 0]} castShadow receiveShadow>
        <boxGeometry args={[10, 10, 10]} />
        <meshStandardMaterial color={color} />
      </mesh>
      {/* Roof */}
      <mesh position={[0, 12.5, 0]} rotation={[0, Math.PI / 4, 0]} castShadow>
        <coneGeometry args={[9, 5, 4]} />
        <meshStandardMaterial color="#475569" />
      </mesh>
      {/* Door */}
      <mesh position={[0, 2.5, 5.1]}>
        <planeGeometry args={[2.5, 5]} />
        <meshStandardMaterial color="#334155" />
      </mesh>
      {/* Window */}
      <mesh position={[2.5, 6, 5.1]}>
        <planeGeometry args={[2, 2]} />
        <meshStandardMaterial color="#94a3b8" emissive="#94a3b8" emissiveIntensity={0.2} />
      </mesh>
    </group>
  );
};

const Building = ({ position, rotation = 0, scale = 1, height = 30, color = '#64748b' }: { position: [number, number, number], rotation?: number, scale?: number, height?: number, color?: string }) => {
  return (
    <group position={position} rotation={[0, rotation, 0]} scale={scale}>
      <mesh position={[0, height / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[15, height, 15]} />
        <meshStandardMaterial color={color} />
      </mesh>
      {/* Windows */}
      {Array.from({ length: Math.floor(height / 6) }).map((_, i) => (
        <group key={i} position={[0, i * 6 + 4, 0]}>
           <mesh position={[0, 0, 7.6]}>
             <planeGeometry args={[10, 3]} />
             <meshStandardMaterial color="#cbd5e1" emissive="#cbd5e1" emissiveIntensity={0.1} />
           </mesh>
           <mesh position={[0, 0, -7.6]} rotation={[0, Math.PI, 0]}>
             <planeGeometry args={[10, 3]} />
             <meshStandardMaterial color="#cbd5e1" emissive="#cbd5e1" emissiveIntensity={0.1} />
           </mesh>
           <mesh position={[7.6, 0, 0]} rotation={[0, Math.PI/2, 0]}>
             <planeGeometry args={[10, 3]} />
             <meshStandardMaterial color="#cbd5e1" emissive="#cbd5e1" emissiveIntensity={0.1} />
           </mesh>
           <mesh position={[-7.6, 0, 0]} rotation={[0, -Math.PI/2, 0]}>
             <planeGeometry args={[10, 3]} />
             <meshStandardMaterial color="#cbd5e1" emissive="#cbd5e1" emissiveIntensity={0.1} />
           </mesh>
        </group>
      ))}
    </group>
  );
};

const StreetLamp = ({ position, rotation = 0 }: { position: [number, number, number], rotation?: number }) => {
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      <mesh position={[0, 6, 0]} castShadow>
        <cylinderGeometry args={[0.3, 0.3, 12]} />
        <meshStandardMaterial color="#1e293b" />
      </mesh>
      <mesh position={[1.5, 11.5, 0]} rotation={[0, 0, -Math.PI/4]}>
        <cylinderGeometry args={[0.2, 0.2, 4]} />
        <meshStandardMaterial color="#1e293b" />
      </mesh>
      <mesh position={[3, 13, 0]}>
         <boxGeometry args={[2, 0.5, 1]} />
         <meshStandardMaterial color="#1e293b" />
      </mesh>
      <mesh position={[3, 12.7, 0]} rotation={[Math.PI/2, 0, 0]}>
        <planeGeometry args={[1.5, 0.8]} />
        <meshBasicMaterial color="#fbbf24" />
      </mesh>
      <pointLight position={[3, 12, 0]} color="#fbbf24" intensity={2} distance={30} decay={2} />
    </group>
  );
};

const PickupModel = ({ color }: { color: string }) => {
  const ref = useRef<THREE.Group>(null);
  useFrame((state) => {
    if (ref.current) {
      ref.current.rotation.y += 0.02;
      ref.current.position.y = 2 + Math.sin(state.clock.elapsedTime * 2) * 0.5;
    }
  });
  return (
    <group ref={ref}>
      <mesh castShadow>
        <boxGeometry args={[3, 3, 3]} />
        <meshStandardMaterial color={color} metalness={0.5} roughness={0.2} />
      </mesh>
      <mesh position={[0, 0, 0]}>
        <boxGeometry args={[3.2, 0.2, 3.2]} />
        <meshStandardMaterial color="#333" />
      </mesh>
      <mesh position={[0, 0, 0]} rotation={[0, 0, Math.PI/2]}>
        <boxGeometry args={[3.2, 0.2, 3.2]} />
        <meshStandardMaterial color="#333" />
      </mesh>
      <pointLight color={color} intensity={2} distance={10} />
    </group>
  );
};

const DeliveryModel = ({ color }: { color: string }) => {
  const ref = useRef<THREE.Group>(null);
  useFrame((state) => {
    if (ref.current) {
      ref.current.rotation.y -= 0.01;
    }
  });
  return (
    <group ref={ref}>
      {/* Platform */}
      <mesh position={[0, 0.2, 0]} receiveShadow>
        <cylinderGeometry args={[8, 9, 1, 8]} />
        <meshStandardMaterial color="#333" metalness={0.8} roughness={0.2} />
      </mesh>
      <mesh position={[0, 0.8, 0]} receiveShadow>
        <cylinderGeometry args={[6, 6, 0.2, 8]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.5} />
      </mesh>
      {/* Holographic pillars */}
      {[0, Math.PI/2, Math.PI, -Math.PI/2].map((angle, i) => (
        <mesh key={i} position={[Math.sin(angle)*6, 2, Math.cos(angle)*6]}>
          <boxGeometry args={[0.5, 4, 0.5]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={2} />
        </mesh>
      ))}
      <pointLight position={[0, 2, 0]} color={color} intensity={3} distance={15} />
    </group>
  );
};

const PowerUpModel = ({ type }: { type: PowerUpType }) => {
  const ref = useRef<THREE.Group>(null);
  useFrame((state) => {
    if (ref.current) {
      ref.current.rotation.y += 0.03;
      ref.current.position.y = 2 + Math.sin(state.clock.elapsedTime * 3) * 0.5;
    }
  });

  const color = type === 'speed' ? '#ef4444' : type === 'shield' ? '#3b82f6' : '#eab308';
  const icon = type === 'speed' ? '⚡' : type === 'shield' ? '🛡️' : 'x2';

  return (
    <group ref={ref}>
      <mesh castShadow>
        <octahedronGeometry args={[2, 0]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.5} metalness={0.8} roughness={0.2} />
      </mesh>
      <Text position={[0, 3, 0]} fontSize={2} color="white" anchorX="center" anchorY="middle" outlineWidth={0.1} outlineColor="black">
        {icon}
      </Text>
      <pointLight color={color} intensity={2} distance={10} />
      {/* Ground glow */}
      <mesh position={[0, -2, 0]} rotation={[-Math.PI/2, 0, 0]}>
        <ringGeometry args={[2, 3, 32]} />
        <meshBasicMaterial color={color} transparent opacity={0.3} />
      </mesh>
    </group>
  );
};

const Billboard = ({ position, rotation = 0, scale = 1 }: { position: [number, number, number], rotation?: number, scale?: number }) => {
  return (
    <group position={position} rotation={[0, rotation, 0]} scale={scale}>
      <mesh position={[-2, 2.5, 0]} castShadow>
        <cylinderGeometry args={[0.1, 0.1, 5]} />
        <meshStandardMaterial color="#333" />
      </mesh>
      <mesh position={[2, 2.5, 0]} castShadow>
        <cylinderGeometry args={[0.1, 0.1, 5]} />
        <meshStandardMaterial color="#333" />
      </mesh>
      <mesh position={[0, 5, 0]} castShadow>
        <boxGeometry args={[6, 3, 0.2]} />
        <meshStandardMaterial color="#fff" />
      </mesh>
      <mesh position={[0, 5, 0.11]}>
        <planeGeometry args={[5.6, 2.6]} />
        <meshStandardMaterial color="#fbbf24" emissive="#fbbf24" emissiveIntensity={0.2} />
      </mesh>
      <Text position={[0, 5, 0.12]} fontSize={0.8} color="black" anchorX="center" anchorY="middle" font="/fonts/Inter-Bold.woff">
        RACE DAY
      </Text>
    </group>
  );
};

const Guardrail = ({ position, rotation = 0, length = 10 }: { position: [number, number, number], rotation?: number, length?: number }) => {
  const postCount = Math.floor(length / 10) + 1;
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      <mesh position={[length/2, 2, 0]} castShadow>
        <boxGeometry args={[length, 0.5, 0.2]} />
        <meshStandardMaterial color="#ccc" metalness={0.8} roughness={0.2} />
      </mesh>
      {Array.from({ length: postCount }).map((_, i) => (
        <mesh key={i} position={[i * 10, 1, 0]} castShadow>
          <cylinderGeometry args={[0.1, 0.1, 2]} />
          <meshStandardMaterial color="#888" />
        </mesh>
      ))}
    </group>
  );
};

const TireStack = ({ position, scale = 1 }: { position: [number, number, number], scale?: number }) => {
  return (
    <group position={position} scale={scale}>
      {[0, 0.4, 0.8].map((y, i) => (
        <mesh key={i} position={[0, y + 0.2, 0]} castShadow>
          <torusGeometry args={[0.4, 0.15, 8, 16]} />
          <meshStandardMaterial color={i % 2 === 0 ? "#ef4444" : "#fff"} roughness={0.8} />
        </mesh>
      ))}
    </group>
  );
};

const Cone = ({ position }: { position: [number, number, number] }) => {
  return (
    <group position={position}>
      <mesh position={[0, 0.5, 0]} castShadow>
        <coneGeometry args={[0.3, 1, 16]} />
        <meshStandardMaterial color="#f97316" />
      </mesh>
      <mesh position={[0, 0.05, 0]}>
        <boxGeometry args={[0.7, 0.1, 0.7]} />
        <meshStandardMaterial color="#111" />
      </mesh>
    </group>
  );
};

// Interactive Props Types
type InteractiveProp = {
  id: number;
  type: 'barrier' | 'ramp' | 'crate';
  x: number;
  y: number;
  rotation: number;
  active: boolean;
  health: number;
};

const BarrierModel = ({ active }: { active: boolean }) => {
  if (!active) return null;
  return (
    <group>
      <mesh position={[0, 1, 0]} castShadow>
        <boxGeometry args={[4, 2, 0.5]} />
        <meshStandardMaterial color="#ef4444" />
      </mesh>
      <mesh position={[0, 1, 0]}>
        <boxGeometry args={[4.1, 1.8, 0.6]} />
        <meshStandardMaterial color="#fee2e2" wireframe />
      </mesh>
    </group>
  );
};

const RampModel = () => {
  return (
    <group>
      <mesh position={[0, 1, 0]} rotation={[Math.PI/8, 0, 0]} castShadow receiveShadow>
        <boxGeometry args={[4, 0.2, 6]} />
        <meshStandardMaterial color="#3b82f6" />
      </mesh>
      <mesh position={[0, 0.5, 2.5]}>
        <boxGeometry args={[4, 1, 0.2]} />
        <meshStandardMaterial color="#1d4ed8" />
      </mesh>
    </group>
  );
};

const CrateModel = ({ active }: { active: boolean }) => {
  if (!active) return null;
  return (
    <mesh position={[0, 1, 0]} castShadow receiveShadow>
      <boxGeometry args={[2, 2, 2]} />
      <meshStandardMaterial color="#d97706" />
    </mesh>
  );
};

const InstancedTrees = React.memo(({ data }: { data: any[] }) => {
  const trunkRef = useRef<THREE.InstancedMesh>(null);
  const leaves1Ref = useRef<THREE.InstancedMesh>(null);
  const leaves2Ref = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useEffect(() => {
    if (!trunkRef.current || !leaves1Ref.current || !leaves2Ref.current) return;
    
    data.forEach((item, i) => {
      const { pos, scale, color } = item;
      
      // Trunk
      dummy.position.set(pos[0], pos[1] + 3 * scale, pos[2]);
      dummy.scale.set(scale, scale, scale);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      trunkRef.current!.setMatrixAt(i, dummy.matrix);
      trunkRef.current!.setColorAt(i, new THREE.Color('#4d2926'));
      
      // Leaves 1
      dummy.position.set(pos[0], pos[1] + 9 * scale, pos[2]);
      dummy.updateMatrix();
      leaves1Ref.current!.setMatrixAt(i, dummy.matrix);
      leaves1Ref.current!.setColorAt(i, new THREE.Color(color));
      
      // Leaves 2
      dummy.position.set(pos[0], pos[1] + 13 * scale, pos[2]);
      dummy.updateMatrix();
      leaves2Ref.current!.setMatrixAt(i, dummy.matrix);
      leaves2Ref.current!.setColorAt(i, new THREE.Color(color));
    });
    
    trunkRef.current.instanceMatrix.needsUpdate = true;
    leaves1Ref.current.instanceMatrix.needsUpdate = true;
    leaves2Ref.current.instanceMatrix.needsUpdate = true;
    
    if (trunkRef.current.instanceColor) trunkRef.current.instanceColor.needsUpdate = true;
    if (leaves1Ref.current.instanceColor) leaves1Ref.current.instanceColor.needsUpdate = true;
    if (leaves2Ref.current.instanceColor) leaves2Ref.current.instanceColor.needsUpdate = true;

  }, [data, dummy]);

  return (
    <group>
      <instancedMesh ref={trunkRef} args={[undefined, undefined, data.length]} castShadow receiveShadow>
        <cylinderGeometry args={[0.6, 0.8, 6, 8]} />
        <meshStandardMaterial color="#4d2926" />
      </instancedMesh>
      <instancedMesh ref={leaves1Ref} args={[undefined, undefined, data.length]} castShadow receiveShadow>
        <coneGeometry args={[4, 10, 8]} />
        <meshStandardMaterial />
      </instancedMesh>
      <instancedMesh ref={leaves2Ref} args={[undefined, undefined, data.length]} castShadow receiveShadow>
        <coneGeometry args={[3, 7, 8]} />
        <meshStandardMaterial />
      </instancedMesh>
    </group>
  );
});

const InstancedRocks = React.memo(({ data }: { data: any[] }) => {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useEffect(() => {
    if (!meshRef.current) return;
    
    data.forEach((item, i) => {
      const { pos, scale, color, rotation } = item;
      dummy.position.set(pos[0], pos[1], pos[2]);
      dummy.scale.set(scale, scale, scale);
      dummy.rotation.set(0, rotation, 0);
      dummy.updateMatrix();
      meshRef.current!.setMatrixAt(i, dummy.matrix);
      meshRef.current!.setColorAt(i, new THREE.Color(color));
    });
    
    meshRef.current.instanceMatrix.needsUpdate = true;
    if (meshRef.current.instanceColor) meshRef.current.instanceColor.needsUpdate = true;

  }, [data, dummy]);

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, data.length]} castShadow receiveShadow>
      <dodecahedronGeometry args={[1.5, 0]} />
      <meshStandardMaterial roughness={0.9} />
    </instancedMesh>
  );
});

const GameScene = ({ 
  localPlayerRef, 
  players, 
  myId,
  showCompass,
  freeCam,
  powerUps,
  props
}: { 
  localPlayerRef: React.MutableRefObject<any>, 
  players: Record<string, Player>, 
  myId: string | null,
  showCompass: boolean,
  freeCam: boolean,
  powerUps: PowerUp[],
  props: InteractiveProp[]
}) => {
  const { camera } = useThree();
  const carRef = useRef<THREE.Group>(null);
  const charRef = useRef<THREE.Group>(null);

  const decorations = DECORATIONS;
  const trees = useMemo(() => decorations.filter(d => d.type === 'tree'), [decorations]);
  const rocks = useMemo(() => decorations.filter(d => d.type === 'rock'), [decorations]);
  const otherDecorations = useMemo(() => decorations.filter(d => d.type !== 'tree' && d.type !== 'rock'), [decorations]);
  
  useFrame((state, delta) => {
    if (localPlayerRef.current && carRef.current && !freeCam) {
      const p = localPlayerRef.current;
      
      if (p.isWalking) {
          const carH = getTerrainHeight(p.carX, p.carY);
          const charH = getTerrainHeight(p.x, p.y);
          
          carRef.current.position.set(p.carX, carH, p.carY);
          carRef.current.rotation.y = -p.carAngle + Math.PI/2;
          
          if (charRef.current) {
              charRef.current.visible = true;
              charRef.current.position.set(p.x, charH, p.y);
              charRef.current.rotation.y = -p.angle + Math.PI/2;
          }
          
          // Camera Follow
          const dist = 20;
          const height = charH + 15;
          const targetCamX = p.x - Math.cos(p.angle) * dist;
          const targetCamZ = p.y - Math.sin(p.angle) * dist;
          camera.position.lerp(new THREE.Vector3(targetCamX, height, targetCamZ), 0.1);
          camera.lookAt(p.x, charH, p.y);
      } else {
          const carH = getTerrainHeight(p.x, p.y);
          // Apply suspension offset to car visual position
          carRef.current.position.set(p.x, (p.z ?? carH) + p.suspensionY, p.y);
          
          // Apply body roll and pitch
          carRef.current.rotation.order = 'YXZ';
          carRef.current.rotation.y = -p.angle + Math.PI/2;
          
          // Tilt car based on terrain/air + physics pitch/roll
          if (p.z && p.z > (getTerrainHeight(p.x, p.y) + 1)) {
              // In air - slight nose dive or stabilize
              carRef.current.rotation.x = THREE.MathUtils.lerp(carRef.current.rotation.x, -0.1 + p.pitch, 0.05);
              carRef.current.rotation.z = THREE.MathUtils.lerp(carRef.current.rotation.z, p.roll, 0.05);
          } else {
              // On ground - align with terrain normal (simplified) + physics pitch/roll
              carRef.current.rotation.x = p.pitch;
              carRef.current.rotation.z = p.roll;
          }
          
          if (charRef.current) {
              charRef.current.visible = false;
          }
          
          // Camera Follow
          const dist = 40;
          const height = (p.z ?? carH) + 20;
          let targetCamX = p.x - Math.cos(p.angle) * dist;
          let targetCamZ = p.y - Math.sin(p.angle) * dist;
          
          if (p.shake > 0) {
              targetCamX += (Math.random() - 0.5) * p.shake;
              targetCamZ += (Math.random() - 0.5) * p.shake;
              p.shake *= 0.9; // decay shake
          }
          
          camera.position.lerp(new THREE.Vector3(targetCamX, height, targetCamZ), 0.1);
          camera.lookAt(p.x, carH, p.y);
      }
    }
  });

  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight 
        position={[600, 400, 425]} 
        intensity={1.2} 
        castShadow 
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-700}
        shadow-camera-right={700}
        shadow-camera-top={700}
        shadow-camera-bottom={-700}
        shadow-camera-far={1500}
        shadow-bias={-0.001} // Reduce shadow artifacts
      />
      <Environment preset="warehouse" />
      
      <TrackMesh />
      
      {/* Start Line Decorations */}
      <AnimatedFlag position={[300, 0, 430]} color="#ef4444" />
      <AnimatedFlag position={[300, 0, 570]} color="#3b82f6" />
      <SpinningTire position={[280, 2.8, 430]} speed={0.1} />
      <SpinningTire position={[280, 2.8, 440]} speed={-0.08} />
      <SpinningTire position={[320, 2.8, 560]} speed={0.12} />
      <SpinningTire position={[320, 2.8, 570]} speed={-0.09} />
      
      {/* Decorative Elements */}
      <InstancedTrees data={trees} />
      <InstancedRocks data={rocks} />
      
      {otherDecorations.map((item, i) => {
        switch (item.type) {
            case 'house': return <House key={i} position={item.pos} scale={item.scale} rotation={item.rotation} color={item.color} />;
            case 'building': return <Building key={i} position={item.pos} scale={item.scale} rotation={item.rotation} color={item.color} />;
            case 'lamp': return <StreetLamp key={i} position={item.pos} rotation={item.rotation} />;
            case 'billboard': return <Billboard key={i} position={item.pos} rotation={item.rotation} scale={item.scale} />;
            case 'guardrail': return <Guardrail key={i} position={item.pos} rotation={item.rotation} length={item.length} />;
            case 'tire': return <TireStack key={i} position={item.pos} scale={item.scale} />;
            case 'cone': return <Cone key={i} position={item.pos} />;
            case 'cactus': return <Cactus key={i} position={item.pos} scale={item.scale} />;
            default: return null;
        }
      })}
      
      {/* Interactive Props */}
      {props.map(prop => (
          <group key={prop.id} position={[prop.x, getTerrainHeight(prop.x, prop.y), prop.y]} rotation={[0, prop.rotation, 0]}>
              {prop.type === 'barrier' && <BarrierModel active={prop.active} />}
              {prop.type === 'ramp' && <RampModel />}
              {prop.type === 'crate' && <CrateModel active={prop.active} />}
          </group>
      ))}

      {/* PowerUps */}
      {powerUps.map((pu) => (
        pu.active && (
            <group key={pu.id} position={[pu.x, getTerrainHeight(pu.x, pu.y), pu.y]}>
                <PowerUpModel type={pu.type} />
            </group>
        )
      ))}

      {/* Delivery Zones */}
      {DELIVERY_ZONES.map((zone, i) => {
        const myPlayer = players[myId || ''];
        const isTarget = myPlayer?.targetZoneIndex === i;
        const isPickup = isTarget && !myPlayer.hasGoods;
        const isDelivery = isTarget && myPlayer.hasGoods;

        return (
          <group key={i} position={[zone.x, 0.1, zone.y]}>
            <mesh rotation={[-Math.PI / 2, 0, 0]}>
              <circleGeometry args={[20, 32]} />
              <meshBasicMaterial color={zone.color} transparent opacity={isTarget ? 0.6 : 0.2} />
            </mesh>
            
            {isPickup && <PickupModel color={zone.color} />}
            {isDelivery && <DeliveryModel color={zone.color} />}
            
            {!isTarget && (
               <mesh position={[0, 0.5, 0]} rotation={[-Math.PI/2, 0, 0]}>
                 <ringGeometry args={[18, 20, 32]} />
                 <meshBasicMaterial color={zone.color} transparent opacity={0.3} />
               </mesh>
            )}

            <Text position={[0, 8, 0]} fontSize={4} color="white" anchorX="center" anchorY="middle" outlineWidth={0.2} outlineColor="black">
              {zone.name}
            </Text>
            {isPickup && (
                <Text position={[0, 5, 0]} fontSize={2} color="#fbbf24" anchorX="center" anchorY="middle" outlineWidth={0.1} outlineColor="black">
                  PICKUP
                </Text>
            )}
            {isDelivery && (
                <Text position={[0, 5, 0]} fontSize={2} color="#4ade80" anchorX="center" anchorY="middle" outlineWidth={0.1} outlineColor="black">
                  DELIVERY
                </Text>
            )}
          </group>
        );
      })}

      {/* Local Player */}
      <group ref={carRef}>
        <CarModel 
            color={players[myId || '']?.color || 'red'} 
            isLocal={!localPlayerRef.current?.isWalking} 
            drifting={localPlayerRef.current?.drifting && !localPlayerRef.current?.isWalking}
            powerUp={players[myId || '']?.activePowerUp}
        />
      </group>
      <group ref={charRef} visible={false}>
        <CharacterModel color={players[myId || '']?.color || 'red'} />
        <pointLight position={[0, 2, 0]} intensity={5} distance={15} color="white" />
      </group>

      {/* Compass */}
      {showCompass && <CompassArrow localPlayerRef={localPlayerRef} />}
      
      {/* Remote Players */}
      {Object.values(players).map(p => {
        if (p.id === myId) return null;
        const carX = p.isWalking ? p.carX : p.x;
        const carY = p.isWalking ? p.carY : p.y;
        const carH = getTerrainHeight(carX, carY);
        const charH = getTerrainHeight(p.x, p.y);
        
        return (
          <React.Fragment key={p.id}>
            <group position={[carX, carH, carY]} rotation={[0, -(p.isWalking ? p.carAngle : p.angle) + Math.PI/2, 0]}>
              <CarModel color={p.color} drifting={p.drifting && !p.isWalking} powerUp={p.activePowerUp} />
              {!p.isWalking && (
                <Text position={[0, 3, 0]} fontSize={2} color="white" anchorX="center" anchorY="middle">
                  {p.name}
                </Text>
              )}
            </group>
            {p.isWalking && (
              <group position={[p.x, charH, p.y]} rotation={[0, -p.angle + Math.PI/2, 0]}>
                <CharacterModel color={p.color} />
                <Text position={[0, 4, 0]} fontSize={2} color="white" anchorX="center" anchorY="middle">
                  {p.name}
                </Text>
              </group>
            )}
          </React.Fragment>
        );
      })}
    </>
  );
};

const Joystick = ({ onMove }: { onMove: (x: number, y: number) => void }) => {
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const joystickRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  const handleStart = (e: React.TouchEvent | React.MouseEvent) => {
    isDragging.current = true;
    handleMove(e);
  };

  const handleMove = (e: React.TouchEvent | React.MouseEvent) => {
    if (!isDragging.current || !joystickRef.current) return;
    
    const rect = joystickRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    
    let dx = clientX - centerX;
    let dy = clientY - centerY;
    
    const distance = Math.sqrt(dx * dx + dy * dy);
    const maxRadius = rect.width / 2;
    
    if (distance > maxRadius) {
      dx *= maxRadius / distance;
      dy *= maxRadius / distance;
    }
    
    setPosition({ x: dx, y: dy });
    onMove(dx / maxRadius, dy / maxRadius);
  };

  const handleEnd = () => {
    isDragging.current = false;
    setPosition({ x: 0, y: 0 });
    onMove(0, 0);
  };

  return (
    <div 
      ref={joystickRef}
      className="w-32 h-32 bg-white/10 backdrop-blur-md rounded-full border border-white/20 relative touch-none select-none"
      onTouchStart={handleStart}
      onTouchMove={handleMove}
      onTouchEnd={handleEnd}
      onMouseDown={handleStart}
      onMouseMove={handleMove}
      onMouseUp={handleEnd}
      onMouseLeave={handleEnd}
    >
      <div 
        className="w-12 h-12 bg-white/30 rounded-full absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none transition-transform duration-75"
        style={{ transform: `translate(${position.x - 24}px, ${position.y - 24}px)` }}
      />
    </div>
  );
};

export default function GameCanvas({ 
  initialPlayers, 
  onExitGame,
  settings,
  setSettings,
  isSinglePlayer = false
}: { 
  initialPlayers?: Record<string, Player>, 
  onExitGame: () => void,
  settings: { volume: number, showCompass: boolean, showLog: boolean, mobileControls: boolean, sensorSteering: boolean },
  setSettings?: React.Dispatch<React.SetStateAction<any>>,
  isSinglePlayer?: boolean
}) {
  const [weather, setWeather] = useState<'clear' | 'rain' | 'fog'>('clear');

  // Weather cycle
  useEffect(() => {
    const weathers: ('clear' | 'rain' | 'fog')[] = ['clear', 'rain', 'fog'];
    let i = 0;
    const interval = setInterval(() => {
      i = (i + 1) % weathers.length;
      setWeather(weathers[i]);
    }, 30000); // Change weather every 30 seconds
    return () => clearInterval(interval);
  }, []);

  const [powerUps, setPowerUps] = useState<PowerUp[]>([]);

  const [props, setProps] = useState<InteractiveProp[]>([
    { id: 1, type: 'barrier', x: 650, y: 700, rotation: 0, active: true, health: 100 },
    { id: 2, type: 'barrier', x: 600, y: 700, rotation: 0, active: true, health: 100 },
    { id: 3, type: 'ramp', x: 750, y: 750, rotation: Math.PI, active: true, health: 100 },
    { id: 4, type: 'crate', x: 800, y: 425, rotation: 0, active: true, health: 100 },
    { id: 5, type: 'crate', x: 810, y: 430, rotation: 0.5, active: true, health: 100 },
    { id: 6, type: 'barrier', x: 900, y: 150, rotation: Math.PI/2, active: true, health: 100 },
    { id: 7, type: 'ramp', x: 250, y: 100, rotation: 0, active: true, health: 100 },
  ]);

  // Initialize PowerUps
  useEffect(() => {
    const initialPowerUps: PowerUp[] = [];
    for (let i = 0; i < 10; i++) {
        const segment = TRACK_SEGMENTS[Math.floor(Math.random() * TRACK_SEGMENTS.length)];
        const t = Math.random();
        const x = segment.start.x + (segment.end.x - segment.start.x) * t;
        const y = segment.start.y + (segment.end.y - segment.start.y) * t;
        
        // Offset slightly from center
        const angle = segment.angle + Math.PI/2;
        const offset = (Math.random() - 0.5) * TRACK_WIDTH * 0.05;
        
        initialPowerUps.push({
            id: `pu-${i}`,
            type: Math.random() > 0.6 ? 'speed' : Math.random() > 0.5 ? 'shield' : 'multiplier',
            x: x + Math.cos(angle) * offset,
            y: y + Math.sin(angle) * offset,
            active: true
        });
    }
    setPowerUps(initialPowerUps);
  }, []);

  // Respawn PowerUps
  useEffect(() => {
    const interval = setInterval(() => {
        setPowerUps(prev => prev.map(pu => {
            if (!pu.active && Math.random() > 0.7) {
                return { ...pu, active: true };
            }
            return pu;
        }));
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // Sound Effects
  const { play: playEngine, stop: stopEngine, setVolume: setEngineVolume } = useSound('/sounds/engine_loop.mp3', { loop: true, volume: 0.3 * (settings.volume / 100) });
  const { play: playDrift, stop: stopDrift, setVolume: setDriftVolume } = useSound('/sounds/drift.mp3', { volume: 0.7 * (settings.volume / 100) });
  const { play: playNitro, setVolume: setNitroVolume } = useSound('/sounds/nitro.mp3', { volume: 0.8 * (settings.volume / 100) });
  const { play: playCollision, setVolume: setCollisionVolume } = useSound('/sounds/collision.mp3', { volume: 0.9 * (settings.volume / 100) });
  const { play: playPickup } = useSound('/sounds/pickup.mp3', { volume: 0.8 * (settings.volume / 100) });
  const { play: playDelivery } = useSound('/sounds/delivery.mp3', { volume: 0.9 * (settings.volume / 100) });
  const { play: playCheckpoint } = useSound('/sounds/checkpoint.mp3', { volume: 0.7 * (settings.volume / 100) });
  const { play: playLapComplete } = useSound('/sounds/lap_complete.mp3', { volume: 1.0 * (settings.volume / 100) });
  const { play: playFootsteps, stop: stopFootsteps } = useSound('/sounds/footsteps.mp3', { loop: true, volume: 0.5 * (settings.volume / 100) });
  const { play: playWind, stop: stopWind, setVolume: setWindVolume } = useSound('/sounds/ambient_wind.mp3', { loop: true, volume: 0 });
  const { play: playNature, stop: stopNature, setVolume: setNatureVolume } = useSound('/sounds/ambient_nature.mp3', { loop: true, volume: 0.2 * (settings.volume / 100) });
  const { play: playCity, stop: stopCity, setVolume: setCityVolume } = useSound('/sounds/ambient_city.mp3', { loop: true, volume: 0.1 * (settings.volume / 100) });

  // Sensor Steering Logic
  useEffect(() => {
    if (settings.sensorSteering && settings.mobileControls) {
      const handleOrientation = (event: DeviceOrientationEvent) => {
        const gamma = event.gamma; // Left/Right tilt in degrees
        if (gamma === null) return;
        
        // Deadzone of 5 degrees, max steering at 30 degrees
        if (gamma < -5) {
            localPlayer.current.keys['ArrowLeft'] = true;
            localPlayer.current.keys['ArrowRight'] = false;
        } else if (gamma > 5) {
            localPlayer.current.keys['ArrowRight'] = true;
            localPlayer.current.keys['ArrowLeft'] = false;
        } else {
            localPlayer.current.keys['ArrowLeft'] = false;
            localPlayer.current.keys['ArrowRight'] = false;
        }
      };
      
      window.addEventListener('deviceorientation', handleOrientation);
      return () => window.removeEventListener('deviceorientation', handleOrientation);
    }
  }, [settings.sensorSteering, settings.mobileControls]);

  useEffect(() => {
    setEngineVolume(0.3 * (settings.volume / 100));
    setDriftVolume(0.7 * (settings.volume / 100));
    setNitroVolume(0.8 * (settings.volume / 100));
    setCollisionVolume(0.9 * (settings.volume / 100));
    setNatureVolume(0.2 * (settings.volume / 100));
  }, [settings.volume, setEngineVolume, setDriftVolume, setNitroVolume, setCollisionVolume, setNatureVolume]);

  // Sanitize initial players
  const sanitizedInitial = useMemo(() => {
      if (!initialPlayers) return {};
      return Object.entries(initialPlayers).reduce((acc, [id, p]) => {
        acc[id] = { ...p, score: p.score || 0 };
        return acc;
      }, {} as Record<string, Player>);
  }, [initialPlayers]);

  const [players, setPlayers] = useState<Record<string, Player>>(sanitizedInitial);
  const [myId, setMyId] = useState<string | null>(isSinglePlayer ? 'local-player' : (socket.id || null));
  const [laps, setLaps] = useState(0);
  const [lastLapTime, setLastLapTime] = useState<number | null>(null);
  const [currentLapStart, setCurrentLapStart] = useState<number>(Date.now());
  const [nitro, setNitro] = useState(100);
  const [wrongWay, setWrongWay] = useState(false);
  const [showDebugger, setShowDebugger] = useState(false);
  const [showPhone, setShowPhone] = useState(false);
  const [freeCam, setFreeCam] = useState(false);
  const timerRef = useRef<HTMLDivElement>(null);
  const fpsRef = useRef<number>(0);
  const lastFrameTimeRef = useRef<number>(performance.now());
  const frameCountRef = useRef<number>(0);
  
  const [eventLog, setEventLog] = useState<{id: number, message: string, color: string, time: number}[]>([]);
  const eventIdCounter = useRef(0);

  const addLog = useCallback((message: string, color: string = 'white') => {
    const id = eventIdCounter.current++;
    setEventLog(prev => [...prev, { id, message, color, time: Date.now() }]);
    setTimeout(() => {
      setEventLog(prev => prev.filter(log => log.id !== id));
    }, 4000);
  }, []);
  
  // HUD Helper
  const formatTime = (ms: number) => {
      if (ms === Infinity || !ms) return "--:--";
      const s = Math.floor(ms / 1000);
      const m = Math.floor(s / 60);
      const rs = s % 60;
      const msPart = Math.floor((ms % 1000) / 10);
      return `${m}:${rs.toString().padStart(2, '0')}.${msPart.toString().padStart(2, '0')}`;
  };
  
  // Local state for smooth physics
  const localPlayer = useRef<{
    x: number;
    y: number;
    angle: number;
    speed: number;
    keys: Record<string, boolean>;
    checkpoint: number; // 0: Start, 1: Top, 2: Bottom
    nitro: number;
    drifting: boolean;
    wrongWayTimer: number | null;
    lapCount: number;
    isWalking: boolean;
    carX: number;
    carY: number;
    carAngle: number;
    toggleCooldown: number;
    shake: number;
    score: number;
    hasGoods: boolean;
    targetZoneIndex: number;
    z: number;
    vz: number;
    activePowerUp?: PowerUpType;
    powerUpEndTime?: number;
    roll: number;
    pitch: number;
    suspensionY: number;
    rollVelocity: number;
    pitchVelocity: number;
  }>({
    x: 660,
    y: 750,
    angle: Math.PI,
    speed: 0,
    keys: {},
    checkpoint: 2, // Start before finish line (checkpoint 0)
    nitro: 100,
    drifting: false,
    wrongWayTimer: null,
    lapCount: 0,
    isWalking: true,
    carX: 650,
    carY: 750,
    carAngle: Math.PI,
    toggleCooldown: 0,
    shake: 0,
    score: 0,
    hasGoods: false,
    targetZoneIndex: 0,
    z: 0,
    vz: 0,
    activePowerUp: undefined,
    powerUpEndTime: undefined,
    roll: 0,
    pitch: 0,
    suspensionY: 0,
    rollVelocity: 0,
    pitchVelocity: 0
  });

  // Initialize local player position from props if available
  useEffect(() => {
      if (myId && players[myId]) {
          const p = players[myId];
          localPlayer.current.x = p.x;
          localPlayer.current.y = p.y;
          localPlayer.current.angle = p.angle;
          localPlayer.current.isWalking = p.isWalking ?? true;
          localPlayer.current.carX = p.carX ?? p.x;
          localPlayer.current.carY = p.carY ?? p.y;
          localPlayer.current.carAngle = p.carAngle ?? p.angle;
          localPlayer.current.score = p.score ?? 0;
          localPlayer.current.hasGoods = p.hasGoods ?? false;
          localPlayer.current.targetZoneIndex = p.targetZoneIndex ?? 0;
      }
  }, [myId]); // Run once when ID is confirmed

  // Ambient Sound Logic
  useEffect(() => {
    const interval = setInterval(() => {
      if (!localPlayer.current) return;
      
      const p = localPlayer.current;
      const maxVol = settings.volume / 100;
      
      // Calculate distance from city center (approx 600, 400)
      const dist = Math.hypot(p.x - 600, p.y - 400);
      
      // City Volume: High near center, fades out by 1200 units
      const cityMix = Math.max(0, 1 - dist / 1200);
      setCityVolume(cityMix * 0.2 * maxVol);
      
      // Nature Volume: Low near center, fades in fully by 800 units
      const natureMix = Math.min(1, dist / 800);
      setNatureVolume(natureMix * 0.25 * maxVol);
      
      // Wind Volume: Based on speed and weather
      let windMix = Math.abs(p.speed) / 2.0; // Speed factor
      if (weather !== 'clear') windMix += 0.3; // Weather factor
      setWindVolume(Math.min(1, windMix) * 0.4 * maxVol);
      
    }, 200);
    
    return () => clearInterval(interval);
  }, [settings.volume, weather, setCityVolume, setNatureVolume, setWindVolume]);

  // Particle System
  const [particles, setParticles] = useState<{id: number, x: number, y: number, life: number, color: string, size: number}[]>([]);
  const particleIdCounter = useRef(0);

  useEffect(() => {
    // Socket event listeners
    if (!isSinglePlayer) {
      socket.on('connect', () => {
        setMyId(socket.id || null);
      });

      socket.on('playerJoinedRoom', (player: unknown) => {
        const p = player as Player;
        setPlayers((prev) => ({ ...prev, [p.id]: { ...p, score: p.score || 0 } }));
        addLog(`${p.name} joined the race`, 'text-blue-400');
      });

      socket.on('playerMoved', (player: unknown) => {
        const p = player as Player;
        setPlayers((prev) => {
          // Don't update local player from server to avoid jitter
          if (p.id === socket.id) return prev;
          return { ...prev, [p.id]: { ...p, score: p.score || 0 } };
        });
      });
      
      socket.on('deliveryUpdate', (data: {id: string, score: number, hasGoods: boolean, targetZoneIndex: number}) => {
          setPlayers(prev => {
              if (!prev[data.id]) return prev;
              
              // If this is local player, only update if server score is BETTER or EQUAL to local score
              // This prevents overwriting optimistic update with stale server data
              if (data.id === socket.id) {
                   const currentScore = prev[data.id].score || 0;
                   if (data.score < currentScore) {
                       // Server sent worse score than we have locally? Ignore it.
                       return prev;
                   }
              } else {
                  // Log remote player delivery
                  if (data.score > (prev[data.id].score || 0)) {
                      addLog(`${prev[data.id].name} made a delivery!`, 'text-green-400');
                  } else if (data.hasGoods && !prev[data.id].hasGoods) {
                      addLog(`${prev[data.id].name} picked up goods`, 'text-yellow-400');
                  }
              }

              return {
                  ...prev,
                  [data.id]: {
                      ...prev[data.id],
                      score: data.score,
                      hasGoods: data.hasGoods,
                      targetZoneIndex: data.targetZoneIndex
                  }
              };
          });
      });

      socket.on('playerDisconnected', (id: string) => {
        setPlayers((prev) => {
          const next = { ...prev };
          if (next[id]) {
              addLog(`${next[id].name} left the race`, 'text-slate-400');
          }
          delete next[id];
          return next;
        });
      });
    }

    // Start ambient sounds
    playWind();
    playNature();
    playCity();

    return () => {
      if (!isSinglePlayer) {
        socket.off('connect');
        socket.off('playerJoinedRoom');
        socket.off('playerMoved');
        socket.off('playerDisconnected');
        socket.off('deliveryUpdate');
      }
      stopEngine();
      stopDrift();
      stopFootsteps();
      stopWind();
      stopNature();
      stopCity();
    };
  }, [isSinglePlayer]);

  // Input handling
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      localPlayer.current.keys[e.code] = true;
      if (e.code === 'Digit0') {
        setShowDebugger(prev => !prev);
      }
      if (e.code === 'Tab') {
        e.preventDefault();
        setShowPhone(prev => !prev);
      }
      if (e.code === 'KeyC') {
        setFreeCam(prev => !prev);
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      localPlayer.current.keys[e.code] = false;
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // Physics Loop (runs independently of 3D render loop)
  useEffect(() => {
    let animationFrameId: number;
    let enginePlaying = false;
    let driftPlaying = false;
    let footstepsPlaying = false;

    const updatePhysics = () => {
      const now = performance.now();
      frameCountRef.current++;
      if (now - lastFrameTimeRef.current >= 1000) {
        fpsRef.current = frameCountRef.current;
        frameCountRef.current = 0;
        lastFrameTimeRef.current = now;
      }

      const p = localPlayer.current;
      const oldX = p.x;
      const oldY = p.y;
      
      // Toggle Walking
      if ((p.keys['KeyE'] || p.keys['KeyF']) && p.toggleCooldown <= 0) {
          if (p.isWalking) {
              // Try to enter car
              const distToCar = Math.hypot(p.x - p.carX, p.y - p.carY);
              if (distToCar < 15) {
                  p.isWalking = false;
                  p.x = p.carX;
                  p.y = p.carY;
                  p.angle = p.carAngle;
                  p.speed = 0;
                  p.toggleCooldown = 30;
              }
          } else {
              // Exit car
              if (Math.abs(p.speed) < 0.5) {
                  p.isWalking = true;
                  p.carX = p.x;
                  p.carY = p.y;
                  p.carAngle = p.angle;
                  p.x = p.carX + Math.cos(p.carAngle + Math.PI/2) * 6;
                  p.y = p.carY + Math.sin(p.carAngle + Math.PI/2) * 6;
                  p.speed = 0;
                  p.toggleCooldown = 30;
              }
          }
      }
      if (p.toggleCooldown > 0) p.toggleCooldown--;

      if (p.isWalking) {
          // Walking physics
          const walkSpeed = 0.6;
          let dx = 0;
          let dy = 0;
          if (p.keys['ArrowUp'] || p.keys['KeyW']) {
              dx += Math.cos(p.angle) * walkSpeed;
              dy += Math.sin(p.angle) * walkSpeed;
          }
          if (p.keys['ArrowDown'] || p.keys['KeyS']) {
              dx -= Math.cos(p.angle) * walkSpeed;
              dy -= Math.sin(p.angle) * walkSpeed;
          }
          if (p.keys['ArrowLeft'] || p.keys['KeyA']) {
              p.angle -= 0.08;
          }
          if (p.keys['ArrowRight'] || p.keys['KeyD']) {
              p.angle += 0.08;
          }
          p.x += dx;
          p.y += dy;
          p.speed = Math.hypot(dx, dy);

          if (p.speed > 0.1) {
              if (!footstepsPlaying) {
                  playFootsteps();
                  footstepsPlaying = true;
              }
          } else {
              if (footstepsPlaying) {
                  stopFootsteps();
                  footstepsPlaying = false;
              }
          }

          p.nitro = Math.min(100, p.nitro + 0.2); // recharge nitro while walking
          setNitro(p.nitro);
          p.drifting = false;
          if (enginePlaying) {
              stopEngine();
              enginePlaying = false;
          }
      } else {
          // Engine Sound
          if (footstepsPlaying) {
              stopFootsteps();
              footstepsPlaying = false;
          }
          if (!enginePlaying) {
              playEngine();
              enginePlaying = true;
          }
          setEngineVolume(Math.min(1, 0.3 + Math.abs(p.speed) / MAX_SPEED * 0.7));

          // Acceleration & Longitudinal Physics
          let targetPitch = 0;
          if (p.keys['ArrowUp'] || p.keys['KeyW']) {
            p.speed += ACCELERATION * TIRE_GRIP_LONGITUDINAL;
            targetPitch = -0.15; // Nose up
          } else if (p.keys['ArrowDown'] || p.keys['KeyS']) {
            p.speed -= ACCELERATION * TIRE_GRIP_LONGITUDINAL;
            targetPitch = 0.15; // Nose down
          } else {
            p.speed *= FRICTION;
            targetPitch = 0;
          }

          // Spring-Damper for Pitch
          const pitchForce = (targetPitch - p.pitch) * PITCH_STIFFNESS;
          p.pitchVelocity += pitchForce;
          p.pitchVelocity *= 0.9; // Damping
          p.pitch += p.pitchVelocity;

          // Nitro
          if ((p.keys['ShiftLeft'] || p.keys['ShiftRight']) && p.nitro > 0) {
              p.speed += NITRO_ACCEL;
              p.nitro = Math.max(0, p.nitro - 1);
              playNitro();
              p.pitchVelocity -= 0.02; // Kick nose up
          } else {
              p.nitro = Math.min(100, p.nitro + 0.2);
          }
          setNitro(p.nitro);

          // Drifting & Lateral Physics
          const isTurning = p.keys['ArrowLeft'] || p.keys['KeyA'] || p.keys['ArrowRight'] || p.keys['KeyD'];
          const wantsDrift = p.keys['Space'];
          
          if (wantsDrift && isTurning && Math.abs(p.speed) > 1.5) {
              p.drifting = true;
              if (!driftPlaying) {
                  playDrift();
                  driftPlaying = true;
              }
          } else {
              p.drifting = false;
              if (driftPlaying) {
                  stopDrift();
                  driftPlaying = false;
              }
          }

          // Max Speed Cap
          const isNitroActive = (p.keys['ShiftLeft'] || p.keys['ShiftRight']) && p.nitro > 0;
          const currentMaxSpeed = isNitroActive ? NITRO_SPEED : MAX_SPEED;
          
          if (p.speed > currentMaxSpeed) {
              if (isNitroActive) {
                  p.speed = currentMaxSpeed;
              } else {
                  p.speed = Math.max(currentMaxSpeed, p.speed * 0.98);
              }
          }
          if (p.speed < -MAX_SPEED / 2) p.speed = -MAX_SPEED / 2;

          // Turning & Roll Physics
          let targetRoll = 0;
          if (Math.abs(p.speed) > 0.1) {
            // Non-linear steering response for better low-speed handling
            const speedRatio = Math.abs(p.speed) / MAX_SPEED;
            // Boost turning at low speeds (min 40% effectiveness)
            const steeringSensitivity = Math.max(0.4, Math.min(1.0, speedRatio + 0.1));
            
            let turn = TURN_SPEED * steeringSensitivity;
            
            // Reverse steering when reversing
            if (p.speed < 0) turn = -turn;
            
            if (p.drifting) {
                turn *= 1.8; // Sharper turning while drifting
                p.speed *= 0.992; // Maintain more momentum while drifting
                p.shake = Math.min(p.shake + 0.2, 1.5);
                targetRoll = (p.keys['ArrowLeft'] || p.keys['KeyA'] ? 0.25 : -0.25); // Exaggerated roll
                
                if (Math.random() > 0.5) {
                    setParticles(prev => [
                        ...prev, 
                        {
                            id: particleIdCounter.current++, 
                            x: p.x + (Math.random() - 0.5) * 2, 
                            y: p.y + (Math.random() - 0.5) * 2, 
                            life: 1.0,
                            color: '#e5e7eb', // Light gray smoke
                            size: 1.5
                        }
                    ]);
                }
            } else {
                // Normal turning roll based on centripetal force approx
                const lateralG = turn * p.speed; 
                targetRoll = (p.keys['ArrowLeft'] || p.keys['KeyA'] ? 0.1 : p.keys['ArrowRight'] || p.keys['KeyD'] ? -0.1 : 0) * (Math.abs(p.speed) / MAX_SPEED);
            }

            if (p.keys['ArrowLeft'] || p.keys['KeyA']) {
              p.angle -= turn;
            }
            if (p.keys['ArrowRight'] || p.keys['KeyD']) {
              p.angle += turn;
            }
          }

          // Nitro Particles
          if (isNitroActive && Math.random() > 0.3) {
               const offsetX = Math.cos(p.angle + Math.PI) * 2.5;
               const offsetY = Math.sin(p.angle + Math.PI) * 2.5;
               setParticles(prev => [
                   ...prev,
                   {
                       id: particleIdCounter.current++,
                       x: p.x + offsetX + (Math.random() - 0.5),
                       y: p.y + offsetY + (Math.random() - 0.5),
                       life: 0.6,
                       color: Math.random() > 0.5 ? '#3b82f6' : '#f97316', // Blue/Orange flame
                       size: 0.8
                   }
               ]);
          }

          // Spring-Damper for Roll
          const rollForce = (targetRoll - p.roll) * ROLL_STIFFNESS;
          p.rollVelocity += rollForce;
          p.rollVelocity *= 0.9; // Damping
          p.roll += p.rollVelocity;

          p.x += Math.cos(p.angle) * p.speed;
          p.y += Math.sin(p.angle) * p.speed;
          
          p.carX = p.x;
          p.carY = p.y;
          p.carAngle = p.angle;
          
          // Vertical Physics (Suspension)
          const terrainH = getTerrainHeight(p.x, p.y);
          p.vz -= GRAVITY;
          p.z += p.vz;
          
          // Advanced Suspension Logic
          if (p.z <= terrainH + SUSPENSION_REST_LENGTH) {
              const compression = (terrainH + SUSPENSION_REST_LENGTH) - p.z;
              const springForce = compression * SUSPENSION_STIFFNESS;
              const dampingForce = -p.vz * SUSPENSION_DAMPING;
              
              p.vz += springForce + dampingForce;
              
              // Hard floor collision
              if (p.z < terrainH) {
                  p.z = terrainH;
                  p.vz = Math.max(0, p.vz); // Stop downward velocity
                  p.speed *= 0.95; // Friction from bottoming out
              }
              
              p.suspensionY = -compression * 0.5; // Visual offset

              // Ramp / Jump Logic
              const lookAhead = 15;
              const nextX = p.x + Math.cos(p.angle) * lookAhead;
              const nextY = p.y + Math.sin(p.angle) * lookAhead;
              const nextH = getTerrainHeight(nextX, nextY);
              const slope = nextH - terrainH;
              
              if (slope > 2 && p.speed > 1.5) {
                  p.vz += Math.min(slope * 0.25 * p.speed, 5.0); // Stronger launch
                  p.pitchVelocity -= 0.05; // Kick nose up slightly on launch
              }
          } else {
              p.suspensionY = THREE.MathUtils.lerp(p.suspensionY, 0, 0.1);
              
              // Air Control
              if (p.z > terrainH + 5) {
                  // Pitch Control
                  if (p.keys['ArrowUp'] || p.keys['KeyW']) p.pitchVelocity -= 0.02;
                  if (p.keys['ArrowDown'] || p.keys['KeyS']) p.pitchVelocity += 0.02;
                  
                  // Roll Control
                  if (p.keys['ArrowLeft'] || p.keys['KeyA']) p.rollVelocity += 0.02;
                  if (p.keys['ArrowRight'] || p.keys['KeyD']) p.rollVelocity -= 0.02;
                  
                  // Yaw Control (Mid-air turning)
                  if (p.keys['ArrowLeft'] || p.keys['KeyA']) p.angle += 0.03;
                  if (p.keys['ArrowRight'] || p.keys['KeyD']) p.angle -= 0.03;
              }
          }
      }

      // Single Player Game Logic
      if (isSinglePlayer) {
          // Check for Pickup
          if (!p.hasGoods) {
              const pickupZone = DELIVERY_ZONES[0]; // Assuming first zone is pickup for simplicity or random
              // Actually, let's use the targetZoneIndex logic
              // In single player, we need to manage the target zone locally
              
              // If we don't have a target, set one
              // But wait, p.targetZoneIndex is already in local state
              
              const currentZone = DELIVERY_ZONES[p.targetZoneIndex];
              const dist = Math.hypot(p.x - currentZone.x, p.y - currentZone.y);
              
              if (dist < 20) {
                  p.hasGoods = true;
                  addLog('Goods Collected! Deliver them!', 'text-yellow-400');
                  playPickup();
                  
                  // Pick a new random delivery zone different from current
                  let nextIndex;
                  do {
                      nextIndex = Math.floor(Math.random() * DELIVERY_ZONES.length);
                  } while (nextIndex === p.targetZoneIndex);
                  p.targetZoneIndex = nextIndex;
              }
          } else {
              // Check for Delivery
              const currentZone = DELIVERY_ZONES[p.targetZoneIndex];
              const dist = Math.hypot(p.x - currentZone.x, p.y - currentZone.y);
              
              if (dist < 20) {
                  p.hasGoods = false;
                  p.score += 100;
                  addLog('Delivery Successful! +100 Points', 'text-green-400');
                  playDelivery();
                  
                  // Pick a new random pickup zone
                  let nextIndex;
                  do {
                      nextIndex = Math.floor(Math.random() * DELIVERY_ZONES.length);
                  } while (nextIndex === p.targetZoneIndex);
                  p.targetZoneIndex = nextIndex;
              }
          }
      }

      // Prop Collision
      setProps(prevProps => prevProps.map(prop => {
          if (!prop.active) return prop;
          
          const dx = p.x - prop.x;
          const dy = p.y - prop.y;
          const dist = Math.sqrt(dx*dx + dy*dy);
          
          if (dist < 3.0) {
              if (prop.type === 'barrier' || prop.type === 'crate') {
                  // Breakable
                  if (Math.abs(p.speed) > 1.5) { // Lower threshold for breaking
                      playCollision();
                      p.shake = 4.0; // More shake
                      p.speed *= 0.7; // Impact slowdown
                      
                      // Spawn debris particles
                      setParticles(prev => {
                          const newParts = [];
                          for(let i=0; i<12; i++) { // More particles
                              newParts.push({
                                  id: particleIdCounter.current++,
                                  x: prop.x + (Math.random()-0.5)*3,
                                  y: prop.y + (Math.random()-0.5)*3,
                                  life: 1.2,
                                  color: prop.type === 'barrier' ? '#ef4444' : '#d97706',
                                  size: 1.2
                              });
                          }
                          return [...prev, ...newParts];
                      });
                      
                      return { ...prop, active: false };
                  } else {
                      // Solid collision (low speed)
                      const angle = Math.atan2(dy, dx);
                      p.x += Math.cos(angle) * 1.0; // Push back harder
                      p.y += Math.sin(angle) * 1.0;
                      p.speed *= -0.4;
                      playCollision();
                      p.shake = 1.5;
                  }
              } else if (prop.type === 'ramp') {
                  // Jump!
                  if (Math.abs(p.speed) > 2.0) {
                      p.vz = 1.5; // Launch
                      p.pitchVelocity = -0.1; // Nose up
                      playNitro(); // Sound effect
                  }
              }
          }
          return prop;
      }));

      // Update Particles
      setParticles(prev => prev.map(pt => ({...pt, life: pt.life - 0.05})).filter(pt => pt.life > 0));

      // Find closest segment for target angle and collision
      let closestPt = {x: p.x, y: p.y};
      let minD2 = Infinity;
      let targetAngle = 0;
      
      TRACK_SEGMENTS.forEach(seg => {
          const pt = getClosestPointOnSegment({x: p.x, y: p.y}, seg.start, seg.end);
          const d2 = (pt.x - p.x)**2 + (pt.y - p.y)**2;
          if (d2 < minD2) {
              minD2 = d2;
              closestPt = pt;
              targetAngle = seg.angle;
          }
      });

      // Track Collision (Off-track logic)
      if (Math.sqrt(minD2) > TRACK_RADIUS) {
        // Off-track: Apply friction but allow driving
        p.speed *= 0.98; // Slight drag
        
        // Remove hard speed cap to allow exploration
        
        p.drifting = false; // Harder to drift on grass
        
        if (Math.abs(p.speed) > 2.0) {
            p.shake = Math.min(p.shake + 0.2, 1.5); // Add shake when off-track
            // Play collision sound with rate limiting
            if (Math.random() > 0.95) playCollision();
        }
      }

      // Decoration Collision (Trees, Rocks, etc.)
      for (const deco of DECORATIONS) {
          // Fast AABB check first
          if (Math.abs(p.x - deco.pos[0]) > 20 || Math.abs(p.y - deco.pos[2]) > 20) continue;

          const dx = p.x - deco.pos[0];
          const dy = p.y - deco.pos[2];
          const distSq = dx*dx + dy*dy;
          const radiusSum = deco.radius + 1.5;
          
          if (distSq < radiusSum * radiusSum) {
              const dist = Math.sqrt(distSq);
              // Solid collision
              const angle = Math.atan2(dy, dx);
              const overlap = radiusSum - dist;
              
              // Push back
              p.x += Math.cos(angle) * overlap;
              p.y += Math.sin(angle) * overlap;
              
              // Bounce
              if (Math.abs(p.speed) > 1.0) {
                  p.speed *= -0.5;
                  playCollision();
                  p.shake = 3.0;
                  
                  // Debris
                  setParticles(prev => {
                      const newParts = [];
                      for(let i=0; i<5; i++) {
                          newParts.push({
                              id: particleIdCounter.current++,
                              x: p.x + (Math.random()-0.5)*2,
                              y: p.y + (Math.random()-0.5)*2,
                              life: 0.8,
                              color: '#57534e',
                              size: 1.0
                          });
                      }
                      return [...prev, ...newParts];
                  });
              } else {
                  p.speed = 0;
              }
          }
      }

      // Car-to-Car Collision
      Object.values(players).forEach(other => {
          if (other.id === myId) return;
          const dx = p.x - other.x;
          const dy = p.y - other.y;
          const dist = Math.sqrt(dx*dx + dy*dy);
          if (dist < 3.5) { // Increased collision radius
              // Elastic collision response
              const angle = Math.atan2(dy, dx);
              const force = 1.5; // Stronger bounce
              
              p.x += Math.cos(angle) * force;
              p.y += Math.sin(angle) * force;
              
              // Transfer momentum
              p.speed *= -0.6; 
              
              playCollision();
              p.shake = 5.0; // Heavy shake
              
              // Spawn sparks
              setParticles(prev => {
                  const newParts = [];
                  for(let i=0; i<8; i++) {
                      newParts.push({
                          id: particleIdCounter.current++,
                          x: p.x + (Math.random()-0.5)*2,
                          y: p.y + (Math.random()-0.5)*2,
                          life: 0.8,
                          color: '#f59e0b', // Orange sparks
                          size: 0.6
                      });
                  }
                  return [...prev, ...newParts];
              });
          }
      });

      // Checkpoint Logic Removed


      // Delivery Logic (Multiplayer Only - Single Player Handled Above)
      if (!isSinglePlayer) {
          const targetZone = DELIVERY_ZONES[p.targetZoneIndex];
          if (targetZone) {
              const distToZone = Math.hypot(p.x - targetZone.x, p.y - targetZone.y);
              if (distToZone < 40) { // Zone radius
                  // Reached target!
                  if (p.hasGoods) {
                      p.score += 1;
                      p.hasGoods = false;
                      addLog('Delivery successful! +1 Point', 'text-green-400');
                      playDelivery();
                  } else {
                      p.hasGoods = true;
                      addLog('Goods picked up! Deliver them to the next zone.', 'text-yellow-400');
                      playPickup();
                  }
                  
                  // Pick a new random zone that isn't the current one
                  let newZoneIndex = p.targetZoneIndex;
                  while (newZoneIndex === p.targetZoneIndex) {
                      newZoneIndex = Math.floor(Math.random() * DELIVERY_ZONES.length);
                  }
                  p.targetZoneIndex = newZoneIndex;

                  // Emit update to server
                  socket.emit('deliveryUpdate', {
                      score: p.score,
                      hasGoods: p.hasGoods,
                      targetZoneIndex: p.targetZoneIndex
                  });
                  
                  // Optimistically update local player
                  setPlayers(prev => {
                      if (!myId || !prev[myId]) return prev;
                      return {
                          ...prev,
                          [myId]: {
                              ...prev[myId],
                              score: p.score,
                              hasGoods: p.hasGoods,
                              targetZoneIndex: p.targetZoneIndex
                          }
                      };
                  });
              }
          }
      }

      // Wrong Way Detection (simplified or removed for delivery mode)
      // For delivery, wrong way doesn't make as much sense since you can go anywhere.
      // We'll just disable it.
      if (wrongWay) setWrongWay(false);

      // Send update
      if (!isSinglePlayer && socket.connected) {
        socket.emit('playerMovement', {
          x: p.x,
          y: p.y,
          angle: p.angle,
          speed: p.speed,
          nitro: p.nitro,
          drifting: p.drifting,
          isWalking: p.isWalking,
          carX: p.carX,
          carY: p.carY,
          carAngle: p.carAngle
        });
      } else if (isSinglePlayer && myId) {
          // In single player, just update the state directly for UI
          setPlayers(prev => ({
              ...prev,
              [myId]: {
                  ...prev[myId],
                  x: p.x,
                  y: p.y,
                  angle: p.angle,
                  speed: p.speed,
                  nitro: p.nitro,
                  drifting: p.drifting,
                  isWalking: p.isWalking,
                  carX: p.carX,
                  carY: p.carY,
                  carAngle: p.carAngle,
                  score: p.score,
                  hasGoods: p.hasGoods,
                  targetZoneIndex: p.targetZoneIndex
              }
          }));
      }

      // Update Ambient Volumes based on height
      const h = getTerrainHeight(p.x, p.y);
      const masterVol = settings.volume / 100;
      // Wind gets louder as you go higher
      const windVol = Math.min(0.8, Math.max(0, (h - 20) / 60)) * masterVol;
      setWindVolume(windVol);
      // Nature gets slightly quieter as you go very high
      const natureVol = Math.max(0.05, 0.2 - Math.max(0, (h - 40) / 100)) * masterVol;
      setNatureVolume(natureVol);

      // City ambience is louder at low altitudes
      const cityVol = Math.max(0, 0.15 - (h / 100)) * masterVol;
      setCityVolume(cityVol);

      animationFrameId = requestAnimationFrame(updatePhysics);
    };

    updatePhysics();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [currentLapStart]);

  return (
    <div className="relative w-full h-full bg-slate-900 overflow-hidden">
      <Canvas shadows>
        <WeatherSystem weather={weather} />
        <PerspectiveCamera makeDefault position={[0, 50, 50]} fov={60} far={1000} />
        <GameScene 
            localPlayerRef={localPlayer} 
            players={players} 
            myId={myId} 
            showCompass={settings.showCompass} 
            freeCam={freeCam}
            powerUps={powerUps}
            props={props}
        />
        
        <EffectComposer>
            <Bloom luminanceThreshold={0.6} luminanceSmoothing={0.9} height={300} intensity={0.5} />
            <N8AO aoRadius={50} distanceFalloff={0.2} intensity={1} />
        </EffectComposer>
        
        {/* Particles */}
        {particles.map(pt => (
            <mesh key={pt.id} position={[pt.x, getTerrainHeight(pt.x, pt.y) + 1.5, pt.y]} rotation={[-Math.PI/2, 0, 0]}>
                <planeGeometry args={[pt.size * pt.life, pt.size * pt.life]} />
                <meshBasicMaterial color={pt.color} transparent opacity={0.6 * pt.life} depthWrite={false} />
            </mesh>
        ))}

        <OrbitControls enabled={freeCam} />
      </Canvas>
      
      {/* Mobile Controls */}
      {settings.mobileControls && (
        <>
            {/* Joystick (Left Side) */}
            <div className="absolute bottom-12 left-12 pointer-events-auto z-50">
                <Joystick onMove={(x, y) => {
                    // Steering
                    if (x < -0.3) {
                        localPlayer.current.keys['ArrowLeft'] = true;
                        localPlayer.current.keys['ArrowRight'] = false;
                    } else if (x > 0.3) {
                        localPlayer.current.keys['ArrowRight'] = true;
                        localPlayer.current.keys['ArrowLeft'] = false;
                    } else {
                        localPlayer.current.keys['ArrowLeft'] = false;
                        localPlayer.current.keys['ArrowRight'] = false;
                    }

                    // Acceleration / Braking
                    if (y < -0.3) {
                        localPlayer.current.keys['ArrowUp'] = true;
                        localPlayer.current.keys['ArrowDown'] = false;
                    } else if (y > 0.3) {
                        localPlayer.current.keys['ArrowDown'] = true;
                        localPlayer.current.keys['ArrowUp'] = false;
                    } else {
                        localPlayer.current.keys['ArrowUp'] = false;
                        localPlayer.current.keys['ArrowDown'] = false;
                    }
                }} />
            </div>

            {/* Actions (Right Side) */}
            <div className="absolute bottom-12 right-12 flex flex-col items-end gap-6 pointer-events-auto z-50">
                {/* Enter/Exit Car Button */}
                <button 
                    className="w-16 h-16 bg-purple-500/20 backdrop-blur-md rounded-full border border-purple-500/40 active:bg-purple-500/40 flex items-center justify-center select-none touch-none"
                    onTouchStart={(e) => { e.preventDefault(); localPlayer.current.keys['KeyE'] = true; }}
                    onTouchEnd={(e) => { e.preventDefault(); localPlayer.current.keys['KeyE'] = false; }}
                >
                    <span className="text-xl text-purple-200 font-bold">E</span>
                </button>

                <div className="grid grid-cols-2 gap-4">
                    {/* Drift */}
                    <button 
                        className="w-16 h-16 bg-yellow-500/20 backdrop-blur-md rounded-full border border-yellow-500/40 active:bg-yellow-500/40 flex items-center justify-center select-none touch-none"
                        onTouchStart={(e) => { e.preventDefault(); localPlayer.current.keys['Space'] = true; }}
                        onTouchEnd={(e) => { e.preventDefault(); localPlayer.current.keys['Space'] = false; }}
                    >
                        <span className="text-xl text-yellow-200 font-bold">D</span>
                    </button>

                    {/* Nitro */}
                    <button 
                        className="w-16 h-16 bg-blue-500/20 backdrop-blur-md rounded-full border border-blue-500/40 active:bg-blue-500/40 flex items-center justify-center select-none touch-none"
                        onTouchStart={(e) => { e.preventDefault(); localPlayer.current.keys['ShiftLeft'] = true; }}
                        onTouchEnd={(e) => { e.preventDefault(); localPlayer.current.keys['ShiftLeft'] = false; }}
                    >
                        <span className="text-xl text-blue-200 font-bold">N</span>
                    </button>
                </div>
            </div>

            {/* Utility Buttons (Top Right, below HUD) */}
            <div className="absolute top-24 right-4 flex flex-col gap-4 pointer-events-auto z-50">
                {/* Phone */}
                <button 
                    className="w-12 h-12 bg-slate-800/50 backdrop-blur-md rounded-full border border-white/20 active:bg-slate-700/50 flex items-center justify-center select-none touch-none"
                    onClick={() => setShowPhone(prev => !prev)}
                >
                    <span className="text-xl">📱</span>
                </button>
                
                {/* Camera */}
                <button 
                    className="w-12 h-12 bg-slate-800/50 backdrop-blur-md rounded-full border border-white/20 active:bg-slate-700/50 flex items-center justify-center select-none touch-none"
                    onClick={() => setFreeCam(prev => !prev)}
                >
                    <span className="text-xl">📷</span>
                </button>
                
                {/* Debug */}
                <button 
                    className="w-12 h-12 bg-slate-800/50 backdrop-blur-md rounded-full border border-white/20 active:bg-slate-700/50 flex items-center justify-center select-none touch-none"
                    onClick={() => setShowDebugger(prev => !prev)}
                >
                    <span className="text-xl">🐛</span>
                </button>
            </div>
        </>
      )}

      {/* HUD Overlay */}
      
      {/* Top Left: Exit Game Button */}
      <div className="absolute top-4 left-4 pointer-events-auto z-50">
        <button
          onClick={onExitGame}
          className="px-3 py-1.5 bg-black/40 hover:bg-black/60 backdrop-blur-md rounded-lg text-xs text-white font-bold transition-all shadow-lg border border-white/10 flex items-center gap-2"
        >
          <span className="opacity-60">←</span> Back to Menu
        </button>
      </div>

      {/* Top Right: Cash & Phone Prompt */}
      <div className="absolute top-4 right-4 sm:top-6 sm:right-6 flex flex-col items-end gap-2 sm:gap-4 pointer-events-none">
          <div className="bg-black/50 text-white px-4 py-2 sm:px-6 sm:py-3 rounded-xl border border-white/10 backdrop-blur-md flex items-center gap-3 sm:gap-4 shadow-lg">
              <div className="text-right">
                  <div className="text-[10px] sm:text-xs text-slate-400 uppercase tracking-wider font-bold">Cash</div>
                  <div className="text-lg sm:text-2xl font-mono font-bold text-green-400 leading-none">
                      ${(players[socket.id || '']?.score || 0) * 100}
                  </div>
              </div>
          </div>

          <div className="bg-black/50 text-white px-4 py-2 sm:px-6 sm:py-3 rounded-xl border border-white/10 backdrop-blur-md flex flex-col items-end shadow-lg">
              <div className={`text-[10px] sm:text-xs font-bold uppercase tracking-widest ${players[socket.id || '']?.hasGoods ? 'text-green-400' : 'text-blue-400'}`}>
                  {players[socket.id || '']?.hasGoods ? 'Deliver To' : 'Pickup At'}
              </div>
              <div className="text-sm sm:text-lg font-bold text-white">
                  {DELIVERY_ZONES[players[socket.id || '']?.targetZoneIndex || 0]?.name}
              </div>
          </div>
          
          <div className="bg-black/50 text-white px-3 py-1.5 sm:px-4 sm:py-2 rounded-xl border border-white/10 backdrop-blur-md flex items-center gap-2 sm:gap-3 shadow-lg">
              <div className="w-5 h-8 sm:w-6 sm:h-10 bg-slate-800 rounded-md border-2 border-slate-600 flex items-center justify-center">
                  <div className="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full bg-blue-500 animate-pulse"></div>
              </div>
              <div className="text-[10px] sm:text-sm font-bold text-slate-300">
                  Press <span className="text-yellow-400 font-mono bg-black/50 px-1.5 py-0.5 sm:px-2 sm:py-1 rounded">TAB</span> for Phone
              </div>
          </div>
      </div>

      {/* Bottom Center: Nitro Bar */}
      <div className="absolute bottom-6 sm:bottom-10 left-1/2 -translate-x-1/2 pointer-events-none w-[80%] max-w-xs">
          <div className="flex justify-between text-[10px] sm:text-xs text-slate-400 uppercase tracking-wider font-bold mb-1 sm:mb-2">
              <span>Nitro</span>
              <span>{Math.round(nitro)}%</span>
          </div>
          <div className="w-full h-3 sm:h-4 bg-slate-800/50 rounded-full overflow-hidden border border-white/20 backdrop-blur-md">
              <div 
                className="h-full bg-gradient-to-r from-blue-600 via-blue-400 to-cyan-300 shadow-[0_0_15px_rgba(59,130,246,0.6)]"
                style={{ width: `${nitro}%` }}
              />
          </div>
      </div>

      {/* Wrong Way Warning (Disabled for delivery) */}

      {/* Bottom Left: Controls (Faded) */}

      {/* Debugger Window */}
      {showDebugger && (
        <div className="absolute bottom-4 right-4 sm:bottom-6 sm:right-6 pointer-events-none z-50">
          <div className="bg-black/80 text-green-400 p-3 sm:p-4 rounded-lg border border-green-500/30 font-mono text-[10px] sm:text-xs w-48 sm:w-64 shadow-2xl backdrop-blur-sm">
            <div className="flex justify-between border-b border-green-500/30 pb-1 sm:pb-2 mb-1 sm:mb-2">
              <span className="font-bold uppercase">Debug</span>
              <span className="text-green-600 opacity-50">0 to toggle</span>
            </div>
            <div className="space-y-1">
              <div className="flex justify-between">
                <span>FPS:</span>
                <span>{fpsRef.current}</span>
              </div>
              <div className="flex justify-between">
                <span>X:</span>
                <span>{localPlayer.current.x.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span>Y:</span>
                <span>{localPlayer.current.y.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span>Angle:</span>
                <span>{localPlayer.current.angle.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span>Speed:</span>
                <span>{localPlayer.current.speed.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span>State:</span>
                <span>{localPlayer.current.isWalking ? 'Walking' : 'Driving'}</span>
              </div>
              <div className="flex justify-between">
                <span>Goods:</span>
                <span>{localPlayer.current.hasGoods ? 'Yes' : 'No'}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Event Log */}
      {settings.showLog && (
        <div className="absolute top-16 sm:top-20 right-4 sm:right-6 flex flex-col items-end gap-1 sm:gap-2 pointer-events-none z-40">
          {eventLog.map(log => (
            <div 
              key={log.id} 
              className={`bg-black/60 px-3 py-1.5 sm:px-4 sm:py-2 rounded-lg border border-white/10 backdrop-blur-sm text-[10px] sm:text-sm font-bold shadow-lg transition-all duration-500 animate-in slide-in-from-right-8 fade-in ${log.color}`}
            >
              {log.message}
            </div>
          ))}
        </div>
      )}

      {/* Virtual Phone */}
      {showPhone && (
        <div className="absolute right-4 bottom-4 sm:right-10 sm:bottom-10 w-[280px] sm:w-80 h-[500px] sm:h-[600px] max-h-[80vh] bg-slate-900 rounded-[2.5rem] sm:rounded-[3rem] border-[6px] sm:border-[8px] border-slate-800 shadow-2xl overflow-hidden flex flex-col pointer-events-auto z-50 transform transition-transform duration-300">
          {/* Phone Header */}
          <div className="bg-slate-800 px-6 py-2 flex justify-between items-center text-xs text-slate-400 font-bold">
            <span>{new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
            <div className="flex gap-2">
              <span>5G</span>
              <span>100%</span>
            </div>
          </div>
          
          {/* Phone Content */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-900 text-slate-200">
            {/* Banking App */}
            <div className="bg-slate-800 p-4 rounded-2xl border border-slate-700">
              <h3 className="text-sm text-slate-400 uppercase font-bold mb-1">Maze Bank</h3>
              <div className="text-3xl font-mono font-bold text-green-400">
                ${(players[socket.id || '']?.score || 0) * 100}
              </div>
            </div>

            {/* Jobs App */}
            <div className="bg-slate-800 p-4 rounded-2xl border border-slate-700">
              <h3 className="text-sm text-slate-400 uppercase font-bold mb-3">Current Job</h3>
              <div className="bg-slate-900 p-3 rounded-xl">
                <div className={`text-sm font-bold mb-1 ${players[socket.id || '']?.hasGoods ? 'text-green-400' : 'text-blue-400'}`}>
                    {players[socket.id || '']?.hasGoods ? 'DELIVER TO:' : 'PICKUP AT:'}
                </div>
                <div className="text-xl font-bold text-white">
                    {DELIVERY_ZONES[players[socket.id || '']?.targetZoneIndex || 0]?.name || '...'}
                </div>
              </div>
            </div>

            {/* Leaderboard App */}
            <div className="bg-slate-800 p-4 rounded-2xl border border-slate-700">
              <h3 className="text-sm text-slate-400 uppercase font-bold mb-3">Top Earners</h3>
              <div className="space-y-2">
                  {Object.values(players)
                    .map(p => p as Player)
                    .sort((a, b) => (b.score || 0) - (a.score || 0))
                    .slice(0, 5)
                    .map((p, i) => (
                      <div key={p.id} className="flex justify-between text-sm bg-slate-900 p-2 rounded-lg">
                          <span className={`${p.id === socket.id ? 'text-yellow-400 font-bold' : 'text-slate-300'} truncate max-w-[120px]`}>
                              {i+1}. {p.name}
                          </span>
                          <span className="font-mono text-green-400">
                              ${(p.score || 0) * 100}
                          </span>
                      </div>
                  ))}
              </div>
            </div>
          </div>

          {/* Phone Home Button */}
          <div className="bg-slate-800 h-12 flex items-center justify-center cursor-pointer hover:bg-slate-700 transition-colors" onClick={() => setShowPhone(false)}>
            <div className="w-1/3 h-1.5 bg-slate-600 rounded-full"></div>
          </div>
        </div>
      )}

      {/* Exit Game Button (Top Right) */}
      <div className="absolute top-6 right-6 pointer-events-auto hidden">
        <button
          onClick={onExitGame}
          className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm text-white font-bold transition-colors"
        >
          Back to Menu
        </button>
      </div>
      <div className="absolute bottom-4 left-4 sm:bottom-6 sm:left-6 text-white pointer-events-none opacity-40 hover:opacity-100 transition-opacity duration-300 hidden sm:block">
        <div className="bg-black/40 p-4 sm:p-5 rounded-xl backdrop-blur-md border border-white/10">
            <h3 className="font-bold text-[10px] sm:text-sm mb-1 sm:mb-2 text-yellow-400/80 uppercase tracking-wider">Controls</h3>
            <ul className="text-[9px] sm:text-xs space-y-0.5 sm:space-y-1 font-mono text-slate-300">
            <li>W / UP : Accelerate</li>
            <li>S / DOWN : Brake</li>
            <li>A / D  : Turn</li>
            <li>SPACE  : Drift</li>
            <li>SHIFT  : Nitro</li>
            <li>TAB    : Phone</li>
            <li>C      : Free Cam</li>
            <li>0      : Debugger</li>
            </ul>
        </div>
      </div>
    </div>
  );
}
