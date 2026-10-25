const configuredApiUrl = import.meta.env.VITE_API_URL?.trim().replace(/\/$/, '');
const isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

export const API_BASE_URL = configuredApiUrl || (isLocalHost && window.location.port === '3000' ? 'http://localhost:4000' : '');

export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

export function gatewayWebSocketUrl(): string {
  if (API_BASE_URL) return API_BASE_URL.replace(/^http/, 'ws');
  return `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;
}
