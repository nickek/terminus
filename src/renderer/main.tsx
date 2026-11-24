import { createRoot } from 'react-dom/client';
import { App } from './App';
import { client } from './client';
import { loadWindowsTerminalProfile } from './schemes';
import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import './styles.css';

client.connect();
loadWindowsTerminalProfile();
createRoot(document.getElementById('root')!).render(<App />);

// Debug handle (used by the self-test harness and handy from DevTools).
import * as workspace from './workspace';
(window as any).__terminus = { client, workspace };
