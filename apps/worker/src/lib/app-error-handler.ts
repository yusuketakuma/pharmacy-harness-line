import type { ErrorHandler } from 'hono';
import { log } from './log.js';

export const appErrorHandler: ErrorHandler = (err, c) => {
  if ('getResponse' in err) {
    const res = err.getResponse();
    return c.newResponse(res.body, res);
  }
  log('unhandled_route_error', { route: c.req.routePath, method: c.req.method, status: 500 }, 'error');
  return c.text('Internal Server Error', 500);
};
