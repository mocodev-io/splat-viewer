import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// No StrictMode: it mounts components twice in development, which would load,
// release and reload every splat.
createRoot(document.getElementById('root')!).render(<App />);
