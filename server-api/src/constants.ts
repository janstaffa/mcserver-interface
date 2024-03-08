import path from 'path';

export const SERVER_ADDRESS = 'localhost';
export const SERVER_ROOT_PATH = process.env.SERVER_ROOT_PATH || '/';
export const BACKUP_PATH = path.join(SERVER_ROOT_PATH, 'backups');
export const DATA_PATH = path.join(SERVER_ROOT_PATH, 'mechanicalcraft');

export const REDIS_URL = 'redis://localhost:6379';
export const REDIS_PUBLIC_CHANNEL = 'public';
