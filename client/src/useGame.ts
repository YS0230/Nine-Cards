import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  EVT,
  type RoomView,
  type PersonalGameState,
  type GameOverPayload,
  type GameEndedPayload,
  type ActionType,
  type JoinResult,
  type LobbyRoom,
} from '@nine-cards/shared';

// 開發模式下前端(5173)與 server(3001)不同埠，需指定位址；
// 正式部署時 server 直接供應 client build，同源連線交給 socket.io-client 預設行為(undefined)。
const SERVER_URL: string | undefined =
  (import.meta.env.VITE_SERVER_URL as string | undefined) ??
  (import.meta.env.DEV ? `http://${location.hostname}:3001` : undefined);

const LS_TOKEN = 'nineCards.token';
const LS_NAME = 'nineCards.name';

export type Screen = 'home' | 'room' | 'game';

export interface Identity {
  playerId: string;
  token: string;
  roomId: string;
  code: string;
}

export interface GameApi {
  connected: boolean;
  screen: Screen;
  identity: Identity | null;
  room: RoomView | null;
  game: PersonalGameState | null;
  gameOver: GameOverPayload | null;
  gameEnded: GameEndedPayload | null;
  toast: string | null;
  savedName: string;
  lobby: LobbyRoom[];
  createRoom: (name: string, isPublic?: boolean, hints?: boolean, claimSeconds?: number) => void;
  joinRoom: (code: string, name: string) => void;
  quickMatch: (name: string) => void;
  watchLobby: () => void;
  unwatchLobby: () => void;
  startGame: () => void;
  act: (type: ActionType, cardId?: string) => void;
  readyContinue: () => void;
  clearToast: () => void;
  leave: () => void;
}

export function useGame(): GameApi {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [screen, setScreen] = useState<Screen>('home');
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [room, setRoom] = useState<RoomView | null>(null);
  const [game, setGame] = useState<PersonalGameState | null>(null);
  const [gameOver, setGameOver] = useState<GameOverPayload | null>(null);
  const [gameEnded, setGameEnded] = useState<GameEndedPayload | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [lobby, setLobby] = useState<LobbyRoom[]>([]);
  const savedName = localStorage.getItem(LS_NAME) ?? '';

  useEffect(() => {
    const socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      const token = localStorage.getItem(LS_TOKEN);
      if (token) socket.emit(EVT.RESUME, { token }, onJoin);
    });
    socket.on('disconnect', () => setConnected(false));

    socket.on(EVT.ROOM_UPDATE, (view: RoomView) => {
      setRoom(view);
      setGameOver(null);
      if (view.phase === 'WAITING') setScreen('room');
    });
    socket.on(EVT.GAME_STATE, (state: PersonalGameState) => {
      setGame(state);
      setScreen('game');
      if (state.phase !== 'FINISHED') setGameOver(null); // 下一局開始 → 收掉結算視窗
    });
    socket.on(EVT.GAME_OVER, (payload: GameOverPayload) => setGameOver(payload));
    socket.on(EVT.GAME_ENDED, (payload: GameEndedPayload) => setGameEnded(payload)); // 整場結束 → 最終計分版
    socket.on(EVT.ERROR_MSG, (p: { message: string }) => setToast(p.message));
    socket.on(EVT.LOBBY_UPDATE, (list: LobbyRoom[]) => setLobby(list));

    return () => {
      socket.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onJoin = useCallback((res: JoinResult) => {
    if (!res.ok || !res.playerId || !res.token || !res.roomId || !res.code) {
      setToast(res.error ?? '加入失敗');
      localStorage.removeItem(LS_TOKEN);
      return;
    }
    localStorage.setItem(LS_TOKEN, res.token);
    setIdentity({
      playerId: res.playerId,
      token: res.token,
      roomId: res.roomId,
      code: res.code,
    });
  }, []);

  const remember = (name: string) => localStorage.setItem(LS_NAME, name.trim().slice(0, 12));

  const createRoom = useCallback(
    (name: string, isPublic = false, hints = true, claimSeconds?: number) => {
      remember(name);
      socketRef.current?.emit(EVT.CREATE_ROOM, { name, isPublic, hints, claimSeconds }, onJoin);
    },
    [onJoin],
  );
  const joinRoom = useCallback(
    (code: string, name: string) => {
      remember(name);
      socketRef.current?.emit(EVT.JOIN_ROOM, { code, name }, onJoin);
    },
    [onJoin],
  );
  const quickMatch = useCallback(
    (name: string) => {
      remember(name);
      socketRef.current?.emit(EVT.QUICK_MATCH, { name }, onJoin);
    },
    [onJoin],
  );
  const watchLobby = useCallback(() => socketRef.current?.emit(EVT.WATCH_LOBBY), []);
  const unwatchLobby = useCallback(() => socketRef.current?.emit(EVT.UNWATCH_LOBBY), []);
  const startGame = useCallback(() => {
    if (identity) socketRef.current?.emit(EVT.START_GAME, identity.playerId);
  }, [identity]);
  const act = useCallback(
    (type: ActionType, cardId?: string) => {
      if (identity) socketRef.current?.emit(EVT.ACTION, identity.playerId, { type, cardId });
    },
    [identity],
  );
  const readyContinue = useCallback(() => {
    if (identity) socketRef.current?.emit(EVT.CONTINUE, identity.playerId); // §13：全員按繼續才開下一局
  }, [identity]);
  const leave = useCallback(() => {
    if (identity) socketRef.current?.emit(EVT.LEAVE, identity.playerId); // 離開此場遊戲（對局中→整場結束）
    localStorage.removeItem(LS_TOKEN);
    setIdentity(null);
    setRoom(null);
    setGame(null);
    setGameOver(null);
    setGameEnded(null);
    setScreen('home');
  }, [identity]);

  const clearToast = useCallback(() => setToast(null), []);

  return {
    connected,
    screen,
    identity,
    room,
    game,
    gameOver,
    gameEnded,
    toast,
    savedName,
    lobby,
    createRoom,
    joinRoom,
    quickMatch,
    watchLobby,
    unwatchLobby,
    startGame,
    act,
    readyContinue,
    clearToast,
    leave,
  };
}
