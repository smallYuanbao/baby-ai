/**
 * Type augmentation for Express's Request object.
 *
 * Adds an optional `user` property populated by the `authenticate` middleware.
 * Routes downstream of `authenticate` can safely read `req.user` without
 * additional type assertions.
 *
 * This file uses `declare global` so it applies across the entire server
 * package without needing explicit imports in every route file.
 */

declare global {
  namespace Express {
    interface Request {
      /**
       * Authenticated user identity injected by the `authenticate` middleware.
       *
       * `undefined` when the route is not behind `authenticate`, or when
       * `authenticate({ required: false })` encounters a missing/invalid token.
       */
      user?: {
        userId: string;
        email: string;
      };
    }
  }
}

export {};
