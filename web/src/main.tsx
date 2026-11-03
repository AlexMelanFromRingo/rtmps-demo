// Global styles first, so component stylesheets can override them at equal specificity.
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { Layout } from './components/Layout';
import { AuthProvider } from './lib/auth';
import { AuthPage } from './pages/AuthPage';
import { CategoriesPage, CategoryPage } from './pages/CategoriesPage';
import { DirectoryPage } from './pages/DirectoryPage';
import { FollowingPage } from './pages/FollowingPage';
import { NotFoundPage, RouteErrorPage } from './pages/NotFoundPage';
import { SearchPage } from './pages/SearchPage';

// The OBS overlay must never paint the site background, not even for a frame.
if (window.location.pathname.startsWith('/overlay/')) {
  document.documentElement.classList.add('overlay-mode');
}

const router = createBrowserRouter([
  {
    // OBS Browser Source: no header, no layout, transparent page.
    path: 'overlay/:token',
    hydrateFallbackElement: <></>,
    errorElement: <></>,
    lazy: async () => ({ Component: (await import('./pages/OverlayPage')).OverlayPage }),
  },
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
      { path: 'directory', element: <CategoriesPage /> },
      { path: 'directory/:category', element: <CategoryPage /> },
      { path: 'search', element: <SearchPage /> },
      { path: 'following', element: <FollowingPage /> },
      { path: 'login', element: <AuthPage mode="login" /> },
      { path: 'signup', element: <AuthPage mode="signup" /> },
      {
        path: 'dashboard',
        // hls.js + WebRTC code only load when needed.
        lazy: async () => ({ Component: (await import('./pages/dashboard/DashboardPage')).DashboardPage }),
      },
      {
        path: 'settings/security',
        lazy: async () => ({ Component: (await import('./pages/SecurityPage')).SecurityPage }),
      },
      {
        path: 'videos/:id',
        lazy: async () => ({ Component: (await import('./pages/VideoPage')).VideoPage }),
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
