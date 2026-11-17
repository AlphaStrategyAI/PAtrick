import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { ServiceProvider } from './api/query.js';
import { isDemo } from './app/demo.js';
import { appRoutes } from './app/routes.js';
import { browserDrafts } from './state/browserDrafts.js';
import '@fontsource/noto-sans-sc/400.css';
import '@fontsource/noto-sans-sc/600.css';
import './styles/tokens.css';

const root = document.getElementById('root');
if (!root) throw new Error('App root is missing');
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15_000 } } });
const router = createBrowserRouter(appRoutes);
createRoot(root).render(<StrictMode>
  <QueryClientProvider client={queryClient}>
    <ServiceProvider demo={isDemo} onAccountExit={(account) => browserDrafts.clearAccount(account)}>
      <RouterProvider router={router} />
    </ServiceProvider>
  </QueryClientProvider>
</StrictMode>);
