/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { socket } from '../services/socket';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { PerspectiveCamera, Environment, Text, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';
import { Player } from '../types';
import useSound from '../hooks/useSound';

const noise2D = createNoise2D();

const TRACK_WIDTH = 1200;
const TRACK_HEIGHT = 850;

// Car physics constants
const ACCELERATION = 0.08;
const MAX_SPEED = 2.8;
const NITRO_SPEED = 4.5;
const NITRO_ACCEL = 0.15;
const FRICTION = 0.96;
const TURN_SPEED = 0.045;
const DRIFT_FACTOR = 0.94;

// Track Geometry
const TRACK_RADIUS = 50; // Slightly narrower for more technical turns
const TRACK_SEGMENTS = [
    { start: {x: 150, y: 500}, end: {x: 450, y: 500}, angle: 0 },
    { start: {x: 450, y: 500}, end: {x: 450, y: 300}, angle: -Math.PI/2 },
    { start: {x: 450, y: 300}, end: {x: 300, y: 300}, angle: Math.PI },
    { start: {x: 300, y: 300}, end: {x: 300, y: 100}, angle: -Math.PI/2 },
    { start: {x: 300, y: 100}, end: {x: 750, y: 100}, angle: 0 },
    { start: {x: 750, y: 100}, end: {x: 750, y: 400}, angle: Math.PI/2 },
    { start: {x: 750, y: 400}, end: {x: 600, y: 400}, angle: Math.PI },
    { start: {x: 600, y: 400}, end: {x: 600, y: 600}, angle: Math.PI/2 },
    { start: {x: 600, y: 600}, end: {x: 950, y: 600}, angle: 0 },
    { start: {x: 950, y: 600}, end: {x: 950, y: 150}, angle: -Math.PI/2 },
    { start: {x: 950, y: 150}, end: {x: 1100, y: 150}, angle: 0 },
    { start: {x: 1100, y: 150}, end: {x: 1100, y: 750}, angle: Math.PI/2 },
    { start: {x: 1100, y: 750}, end: {x: 150, y: 750}, angle: Math.PI },
    { start: {x: 150, y: 750}, end: {x: 150, y: 500}, angle: -Math.PI/2 }
];

const DELIVERY_ZONES = [
  { x: 300, y: 500, name: 'Factory', color: '#ff00ff' },
  { x: 300, y: 100, name: 'Warehouse', color: '#00ffff' },
  { x: 750, y: 250, name: 'Docks', color: '#ffff00' },
  { x: 775, y: 600, name: 'Store', color: '#ff8800' },
  { x: 1100, y: 450, name: 'Market', color: '#00ff00' },
  { x: 625, y: 750, name: 'HQ', color: '#ff0000' },
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
  const p = {x, y};
  let minDist = Infinity;
  for (const seg of TRACK_SEGMENTS) {
    const d = distToSegment(p, seg.start, seg.end);
    if (d < minDist) minDist = d;
  }
  
  if (minDist <= TRACK_RADIUS) return 0;
  
  const blendDist = 60;
  const distFromEdge = minDist - TRACK_RADIUS;
  const blend = Math.min(1, distFromEdge / blendDist);
  
  const n1 = noise2D(x * 0.002, y * 0.002) * 40 + 20;
  const n2 = noise2D(x * 0.01, y * 0.01) * 10;
  const n3 = noise2D(x * 0.05, y * 0.05) * 2;
  const n4 = Math.max(0, noise2D(x * 0.001, y * 0.001)) * 80;
  
  return Math.max(-5, (n1 + n2 + n3 + n4)) * blend;
};

// 3D Components
const CarModel = ({ color, isLocal, drifting }: { color: string, isLocal?: boolean, drifting?: boolean }) => {
  return (
    <group scale={[2, 2, 2]}>
      {/* Body */}
      <mesh position={[0, 0.5, 0]} castShadow receiveShadow>
        <boxGeometry args={[2, 1, 4]} />
        <meshStandardMaterial color={color} metalness={0.8} roughness={0.3} />
      </mesh>
      {/* Cabin */}
      <mesh position={[0, 1.2, -0.5]} castShadow>
        <boxGeometry args={[1.8, 0.8, 2]} />
        <meshStandardMaterial color="#222" metalness={0.7} roughness={0.2} />
      </mesh>
      {/* Spoiler */}
      <mesh position={[0, 1.1, -2.2]} castShadow>
        <boxGeometry args={[2.2, 0.2, 0.5]} />
        <meshStandardMaterial color="#111" metalness={0.8} roughness={0.3} />
      </mesh>
      {/* Wheels */}
      <mesh position={[1.1, 0.4, 1.2]} rotation={[0, 0, Math.PI/2]} castShadow>
        <cylinderGeometry args={[0.4, 0.4, 0.4, 16]} />
        <meshStandardMaterial color="#111" roughness={0.6} />
      </mesh>
      <mesh position={[-1.1, 0.4, 1.2]} rotation={[0, 0, Math.PI/2]} castShadow>
        <cylinderGeometry args={[0.4, 0.4, 0.4, 16]} />
        <meshStandardMaterial color="#111" roughness={0.6} />
      </mesh>
      <mesh position={[1.1, 0.4, -1.2]} rotation={[0, 0, Math.PI/2]} castShadow>
        <cylinderGeometry args={[0.4, 0.4, 0.4, 16]} />
        <meshStandardMaterial color="#111" roughness={0.6} />
      </mesh>
      <mesh position={[-1.1, 0.4, -1.2]} rotation={[0, 0, Math.PI/2]} castShadow>
        <cylinderGeometry args={[0.4, 0.4, 0.4, 16]} />
        <meshStandardMaterial color="#111" roughness={0.6} />
      </mesh>
      {/* Headlights */}
      <mesh position={[0.6, 0.6, 2.05]}>
        <boxGeometry args={[0.5, 0.2, 0.1]} />
        <meshStandardMaterial color="#ffffaa" emissive="#ffffaa" emissiveIntensity={3} />
      </mesh>
      <mesh position={[-0.6, 0.6, 2.05]}>
        <boxGeometry args={[0.5, 0.2, 0.1]} />
        <meshStandardMaterial color="#ffffaa" emissive="#ffffaa" emissiveIntensity={3} />
      </mesh>
      {/* Taillights */}
      <mesh position={[0.6, 0.6, -2.05]}>
        <boxGeometry args={[0.5, 0.2, 0.1]} />
        <meshStandardMaterial color="#ff0000" emissive="#ff0000" emissiveIntensity={2} />
      </mesh>
      <mesh position={[-0.6, 0.6, -2.05]}>
        <boxGeometry args={[0.5, 0.2, 0.1]} />
        <meshStandardMaterial color="#ff0000" emissive="#ff0000" emissiveIntensity={2} />
      </mesh>
      
      {/* Drift Smoke Particles (Simple visual representation attached to car) */}
      {drifting && (
        <group>
          <mesh position={[1.2, 0.2, -1.5]}>
             <sphereGeometry args={[0.3, 8, 8]} />
             <meshBasicMaterial color="#aaa" transparent opacity={0.6} />
          </mesh>
          <mesh position={[-1.2, 0.2, -1.5]}>
             <sphereGeometry args={[0.3, 8, 8]} />
             <meshBasicMaterial color="#aaa" transparent opacity={0.6} />
          </mesh>
        </group>
      )}

      {isLocal && (
        <pointLight position={[0, 2, 4]} intensity={10} distance={20} color="white" />
      )}
    </group>
  );
};

const Tree = ({ position, scale = 1 }: { position: [number, number, number], scale?: number }) => {
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
        <meshStandardMaterial color="#2d5a27" />
      </mesh>
      <mesh position={[0, 13, 0]} castShadow>
        <coneGeometry args={[3, 7, 8]} />
        <meshStandardMaterial color="#3a7532" />
      </mesh>
    </group>
  );
};

const Rock = ({ position, scale = 1 }: { position: [number, number, number], scale?: number }) => {
  return (
    <mesh position={position} scale={scale} castShadow receiveShadow>
      <dodecahedronGeometry args={[1.5, 0]} />
      <meshStandardMaterial color="#666" roughness={0.9} />
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

const GrassMesh = () => {
  const geomRef = useRef<THREE.PlaneGeometry>(null);
  
  useEffect(() => {
    if (geomRef.current) {
      const pos = geomRef.current.attributes.position;
      const colors = new Float32Array(pos.count * 3);
      const colorObj = new THREE.Color();
      
      for (let i = 0; i < pos.count; i++) {
        const localX = pos.getX(i);
        const localY = pos.getY(i);
        const worldX = localX + TRACK_WIDTH/2;
        const worldY = localY + TRACK_HEIGHT/2;
        
        const h = getTerrainHeight(worldX, worldY);
        pos.setZ(i, h);
        
        if (h < 5) {
            colorObj.set('#2a5c3a');
        } else if (h < 20) {
            colorObj.set('#3a704a');
        } else if (h < 40) {
            colorObj.set('#6b705c');
        } else {
            colorObj.set('#8a8a8a');
        }
        
        const noise = noise2D(worldX * 0.1, worldY * 0.1) * 0.05;
        colorObj.offsetHSL(0, 0, noise);
        
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
      <planeGeometry ref={geomRef} args={[3000, 3000, 200, 200]} />
      <meshStandardMaterial vertexColors roughness={0.9} metalness={0.1} />
    </mesh>
  );
};

const TrackMesh = () => {
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
        <mesh key={seg.id} position={[seg.centerX, seg.centerY, 0.1]} rotation={[0, 0, seg.angle]} receiveShadow>
          <planeGeometry args={[seg.length, TRACK_RADIUS * 2]} />
          <meshStandardMaterial color="#444" roughness={0.7} metalness={0.2} />
        </mesh>
      ))}

      {/* Smooth Corners */}
      {corners.map((pos, i) => (
        <mesh key={i} position={[pos.x, pos.y, 0.1]} receiveShadow>
          <circleGeometry args={[TRACK_RADIUS, 32]} />
          <meshStandardMaterial color="#444" roughness={0.7} metalness={0.2} />
        </mesh>
      ))}
      
      {/* Start Line */}
      <mesh position={[625, 750, 0.12]} rotation={[0, 0, 0]}>
        <planeGeometry args={[10, TRACK_RADIUS * 2]} />
        <meshStandardMaterial color="white" emissive="white" emissiveIntensity={0.5} />
      </mesh>
    </group>
  );
};

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

const GameScene = ({ 
  localPlayerRef, 
  players, 
  myId,
  showCompass
}: { 
  localPlayerRef: React.MutableRefObject<any>, 
  players: Record<string, Player>, 
  myId: string | null,
  showCompass: boolean
}) => {
  const { camera } = useThree();
  const carRef = useRef<THREE.Group>(null);
  const charRef = useRef<THREE.Group>(null);

  const decorations = useMemo(() => {
    const items: { type: 'tree' | 'rock', pos: [number, number, number], scale: number }[] = [];
    const count = 500; // Increased for better density
    const seed = 42;
    const rng = (s: number) => {
        const x = Math.sin(s) * 10000;
        return x - Math.floor(x);
    };
    let s = seed;

    for (let i = 0; i < count; i++) {
      // Area large enough to fill the new draw distance
      const x = rng(s++) * 3000 - 900; 
      const z = rng(s++) * 3000 - 1075;
      
      // Check if on track using the math helper with a buffer to account for decoration size
      if (!isPointOnTrackMath(x, z, 20)) {
        const type = rng(s++) > 0.4 ? 'tree' : 'rock';
        const scale = type === 'tree' ? 2.5 + rng(s++) * 3.5 : 3 + rng(s++) * 5;
        const y = getTerrainHeight(x, z);
        items.push({ type, pos: [x, y, z], scale });
      }
    }
    return items;
  }, []);
  
  useFrame((state, delta) => {
    if (localPlayerRef.current && carRef.current) {
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
          carRef.current.position.set(p.x, carH, p.y);
          carRef.current.rotation.y = -p.angle + Math.PI/2;
          
          if (charRef.current) {
              charRef.current.visible = false;
          }
          
          // Camera Follow
          const dist = 40;
          const height = carH + 20;
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
      
      {/* Decorative Elements */}
      {decorations.map((item, i) => (
        item.type === 'tree' ? (
          <Tree key={i} position={item.pos} scale={item.scale} />
        ) : (
          <Rock key={i} position={item.pos} scale={item.scale} />
        )
      ))}
      
      {/* Delivery Zones */}
      {DELIVERY_ZONES.map((zone, i) => {
        const isTarget = localPlayerRef.current?.targetZoneIndex === i;
        return (
          <group key={i} position={[zone.x, 0.1, zone.y]}>
            <mesh rotation={[-Math.PI / 2, 0, 0]}>
              <circleGeometry args={[20, 32]} />
              <meshBasicMaterial color={zone.color} transparent opacity={isTarget ? 0.6 : 0.2} />
            </mesh>
            {isTarget && (
              <mesh position={[0, 10, 0]}>
                <cylinderGeometry args={[15, 15, 20, 16]} />
                <meshBasicMaterial color={zone.color} transparent opacity={0.3} />
              </mesh>
            )}
            <Text position={[0, 5, 0]} fontSize={4} color="white" anchorX="center" anchorY="middle" outlineWidth={0.2} outlineColor="black">
              {zone.name}
            </Text>
          </group>
        );
      })}

      {/* Local Player */}
      <group ref={carRef}>
        <CarModel color={players[myId || '']?.color || 'red'} isLocal={!localPlayerRef.current?.isWalking} drifting={localPlayerRef.current?.drifting && !localPlayerRef.current?.isWalking} />
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
              <CarModel color={p.color} drifting={p.drifting && !p.isWalking} />
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

export default function GameCanvas({ 
  initialPlayers, 
  onExitGame,
  settings
}: { 
  initialPlayers?: Record<string, Player>, 
  onExitGame: () => void,
  settings: { volume: number, showCompass: boolean, showLog: boolean }
}) {
  // Sound Effects
  const { play: playEngine, stop: stopEngine, setVolume: setEngineVolume } = useSound('/sounds/engine_loop.mp3', { loop: true, volume: 0.3 * (settings.volume / 100) });
  const { play: playDrift, stop: stopDrift, setVolume: setDriftVolume } = useSound('/sounds/drift.mp3', { volume: 0.7 * (settings.volume / 100) });
  const { play: playNitro, setVolume: setNitroVolume } = useSound('/sounds/nitro.mp3', { volume: 0.8 * (settings.volume / 100) });
  const { play: playCollision, setVolume: setCollisionVolume } = useSound('/sounds/collision.mp3', { volume: 0.9 * (settings.volume / 100) });

  useEffect(() => {
    setEngineVolume(0.3 * (settings.volume / 100));
    setDriftVolume(0.7 * (settings.volume / 100));
    setNitroVolume(0.8 * (settings.volume / 100));
    setCollisionVolume(0.9 * (settings.volume / 100));
  }, [settings.volume, setEngineVolume, setDriftVolume, setNitroVolume, setCollisionVolume]);

  // Sanitize initial players
  const sanitizedInitial = useMemo(() => {
      if (!initialPlayers) return {};
      return Object.entries(initialPlayers).reduce((acc, [id, p]) => {
        acc[id] = { ...p, score: p.score || 0 };
        return acc;
      }, {} as Record<string, Player>);
  }, [initialPlayers]);

  const [players, setPlayers] = useState<Record<string, Player>>(sanitizedInitial);
  const [myId, setMyId] = useState<string | null>(socket.id || null);
  const [laps, setLaps] = useState(0);
  const [lastLapTime, setLastLapTime] = useState<number | null>(null);
  const [currentLapStart, setCurrentLapStart] = useState<number>(Date.now());
  const [nitro, setNitro] = useState(100);
  const [wrongWay, setWrongWay] = useState(false);
  const [showDebugger, setShowDebugger] = useState(false);
  const [showPhone, setShowPhone] = useState(false);
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
  }>({
    x: 660,
    y: 750,
    angle: Math.PI,
    speed: 0,
    keys: {},
    checkpoint: 3, // Start in sector 3 (before finish line)
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

  // Particle System
  const [particles, setParticles] = useState<{id: number, x: number, y: number, life: number}[]>([]);
  const particleIdCounter = useRef(0);

  useEffect(() => {
    // Socket event listeners
    socket.on('connect', () => {
      setMyId(socket.id || null);
    });

    // 'currentPlayers' and 'newPlayer' are handled in Lobby now.
    // We only need game-specific updates here.
    
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

    return () => {
      socket.off('connect');
      socket.off('playerJoinedRoom');
      socket.off('playerMoved');
      socket.off('playerDisconnected');
      socket.off('deliveryUpdate');
      stopEngine();
      stopDrift();
    };
  }, []);

  // Input handling
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      localPlayer.current.keys[e.code] = true;
      if (e.code === 'Backquote') {
        setShowDebugger(prev => !prev);
      }
      if (e.code === 'Tab') {
        e.preventDefault();
        setShowPhone(prev => !prev);
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
          p.nitro = Math.min(100, p.nitro + 0.2); // recharge nitro while walking
          setNitro(p.nitro);
          p.drifting = false;
          if (enginePlaying) {
              stopEngine();
              enginePlaying = false;
          }
      } else {
          // Engine Sound
          if (!enginePlaying) {
              playEngine();
              enginePlaying = true;
          }
          setEngineVolume(Math.min(1, 0.3 + Math.abs(p.speed) / MAX_SPEED * 0.7));

          // Acceleration
          if (p.keys['ArrowUp'] || p.keys['KeyW']) {
            p.speed += ACCELERATION;
          } else if (p.keys['ArrowDown'] || p.keys['KeyS']) {
            p.speed -= ACCELERATION;
          } else {
            p.speed *= FRICTION;
          }

          // Nitro
          if ((p.keys['ShiftLeft'] || p.keys['ShiftRight']) && p.nitro > 0) {
              p.speed += NITRO_ACCEL;
              p.nitro = Math.max(0, p.nitro - 1);
              playNitro();
          } else {
              p.nitro = Math.min(100, p.nitro + 0.2);
          }
          setNitro(p.nitro);

          // Drifting Logic
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

          // Turning
          if (Math.abs(p.speed) > 0.1) {
            let turn = TURN_SPEED * (p.speed / MAX_SPEED);
            
            if (p.drifting) {
                turn *= 1.6;
                p.speed *= 0.97;
                p.shake = Math.min(p.shake + 0.2, 1.5); // Add shake when drifting
                
                if (Math.random() > 0.5) {
                    setParticles(prev => [
                        ...prev, 
                        {
                            id: particleIdCounter.current++, 
                            x: p.x + (Math.random() - 0.5) * 2, 
                            y: p.y + (Math.random() - 0.5) * 2, 
                            life: 1.0
                        }
                    ]);
                }
            }

            if (p.keys['ArrowLeft'] || p.keys['KeyA']) {
              p.angle -= turn;
            }
            if (p.keys['ArrowRight'] || p.keys['KeyD']) {
              p.angle += turn;
            }
          }

          p.x += Math.cos(p.angle) * p.speed;
          p.y += Math.sin(p.angle) * p.speed;
          
          p.carX = p.x;
          p.carY = p.y;
          p.carAngle = p.angle;
      }

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
        // Off-track: Apply heavy friction/slowdown instead of hard wall
        p.speed *= 0.85; // Rapidly slow down
        
        // Cap max speed on grass
        if (p.speed > 1.0) p.speed = 1.0;
        if (p.speed < -0.5) p.speed = -0.5;

        p.drifting = false; // Harder to drift on grass
        
        if (Math.abs(p.speed) > 0.5) {
            p.shake = Math.min(p.shake + 0.5, 2.5); // Add shake when off-track
            playCollision();
        }
      }

      // Delivery Logic
      const targetZone = DELIVERY_ZONES[p.targetZoneIndex];
      if (targetZone) {
          const distToZone = Math.hypot(p.x - targetZone.x, p.y - targetZone.y);
          if (distToZone < 40) { // Zone radius
              // Reached target!
              if (p.hasGoods) {
                  p.score += 1;
                  p.hasGoods = false;
                  addLog('Delivery successful! +1 Point', 'text-green-400');
              } else {
                  p.hasGoods = true;
                  addLog('Goods picked up! Deliver them to the next zone.', 'text-yellow-400');
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

      // Wrong Way Detection (simplified or removed for delivery mode)
      // For delivery, wrong way doesn't make as much sense since you can go anywhere.
      // We'll just disable it.
      if (wrongWay) setWrongWay(false);

      // Send update
      if (socket.connected) {
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
      }

      animationFrameId = requestAnimationFrame(updatePhysics);
    };

    updatePhysics();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [currentLapStart]);

  return (
    <div className="relative w-full h-[850px] bg-slate-900 rounded-xl overflow-hidden shadow-2xl border-4 border-slate-700">
      <Canvas shadows>
        <color attach="background" args={['#0f172a']} />
        <PerspectiveCamera makeDefault position={[0, 50, 50]} fov={60} far={1000} />
        <fog attach="fog" args={['#0f172a', 100, 900]} />
        <GameScene localPlayerRef={localPlayer} players={players} myId={myId} showCompass={settings.showCompass} />
        
        {/* Particles */}
        {particles.map(pt => (
            <mesh key={pt.id} position={[pt.x, getTerrainHeight(pt.x, pt.y) + 2, pt.y]} rotation={[-Math.PI/2, 0, 0]}>
                <planeGeometry args={[1.5 * pt.life, 1.5 * pt.life]} />
                <meshBasicMaterial color="#888" transparent opacity={0.4 * pt.life} />
            </mesh>
        ))}

        <OrbitControls enabled={false} />
      </Canvas>
      
      {/* HUD Overlay */}
      
      {/* Top Left: Exit Game Button */}
      <div className="absolute top-6 left-6 pointer-events-auto">
        <button
          onClick={onExitGame}
          className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm text-white font-bold transition-colors shadow-lg border border-white/10"
        >
          Back to Menu
        </button>
      </div>

      {/* Top Right: Cash & Phone Prompt */}
      <div className="absolute top-6 right-6 flex flex-col items-end gap-4 pointer-events-none">
          <div className="bg-black/50 text-white px-6 py-3 rounded-xl border border-white/10 backdrop-blur-md flex items-center gap-4 shadow-lg">
              <div className="text-right">
                  <div className="text-xs text-slate-400 uppercase tracking-wider font-bold">Cash</div>
                  <div className="text-2xl font-mono font-bold text-green-400 leading-none">
                      ${(players[socket.id || '']?.score || 0) * 100}
                  </div>
              </div>
          </div>
          
          <div className="bg-black/50 text-white px-4 py-2 rounded-xl border border-white/10 backdrop-blur-md flex items-center gap-3 shadow-lg">
              <div className="w-6 h-10 bg-slate-800 rounded-md border-2 border-slate-600 flex items-center justify-center">
                  <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></div>
              </div>
              <div className="text-sm font-bold text-slate-300">
                  Press <span className="text-yellow-400 font-mono bg-black/50 px-2 py-1 rounded">TAB</span> for Phone
              </div>
          </div>
      </div>

      {/* Bottom Center: Nitro Bar */}
      <div className="absolute bottom-10 left-1/2 -translate-x-1/2 pointer-events-none w-80">
          <div className="flex justify-between text-xs text-slate-400 uppercase tracking-wider font-bold mb-2">
              <span>Nitro</span>
              <span>{Math.round(nitro)}%</span>
          </div>
          <div className="w-full h-4 bg-slate-800/50 rounded-full overflow-hidden border border-white/20 backdrop-blur-md">
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
        <div className="absolute bottom-6 right-6 pointer-events-none z-50">
          <div className="bg-black/80 text-green-400 p-4 rounded-lg border border-green-500/30 font-mono text-xs w-64 shadow-2xl backdrop-blur-sm">
            <div className="flex justify-between border-b border-green-500/30 pb-2 mb-2">
              <span className="font-bold">DEBUGGER</span>
              <span className="text-green-600">~ to toggle</span>
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
        <div className="absolute top-32 right-6 flex flex-col items-end gap-2 pointer-events-none z-40">
          {eventLog.map(log => (
            <div 
              key={log.id} 
              className={`bg-black/60 px-4 py-2 rounded-lg border border-white/10 backdrop-blur-sm text-sm font-bold shadow-lg transition-all duration-500 animate-in slide-in-from-right-8 fade-in ${log.color}`}
            >
              {log.message}
            </div>
          ))}
        </div>
      )}

      {/* Virtual Phone */}
      {showPhone && (
        <div className="absolute right-10 bottom-10 w-80 h-[600px] bg-slate-900 rounded-[3rem] border-[8px] border-slate-800 shadow-2xl overflow-hidden flex flex-col pointer-events-auto z-50 transform transition-transform duration-300">
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
      <div className="absolute bottom-6 left-6 text-white pointer-events-none opacity-50 hover:opacity-100 transition-opacity duration-300">
        <div className="bg-black/40 p-5 rounded-xl backdrop-blur-md border border-white/10">
            <h3 className="font-bold text-sm mb-2 text-yellow-400/80">Controls</h3>
            <ul className="text-xs space-y-1 font-mono text-slate-300">
            <li>W / UP : Accelerate</li>
            <li>S / DOWN : Brake</li>
            <li>A / D  : Turn</li>
            <li>SPACE  : Drift</li>
            <li>SHIFT  : Nitro</li>
            <li>TAB    : Phone</li>
            <li>~      : Toggle Debugger</li>
            </ul>
        </div>
      </div>
    </div>
  );
}
