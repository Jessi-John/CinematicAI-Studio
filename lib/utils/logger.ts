import pino from 'pino';

const isDev = typeof process !== 'undefined'
  ? process.env.NODE_ENV === 'development'
  : true;

const instance = pino({
  browser: {
    asObject: true,
  },
  level: isDev ? 'warn' : 'silent',
});

export const logger = {
  warn: instance.warn.bind(instance),
  error: instance.error.bind(instance),
};
