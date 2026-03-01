/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

export type PowerUpType = 'speed' | 'shield' | 'multiplier';

export type PowerUp = {
  id: string;
  type: PowerUpType;
  x: number;
  y: number;
  active: boolean;
};

export type Player = {
  id: string;
  x: number;
  y: number;
  angle: number;
  color: string;
  name: string;
  speed: number;
  score: number;
  hasGoods: boolean;
  targetZoneIndex: number;
  nitro: number;
  drifting: boolean;
  isWalking: boolean;
  carX: number;
  carY: number;
  carAngle: number;
  activePowerUp?: PowerUpType;
  powerUpEndTime?: number;
  damage: number;
  headlightsOn: boolean;
};
