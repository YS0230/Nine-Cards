import { useState } from 'react';
import { cardImageBase, type Card as CardT } from '@nine-cards/shared';

interface Props {
  card?: CardT;
  faceDown?: boolean;
  small?: boolean;
  big?: boolean;
  selectable?: boolean;
  selected?: boolean;
  onClick?: () => void;
}

const COLOR_HEX: Record<string, string> = { 黃: '#e8b60c', 紅: '#e0621a', 綠: '#1f9d4d', 白: '#f4f4f4' };

export function Card({ card, faceDown, small, big, selectable, selected, onClick }: Props) {
  const [imgFailed, setImgFailed] = useState(false);
  const cls = [
    'card',
    small ? 'card-sm' : '',
    big ? 'card-big' : '',
    faceDown ? 'card-back' : '',
    selectable ? 'card-selectable' : '',
    selected ? 'card-selected' : '',
  ]
    .filter(Boolean)
    .join(' ');

  if (faceDown || !card) {
    return <div className={cls} onClick={onClick} />;
  }

  return (
    <div className={cls} onClick={onClick} aria-label={`${card.color}${card.rank}`}>
      {imgFailed ? (
        <div className="card-fallback" style={{ background: COLOR_HEX[card.color] ?? '#ccc' }}>
          {card.rank}
        </div>
      ) : (
        <img
          src={`/cards/${cardImageBase(card)}.png`}
          alt={`${card.color}${card.rank}`}
          draggable={false}
          onError={() => setImgFailed(true)}
        />
      )}
    </div>
  );
}
