import { useGame } from './useGame.js';
import { Lobby } from './components/Lobby.js';
import { WaitingRoom } from './components/WaitingRoom.js';
import { Table } from './components/Table.js';
import { Toast } from './components/Toast.js';

export function App() {
  const api = useGame();

  return (
    <div className="app">
      {!api.connected && <div className="conn-banner">連線中…</div>}

      {api.screen === 'home' && <Lobby api={api} />}
      {api.screen === 'room' && api.room && <WaitingRoom api={api} />}
      {api.screen === 'game' && api.game && <Table api={api} />}

      <Toast message={api.toast} onClose={api.clearToast} />
    </div>
  );
}
