import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { createApiClient, type FetchFn } from './api/client';
import { API_URL } from './config';
import './styles.css';

async function bootstrap() {
  let fetchFn: FetchFn = (input, init) => fetch(input, init);
  let baseUrl = API_URL;
  let devPanel: ReactNode = null;

  // Statically false in production builds, so the mock chunk is never emitted.
  if (import.meta.env.VITE_MOCK === 'true') {
    const [{ createMockBackend }, { DevPanel }] = await Promise.all([
      import('./mocks/mockBackend'),
      import('./mocks/DevPanel'),
    ]);
    const backend = createMockBackend();
    fetchFn = backend.fetch;
    baseUrl = 'https://caption-api.icyground-e68f5579.francecentral.azurecontainerapps.io';
    devPanel = <DevPanel backend={backend} />;
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App api={createApiClient(baseUrl, fetchFn)} devPanel={devPanel} />
    </StrictMode>,
  );
}

void bootstrap();
