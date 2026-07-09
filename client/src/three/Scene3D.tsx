// three.js 場景的 React 包裝：掛載/卸載 TableScene，狀態變更時 sync()
import { useEffect, useRef } from 'react';
import { TableScene, type SceneInput } from './tableScene.js';

interface Props extends SceneInput {
  onPick: (cardId: string) => void;
  onPass: () => void;
}

export function Scene3D({ g, selectedId, pickableIds, canPass, standeeStyle, onPick, onPass }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<TableScene | null>(null);
  // callbacks 走 ref，避免每次 render 重建整個場景
  const cbRef = useRef({ onPick, onPass });
  cbRef.current = { onPick, onPass };

  useEffect(() => {
    const scene = new TableScene(containerRef.current!, {
      onPick: (id) => cbRef.current.onPick(id),
      onPass: () => cbRef.current.onPass(),
    });
    sceneRef.current = scene;
    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.sync({ g, selectedId, pickableIds, canPass, standeeStyle });
  }, [g, selectedId, pickableIds, canPass, standeeStyle]);

  return <div className="scene3d" ref={containerRef} />;
}
