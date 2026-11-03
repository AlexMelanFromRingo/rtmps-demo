export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const notFound = (what = 'Не найдено') => new HttpError(404, 'not_found', what);
export const unauthorized = () => new HttpError(401, 'unauthorized', 'Требуется вход');
