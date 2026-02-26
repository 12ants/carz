/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import GameCanvas from './components/GameCanvas';
import { socket } from './services/socket';
import { Player } from './types';

export default function App() {
  const [view, setView] = useState<'intro' | 'landing' | 'lobby' | 'game' | 'options' | 'credits' | 'settings'>('intro');
  const [roomCode, setRoomCode] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [players, setPlayers] = useState<Record<string, Player>>({});
  const [isHost, setIsHost] = useState(false);
  const [error, setError] = useState('');
  
  // Settings state
  const [settings, setSettings] = useState({
    volume: 50,
    showCompass: true,
    showLog: true,
  });

  useEffect(() => {
    socket.on('roomCreated', ({ roomId, players, isHost }) => {
      setRoomCode(roomId);
      setPlayers(players);
      setIsHost(isHost);
      setView('lobby');
      setError('');
    });

    socket.on('roomJoined', ({ roomId, players, isHost }) => {
      setRoomCode(roomId);
      setPlayers(players);
      setIsHost(isHost);
      setView('lobby');
      setError('');
    });

    socket.on('playerJoinedRoom', (player) => {
      setPlayers((prev) => ({ ...prev, [player.id]: player }));
    });

    socket.on('playerDisconnected', (id) => {
      setPlayers((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    });

    socket.on('gameStarted', (initialPlayers) => {
      setPlayers(initialPlayers);
      setView('game');
    });

    socket.on('error', (msg) => {
      setError(msg);
    });
    
    socket.on('hostMigrated', (newHostId) => {
        if (socket.id === newHostId) {
            setIsHost(true);
        }
    });

    return () => {
      socket.off('roomCreated');
      socket.off('roomJoined');
      socket.off('playerJoinedRoom');
      socket.off('playerDisconnected');
      socket.off('gameStarted');
      socket.off('error');
      socket.off('hostMigrated');
    };
  }, []);

  const handleCreate = () => {
    socket.emit('createRoom');
  };

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!joinCode.trim() || joinCode.length !== 6) {
        setError('Please enter a valid 6-character room code');
        return;
    }
    socket.emit('joinRoom', { roomId: joinCode.toUpperCase() });
  };

  const handleStartGame = () => {
    socket.emit('startGame');
  };

  const handleGoToLanding = () => {
    setView('landing');
    setError('');
  };

  const handleGoToOptions = () => {
    setView('options');
    setError('');
  };

  const handleGoToCredits = () => {
    setView('credits');
    setError('');
  };

  const handleGoToSettings = () => {
    setView('settings');
    setError('');
  };

  const handleGoToIntro = () => {
    setView('intro');
    setError('');
    setRoomCode('');
    setJoinCode('');
    setPlayers({});
    setIsHost(false);
    socket.disconnect();
    socket.connect();
  };

  return (
    <div className={`min-h-screen bg-slate-900 flex flex-col items-center ${view === 'game' ? 'justify-start' : 'justify-center'} font-sans text-slate-100`}>
      <header className={`w-full max-w-4xl mx-auto ${view === 'game' ? 'p-2' : 'p-6'} flex justify-between items-center transition-all`}>
        <h1 className={`${view === 'game' ? 'text-2xl' : 'text-4xl'} font-black italic tracking-tighter text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 to-orange-500 transform -skew-x-12 transition-all`}>
          TURBO RACE
        </h1>
        {(view !== 'intro') && (
          <button 
            onClick={handleGoToIntro}
            className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm text-white font-bold transition-colors"
          >
            Back to Menu
          </button>
        )}
      </header>

      <main className={`flex-1 w-full flex flex-col items-center ${view === 'game' ? 'p-0' : 'p-4'} transition-all`}>
        {view === 'intro' && (
          <div className="bg-slate-800 p-8 rounded-2xl shadow-2xl border border-slate-700 max-w-md w-full text-center">
            <h2 className="text-4xl font-black italic tracking-tighter text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 to-orange-500 transform -skew-x-6 mb-8">TURBO RACE</h2>
            <div className="space-y-4">
              <button
                onClick={handleGoToLanding}
                className="w-full bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 text-white font-bold py-4 rounded-lg shadow-lg text-xl tracking-wide transition-transform active:scale-95"
              >
                START GAME
              </button>
              <button
                onClick={handleGoToOptions}
                className="w-full bg-slate-700 hover:bg-slate-600 text-white font-bold py-3 rounded-lg shadow-md transition-transform active:scale-95"
              >
                HOW TO PLAY
              </button>
              <button
                onClick={handleGoToSettings}
                className="w-full bg-slate-700 hover:bg-slate-600 text-white font-bold py-3 rounded-lg shadow-md transition-transform active:scale-95"
              >
                SETTINGS
              </button>
              <button
                onClick={handleGoToCredits}
                className="w-full bg-slate-700 hover:bg-slate-600 text-white font-bold py-3 rounded-lg shadow-md transition-transform active:scale-95"
              >
                CREDITS
              </button>
            </div>
          </div>
        )}

        {view === 'landing' && (
          <div className="bg-slate-800 p-8 rounded-2xl shadow-2xl border border-slate-700 max-w-md w-full">
            <h2 className="text-2xl font-bold mb-6 text-center">Start Your Engines</h2>
            
            <div className="space-y-6">
              {error && <div className="text-red-400 text-sm text-center bg-red-900/20 p-2 rounded">{error}</div>}

              <div className="grid grid-cols-1 gap-4">
                <button
                  onClick={handleCreate}
                  className="w-full bg-gradient-to-r from-yellow-500 to-orange-600 hover:from-yellow-400 hover:to-orange-500 text-black font-bold py-3 rounded-lg shadow-lg transition-transform active:scale-95"
                >
                  CREATE RACE
                </button>
                
                <div className="relative">
                    <div className="absolute inset-0 flex items-center">
                        <div className="w-full border-t border-slate-700"></div>
                    </div>
                    <div className="relative flex justify-center text-sm">
                        <span className="px-2 bg-slate-800 text-slate-500">Or join a friend</span>
                    </div>
                </div>

                <form onSubmit={handleJoin} className="flex gap-2">
                    <input
                        type="text"
                        value={joinCode}
                        onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                        className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-4 py-3 text-white uppercase tracking-widest font-mono focus:ring-2 focus:ring-blue-500 outline-none"
                        placeholder="CODE"
                        maxLength={6}
                    />
                    <button
                        type="submit"
                        className="bg-blue-600 hover:bg-blue-500 text-white font-bold px-6 py-3 rounded-lg shadow-lg transition-transform active:scale-95"
                    >
                        JOIN
                    </button>
                </form>
              </div>
            </div>
          </div>
        )}

        {view === 'lobby' && (
            <div className="bg-slate-800 p-8 rounded-2xl shadow-2xl border border-slate-700 max-w-2xl w-full">
                <div className="text-center mb-8">
                    <h2 className="text-xl text-slate-400 mb-2">Room Code</h2>
                    <div className="text-6xl font-mono font-black tracking-widest text-yellow-400 bg-black/30 p-4 rounded-xl inline-block border-2 border-dashed border-slate-600 select-all">
                        {roomCode}
                    </div>
                    <p className="text-sm text-slate-500 mt-2">Share this code with your friends!</p>
                </div>

                <div className="mb-8">
                    <h3 className="text-lg font-bold mb-4 flex justify-between items-center">
                        <span>Racers ({Object.keys(players).length})</span>
                        {isHost && <span className="text-xs bg-yellow-500/20 text-yellow-400 px-2 py-1 rounded">You are Host</span>}
                    </h3>
                    <div className="grid grid-cols-2 gap-3">
                        {Object.values(players).map(p => (
                            <div key={p.id} className="bg-slate-700/50 p-3 rounded-lg flex items-center gap-3 border border-slate-600">
                                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: p.color }}></div>
                                <span className="font-bold truncate">{p.name}</span>
                                {p.id === socket.id && <span className="text-xs text-slate-400">(You)</span>}
                            </div>
                        ))}
                    </div>
                </div>

                {isHost ? (
                    <button
                        onClick={handleStartGame}
                        className="w-full bg-green-600 hover:bg-green-500 text-white font-bold py-4 rounded-xl shadow-lg text-xl tracking-wide transition-transform active:scale-95 animate-pulse"
                    >
                        START RACE
                    </button>
                ) : (
                    <div className="text-center text-slate-400 italic animate-pulse">
                        Waiting for host to start the race...
                    </div>
                )}
            </div>
        )}

        {view === 'options' && (
          <div className="bg-slate-800 p-8 rounded-2xl shadow-2xl border border-slate-700 max-w-md w-full">
            <h2 className="text-2xl font-bold mb-6 text-center text-yellow-400">How to Play</h2>
            <div className="space-y-4 text-slate-300">
              <div className="bg-slate-900 p-4 rounded-lg border border-slate-700">
                <h3 className="font-bold text-white mb-2">Controls</h3>
                <ul className="list-disc list-inside space-y-1 text-sm">
                  <li><span className="text-yellow-400 font-mono">W / UP</span> - Accelerate</li>
                  <li><span className="text-yellow-400 font-mono">S / DOWN</span> - Brake / Reverse</li>
                  <li><span className="text-yellow-400 font-mono">A / D</span> - Steer</li>
                  <li><span className="text-yellow-400 font-mono">SPACE</span> - Drift</li>
                  <li><span className="text-yellow-400 font-mono">SHIFT</span> - Nitro Boost</li>
                  <li><span className="text-yellow-400 font-mono">E / F</span> - Enter/Exit Car</li>
                  <li><span className="text-yellow-400 font-mono">~</span> - Toggle Debugger</li>
                </ul>
              </div>
              <div className="bg-slate-900 p-4 rounded-lg border border-slate-700">
                <h3 className="font-bold text-white mb-2">Objective</h3>
                <p className="text-sm leading-relaxed">
                  Drive to the designated <span className="text-blue-400 font-bold">PICKUP</span> zones to collect goods, then race to the <span className="text-green-400 font-bold">DELIVERY</span> zones to drop them off. Compete with friends for the highest score!
                </p>
              </div>
              <button
                onClick={handleGoToIntro}
                className="w-full bg-slate-700 hover:bg-slate-600 text-white font-bold py-3 rounded-lg shadow-md transition-transform active:scale-95 mt-4"
              >
                BACK TO MENU
              </button>
            </div>
          </div>
        )}

        {view === 'settings' && (
          <div className="bg-slate-800 p-8 rounded-2xl shadow-2xl border border-slate-700 max-w-md w-full">
            <h2 className="text-2xl font-bold mb-6 text-center text-yellow-400">Settings</h2>
            <div className="space-y-6 text-slate-300">
              <div className="space-y-2">
                <div className="flex justify-between">
                  <label className="font-bold text-white">Master Volume</label>
                  <span className="text-yellow-400 font-mono">{settings.volume}%</span>
                </div>
                <input 
                  type="range" 
                  min="0" 
                  max="100" 
                  value={settings.volume}
                  onChange={(e) => setSettings(prev => ({...prev, volume: parseInt(e.target.value)}))}
                  className="w-full accent-yellow-400"
                />
              </div>
              
              <div className="flex items-center justify-between">
                <label className="font-bold text-white">Show Compass</label>
                <button 
                  onClick={() => setSettings(prev => ({...prev, showCompass: !prev.showCompass}))}
                  className={`w-12 h-6 rounded-full transition-colors relative ${settings.showCompass ? 'bg-green-500' : 'bg-slate-600'}`}
                >
                  <div className={`w-4 h-4 rounded-full bg-white absolute top-1 transition-transform ${settings.showCompass ? 'translate-x-7' : 'translate-x-1'}`} />
                </button>
              </div>

              <div className="flex items-center justify-between">
                <label className="font-bold text-white">Show Event Log</label>
                <button 
                  onClick={() => setSettings(prev => ({...prev, showLog: !prev.showLog}))}
                  className={`w-12 h-6 rounded-full transition-colors relative ${settings.showLog ? 'bg-green-500' : 'bg-slate-600'}`}
                >
                  <div className={`w-4 h-4 rounded-full bg-white absolute top-1 transition-transform ${settings.showLog ? 'translate-x-7' : 'translate-x-1'}`} />
                </button>
              </div>

              <button
                onClick={handleGoToIntro}
                className="w-full bg-slate-700 hover:bg-slate-600 text-white font-bold py-3 rounded-lg shadow-md transition-transform active:scale-95 mt-4"
              >
                BACK TO MENU
              </button>
            </div>
          </div>
        )}

        {view === 'credits' && (
          <div className="bg-slate-800 p-8 rounded-2xl shadow-2xl border border-slate-700 max-w-md w-full">
            <h2 className="text-2xl font-bold mb-6 text-center text-yellow-400">Credits</h2>
            <div className="space-y-6 text-slate-300 text-center">
              <div className="bg-slate-900 p-6 rounded-lg border border-slate-700">
                <p className="text-sm uppercase tracking-widest text-slate-500 mb-2">Developed By</p>
                <p className="text-xl font-bold text-white">AI Studio</p>
              </div>
              <div className="bg-slate-900 p-6 rounded-lg border border-slate-700">
                <p className="text-sm uppercase tracking-widest text-slate-500 mb-2">Powered By</p>
                <div className="flex justify-center gap-4 text-lg font-bold">
                  <span className="text-blue-400">React</span>
                  <span className="text-slate-600">&bull;</span>
                  <span className="text-cyan-400">Three.js</span>
                  <span className="text-slate-600">&bull;</span>
                  <span className="text-green-400">Socket.io</span>
                </div>
              </div>
              <button
                onClick={handleGoToIntro}
                className="w-full bg-slate-700 hover:bg-slate-600 text-white font-bold py-3 rounded-lg shadow-md transition-transform active:scale-95 mt-4"
              >
                BACK TO MENU
              </button>
            </div>
          </div>
        )}

        {view === 'game' && (
          <GameCanvas initialPlayers={players} onExitGame={handleGoToIntro} settings={settings} />
        )}
      </main>
    </div>
  );
}
