// src/renderer/main.tsx
import './monacoSetup'; // §14 B2：Monaco 本地化（必须在 App / loader.init 之前）
import { createRoot } from 'react-dom/client';
import App from './App';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<App />);
}
