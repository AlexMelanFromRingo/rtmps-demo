import type { ReactNode } from 'react';
import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { useDocumentTitle } from '../lib/hooks';
import './NotFoundPage.css';

export function NoSignal({
  code,
  title,
  children,
}: {
  code: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="page nosignal">
      <div className="nosignal__screen" aria-hidden="true">
        <span className="nosignal__code">{code}</span>
        <span className="nosignal__caption">нет сигнала</span>
      </div>
      <div className="nosignal__text">
        <h1 className="h-page">{title}</h1>
        {children}
      </div>
    </div>
  );
}

export function NotFoundPage({ what = 'page' }: { what?: 'page' | 'channel' }) {
  useDocumentTitle('Не найдено');
  return (
    <NoSignal code="404" title={what === 'channel' ? 'Такого канала нет' : 'Такой страницы нет'}>
      <p className="muted">
        {what === 'channel'
          ? 'Проверьте адрес: имя канала совпадает с именем пользователя стримера.'
          : 'Возможно, ссылка устарела или в адресе опечатка.'}
      </p>
      <Link to="/" className="btn btn--primary">
        Открыть каталог эфиров
      </Link>
    </NoSignal>
  );
}

export function RouteErrorPage() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />;
  return (
    <NoSignal code="ERR" title="Страница не загрузилась">
      <p className="muted">
        Скорее всего, приложение обновилось или пропала связь с сервером. Перезагрузите страницу.
      </p>
      <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
        Перезагрузить
      </button>
    </NoSignal>
  );
}
