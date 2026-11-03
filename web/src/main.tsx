import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { Layout } from './components/Layout';
import { AuthProvider } from './lib/auth';
import { AuthPage } from './pages/AuthPage';
import { DirectoryPage } from './pages/DirectoryPage';
import { NotFoundPage, RouteErrorPage } from './pages/NotFoundPage';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';

const router = createBrowserRouter([
  {
    element: <Layout />,
    errorElement: <RouteErrorPage />,
    hydrateFallbackElement: (
      <div className="center-state">
        <div className="spinner" aria-label="Загрузка" />
      </div>
    ),
    children: [
      { index: true, element: <DirectoryPage /> },
      { path: 'login', element: <AuthPage mode="login" /> },
      { path: 'signup', element: <AuthPage mode="signup" /> },
      {
        path: 'dashboard',
        // hls.js + WebRTC code only load when needed.
        lazy: async () => ({ Component: (await import('./pages/dashboard/DashboardPage')).DashboardPage }),
      },
      {
        path: ':slug',
        lazy: async () => ({ Component: (await import('./pages/ChannelPage')).ChannelPage }),
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </StrictMode>,
);
